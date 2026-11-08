import test from "node:test";
import assert from "node:assert/strict";
import { createMockPayPal } from "../src/mock-paypal.js";
import { createJobService } from "../src/jobs.js";
import { createMockStore } from "../src/stores.js";
import { createTarkleStore } from "../src/tarkle-store.js";
import { bootstrap } from "../src/bootstrap.js";
import { homePage } from "../src/home.js";

// Tarkle stand-in that only records transfer view_only changes (enough for a restart test).
function tinyTarkle() {
  const transfers = new Map();
  let seq = 1;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const handle = async (url, init = {}) => {
    const u = new URL(url);
    const m = (init.method || "GET").toUpperCase();
    const path = u.pathname.replace("/api/v1", "");
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    if (u.host === "storage.test") return new Response("", { status: 200 });
    if (m === "GET" && path === "/contacts") return json(200, { contacts: [] });
    if (m === "POST" && path === "/contacts") return json(201, { contactId: "00000000-0000-4000-8000-000000000001", email: body.email });
    if (m === "POST" && path === "/folders") return json(201, { id: "f0000000-0000-4000-8000-000000000001" });
    if (m === "POST" && path === "/uploads") return json(201, { action: "upload", id: `u${seq++}`, uploads: [{ url: "https://storage.test/x" }] });
    if (m === "POST" && /\/complete$/.test(path)) return json(200, { id: String(seq++) });
    if (m === "POST" && path === "/transfers") {
      transfers.set("77", { view_only: body.view_only });
      return json(201, { id: "77" });
    }
    if (m === "PATCH" && path === "/transfers/77") {
      transfers.get("77").view_only = body.view_only;
      return json(200, { id: "77" });
    }
    return json(200, {});
  };
  return { handle, transfers };
}

const wedding = { title: "Smith wedding", clientName: "Ana Smith", clientEmail: "ana@example.com", price: 1500, files: [{ name: "a.jpg", content: "x" }] };

test("after a restart, a paid webhook rebuilds the job from its PayPal invoice, unlocks it in Tarkle and notifies once", async () => {
  const paypal = createMockPayPal();
  const tarkle = tinyTarkle();
  const storeOf = () => createTarkleStore({ apiBase: "https://tarkle.test/api/v1", apiKey: "tk", workspaceKey: "abcd1234", fetchImpl: tarkle.handle });

  const before = createJobService({ paypal, store: storeOf() });
  const job = await before.createJob(wedding);
  const sent = await before.sendInvoice(job.jobId);
  const memo = (await paypal.getInvoice(sent.invoiceId)).memo;
  assert.match(memo, /^tarkle-demo:v1 \{/);
  assert.ok(memo.length <= 500, "fits PayPal's 500-character memo");
  assert.equal(tarkle.transfers.get("77").view_only, true);

  // The instance sleeps; memory is gone. The client pays; PayPal's webhook wakes a fresh instance.
  paypal.payInvoice(sent.invoiceId);
  const sentEvents = [];
  const after = createJobService({ paypal, store: storeOf(), notify: async (type) => sentEvents.push(type) });
  const res = await after.handleWebhookEvent({ id: "WH-R1", event_type: "INVOICING.INVOICE.PAID", resource: { id: sent.invoiceId } });
  assert.deepEqual(res, { handled: true, jobId: job.jobId, status: "delivered" });
  assert.equal(tarkle.transfers.get("77").view_only, false);
  assert.deepEqual(sentEvents, ["job.paid", "job.delivered"]);
  const rebuilt = after.getJob(job.jobId);
  assert.equal(rebuilt.client.email, "ana@example.com");
  assert.equal(rebuilt.price, "1500.00");
  assert.equal(rebuilt.title, "Smith wedding");
});

test("after a restart, the assistant still finds, lists and refunds jobs", async () => {
  const paypal = createMockPayPal();
  const tarkle = tinyTarkle();
  const storeOf = () => createTarkleStore({ apiBase: "https://tarkle.test/api/v1", apiKey: "tk", workspaceKey: "abcd1234", fetchImpl: tarkle.handle });
  const before = createJobService({ paypal, store: storeOf() });
  const job = await before.createJob(wedding);
  const sent = await before.sendInvoice(job.jobId);
  paypal.payInvoice(sent.invoiceId);
  await before.refreshJob(job.jobId);

  const after = createJobService({ paypal, store: storeOf() });
  const list = await after.listAllJobs();
  assert.deepEqual(list.map((j) => [j.jobId, j.status]), [[job.jobId, "delivered"]]);
  assert.equal((await after.refundJob(job.jobId)).status, "refunded");
  assert.equal(tarkle.transfers.get("77").view_only, true);
});

test("a draft invoice or someone else's invoice is never turned into a job", async () => {
  const paypal = createMockPayPal();
  await paypal.createInvoice({ reference: "not-a-job", currency: "USD", amount: "5.00", memo: "tarkle-demo:v1 {}", recipient: { email: "x@example.com" } });
  const other = await paypal.createInvoice({ reference: "job_0123456789", currency: "USD", amount: "5.00", memo: "my own note", recipient: { email: "y@example.com" } });
  await paypal.sendInvoice(other.id);
  const jobs = createJobService({ paypal, store: createMockStore({ baseUrl: "http://x" }) });
  assert.deepEqual(await jobs.listAllJobs(), []);
});

test("the home page names the studio, links the client portal, and ends with the Tarkle footer", async () => {
  const html = homePage({ studioName: "DUC Agency", portalUrl: "https://deesigner.tarklesend.com/portal", year: 2026 });
  assert.match(html, /<title>DUC Agency · Client galleries<\/title>/);
  assert.match(html, /<span class="soft">DUC Agency\.<\/span> Your photos, delivered the moment you pay/);
  assert.equal(html.match(/href="https:\/\/deesigner\.tarklesend\.com\/portal"/g).length, 2, "nav and hero both link the portal");
  assert.match(html, /A demo for DUC Agency, built on Tarkle and the PayPal sandbox/);
  assert.match(html, /<footer>© 2026 Tarkle<\/footer>/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(homePage({ studioName: "<b>x</b>" }), /<b>x<\/b>/, "the name is escaped");
  assert.doesNotMatch(homePage({ portalUrl: null }), /Client portal login/, "no portal link without a portal");

  const app = bootstrap({ PORT: "3420", TARKLE_PORTAL_URL: "https://deesigner.tarklesend.com/portal" });
  await new Promise((r) => app.web.listen(app.port, r));
  try {
    const res = await fetch(`${app.baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Client portal login/);
  } finally {
    app.web.close();
  }
});
