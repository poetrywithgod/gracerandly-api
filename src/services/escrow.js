const { supabase } = require("../config/supabase");

const COMMISSION_RATE = Number(process.env.PLATFORM_COMMISSION_RATE || 0.15);

/**
 * Holds a Requester's payment in escrow at errand confirmation.
 * Runner payout is computed now but NOT released until delivery is
 * confirmed (PRD §6.7 — "funds are held in escrow... Runner's share
 * settles... only after delivery is confirmed").
 */
async function holdInEscrow({ errandId, requesterId, amountPaid, paymentGatewayRef }) {
  const commissionAmount = Number((amountPaid * COMMISSION_RATE).toFixed(2));
  const runnerPayoutAmount = Number((amountPaid - commissionAmount).toFixed(2));

  const { data, error } = await supabase
    .from("escrow_transactions")
    .insert({
      errand_id: errandId,
      requester_id: requesterId,
      amount_paid: amountPaid,
      commission_rate: COMMISSION_RATE,
      commission_amount: commissionAmount,
      runner_payout_amount: runnerPayoutAmount,
      payment_gateway_ref: paymentGatewayRef,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Releases the Runner's payout from escrow. Only call this after BOTH
 * the geofence-gated delivery confirmation AND the PIN/photo confirmation
 * have succeeded (PRD §6.7).
 */
async function releaseEscrow({ errandId }) {
  const { data, error } = await supabase
    .from("escrow_transactions")
    .update({ released_at: new Date().toISOString() })
    .eq("errand_id", errandId)
    .is("released_at", null)
    .select()
    .single();

  if (error || !data) throw new Error("Escrow already released or not found for this errand");

  // TODO: trigger actual Paystack/Flutterwave transfer to Runner's bank account here

  await supabase.from("analytics_events").insert({
    event_name: "payout_released",
    errand_id: errandId,
    metadata: { amount: data.runner_payout_amount },
  });

  return data;
}

module.exports = { holdInEscrow, releaseEscrow, COMMISSION_RATE };
