-- ============================================================
-- GRACERANDLY — DATABASE SCHEMA (Postgres, Supabase-hosted)
-- "Get it done without leaving."
-- v0.1 — foundational schema per PRD §6, System Architecture §3.9,
-- and the Decision Addendum's default thresholds.
-- Threshold values below are the addendum's PROPOSED MVP defaults
-- (₦ caps, geofence radius, etc.) — pending sponsor sign-off.
-- ============================================================

create extension if not exists "uuid-ossp";
create extension if not exists postgis; -- for geofence distance checks

-- ------------------------------------------------------------
-- ENUMS
-- ------------------------------------------------------------
create type user_role as enum ('requester', 'runner', 'platform_admin', 'trust_safety_admin', 'finance_ops_admin');
create type trust_tier as enum ('probationary', 'silver', 'gold');
create type errand_category as enum ('grocery', 'pharmacy', 'food', 'parcel', 'misc');
create type errand_status as enum (
  'pending_match', 'matched', 'accepted', 'en_route_pickup',
  'in_progress', 'en_route_delivery', 'delivered', 'cancelled_pre_pickup',
  'cancelled_post_pickup', 'disputed'
);
create type vendor_payment_method as enum ('virtual_card', 'bank_transfer_ussd', 'petty_cash_float');
create type incident_type as enum ('geofence_mismatch', 'route_deviation', 'sos', 'unreconciled_float', 'cancellation', 'dispute');
create type incident_status as enum ('open', 'under_review', 'resolved_no_action', 'confirmed_against_runner', 'confirmed_against_requester');

-- ------------------------------------------------------------
-- USERS & IDENTITY  (PRD §6.1, §6.8)
-- ------------------------------------------------------------
create table users (
  id uuid primary key default uuid_generate_v4(),
  role user_role not null,
  full_name text not null,
  phone text unique not null,
  phone_verified_at timestamptz,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table runner_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  nin_verified boolean not null default false,
  bvn_verified boolean not null default false,
  guarantor_name text not null,
  guarantor_phone text not null,
  guarantor_relationship text,
  trust_tier trust_tier not null default 'probationary',
  -- addendum defaults: probationary ₦2,000 / silver ₦5,000 / gold ₦10,000
  petty_cash_float_cap numeric(10,2) not null default 2000.00,
  item_value_cap numeric(10,2) not null default 15000.00,
  is_online boolean not null default false,
  last_location geography(Point, 4326),
  active_errand_count int not null default 0 check (active_errand_count <= 3),
  created_at timestamptz not null default now()
);

create table admin_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  admin_role user_role not null check (admin_role in ('platform_admin','trust_safety_admin','finance_ops_admin')),
  created_by uuid references users(id)
);

-- ------------------------------------------------------------
-- ERRANDS  (PRD §6.2–§6.4)
-- ------------------------------------------------------------
create table errands (
  id uuid primary key default uuid_generate_v4(),
  requester_id uuid not null references users(id),
  runner_id uuid references users(id),
  category errand_category not null,
  status errand_status not null default 'pending_match',
  is_recurring boolean not null default false,
  recurrence_rule text, -- e.g. 'weekly' — simple MVP cron-style string

  raw_ai_text text,               -- what the Requester typed, if AI-assisted
  ai_parsed_at timestamptz,

  pickup_label text not null,
  pickup_location geography(Point, 4326) not null,
  dropoff_label text not null,
  dropoff_location geography(Point, 4326) not null,
  items jsonb not null default '[]', -- [{name, qty, notes}]
  instructions text,

  estimated_cost numeric(10,2),
  final_cost numeric(10,2),
  surge_multiplier numeric(4,2) default 1.0,

  match_radius_meters int not null default 4828, -- 3 miles, expands per matching logic
  matching_score numeric(5,2),

  sequence_position int, -- for multi-errand route sequencing (see runner load)

  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  delivery_pin text,
  delivery_confirmed_at timestamptz
);

create index idx_errands_status on errands(status);
create index idx_errands_pickup_geo on errands using gist(pickup_location);

-- ------------------------------------------------------------
-- TRUST & SAFETY ENGINE  (PRD §6.4, §6.8, System Architecture §3.5)
-- ------------------------------------------------------------
create table geofence_checks (
  id uuid primary key default uuid_generate_v4(),
  errand_id uuid not null references errands(id),
  check_type text not null check (check_type in ('pickup','dropoff')),
  runner_location geography(Point, 4326) not null,
  target_location geography(Point, 4326) not null,
  distance_meters numeric(8,2) not null,
  -- addendum default: 150m radius, configurable by Platform Admin
  radius_threshold_meters int not null default 150,
  passed boolean not null,
  checked_at timestamptz not null default now()
);

create table route_deviation_flags (
  id uuid primary key default uuid_generate_v4(),
  errand_id uuid not null references errands(id),
  runner_id uuid not null references users(id),
  deviation_meters numeric(8,2) not null,
  -- addendum default: >400m for >3min, or stationary >5min
  duration_seconds int not null,
  trigger_reason text not null check (trigger_reason in ('off_route', 'unexpected_stationary')),
  flagged_at timestamptz not null default now(),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz
);

