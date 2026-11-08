import test from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "../src/bootstrap.js";
import { createMcpHandler } from "../src/mcp.js";
import { createPayPalClient } from "../src/paypal.js";

let nextPort = 3260;
async function withApp(fn, env = {}, opts = {}) {
  const app = bootstrap({ PORT: String(nextPort++), ...env }, opts);
  await new Promise((r) => app.web.listen(app.port, r));
  try {
    await fn(app);
  } finally {
    app.web.close();
  }
}

const wedding = { title: "Smith wedding, full gallery", clientName: "Ana Smith", clientEmail: "ana@example.com", price: 1500, files: [{ name: "001.jpg", content: "photo-1" }, { name: "002.jpg", content: "photo-2" }] };

const deliver = (app, event, signature = "valid") =>
  fetch(`${app.baseUrl}/paypal/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature ? { "x-mock-signature": signature } : {}) },
    body: JSON.stringify(event),
  });

async function invoicedJob(app) {
  const job = await app.jobs.createJob(wedding);
  return app.jobs.sendInvoice(job.jobId);
}

const keyOf = (app, jobId) => app.jobs.accessKeyFor(jobId);
const fileStatus = (app, jobId, i = 0) => fetch(`${app.baseUrl}/client/${jobId}/file/${i}?key=${keyOf(app, jobId)}`).then((r) => r.status);

test("a job starts locked, the invoice is sent, and nothing unlocks before payment", async () => {
  await withApp(async (app) => {
    const job = await app.jobs.createJob(wedding);
    assert.equal(job.status, "draft");
    assert.equal(await fileStatus(app, job.jobId), 403);
    const sent = await app.jobs.sendInvoice(job.jobId);
    assert.equal(sent.status, "invoiced");
    assert.match(sent.payUrl, /\/mock\/invoice\?id=INV2-MOCK-/);
    assert.equal(await fileStatus(app, job.jobId), 403);
    // Sending twice makes no second invoice.
    assert.equal((await app.jobs.sendInvoice(job.jobId)).invoiceId, sent.invoiceId);
  });
});

test("the client pays on PayPal, comes back, and the gallery unlocks (no webhook needed)", async () => {
  await withApp(async (app) => {
    const job = await invoicedJob(app);
    const page = await fetch(job.payUrl); // mock PayPal page pays in full, then sends the client back
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ready to download/);
    assert.equal(app.jobs.getJob(job.jobId).status, "delivered");
    const file = await fetch(`${app.baseUrl}/client/${job.jobId}/file/1?key=${keyOf(app, job.jobId)}`);
    assert.equal(await file.text(), "photo-2");
  });
});

test("a verified PAID webhook unlocks after re-reading the invoice; a forged one changes nothing", async () => {
  await withApp(async (app) => {
    const job = await invoicedJob(app);
    app.paypal.payInvoice(job.invoiceId);
    const event = { id: "WH-J1", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: job.invoiceId } } };
    assert.equal((await deliver(app, event, "forged")).status, 400);
    assert.equal(app.jobs.getJob(job.jobId).status, "invoiced");
    const ok = await (await deliver(app, event)).json();
    assert.deepEqual(ok, { handled: true, jobId: job.jobId, status: "delivered" });
    assert.equal(await fileStatus(app, job.jobId), 200);
    assert.deepEqual(await (await deliver(app, event)).json(), { handled: false, reason: "duplicate" });
  });
});

test("a PAID event whose invoice is not actually paid unlocks nothing (the event body is never trusted)", async () => {
  await withApp(async (app) => {
    const job = await invoicedJob(app);
    const res = await (await deliver(app, { id: "WH-J2", event_type: "INVOICING.INVOICE.PAID", resource: { id: job.invoiceId, status: "PAID" } })).json();
    assert.equal(res.status, "invoiced");
    assert.equal(await fileStatus(app, job.jobId), 403);
  });
});

test("a partial payment unlocks nothing", async () => {
  await withApp(async (app) => {
    const job = await invoicedJob(app);
    app.paypal.payInvoice(job.invoiceId, "100.00");
    assert.equal((await app.jobs.refreshJob(job.jobId)).status, "invoiced");
    assert.equal(await fileStatus(app, job.jobId), 403);
  });
});

test("PAID for the wrong amount goes to review and unlocks nothing", async () => {
  await withApp(async (app) => {
    const job = await invoicedJob(app);
    const invoice = await app.paypal.getInvoice(job.invoiceId);
    // Simulate PayPal reporting PAID for less than the job price (for example the invoice was edited in PayPal).
    app.paypal.getInvoice = async () => ({ ...invoice, status: "PAID", amount: "15.00", paidAmount: "15.00" });
    const v = await app.jobs.refreshJob(job.jobId);
    assert.equal(v.status, "review");
    assert.match(v.note, /expected 1500.00 USD/);
    assert.equal(await fileStatus(app, job.jobId), 403);
  });
});

test("refunding through the assistant locks the gallery again; a PayPal refund or reversal does too", async () => {
  await withApp(async (app) => {
    const a = await invoicedJob(app);
    app.paypal.payInvoice(a.invoiceId);
    await app.jobs.refreshJob(a.jobId);
    assert.equal((await app.jobs.refundJob(a.jobId)).status, "refunded");
    assert.equal(await fileStatus(app, a.jobId), 403);
    await assert.rejects(app.jobs.refundJob(a.jobId), /Only a paid job/);

    const b = await invoicedJob(app);
    app.paypal.payInvoice(b.invoiceId);
    await app.jobs.refreshJob(b.jobId);
    const reversed = await (await deliver(app, { id: "WH-J3", event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: `MOCKPAY${b.invoiceId}` } })).json();
    assert.equal(reversed.status, "refunded");
    assert.equal(await fileStatus(app, b.jobId), 403);
  });
});

test("a cancelled invoice cancels the job and never unlocks it", async () => {
  await withApp(async (app) => {
    const job = await invoicedJob(app);
    const invoice = await app.paypal.getInvoice(job.invoiceId);
    app.paypal.getInvoice = async () => ({ ...invoice, status: "CANCELLED" });
    const res = await (await deliver(app, { id: "WH-J4", event_type: "INVOICING.INVOICE.CANCELLED", resource: { id: job.invoiceId } })).json();
    assert.equal(res.status, "cancelled");
    assert.equal(await fileStatus(app, job.jobId), 403);
  });
});

test("a wrong client key sees nothing", async () => {
  await withApp(async (app) => {
    const job = await app.jobs.createJob(wedding);
    assert.equal((await fetch(`${app.baseUrl}/client/${job.jobId}?key=nope`)).status, 403);
    assert.equal((await fetch(`${app.baseUrl}/client/${job.jobId}/file/0?key=nope`)).status, 403);
  });
});

test("the assistant needs the photographer's approval to send an invoice or refund, bound to the job", async () => {
  await withApp(async (app) => {
    const call = (name, args) => createMcpHandler(app.tools)({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).then((r) => JSON.parse(r.result.content[0].text));
    const a = await call("create_client_job", wedding);
    const b = await call("create_client_job", { ...wedding, clientEmail: "bo@example.com" });

    const first = await call("send_job_invoice", { jobId: a.jobId });
    assert.equal(first.approvalRequired, true);
    assert.equal(first.preview.to, "ana@example.com");
    assert.equal(app.jobs.getJob(a.jobId).status, "draft");

    // A code for job A does not send job B, and an invented code does nothing.
    assert.equal((await call("send_job_invoice", { jobId: b.jobId, approvalCode: first.approvalCode })).approvalRequired, true);
    assert.equal((await call("send_job_invoice", { jobId: a.jobId, approvalCode: "123.abc" })).approvalRequired, true);
    assert.equal(app.jobs.getJob(b.jobId).status, "draft");

    const sent = await call("send_job_invoice", { jobId: a.jobId, approvalCode: first.approvalCode });
    assert.equal(sent.status, "invoiced");

    app.paypal.payInvoice(sent.invoiceId);
    assert.equal((await call("get_job_status", { jobId: a.jobId })).status, "delivered");
    const r1 = await call("refund_job", { jobId: a.jobId });
    assert.equal(r1.approvalRequired, true);
    assert.equal(app.jobs.getJob(a.jobId).status, "delivered");
    assert.equal((await call("refund_job", { jobId: a.jobId, approvalCode: r1.approvalCode })).status, "refunded");
  });
});

test("job events are sent to the Zapier hook; a failing hook never blocks the unlock", async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    if (url === "https://hooks.zapier.com/hooks/catch/1/abc/") {
      posts.push(JSON.parse(init.body));
      return new Response("", { status: 500 });
    }
    return fetch(url, init);
  };
  await withApp(
    async (app) => {
      const job = await invoicedJob(app);
      app.paypal.payInvoice(job.invoiceId);
      assert.equal((await app.jobs.refreshJob(job.jobId)).status, "delivered");
      assert.deepEqual(posts.map((p) => p.type), ["job.paid", "job.delivered"]);
      assert.equal(posts[0].client_email, "ana@example.com");
      assert.equal(posts[0].amount, "1500.00");
    },
    { ZAPIER_WEBHOOK_URL: "https://hooks.zapier.com/hooks/catch/1/abc/" },
    { fetchImpl },
  );
});

test("job input is checked", async () => {
  await withApp(async (app) => {
    await assert.rejects(app.jobs.createJob({ ...wedding, clientEmail: "nope" }), /valid email/);
    await assert.rejects(app.jobs.createJob({ ...wedding, files: [] }), /at least one file/);
    await assert.rejects(app.jobs.createJob({ ...wedding, price: 0 }), /positive/);
    await assert.rejects(app.jobs.createJob({ ...wedding, currency: "JPY" }), /Currency/);
  });
});

test("real client: creates, sends and reads invoices with the documented Invoicing v2 calls", async () => {
  const calls = [];
  const invoice = {
    id: "INV2-AAAA",
    status: "SENT",
    detail: { reference: "job_1", currency_code: "USD", metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#INV2-AAAA" } },
    amount: { value: "1500.00", currency_code: "USD" },
  };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body && String(init.headers?.["Content-Type"]).includes("json") ? JSON.parse(init.body) : init.body });
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "T", expires_in: 3600 });
    if (url.endsWith("/send")) return Response.json({ href: "https://www.sandbox.paypal.com/invoice/p/#INV2-AAAA", rel: "payer-view", method: "GET" });
    return Response.json(invoice, { status: init.method === "POST" ? 201 : 200 });
  };
  const client = createPayPalClient({ clientId: "id", secret: "s", fetchImpl });
  const draft = await client.createInvoice({ reference: "job_1", currency: "USD", amount: "1500.00", itemName: "Smith wedding", note: "Thanks!", recipient: { name: "Ana Smith", email: "ana@example.com" } });
  assert.equal(draft.id, "INV2-AAAA");
  const create = calls[1];
  assert.ok(create.url.endsWith("/v2/invoicing/invoices"));
  assert.equal(create.headers.Prefer, "return=representation");
  assert.equal(create.headers["PayPal-Request-Id"], "invoice-job_1");
  assert.deepEqual(create.body.detail, { currency_code: "USD", reference: "job_1", note: "Thanks!" });
  assert.deepEqual(create.body.primary_recipients[0].billing_info, { email_address: "ana@example.com", name: { given_name: "Ana", surname: "Smith" } });
  assert.deepEqual(create.body.items[0].unit_amount, { currency_code: "USD", value: "1500.00" });

  const sent = await client.sendInvoice("INV2-AAAA");
  assert.deepEqual(calls[2].body, { send_to_invoicer: false, send_to_recipient: true });
  assert.ok(calls[2].url.endsWith("/v2/invoicing/invoices/INV2-AAAA/send"));
  assert.equal(sent.payUrl, "https://www.sandbox.paypal.com/invoice/p/#INV2-AAAA");
  assert.equal(calls[3].method, "GET");
});
