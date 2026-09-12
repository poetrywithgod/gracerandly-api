const express = require("express");
const { supabase } = require("../config/supabase");
const { checkGeofence } = require("../services/geofence");
const { matchErrand } = require("../services/matching");
const { authenticate, requireRole } = require("../middleware/auth");

const router = express.Router();
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_ERRANDS_PER_RUNNER || 3);
const INITIAL_RADIUS = Number(process.env.INITIAL_MATCH_RADIUS_METERS || 4828);

// POST /errands — Requester creates an errand (PRD §6.2)
// requesterId now comes from the authenticated token, not the request body —
// a Requester can no longer create an errand on someone else's behalf.
router.post("/", authenticate, requireRole("requester"), async (req, res) => {
  const requesterId = req.user.id;
  const { category, pickup, dropoff, items, instructions, isRecurring, rawAiText } = req.body;

  if (!category || !pickup || !dropoff) {
    return res.status(400).json({ error: "category, pickup, and dropoff are required" });
  }

  const { data, error } = await supabase
    .from("errands")
    .insert({
      requester_id: requesterId,
      category,
      pickup_label: pickup.label,
      pickup_location: `POINT(${pickup.lng} ${pickup.lat})`,
      dropoff_label: dropoff.label,
      dropoff_location: `POINT(${dropoff.lng} ${dropoff.lat})`,
      items: items || [],
      instructions,
      is_recurring: !!isRecurring,
      raw_ai_text: rawAiText || null,
      match_radius_meters: INITIAL_RADIUS,
      status: "pending_match",
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  await supabase.from("analytics_events").insert({
    user_id: requesterId,
    event_name: "errand_created",
    errand_id: data.id,
  });

  const matchResult = await matchErrand(data.id);

  const { data: freshErrand } = await supabase.from("errands").select("*").eq("id", data.id).single();

  res.status(201).json({ errand: freshErrand || data, match: matchResult });
});

// GET /errands — list, optionally filtered by status (Admin dashboard use)
router.get("/", authenticate, requireRole("platform_admin", "trust_safety_admin", "finance_ops_admin"), async (req, res) => {
  const { status } = req.query;
  let query = supabase.from("errands").select("*").order("created_at", { ascending: false }).limit(100);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /errands/:id
router.get("/:id", async (req, res) => {
  const { data, error } = await supabase.from("errands").select("*").eq("id", req.params.id).single();
  if (error) return res.status(404).json({ error: "Errand not found" });
  res.json(data);
});

// POST /errands/:id/accept — Runner accepts their offered match (PRD §6.3, load cap enforced)
// runnerId now comes from the token — a Runner can only accept for themselves.
router.post("/:id/accept", authenticate, requireRole("runner"), async (req, res) => {
  const runnerId = req.user.id;
  const errandId = req.params.id;

  const { data: runner, error: runnerErr } = await supabase
    .from("runner_profiles")
    .select("active_errand_count")
    .eq("user_id", runnerId)
    .single();

  if (runnerErr) return res.status(404).json({ error: "Runner not found" });
  if (runner.active_errand_count >= MAX_CONCURRENT) {
    return res.status(409).json({ error: `Runner already at max ${MAX_CONCURRENT} concurrent errands` });
  }

  const { data, error } = await supabase
    .from("errands")
    .update({ runner_id: runnerId, status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", errandId)
    .eq("status", "matched")
    .eq("offered_runner_id", runnerId)
    .select()
    .single();

  if (error || !data) {
    return res.status(409).json({ error: "This errand wasn't offered to this Runner, or is no longer available" });
  }

  await supabase
    .from("runner_profiles")
    .update({ active_errand_count: runner.active_errand_count + 1 })
    .eq("user_id", runnerId);

  res.json(data);
});

// POST /errands/:id/decline — Runner declines their offer; re-run matching excluding them
router.post("/:id/decline", authenticate, requireRole("runner"), async (req, res) => {
  const runnerId = req.user.id;
  const errandId = req.params.id;

  const { data: errand, error: fetchErr } = await supabase
    .from("errands")
    .select("offered_runner_id, declined_runner_ids, status")
    .eq("id", errandId)
    .single();
  if (fetchErr) return res.status(404).json({ error: "Errand not found" });

  if (errand.status !== "matched" || errand.offered_runner_id !== runnerId) {
    return res.status(409).json({ error: "This errand wasn't offered to this Runner" });
  }

  const updatedDeclineList = [...errand.declined_runner_ids, runnerId];

  await supabase
    .from("errands")
    .update({ status: "pending_match", offered_runner_id: null, declined_runner_ids: updatedDeclineList })
    .eq("id", errandId);

  const matchResult = await matchErrand(errandId, { excludeRunnerIds: updatedDeclineList });

  res.json({ declined: true, rematch: matchResult });
});

// POST /errands/:id/pickup — geofence-gated status change (PRD §6.4)
// Only the Runner assigned to this errand can mark it picked up.
router.post("/:id/pickup", authenticate, requireRole("runner"), async (req, res) => {
  const runnerId = req.user.id;
  const errandId = req.params.id;

  const { data: errand, error: fetchErr } = await supabase
    .from("errands")
    .select("id, pickup_label, status, runner_id")
    .eq("id", errandId)
    .single();
  if (fetchErr) return res.status(404).json({ error: "Errand not found" });

  if (errand.runner_id !== runnerId) {
    return res.status(403).json({ error: "This errand isn't assigned to you" });
  }

  const { runnerLat, runnerLng, targetLat, targetLng } = req.body;
  if (targetLat == null || targetLng == null) {
    return res.status(400).json({ error: "targetLat/targetLng required (pickup coordinates)" });
  }

  const geofenceResult = await checkGeofence({
    errandId,
    checkType: "pickup",
    runnerLat,
    runnerLng,
    targetLat,
    targetLng,
  });

  if (!geofenceResult.passed) {
    return res.status(403).json({
      error: "Outside geofence radius — move closer to the pickup location to confirm",
      ...geofenceResult,
    });
  }

  const { data, error } = await supabase
    .from("errands")
    .update({ status: "in_progress", picked_up_at: new Date().toISOString() })
    .eq("id", errandId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ errand: data, geofence: geofenceResult });
});

module.exports = router;
