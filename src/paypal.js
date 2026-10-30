// Minimal PayPal Orders v2 client. Sandbox only: it refuses any other base URL.
import { randomUUID } from "node:crypto";

export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(message, status, debugId) {
    super(message);
    this.name = "PayPalError";
    this.status = status;
    this.debugId = debugId;
  }
}

export function createPayPalClient({ clientId, secret, baseUrl = SANDBOX_BASE, fetchImpl = fetch }) {
  if (!baseUrl.includes("sandbox")) {
    throw new Error("This demo only talks to the PayPal sandbox.");
  }
  if (!clientId || !secret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required.");

  let token = null;
  let tokenExpiresAt = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExpiresAt - 30_000) return token;
    const res = await fetchImpl(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(data.error_description || "PayPal auth failed", res.status);
    token = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return token;
  }

  async function call(method, path, body, requestId) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
        // Idempotency: a retried call with the same id will not create a second order or refund.
        "PayPal-Request-Id": requestId || randomUUID(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new PayPalError(data.message || data.name || `PayPal request failed (${res.status})`, res.status, data.debug_id);
    }
    return data;
  }

  return {
    mock: false,

    async createOrder({ amount, currency, description, referenceId, returnUrl, cancelUrl }) {
      const data = await call(
        "POST",
        "/v2/checkout/orders",
        {
          intent: "CAPTURE",
          purchase_units: [
            { reference_id: referenceId, description, amount: { currency_code: currency, value: amount } },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                return_url: returnUrl,
                cancel_url: cancelUrl,
                user_action: "PAY_NOW",
                shipping_preference: "NO_SHIPPING",
              },
            },
          },
        },
        referenceId,
      );
      const link = data.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
      if (!link) throw new PayPalError("PayPal returned no approval link", 502);
      return { id: data.id, approveUrl: link.href };
    },

    async captureOrder(orderId) {
      const data = await call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, undefined, `capture-${orderId}`);
      const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
      return {
        status: capture?.status === "COMPLETED" ? "COMPLETED" : capture?.status || data.status,
        captureId: capture?.id,
        amount: capture?.amount?.value,
        currency: capture?.amount?.currency_code,
      };
    },

    async refundCapture(captureId, { amount, currency }) {
      const data = await call(
        "POST",
        `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
        { amount: { value: amount, currency_code: currency } },
        `refund-${captureId}`,
      );
      return { id: data.id, status: data.status };
    },
  };
}
