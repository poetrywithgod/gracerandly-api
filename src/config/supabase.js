const { createClient } = require("@supabase/supabase-js");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  // Fail loudly at boot rather than silently later — this is a common
  // silent-timeline-killer during setup.
  console.error(
    "Missing SUPABASE_URL / SUPABASE_SERVICE_KEY. Copy .env.example to .env and fill in your project's values."
  );
}

// service_role key — this client runs ONLY on the server (this API layer).
// Mobile/web clients never talk to Supabase directly (System Architecture §2).
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

module.exports = { supabase };
