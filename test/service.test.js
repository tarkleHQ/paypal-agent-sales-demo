import test from "node:test";
import assert from "node:assert/strict";
import { createService, toCents } from "../src/service.js";
import { createMockPayPal } from "../src/mock-paypal.js";
import { createPayPalClient } from "../src/paypal.js";

function setup() {
  const clock = { t: 1_000_000 };
  const paypal = createMockPayPal({ baseUrl: "http://x" });
  const service = createService({ paypal, baseUrl: "http://x", now: () => clock.t });
  return { paypal, service, clock };
}

// Starts checkout and plays the buyer approving on PayPal.
async function startAndApprove(ctx, productId) {
  const { orderId, approveUrl } = await ctx.service.startCheckout(productId);
  const token = new URL(approveUrl).searchParams.get("token");
  ctx.paypal.approve(token);
  return { orderId, token };
}

test("price parsing", () => {
  assert.equal(toCents(19.99), 1999);
  assert.throws(() => toCents(0));
  assert.throws(() => toCents(1.005));
  assert.throws(() => toCents(20000));
});

test("file stays locked until PayPal capture completes", async () => {
  const ctx = setup();
  const { productId } = ctx.service.createPaidShare({ title: "Kit", fileName: "kit.txt", content: "secret", price: 20 });
  const { orderId, token } = await startAndApprove(ctx, productId);
  const view = ctx.service.orderView(orderId);
  assert.equal(view.status, "pending");
  assert.equal(ctx.service.download(orderId, "anything"), null);

  const paid = await ctx.service.completeCheckout(token);
  assert.equal(paid.status, "paid");
  assert.equal(ctx.service.download(orderId, "wrong-key"), null);
  assert.equal(ctx.service.download(orderId, paid.accessKey).content, "secret");
});

test("returning without approving does not unlock anything", async () => {
  const ctx = setup();
  const { productId } = ctx.service.createPaidShare({ title: "Kit", fileName: "kit.txt", price: 5 });
  const { approveUrl, orderId } = await ctx.service.startCheckout(productId);
  const token = new URL(approveUrl).searchParams.get("token");
  await assert.rejects(ctx.service.completeCheckout(token));
  assert.notEqual(ctx.service.orderView(orderId).status, "paid");
});

test("completing twice is idempotent", async () => {
  const ctx = setup();
  const { productId } = ctx.service.createPaidShare({ title: "Kit", fileName: "kit.txt", price: 5 });
  const { token } = await startAndApprove(ctx, productId);
  const a = await ctx.service.completeCheckout(token);
  const b = await ctx.service.completeCheckout(token);
  assert.equal(a.accessKey, b.accessKey);
  assert.equal(ctx.service.salesStatus()[0].paid, 1);
});

test("refund revokes access and cannot repeat", async () => {
  const ctx = setup();
  const { productId } = ctx.service.createPaidShare({ title: "Kit", fileName: "kit.txt", content: "x", price: 20 });
  const { token, orderId } = await startAndApprove(ctx, productId);
  const { accessKey } = await ctx.service.completeCheckout(token);
  await ctx.service.refund(orderId);
  assert.equal(ctx.service.download(orderId, accessKey), null);
  await assert.rejects(ctx.service.refund(orderId));
  assert.equal(ctx.service.salesStatus()[0].revenue, "0.00");
});

test("tickets: seats are held, sold out blocks checkout, refund frees the seat", async () => {
  const ctx = setup();
  const { productId } = ctx.service.createEvent({ title: "Party", startsAt: "2026-12-01T18:00:00Z", capacity: 1, price: 15 });
  const first = await startAndApprove(ctx, productId);
  assert.equal(ctx.service.publicProduct(productId).seatsLeft, 0); // held, not yet paid
  await assert.rejects(ctx.service.startCheckout(productId), /Sold out/);

  await ctx.service.completeCheckout(first.token);
  await assert.rejects(ctx.service.startCheckout(productId), /Sold out/);

  await ctx.service.refund(first.orderId);
  assert.equal(ctx.service.publicProduct(productId).seatsLeft, 1);
  await ctx.service.startCheckout(productId);
});

test("an expired hold releases the seat, and a late payer is not charged when it sold out", async () => {
  const ctx = setup();
  const { productId } = ctx.service.createEvent({ title: "Party", startsAt: "2026-12-01T18:00:00Z", capacity: 1, price: 15 });
  const slow = await startAndApprove(ctx, productId);
  ctx.clock.t += 11 * 60 * 1000;
  assert.equal(ctx.service.publicProduct(productId).seatsLeft, 1);

  const fast = await startAndApprove(ctx, productId);
  await ctx.service.completeCheckout(fast.token);
  await assert.rejects(ctx.service.completeCheckout(slow.token), /sold out/);
  assert.equal(ctx.service.salesStatus()[0].paid, 1);
});

test("a capture for the wrong amount is not accepted", async () => {
  const ctx = setup();
  const { productId } = ctx.service.createPaidShare({ title: "Kit", fileName: "k.txt", price: 20 });
  const { orderId, token } = await startAndApprove(ctx, productId);
  const real = ctx.paypal.captureOrder.bind(ctx.paypal);
  ctx.paypal.captureOrder = async (id) => ({ ...(await real(id)), amount: "1.00" });
  await assert.rejects(ctx.service.completeCheckout(token), /does not match/);
  assert.equal(ctx.service.orderView(orderId).status, "failed");
});

test("real client refuses anything but the sandbox", () => {
  assert.throws(() => createPayPalClient({ clientId: "a", secret: "b", baseUrl: "https://api-m.paypal.com" }), /sandbox/);
});

test("real client sends the expected Orders v2 calls", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "T", expires_in: 3600 });
    if (url.endsWith("/v2/checkout/orders")) return Response.json({ id: "O1", links: [{ rel: "payer-action", href: "https://sandbox.paypal.com/approve" }] });
    return Response.json({ purchase_units: [{ payments: { captures: [{ id: "C1", status: "COMPLETED", amount: { value: "20.00", currency_code: "USD" } }] } }] });
  };
  const client = createPayPalClient({ clientId: "id", secret: "s", fetchImpl });
  const order = await client.createOrder({ amount: "20.00", currency: "USD", description: "d", referenceId: "r1", returnUrl: "http://r", cancelUrl: "http://c" });
  assert.equal(order.approveUrl, "https://sandbox.paypal.com/approve");
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.intent, "CAPTURE");
  assert.equal(body.purchase_units[0].amount.value, "20.00");
  assert.equal(calls[1].init.headers["PayPal-Request-Id"], "r1");
  const cap = await client.captureOrder("O1");
  assert.deepEqual(cap, { status: "COMPLETED", captureId: "C1", amount: "20.00", currency: "USD" });
});
