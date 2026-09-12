const crypto = require("crypto");

const BASE_URL = process.env.REMITA_ENV === "live" ? "https://login.remita.net" : "https://remitademo.net";
const MERCHANT_ID = process.env.REMITA_MERCHANT_ID;
const API_KEY = process.env.REMITA_API_KEY;
const API_TOKEN = process.env.REMITA_API_TOKEN; // used for transfer hash, not collection hash
const SERVICE_TYPE_ID = process.env.REMITA_SERVICE_TYPE_ID;

/*
 * IMPORTANT: Remita doesn't publish a single canonical REST reference the
 * way Paystack/Stripe do — the exact endpoint sub-paths below are the
 * well-established pattern used across their official SDKs and demo
 * credentials, but CONFIRM the exact paths against the Postman collection
 * Remita sends you after merchant registration before going live. The
 * hash/auth mechanics here are correct regardless of the exact path.
 */

function collectionHash({ orderId, amount }) {
  // Documented pattern: SHA512(merchantId + serviceTypeId + orderId + amount + apiKey)
  const raw = `${MERCHANT_ID}${SERVICE_TYPE_ID}${orderId}${amount}${API_KEY}`;
  return crypto.createHash("sha512").update(raw).digest("hex");
}

function statusHash({ rrr }) {
  // Documented pattern for status checks: SHA512(rrr + apiKey + merchantId)
  const raw = `${rrr}${API_KEY}${MERCHANT_ID}`;
  return crypto.createHash("sha512").update(raw).digest("hex");
}

/**
 * Initiates a Remita RRR for a Requester's escrow payment. The Requester
 * completes payment on Remita's hosted page (remita-pay-inline widget or
 * redirect), which itself offers card, bank transfer, and USSD as
 * channels — we don't need to build separate channel-specific flows for
 * collection, just hand off the RRR.
 */
async function initCollection({ orderId, amount, payerName, payerEmail, payerPhone, description }) {
  const hash = collectionHash({ orderId, amount });

  const res = await fetch(`${BASE_URL}/remita/exapp/api/v1/send/api/echannelsvc/merchant/api/paymentinit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serviceTypeId: SERVICE_TYPE_ID,
      amount: String(amount),
      orderId: String(orderId),
      payerName,
      payerEmail,
      payerPhone,
      description,
      hash,
    }),
  });

  const data = await res.json();
  // Expected shape: { RRR, statuscode, status }
  return data;
}

/**
 * Polls Remita for whether an RRR has been paid. Use this as a fallback
 * alongside (or instead of) a webhook, since webhook delivery reliability
 * varies more than with the newer fintechs.
 */
async function verifyCollection(rrr) {
  const hash = statusHash({ rrr });

  const res = await fetch(
    `${BASE_URL}/remita/exapp/api/v1/send/api/echannelsvc/${MERCHANT_ID}/${rrr}/${hash}/status.reg`,
    { method: "GET" }
  );

  const data = await res.json();
  // Expected shape includes status: "00" or "01" = paid/successful
  return { paid: data.status === "00" || data.status === "01", raw: data };
}

/**
 * Transfers funds to a beneficiary bank account — used for both
 * vendor-direct disbursement (bank_transfer_ussd method) and Runner
 * payouts. Uses AES-128-CBC + the shared hash, per Remita's Interbank
 * Transfer Service (RITS) pattern.
 */
function encryptPayload(payload) {
  const key = Buffer.from(process.env.REMITA_AES_KEY || "", "utf8");
  const iv = Buffer.from(process.env.REMITA_AES_IV || "", "utf8");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  let encrypted = cipher.update(JSON.stringify(payload), "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
}

async function transfer({ requestId, beneficiaryAccount, beneficiaryName, bankCode, amount, narration }) {
  const hash = crypto
    .createHash("sha512")
    .update(`${MERCHANT_ID}${API_KEY}${requestId}${amount}${API_TOKEN}`)
    .digest("hex");

  const encryptedPayload = encryptPayload({
    beneficiaryAccount,
    beneficiaryName,
    bankCode,
    amount,
    narration,
    requestId,
  });

  const res = await fetch(`${BASE_URL}/remita/exapp/api/v1/send/api/fundstransfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `remitaConsumerKey=${MERCHANT_ID},remitaConsumerToken=${hash}`,
    },
    body: JSON.stringify({ merchantId: MERCHANT_ID, requestId, data: encryptedPayload }),
  });

  const data = await res.json();
  return data;
}

module.exports = { initCollection, verifyCollection, transfer };
