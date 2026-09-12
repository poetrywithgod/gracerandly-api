const express = require("express");
const bcrypt = require("bcryptjs");
const { supabase } = require("../config/supabase");
const { authenticate, requireRole, signToken } = require("../middleware/auth");
const { logAdminAction } = require("../services/auditLog");

const router = express.Router();

// Decision Addendum §4 defaults — configurable later via Platform Admin settings
const REFUND_CAP = Number(process.env.FINANCE_REFUND_CAP || 10000);

const TIER_CAPS = {
  probationary: { petty_cash_float_cap: 2000, item_value_cap: 15000 },
  silver: { petty_cash_float_cap: 5000, item_value_cap: 50000 },
  gold: { petty_cash_float_cap: 10000, item_value_cap: 150000 },
};

// POST /admin/bootstrap — creates the FIRST Platform Admin. Gated by a
// shared secret (not a role, since no admin exists yet to grant one).
// Use once, then treat that secret as compromised and rotate it.
router.post("/bootstrap", async (req, res) => {
  const bootstrapSecret = req.headers["x-bootstrap-secret"];
  if (!bootstrapSecret || bootstrapSecret !== process.env.ADMIN_BOOTSTRAP_SECRET) {
    return res.status(403).json({ error: "Invalid or missing bootstrap secret" });
  }

  const { fullName, phone, email, password } = req.body;
  if (!fullName || !phone || !password) {
    return res.status(400).json({ error: "fullName, phone, and password are required" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const { data: user, error: userErr } = await supabase
    .from("users")
    .insert({ role: "platform_admin", full_name: fullName, phone, email, password_hash: passwordHash })
    .select("id, role, full_name, phone, email, created_at")
    .single();
  if (userErr) {
    if (userErr.code === "23505") return res.status(409).json({ error: "Phone number already registered" });
    return res.status(500).json({ error: userErr.message });
  }

  await supabase.from("admin_profiles").insert({ user_id: user.id, admin_role: "platform_admin" });

  const token = signToken({ id: user.id, role: user.role });
  res.status(201).json({ user, token });
});

// POST /admin/create-admin — Platform Admin creates Trust & Safety / Finance & Ops accounts
router.post("/create-admin", authenticate, requireRole("platform_admin"), async (req, res) => {
  const { fullName, phone, email, password, adminRole } = req.body;
  const validRoles = ["trust_safety_admin", "finance_ops_admin", "platform_admin"];

  if (!fullName || !phone || !password || !validRoles.includes(adminRole)) {
    return res.status(400).json({ error: `fullName, phone, password, and adminRole (one of: ${validRoles.join(", ")}) are required` });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const { data: user, error: userErr } = await supabase
    .from("users")
    .insert({ role: adminRole, full_name: fullName, phone, email, password_hash: passwordHash })
    .select("id, role, full_name, phone, email, created_at")
    .single();
  if (userErr) {
    if (userErr.code === "23505") return res.status(409).json({ error: "Phone number already registered" });
    return res.status(500).json({ error: userErr.message });
  }

  await supabase.from("admin_profiles").insert({ user_id: user.id, admin_role: adminRole, created_by: req.user.id });

  await logAdminAction({
    actorId: req.user.id,
    action: "admin_account_created",
    targetTable: "users",
    targetId: user.id,
    metadata: { adminRole },
  });

  res.status(201).json({ user });
});

// GET /admin/incidents — Trust & Safety queue (PRD §6.11)
router.get("/incidents", authenticate, requireRole("trust_safety_admin", "platform_admin"), async (req, res) => {
  const { status } = req.query;
  let query = supabase.from("incidents").select("*").order("created_at", { ascending: false }).limit(100);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /admin/incidents/:id/resolve
router.patch("/incidents/:id/resolve", authenticate, requireRole("trust_safety_admin", "platform_admin"), async (req, res) => {
  const { status, resolutionNotes } = req.body;
  const validStatuses = ["resolved_no_action", "confirmed_against_runner", "confirmed_against_requester"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
  }

  const { data: incident, error: fetchErr } = await supabase.from("incidents").select("*").eq("id", req.params.id).single();
  if (fetchErr) return res.status(404).json({ error: "Incident not found" });

  // Escalation rule (Decision Addendum §4): Gold-tier suspensions or any
  // confirmed fund/goods loss require Platform Admin sign-off.
  if (incident.requires_platform_admin && req.user.role !== "platform_admin") {
    return res.status(403).json({ error: "This incident requires Platform Admin approval" });
  }

  const { data, error } = await supabase
    .from("incidents")
    .update({ status, resolution_notes: resolutionNotes, resolved_at: new Date().toISOString(), assigned_to: req.user.id })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logAdminAction({
    actorId: req.user.id,
    action: "incident_resolved",
    targetTable: "incidents",
    targetId: req.params.id,
    metadata: { status, resolutionNotes },
  });

  res.json(data);
});

// PATCH /admin/runners/:id/verify — mark NIN/BVN verified (manual stand-in
// until Smile ID / Prembly integration exists — Decision Addendum §1)
router.patch("/runners/:id/verify", authenticate, requireRole("trust_safety_admin", "platform_admin"), async (req, res) => {
  const { ninVerified, bvnVerified } = req.body;
  const update = {};
  if (typeof ninVerified === "boolean") update.nin_verified = ninVerified;
  if (typeof bvnVerified === "boolean") update.bvn_verified = bvnVerified;

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: "Provide ninVerified and/or bvnVerified" });
  }

  const { data, error } = await supabase.from("runner_profiles").update(update).eq("user_id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAdminAction({
    actorId: req.user.id,
    action: "runner_verification_updated",
    targetTable: "runner_profiles",
    targetId: req.params.id,
    metadata: update,
  });

  res.json(data);
});

// PATCH /admin/runners/:id/trust-tier — adjust tier, apply matching caps, log history
router.patch("/runners/:id/trust-tier", authenticate, requireRole("trust_safety_admin", "platform_admin"), async (req, res) => {
  const { newTier, reason } = req.body;
  if (!TIER_CAPS[newTier]) {
    return res.status(400).json({ error: `newTier must be one of: ${Object.keys(TIER_CAPS).join(", ")}` });
  }
  if (!reason) return res.status(400).json({ error: "reason is required for any trust-tier change" });

  const { data: current, error: currentErr } = await supabase
    .from("runner_profiles")
    .select("trust_tier")
    .eq("user_id", req.params.id)
    .single();
  if (currentErr) return res.status(404).json({ error: "Runner not found" });

  const caps = TIER_CAPS[newTier];
  const { data, error } = await supabase
    .from("runner_profiles")
    .update({ trust_tier: newTier, ...caps })
    .eq("user_id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from("trust_tier_history").insert({
    runner_id: req.params.id,
    previous_tier: current.trust_tier,
    new_tier: newTier,
    reason,
    changed_by: req.user.id,
  });

  await logAdminAction({
    actorId: req.user.id,
    action: "trust_tier_changed",
    targetTable: "runner_profiles",
    targetId: req.params.id,
    metadata: { from: current.trust_tier, to: newTier, reason },
  });

  res.json(data);
});

// POST /admin/refunds — Finance & Ops processes refunds up to the cap;
// above it, only Platform Admin can (Decision Addendum §4)
router.post("/refunds", authenticate, requireRole("finance_ops_admin", "platform_admin"), async (req, res) => {
  const { errandId, amount, reason } = req.body;
  if (!errandId || !amount || !reason) {
    return res.status(400).json({ error: "errandId, amount, and reason are required" });
  }

  if (amount > REFUND_CAP && req.user.role !== "platform_admin") {
    return res.status(403).json({ error: `Refunds above ₦${REFUND_CAP} require Platform Admin approval` });
  }

  const { data, error } = await supabase
    .from("escrow_transactions")
    .update({ refunded_amount: amount, refunded_by: req.user.id, refunded_at: new Date().toISOString() })
    .eq("errand_id", errandId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await logAdminAction({
    actorId: req.user.id,
    action: "refund_issued",
    targetTable: "escrow_transactions",
    targetId: errandId,
    metadata: { amount, reason },
  });

  res.json(data);
});

// GET /admin/audit-log — read-only view of everything above
router.get("/audit-log", authenticate, requireRole("platform_admin"), async (req, res) => {
  const { data, error } = await supabase
    .from("audit_log")
    .select("*, actor:actor_id(full_name, role)")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
