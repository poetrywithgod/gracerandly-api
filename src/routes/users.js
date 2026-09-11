const express = require("express");
const { supabase } = require("../config/supabase");

const router = express.Router();

// POST /users/signup/requester (PRD §6.1 — basic profile + phone verification)
router.post("/signup/requester", async (req, res) => {
  const { fullName, phone, email } = req.body;
  if (!fullName || !phone) {
    return res.status(400).json({ error: "fullName and phone are required" });
  }

  const { data, error } = await supabase
    .from("users")
    .insert({ role: "requester", full_name: fullName, phone, email })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Phone number already registered" });
    return res.status(500).json({ error: error.message });
  }

  await supabase.from("analytics_events").insert({ user_id: data.id, event_name: "signup" });

  res.status(201).json(data);
});

// POST /users/signup/runner (PRD §6.1, §6.8 — NIN/BVN + guarantor, starts probationary)
router.post("/signup/runner", async (req, res) => {
  const { fullName, phone, email, guarantorName, guarantorPhone, guarantorRelationship } = req.body;

  if (!fullName || !phone || !guarantorName || !guarantorPhone) {
    return res.status(400).json({ error: "fullName, phone, guarantorName, and guarantorPhone are required" });
  }

  const { data: user, error: userErr } = await supabase
    .from("users")
    .insert({ role: "runner", full_name: fullName, phone, email })
    .select()
    .single();

  if (userErr) {
    if (userErr.code === "23505") return res.status(409).json({ error: "Phone number already registered" });
    return res.status(500).json({ error: userErr.message });
  }

  const { data: profile, error: profileErr } = await supabase
    .from("runner_profiles")
    .insert({
      user_id: user.id,
      guarantor_name: guarantorName,
      guarantor_phone: guarantorPhone,
      guarantor_relationship: guarantorRelationship || null,
    })
    .select()
    .single();

  if (profileErr) return res.status(500).json({ error: profileErr.message });

  await supabase.from("analytics_events").insert({ user_id: user.id, event_name: "signup" });
  await supabase.from("trust_tier_history").insert({
    runner_id: user.id,
    new_tier: "probationary",
    reason: "initial_signup",
  });

  res.status(201).json({ user, profile });
});

// GET /users/:id
router.get("/:id", async (req, res) => {
  const { data, error } = await supabase.from("users").select("*").eq("id", req.params.id).single();
  if (error) return res.status(404).json({ error: "User not found" });
  res.json(data);
});

module.exports = router;
