# Gracerandly API

"Get it done without leaving." — backend API layer, sits in front of Supabase
(System Architecture §2 — mobile/web clients only ever call this, never the
database provider directly).

## What's here

```
gracerandly-api/
├── src/
│   ├── config/supabase.js     Supabase client (service_role — server-only)
│   ├── db/schema.sql          Full Postgres schema — run this first
│   ├── routes/errands.js      Create / accept / geofence-gated pickup
│   ├── services/geofence.js   Trust & Safety Engine — geofence + route deviation
│   ├── services/escrow.js     Escrow hold + release, commission split
│   └── index.js               Express app entrypoint
├── .env.example                Copy to .env and fill in real values
└── package.json
```

This is a working scaffold, not the full API — `errands.js` covers the
create → accept → geofence-gated pickup path end to end so the pattern is
established. Payments/users/admin routes are stubbed as TODOs in `index.js`.

---

## Setup — run these in Git Bash, in order

### 1. Create the Supabase project (one-time, via browser)
Go to https://supabase.com/dashboard → New Project → free tier. Once it's
created, grab two values from **Settings → API**:
- Project URL
- `service_role` key (NOT the `anon` key — this API needs full server access)

### 2. Initialize the repo

```bash
cd gracerandly-api
git init
git add .
git commit -m "Initial API scaffold: schema, geofence engine, errand routes"
```

If you already have a remote (GitHub/GitLab) to push to:

```bash
git remote add origin <your-repo-url>
git branch -M main
git push -u origin main
```

### 3. Install dependencies

```bash
npm install
```

### 4. Configure environment

```bash
cp .env.example .env
```

Then open `.env` and paste in your `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`
from step 1.

### 5. Apply the schema to Supabase

Easiest path — no CLI needed:
1. Open your Supabase project → **SQL Editor**
2. Paste the entire contents of `src/db/schema.sql`
3. Run it

CLI path, if you'd rather script it (requires `npx supabase login` once):

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push --file src/db/schema.sql
```

### 6. Run it

```bash
npm run dev
```

You should see `Gracerandly API listening on http://localhost:4000`.

### 7. Smoke test

```bash
curl http://localhost:4000/health
```

Then try creating an errand:

```bash
curl -X POST http://localhost:4000/errands \
  -H "Content-Type: application/json" \
  -d '{
    "requesterId": "<a real user uuid from your users table>",
    "category": "pharmacy",
    "pickup": {"label": "Aggrey Rd Pharmacy", "lat": 4.8156, "lng": 7.0498},
    "dropoff": {"label": "Home", "lat": 4.8200, "lng": 7.0450},
    "items": [{"name": "Paracetamol", "qty": 1}]
  }'
```

(You'll need at least one row in `users` first — insert one manually via the
Supabase Table Editor to test with, until the auth/signup routes exist.)

---

## What's deliberately NOT in this scaffold yet

- Signup/auth routes (NIN/BVN verification needs a provider decision first —
  see the Decision Addendum, Smile ID / Prembly recommended)
- Matching service (expanding-radius search logic)
- Paystack/Flutterwave integration for real disbursement (escrow.js has the
  hold/release logic; the actual gateway call is a TODO)
- Admin dashboard routes (role-based views)
- WebSocket/Realtime wiring for live status updates

These are the natural next pieces — say which one to build next.
