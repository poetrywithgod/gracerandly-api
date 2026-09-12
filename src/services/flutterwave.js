const BASE_URL = "https://api.flutterwave.com/v3";
const SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY;

/*
 * Virtual card issuance ONLY — Flutterwave handles this leg exclusively;
 * collections and all transfers/payouts go through Remita (services/remita.js).
 *
 * CONFIRM against Flutterwave's current Issuing docs before going live —
 * this is a newer product on their side (they only secured the Nigerian
 * card-issuing banking license recently), so field names below are the
 * documented pattern as of this build but worth a sandbox smoke-test
 * before relying on it for a real vendor payment.
 */

async function issueVirtualCard({ amount, currency = "NGN", cardholderName, debitCurrency = "NGN" }) {
  const res = await fetch(`${BASE_URL}/virtual-cards`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      currency,
      amount,
      billing_name: cardholderName,
      debit_currency: debitCurrency,
    }),
  });

  const data = await res.json();
  // Expected shape: { status: "success", data: { id, card_pan, cvv, expiration, ... } }
  return data;
}

async function terminateVirtualCard(cardId) {
  const res = await fetch(`${BASE_URL}/virtual-cards/${cardId}/terminate`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${SECRET_KEY}` },
  });
  return res.json();
}

module.exports = { issueVirtualCard, terminateVirtualCard };
