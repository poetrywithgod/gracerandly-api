const { supabase } = require("../config/supabase");

/**
 * Records an admin action to the immutable audit trail (PRD §5 — "All
 * admin actions are recorded in an immutable audit trail (who, what,
 * when)"). This is append-only at the application layer — nothing in
 * this codebase ever updates or deletes an audit_log row.
 *
 * NOTE: true immutability also needs a DB-level grant restriction (the
 * app currently connects via the Supabase service_role key, which can
 * technically update/delete anything). Enforcing that fully means giving
 * the API a lower-privilege Postgres role for its day-to-day connection —
 * a real follow-up, not done here, flagging so it isn't quietly assumed
 * to be airtight.
 */
async function logAdminAction({ actorId, action, targetTable, targetId, metadata }) {
  const { error } = await supabase.from("audit_log").insert({
    actor_id: actorId,
    action,
    target_table: targetTable || null,
    target_id: targetId || null,
    metadata: metadata || {},
  });
  if (error) console.error("Failed to write audit log entry:", error.message);
}

module.exports = { logAdminAction };
