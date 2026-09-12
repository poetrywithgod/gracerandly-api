const { supabase } = require("../config/supabase");
const remita = require("./remita");

const COMMISSION_RATE = Number(process.env.PLATFORM_COMMISSION_RATE || 0.15);

/**
 * Step 1 of collection: generate a Remita RRR for a Requester's errand
 * payment and record a PENDING escrow row (not yet held — held_at stays
 * null until the payment is actually confirmed, see confirmEscrowPaid).
 */
async function initEscrowCollection({ errandId, requesterId, amountPaid, payerName, payerEmail, payerPhone }) {
  const commissionAmount = Number((amountPaid * COMMISSION_RATE).toFixed(2));
  const runnerPayoutAmount = Number((amountPaid - commissionAmount).toFixed(2));

  const rrrResponse = await remita.initCollection({
    orderId: errandId,
    amount: amountPaid,
    payerName,
    payerEmail,
    payerPhone,
    description: `Gracerandly errand ${errandId}`,
  });

  const { data, error } = await supabase
    .from("escrow_transactions")
    .insert({
      errand_id: errandId,
      requester_id: requesterId,
      amount_paid: amountPaid,
      commission_rate: COMMISSION_RATE,
      commission_amount: commissionAmount,
      runner_payout_amount: runnerPayoutAmount,
      payment_gateway_ref: rrrResponse.RRR || null,
    })
    .select()
    .single();

  if (error) throw error;
  return { escrow: data, rrr: rrrResponse };
}

/**
 * Step 2 of collection: verify the RRR was actually paid (poll, or call
 * this from a webhook handler) and mark the escrow as held. This is the
 * moment funds are genuinely considered "in escrow."
 */
async function confirmEscrowPaid(errandId) {
  const { data: escrow, error: fetchErr } = await supabase
    .from("escrow_transactions")
    .select("*")
    .eq("errand_id", errandId)
    .single();
  if (fetchErr) throw fetchErr;
  if (!escrow.payment_gateway_ref) throw new Error("No RRR recorded for this escrow — call initEscrowCollection first");

  const verification = await remita.verifyCollection(escrow.payment_gateway_ref);
  if (!verification.paid) return { held: false, verification };

  const { data, error } = await supabase
    .from("escrow_transactions")
    .update({ held_at: new Date().toISOString() })
    .eq("errand_id", errandId)
    .select()
    .single();
  if (error) throw error;

  return { held: true, escrow: data, verification };
}

/**
 * Releases the Runner's payout — actually transfers funds via Remita to
 * the Runner's registered bank account, then marks escrow released. Only
 * call this after BOTH the geofence-gated delivery confirmation AND the
 * PIN/photo confirmation have succeeded (PRD §6.7).
 */
async function releaseEscrow({ errandId }) {
  const { data: escrow, error: fetchErr } = await supabase
    .from("escrow_transactions")
    .select("*")
    .eq("errand_id", errandId)
    .single();
  if (fetchErr) throw fetchErr;
  if (!escrow.held_at) throw new Error("Escrow was never confirmed as held — cannot release");
  if (escrow.released_at) throw new Error("Escrow already released for this errand");

  const { data: errand, error: errandErr } = await supabase
    .from("errands")
    .select("runner_id")
    .eq("id", errandId)
    .single();
  if (errandErr) throw errandErr;

  const { data: runnerProfile, error: runnerErr } = await supabase
    .from("runner_profiles")
    .select("bank_account_number, bank_code, bank_account_name")
    .eq("user_id", errand.runner_id)
    .single();
  if (runnerErr) throw runnerErr;
  if (!runnerProfile.bank_account_number || !runnerProfile.bank_code) {
    throw new Error("Runner has no payout bank account on file — cannot release funds");
  }

  const transferResult = await remita.transfer({
    requestId: `payout-${errandId}`,
    beneficiaryAccount: runnerProfile.bank_account_number,
    beneficiaryName: runnerProfile.bank_account_name,
    bankCode: runnerProfile.bank_code,
    amount: escrow.runner_payout_amount,
    narration: `Gracerandly payout for errand ${errandId}`,
  });

  const { data, error } = await supabase
    .from("escrow_transactions")
    .update({ released_at: new Date().toISOString() })
    .eq("errand_id", errandId)
    .select()
    .single();
  if (error) throw error;

  await supabase.from("analytics_events").insert({
    event_name: "payout_released",
    errand_id: errandId,
    metadata: { amount: escrow.runner_payout_amount, transferResult },
  });

  return { escrow: data, transferResult };
}

module.exports = { initEscrowCollection, confirmEscrowPaid, releaseEscrow, COMMISSION_RATE };
