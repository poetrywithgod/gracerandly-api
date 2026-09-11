const express = require("express");
const { supabase } = require("../config/supabase");
const { checkGeofence } = require("../services/geofence");

const router = express.Router();
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_ERRANDS_PER_RUNNER || 3);
const INITIAL_RADIUS = Number(process.env.INITIAL_MATCH_RADIUS_METERS || 4828);

// POST /errands — Requester creates an errand (PRD §6.2)
router.post("/", async (req, res) => {
  const { requesterId, category, pickup, dropoff, items, instructions, isRecurring, rawAiText } = req.body;

  if (!requesterId || !category || !pickup || !dropoff) {
    return res.status(400).json({ error: "requesterId, category, pickup, and dropoff are required" });
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

  // TODO: kick off matching service (expanding-radius search) here
  res.status(201).json(data);
});

// GET /errands/:id
router.get("/:id", async (req, res) => {
  const { data, error } = await supabase.from("errands").select("*").eq("id", req.params.id).single();
  if (error) return res.status(404).json({ error: "Errand not found" });
  res.json(data);
});

// POST /errands/:id/accept — Runner accepts (PRD §6.3, load cap enforced)
router.post("/:id/accept", async (req, res) => {
  const { runnerId } = req.body;
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
    .eq("status", "pending_match") // prevent double-accept race
    .select()
    .single();

  if (error || !data) {
    return res.status(409).json({ error: "Errand is no longer available (already accepted or cancelled)" });
  }

  await supabase
    .from("runner_profiles")
    .update({ active_errand_count: runner.active_errand_count + 1 })
    .eq("user_id", runnerId);

  res.json(data);
});

// POST /errands/:id/pickup — geofence-gated status change (PRD §6.4)
router.post("/:id/pickup", async (req, res) => {
  const { runnerLat, runnerLng } = req.body;
  const errandId = req.params.id;

  const { data: errand, error: fetchErr } = await supabase
    .from("errands")
    .select("id, pickup_label, status, runner_id")
    .eq("id", errandId)
    .single();
  if (fetchErr) return res.status(404).json({ error: "Errand not found" });

  // NOTE: pickup_location is stored as geography; for this MVP scaffold we
  // expect the caller to also pass targetLat/targetLng captured at errand
  // creation time until a lookup helper is added.
  const { targetLat, targetLng } = req.body;
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
