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

  async function call(method, path, body, requestId, extraHeaders = {}) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
        // Idempotency: a retried call with the same id will not create a second order or refund.
        "PayPal-Request-Id": requestId || randomUUID(),
        ...extraHeaders,
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

    // Asks PayPal to verify the signature of a webhook delivery. Needs the raw body and the id of
    // the webhook registered in the developer dashboard.
    async verifyWebhook({ headers, rawBody, webhookId }) {
      const event = JSON.parse(rawBody);
      const data = await call("POST", "/v1/notifications/verify-webhook-signature", {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      });
      return data.verification_status === "SUCCESS";
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

    // ---- Invoicing v2 (the photographer's invoice). Field names from PayPal's published Invoicing v2 OpenAPI spec.

    // Creates a draft invoice. `reference` is our job id: it is the idempotency key, so a retry never makes a second invoice.
    async createInvoice({ reference, currency, amount, itemName, itemDescription, note, recipient }) {
      const [givenName, ...rest] = String(recipient.name || "").trim().split(/\s+/);
      const data = await call(
        "POST",
        "/v2/invoicing/invoices",
        {
          detail: { currency_code: currency, reference, ...(note ? { note } : {}) },
          primary_recipients: [
            {
              billing_info: {
                email_address: recipient.email,
                ...(givenName ? { name: { given_name: givenName, ...(rest.length ? { surname: rest.join(" ") } : {}) } } : {}),
              },
            },
          ],
          items: [
            {
              name: String(itemName).slice(0, 200),
              ...(itemDescription ? { description: String(itemDescription).slice(0, 1000) } : {}),
              quantity: "1",
              unit_amount: { currency_code: currency, value: amount },
              unit_of_measure: "AMOUNT",
            },
          ],
        },
        `invoice-${reference}`,
        { Prefer: "return=representation" },
      );
      return normalizeInvoice(data);
    },

    // Sends the invoice to the client by email (PayPal's own email in the sandbox) and returns the payer link.
    async sendInvoice(invoiceId) {
      const link = await call(
        "POST",
        `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`,
        { send_to_invoicer: false, send_to_recipient: true },
        `send-${invoiceId}`,
      );
      const invoice = await this.getInvoice(invoiceId);
      return { ...invoice, payUrl: invoice.payUrl || link?.href || null };
    },

    async getInvoice(invoiceId) {
      return normalizeInvoice(await call("GET", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`));
    },
  };
}

// The few invoice fields this app relies on, read the same way for real and mock invoices.
export function normalizeInvoice(data = {}) {
  return {
    id: data.id,
    status: data.status,
    reference: data.detail?.reference,
    amount: data.amount?.value,
    currency: data.amount?.currency_code || data.detail?.currency_code,
    paidAmount: data.payments?.paid_amount?.value ?? null,
    payUrl: data.detail?.metadata?.recipient_view_url || null,
    // PayPal payments recorded against the invoice; their ids are what a refund needs.
    paymentIds: (data.payments?.transactions || []).filter((t) => (t.type || "PAYPAL") === "PAYPAL" && t.payment_id).map((t) => t.payment_id),
  };
}
