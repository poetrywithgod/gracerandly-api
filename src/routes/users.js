const express = require("express");
const { supabase } = require("../config/supabase");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

// GET /users — list, optionally filtered by role (Admin dashboard use)
// NOTE: unauthenticated for now — this becomes admin-only once admin
// auth exists. Tracked as a known gap, not forgotten.
router.get("/", async (req, res) => {
  const { role } = req.query;
  let query = supabase.from("users").select("id, role, full_name, phone, email, created_at, runner_profiles(*)").order("created_at", { ascending: false }).limit(100);
  if (role) query = query.eq("role", role);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /users/:id
router.get("/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("users")
    .select("id, role, full_name, phone, email, created_at")
    .eq("id", req.params.id)
    .single();
  if (error) return res.status(404).json({ error: "User not found" });
  res.json(data);
});

// PATCH /users/:id/runner-status — go online/offline and report location.
// Protected: only the Runner themselves can update their own status.
router.patch("/:id/runner-status", authenticate, async (req, res) => {
  const runnerId = req.params.id;

  if (req.user.id !== runnerId) {
    return res.status(403).json({ error: "You can only update your own Runner status" });
  }

  const { isOnline, lat, lng } = req.body;
  const update = {};
  if (typeof isOnline === "boolean") update.is_online = isOnline;
  if (lat != null && lng != null) update.last_location = `POINT(${lng} ${lat})`;

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: "Provide isOnline and/or lat+lng" });
  }

  const { data, error } = await supabase
    .from("runner_profiles")
    .update(update)
    .eq("user_id", runnerId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