create table trust_tier_history (
  id uuid primary key default uuid_generate_v4(),
  runner_id uuid not null references users(id),
  previous_tier trust_tier,
  new_tier trust_tier not null,
  reason text not null, -- 'clean_track_record' | 'confirmed_incident' | 'unreconciled_float' | ...
  changed_by uuid references users(id), -- null if system-automated
  created_at timestamptz not null default now()
);

create table incidents (
  id uuid primary key default uuid_generate_v4(),
  errand_id uuid references errands(id),
  runner_id uuid references users(id),
  requester_id uuid references users(id),
  incident_type incident_type not null,
  status incident_status not null default 'open',
  description text,
  evidence_urls jsonb default '[]', -- photos, chat logs, etc.
  -- Finance & Ops can act up to ₦10,000 refund without escalation (addendum default)
  requires_platform_admin boolean not null default false,
  assigned_to uuid references users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_notes text
);

-- ------------------------------------------------------------
-- PAYMENTS, ESCROW & VENDOR DISBURSEMENT  (PRD §6.7)
-- ------------------------------------------------------------
create table escrow_transactions (
  id uuid primary key default uuid_generate_v4(),
  errand_id uuid not null unique references errands(id),
  requester_id uuid not null references users(id),
  amount_paid numeric(10,2) not null,
  commission_rate numeric(4,3) not null default 0.150, -- 15%, Platform Admin configurable
  commission_amount numeric(10,2) not null,
  runner_payout_amount numeric(10,2) not null,
  held_at timestamptz not null default now(),
  released_at timestamptz,
  payment_gateway_ref text, -- Paystack/Flutterwave transaction ID
  refunded_amount numeric(10,2) default 0,
  refunded_by uuid references users(id),
  refunded_at timestamptz
);

create table vendor_disbursements (
  id uuid primary key default uuid_generate_v4(),
  errand_id uuid not null references errands(id),
  runner_id uuid not null references users(id),
  method vendor_payment_method not null,
  amount numeric(10,2) not null,
  vendor_name text,
  vendor_directory_id uuid, -- fk to verified_vendors, nullable for ad-hoc vendors
  virtual_card_ref text,     -- if method = virtual_card
  transfer_ref text,         -- if method = bank_transfer_ussd
  receipt_photo_url text,    -- required if method = petty_cash_float
  purchase_location geography(Point, 4326),
  reconciled boolean not null default false,
  reconciled_at timestamptz,
  -- addendum: unreconciled float auto-flags to Trust & Safety after 4 hours
  disbursed_at timestamptz not null default now()
);

create table verified_vendors (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  category errand_category,
  location geography(Point, 4326),
  preferred_method vendor_payment_method,
  account_details jsonb, -- bank/mobile-money details if applicable
  added_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- RATINGS, REFERRALS, SUPPORT  (PRD §6.9, §6.14)
-- ------------------------------------------------------------
create table ratings (
  id uuid primary key default uuid_generate_v4(),
  errand_id uuid not null references errands(id),
  rater_id uuid not null references users(id),
  ratee_id uuid not null references users(id),
  stars smallint not null check (stars between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique(errand_id, rater_id)
);

create table referrals (
  id uuid primary key default uuid_generate_v4(),
  referrer_id uuid not null references users(id),
  referred_id uuid not null references users(id) unique,
  reward_triggered_at timestamptz, -- set once referred user completes qualifying action
  created_at timestamptz not null default now()
);

create table support_tickets (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id),
  errand_id uuid references errands(id),
  subject text not null,
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  assigned_to uuid references users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- ------------------------------------------------------------
-- COMMUNICATION  (PRD §6.5)
-- ------------------------------------------------------------
create table messages (
  id uuid primary key default uuid_generate_v4(),
  errand_id uuid not null references errands(id),
  sender_id uuid not null references users(id),
  message_type text not null check (message_type in ('text','photo','voice_note','call_log')),
  content text, -- text body or media URL
  moderation_flagged boolean not null default false,
  moderation_reason text,
  sent_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- SOS  (PRD §6.10)
-- ------------------------------------------------------------
create table sos_events (
  id uuid primary key default uuid_generate_v4(),
  triggered_by uuid not null references users(id),
  errand_id uuid references errands(id),
  location geography(Point, 4326),
  trusted_contact_notified boolean not null default false,
  admin_notified boolean not null default false,
  triggered_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- ------------------------------------------------------------
-- IMMUTABLE AUDIT LOG  (PRD §5 — every admin action)
-- ------------------------------------------------------------
create table audit_log (
  id uuid primary key default uuid_generate_v4(),
  actor_id uuid not null references users(id),
  action text not null,          -- e.g. 'refund_issued', 'runner_suspended', 'tier_adjusted'
  target_table text,
  target_id uuid,
  metadata jsonb default '{}',
  created_at timestamptz not null default now()
);
-- No update/delete permissions granted on this table at the application layer —
-- inserts only, enforced via Postgres role grants, not application logic alone.

-- ------------------------------------------------------------
-- ANALYTICS EVENTS  (PRD §6.12 — funnel/retention/heatmap source)
-- ------------------------------------------------------------
create table analytics_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users(id),
  event_name text not null, -- 'signup','errand_created','matched','completed','cancelled','rated', etc.
  errand_id uuid references errands(id),
  zone text,                 -- for geographic heatmaps
  metadata jsonb default '{}',
  occurred_at timestamptz not null default now()
);
create index idx_analytics_event_name_time on analytics_events(event_name, occurred_at);
