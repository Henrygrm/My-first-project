import { json } from "../lib/http.js";
import { paymentsEnabled, handleWebhook } from "../lib/billing.js";

// POST /api/stripe-webhook – Stripe tells us about payments and subscription changes here.
export async function POST(request) {
  if (!paymentsEnabled()) return json({ error: "Payments aren't set up" }, 503);
  const signature = request.headers.get("stripe-signature");
  const rawBody = await request.text(); // signature check needs the exact bytes
  let type;
  try {
    type = await handleWebhook(rawBody, signature);
  } catch (err) {
    if (err?.type === "StripeSignatureVerificationError") return json({ error: "Invalid signature" }, 400);
    console.error("Webhook failed:", err);
    return json({ error: "Webhook handler failed" }, 500); // Stripe retries
  }
  return json({ received: true, type });
}
