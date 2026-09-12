const express = require("express");
const { supabase } = require("../config/supabase");
const escrow = require("../services/escrow");
const { authenticate, requireRole } = require("../middleware/auth");
const remita = require("../services/remita");
const flutterwave = require("../services/flutterwave");

const router = express.Router();

// POST /payments/collect/init — generate RRR, Requester pays on Remita's hosted page
router.post("/collect/init", authenticate, requireRole("requester"), async (req, res) => {
  const requesterId = req.user.id;
  const { errandId, amount, payerName, payerEmail, payerPhone } = req.body;
  if (!errandId || !amount) {
    return res.status(400).json({ error: "errandId and amount are required" });
  }

  try {
    const result = await escrow.initEscrowCollection({
      errandId,
      requesterId,
      amountPaid: amount,
      payerName,
      payerEmail,
      payerPhone,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /payments/collect/verify — poll Remita to confirm the RRR was paid; marks escrow held
router.post("/collect/verify", authenticate, requireRole("requester"), async (req, res) => {
  const { errandId } = req.body;
  if (!errandId) return res.status(400).json({ error: "errandId is required" });

  try {
    const result = await escrow.confirmEscrowPaid(errandId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /payments/webhook — Remita callback (confirm exact payload shape against
// your merchant dashboard's webhook config before relying on this in production)
router.post("/webhook", async (req, res) => {
  const { orderId } = req.body; // orderId was set to errandId at RRR init time
  if (!orderId) return res.status(400).json({ error: "Missing orderId in webhook payload" });

  try {
    await escrow.confirmEscrowPaid(orderId);
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /payments/release/:errandId — release Runner payout via Remita transfer
// TODO: this should eventually only be callable by the system itself
// (auto-triggered after delivery confirmation) or a Finance & Ops admin —
// authenticate() is the floor for now, not the final access model.
router.post("/release/:errandId", authenticate, async (req, res) => {
  try {
    const result = await escrow.releaseEscrow({ errandId: req.params.errandId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /payments/vendor/disburse — the four-option cascade for paying a vendor
router.post("/vendor/disburse", authenticate, requireRole("runner"), async (req, res) => {
  const runnerId = req.user.id;
  const { errandId, method, amount, vendorName, vendorAccountNumber, vendorBankCode, bankAppName, receiptPhotoUrl, purchaseLat, purchaseLng } = req.body;

  if (!errandId || !method || !amount) {
    return res.status(400).json({ error: "errandId, method, and amount are required" });
  }

  const disbursementRow = {
    errand_id: errandId,
    runner_id: runnerId,
    method,
    amount,
    vendor_name: vendorName,
    receipt_photo_url: receiptPhotoUrl || null,
    purchase_location: purchaseLat && purchaseLng ? `POINT(${purchaseLng} ${purchaseLat})` : null,
  };

  try {
    if (method === "virtual_card") {
      const card = await flutterwave.issueVirtualCard({ amount, cardholderName: vendorName || "Gracerandly Vendor" });
      if (card.status !== "success") return res.status(502).json({ error: "Flutterwave card issuance failed", detail: card });
      disbursementRow.virtual_card_ref = card.data?.id;
      disbursementRow.reconciled = true; // card spend is self-evidencing via the card transaction

    } else if (method === "bank_transfer_ussd") {
      if (!vendorAccountNumber || !vendorBankCode) {
        return res.status(400).json({ error: "vendorAccountNumber and vendorBankCode required for bank_transfer_ussd" });
      }
      const transferResult = await remita.transfer({
        requestId: `vendor-${errandId}-${Date.now()}`,
        beneficiaryAccount: vendorAccountNumber,
        beneficiaryName: vendorName,
        bankCode: vendorBankCode,
        amount,
        narration: `Gracerandly vendor payment, errand ${errandId}`,
      });
      disbursementRow.transfer_ref = transferResult.requestId || transferResult.responseCode || null;
      disbursementRow.reconciled = true;

    } else if (method === "manual_bank_app_redirect") {
      if (!receiptPhotoUrl) {
        return res.status(400).json({ error: "receiptPhotoUrl required — proof of manual transfer must be uploaded" });
      }
      disbursementRow.bank_app_name = bankAppName || null;
      disbursementRow.reconciled = true; // evidenced at submission, same trust bar as float

    } else if (method === "petty_cash_float") {
      if (!receiptPhotoUrl || !purchaseLat || !purchaseLng) {
        return res.status(400).json({ error: "receiptPhotoUrl and purchase location required for petty_cash_float" });
      }
      disbursementRow.reconciled = false; // float reconciliation is a separate confirm step (see PRD/addendum)

    } else {
      return res.status(400).json({ error: `Unknown method: ${method}` });
    }

    const { data, error } = await supabase.from("vendor_disbursements").insert(disbursementRow).select().single();
    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
