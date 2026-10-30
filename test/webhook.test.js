import test from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "../src/bootstrap.js";

async function withApp(port, fn) {
  const app = bootstrap({ PORT: String(port) });
  await new Promise((r) => app.web.listen(app.port, r));
  try {
    await fn(app);
  } finally {
    app.web.close();
  }
}

const deliver = (app, event, signature = "valid") =>
  fetch(`${app.baseUrl}/paypal/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature ? { "x-mock-signature": signature } : {}) },
    body: JSON.stringify(event),
  });

// Buyer approves on PayPal, then closes the tab: nothing hits our return URL.
async function approvedButNotReturned(app, { kind = "file", capacity = 1 } = {}) {
  const { productId } =
    kind === "file"
      ? app.service.createPaidShare({ title: "Kit", fileName: "k.txt", content: "secret", price: 20 })
      : app.service.createEvent({ title: "Party", startsAt: "2026-12-01T18:00:00Z", capacity, price: 15 });
  const { orderId, approveUrl } = await app.service.startCheckout(productId);
  const token = new URL(approveUrl).searchParams.get("token");
  app.paypal.approve(token);
  return { productId, orderId, token };
}

test("webhook: bad or missing signature is rejected and changes nothing", async () => {
  await withApp(3180, async (app) => {
    const { orderId, token } = await approvedButNotReturned(app);
    const event = { id: "WH-1", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: token } };
    assert.equal((await deliver(app, event, "forged")).status, 400);
    assert.equal((await deliver(app, event, null)).status, 400);
    assert.equal(app.service.orderView(orderId).status, "pending");
  });
});

test("webhook: an approved order is captured even if the buyer never returned", async () => {
  await withApp(3181, async (app) => {
    const { orderId, token } = await approvedButNotReturned(app);
    const res = await deliver(app, { id: "WH-2", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: token } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { handled: true, orderId, status: "paid" });
    assert.equal(app.service.orderView(orderId).status, "paid");
  });
});

test("webhook: a duplicate delivery is ignored", async () => {
  await withApp(3182, async (app) => {
    const { token } = await approvedButNotReturned(app);
    const event = { id: "WH-3", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: token } };
    await deliver(app, event);
    const again = await (await deliver(app, event)).json();
    assert.deepEqual(again, { handled: false, reason: "duplicate" });
    assert.equal(app.service.salesStatus()[0].paid, 1);
  });
});

test("webhook: an approval whose seat hold is still valid is captured", async () => {
  await withApp(3183, async (app) => {
    const slow = await approvedButNotReturned(app, { kind: "ticket" });
    assert.equal(app.service.salesStatus()[0].seatsLeft, 0); // held for this buyer
    const res = await deliver(app, { id: "WH-4", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: slow.token } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "paid");
  });
});

test("webhook: refund or reversal made outside the app revokes access", async () => {
  await withApp(3184, async (app) => {
    const { productId, orderId, token } = await approvedButNotReturned(app);
    const paid = await app.service.completeCheckout(token);
    assert.ok(app.service.download(orderId, paid.accessKey));
    const captureId = `MOCKCAPTURE${token}`;
    const res = await deliver(app, { id: "WH-5", event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: captureId } });
    assert.equal((await res.json()).status, "refunded");
    assert.equal(app.service.download(orderId, paid.accessKey), null);
    assert.equal(app.service.salesStatus().find((p) => p.productId === productId).revenue, "0.00");
  });
});

test("webhook: our own refund echoing back is harmless", async () => {
  await withApp(3185, async (app) => {
    const { orderId, token } = await approvedButNotReturned(app);
    await app.service.completeCheckout(token);
    await app.service.refund(orderId);
    const res = await deliver(app, {
      id: "WH-6",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: { id: "REF1", links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/MOCKCAPTURE${token}` }] },
    });
    assert.equal(res.status, 200);
    assert.equal(app.service.orderView(orderId).status, "refunded");
  });
});

test("webhook: capture completed with the wrong amount flags the order", async () => {
  await withApp(3186, async (app) => {
    const { orderId, token } = await approvedButNotReturned(app);
    await deliver(app, {
      id: "WH-7",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "CAP9", amount: { value: "1.00", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: token } } },
    });
    assert.equal(app.service.orderView(orderId).status, "failed");
  });
});

test("webhook: real mode without a webhook id has no endpoint", async () => {
  const app = bootstrap({ PORT: "3187", PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" });
  await new Promise((r) => app.web.listen(app.port, r));
  try {
    assert.equal((await fetch(`${app.baseUrl}/paypal/webhook`, { method: "POST", body: "{}" })).status, 404);
  } finally {
    app.web.close();
  }
});

test("real client posts the documented verify-webhook-signature body", async () => {
  const { createPayPalClient } = await import("../src/paypal.js");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "T", expires_in: 3600 });
    return Response.json({ verification_status: "SUCCESS" });
  };
  const client = createPayPalClient({ clientId: "id", secret: "s", fetchImpl });
  const ok = await client.verifyWebhook({
    headers: {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
      "paypal-transmission-id": "tid",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": "2026-10-30T00:00:00Z",
    },
    rawBody: JSON.stringify({ id: "WH-1" }),
    webhookId: "WEBHOOK123",
  });
  assert.equal(ok, true);
  assert.ok(calls[1].url.endsWith("/v1/notifications/verify-webhook-signature"));
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.webhook_id, "WEBHOOK123");
  assert.equal(body.transmission_sig, "sig");
  assert.deepEqual(body.webhook_event, { id: "WH-1" });
});
