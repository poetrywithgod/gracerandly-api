const express = require("express");
const bcrypt = require("bcryptjs");
const { supabase } = require("../config/supabase");
const { authenticate, signToken } = require("../middleware/auth");

const router = express.Router();

// POST /auth/signup/requester (PRD §6.1)
router.post("/signup/requester", async (req, res) => {
  const { fullName, phone, email, password } = req.body;
  if (!fullName || !phone || !password) {
    return res.status(400).json({ error: "fullName, phone, and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from("users")
    .insert({ role: "requester", full_name: fullName, phone, email, password_hash: passwordHash })
    .select("id, role, full_name, phone, email, created_at")
    .single();

  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Phone number already registered" });
    return res.status(500).json({ error: error.message });
  }

  await supabase.from("analytics_events").insert({ user_id: data.id, event_name: "signup" });

  const token = signToken({ id: data.id, role: data.role });
  res.status(201).json({ user: data, token });
});

// POST /auth/signup/runner (PRD §6.1, §6.8 — NIN/BVN + guarantor, starts probationary)
router.post("/signup/runner", async (req, res) => {
  const { fullName, phone, email, password, guarantorName, guarantorPhone, guarantorRelationship } = req.body;

  if (!fullName || !phone || !password || !guarantorName || !guarantorPhone) {
    return res.status(400).json({ error: "fullName, phone, password, guarantorName, and guarantorPhone are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const { data: user, error: userErr } = await supabase
    .from("users")
    .insert({ role: "runner", full_name: fullName, phone, email, password_hash: passwordHash })
    .select("id, role, full_name, phone, email, created_at")
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

  const token = signToken({ id: user.id, role: user.role });
  res.status(201).json({ user, profile, token });
});

// POST /auth/login — phone + password, works for any role
router.post("/login", async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: "phone and password are required" });

  const { data: user, error } = await supabase.from("users").select("*").eq("phone", phone).single();
  if (error || !user || !user.password_hash) {
    return res.status(401).json({ error: "Invalid phone or password" });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Invalid phone or password" });

  const token = signToken({ id: user.id, role: user.role });
  const { password_hash, ...safeUser } = user;
  res.json({ user: safeUser, token });
});

// GET /auth/me — confirms who the current token belongs to
router.get("/me", authenticate, async (req, res) => {
  const { data, error } = await supabase
    .from("users")
    .select("id, role, full_name, phone, email, created_at")
    .eq("id", req.user.id)
    .single();
  if (error) return res.status(404).json({ error: "User not found" });
  res.json(data);
});

module.exports = router;
