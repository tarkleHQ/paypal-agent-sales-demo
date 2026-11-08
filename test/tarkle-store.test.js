import test from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "../src/bootstrap.js";
import { createTarkleStore } from "../src/tarkle-store.js";

// A stand-in for Tarkle's public API v1 with the shapes the real routes answer (contacts, folders, uploads, transfers).
function fakeTarkle({ existingContact = null } = {}) {
  const calls = [];
  const db = { contacts: existingContact ? [existingContact] : [], folders: [], files: [], transfers: [], storage: new Map(), idem: new Map() };
  let seq = 100;
  let failPatch = 0;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function handle(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    if (u.host === "storage.test") {
      db.storage.set(u.pathname, Buffer.from(init.body).toString("utf8"));
      return new Response("", { status: 200 });
    }
    const h = init.headers || {};
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname.replace("/api/v1", ""), query: u.search, body, idem: h["Idempotency-Key"] });
    if (h.Authorization !== "Bearer tk_test" || h["X-Workspace-Key"] !== "abcd1234") return json(401, { code: "unauthorized", detail: "Bad token" });
    // Tarkle's own rule: the same key replays the first answer.
    if (h["Idempotency-Key"] && db.idem.has(h["Idempotency-Key"])) return json(...db.idem.get(h["Idempotency-Key"]));
    const answer = route(method, u.pathname.replace("/api/v1", ""), u.searchParams, body);
    if (h["Idempotency-Key"]) db.idem.set(h["Idempotency-Key"], answer);
    return json(...answer);
  }

  function route(method, path, q, body) {
    let m;
    if (method === "GET" && path === "/contacts") {
      const query = (q.get("query") || "").toLowerCase();
      return [200, { contacts: db.contacts.filter((c) => c.email.includes(query)) }];
    }
    if (method === "POST" && path === "/contacts") {
      const c = { contactId: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, email: body.email, name: body.first_name, portalAccess: false };
      db.contacts.push(c);
      return [201, c];
    }
    if (method === "POST" && (m = path.match(/^\/contacts\/([^/]+)\/portal-access$/))) {
      const c = db.contacts.find((x) => x.contactId === m[1]);
      if (!c) return [404, { code: "not_found", detail: "Contact not found" }];
      const invited = body.enabled && !c.portalAccess;
      c.portalAccess = body.enabled;
      return [200, { contactId: c.contactId, portalAccess: body.enabled, inviteEmailSent: invited }];
    }
    if (method === "POST" && path === "/folders") {
      const f = { id: `f0000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, type: "folder", name: body.name };
      db.folders.push(f);
      return [201, f];
    }
    if (method === "POST" && path === "/uploads") {
      const id = `up_${++seq}`;
      if (body.size === 0) {
        const file = { id: String(++seq), name: body.name, folder: body.folder_id };
        db.files.push(file);
        return [201, { action: "created", kind: "empty", file }];
      }
      db.files.push({ uploadId: id, name: body.name, folder: body.folder_id, pending: true });
      return [201, { action: "upload", id, mode: "single", content_type: "application/octet-stream", uploads: [{ part: 1, url: `https://storage.test/put/${id}` }] }];
    }
    if (method === "POST" && (m = path.match(/^\/uploads\/([^/]+)\/complete$/))) {
      const f = db.files.find((x) => x.uploadId === m[1]);
      if (!db.storage.has(`/put/${m[1]}`)) return [409, { code: "incomplete", detail: "Bytes missing" }];
      f.pending = false;
      f.id = String(++seq);
      return [200, { id: f.id, type: "file", name: f.name }];
    }
    if (method === "POST" && path === "/transfers") {
      const t = { id: String(++seq), items: body.items, access: body.access, hasPassword: Boolean(body.password), view_only: body.view_only, contactIds: [] };
      db.transfers.push(t);
      return [201, { id: t.id, url: `https://acme.tarkle.com/t/T${t.id}`, view_only: t.view_only, access: t.access }];
    }
    if (method === "POST" && (m = path.match(/^\/transfers\/([^/]+)\/contacts$/))) {
      const t = db.transfers.find((x) => x.id === m[1]);
      const added = body.contact_ids.filter((id) => !t.contactIds.includes(id));
      t.contactIds.push(...added);
      return [200, { id: t.id, contact_ids: t.contactIds, added, view_only: t.view_only }];
    }
    if (method === "PATCH" && (m = path.match(/^\/transfers\/([^/]+)$/))) {
      if (failPatch > 0) {
        failPatch -= 1;
        return [503, { code: "server_error", detail: "Try again" }];
      }
      const t = db.transfers.find((x) => x.id === m[1]);
      t.view_only = body.view_only;
      return [200, { id: t.id, view_only: t.view_only }];
    }
    return [404, { code: "not_found", detail: `No route ${method} ${path}` }];
  }

  return { handle, calls, db, failNextPatches: (n) => (failPatch = n) };
}

const ENV = { TARKLE_API_BASE: "https://tarkle.test/api/v1", TARKLE_API_KEY: "tk_test", TARKLE_WORKSPACE_KEY: "abcd1234", TARKLE_PORTAL_URL: "https://acme.tarkle.com/portal" };
const wedding = { title: "Smith wedding", clientName: "Ana Smith", clientEmail: "ana@example.com", price: 1500, files: [{ name: "001.jpg", content: "photo-1" }, { name: "002.jpg", content: "photo-2" }] };

let nextPort = 3300;
async function withTarkle(fn, fake = fakeTarkle()) {
  const fetchImpl = (url, init) => (String(url).startsWith("https://tarkle.test") || String(url).startsWith("https://storage.test") ? fake.handle(url, init) : fetch(url, init));
  const app = bootstrap({ PORT: String(nextPort++), ...ENV }, { fetchImpl });
  await new Promise((r) => app.web.listen(app.port, r));
  try {
    await fn(app, fake);
  } finally {
    app.web.close();
  }
}

test("a job is delivered into the client's Tarkle portal, view only, before anyone is emailed", async () => {
  await withTarkle(async (app, fake) => {
    assert.equal(app.store.kind, "tarkle");
    const job = await app.jobs.createJob(wedding);
    assert.equal(job.clientUrl, "https://acme.tarkle.com/portal");

    const [contact] = fake.db.contacts;
    assert.equal(contact.email, "ana@example.com");
    assert.equal(contact.portalAccess, false, "no portal invite before the photographer approves the invoice");
    assert.equal(fake.db.folders.length, 1);
    assert.match(fake.db.folders[0].name, /^Smith wedding \(job_/);
    assert.deepEqual([...fake.db.storage.values()], ["photo-1", "photo-2"]);
    const [t] = fake.db.transfers;
    assert.deepEqual(t.items, [{ id: fake.db.folders[0].id, type: "folder" }]);
    assert.equal(t.view_only, true);
    assert.equal(t.access, "public", "no password: the portal opens the transfer through its link, and view only is the lock");
    assert.equal(t.hasPassword, false);
    assert.deepEqual(t.contactIds, [contact.contactId]);
    // The transfer password is never shown anywhere.
    assert.doesNotMatch(JSON.stringify(app.jobs.getJob(job.jobId)), /password/i);
  });
});

test("sending the invoice turns the portal on; payment unlocks downloads; a refund locks them again", async () => {
  await withTarkle(async (app, fake) => {
    const job = await app.jobs.createJob(wedding);
    const sent = await app.jobs.sendInvoice(job.jobId);
    assert.equal(fake.db.contacts[0].portalAccess, true);
    assert.equal(fake.db.transfers[0].view_only, true);

    app.paypal.payInvoice(sent.invoiceId);
    assert.equal((await app.jobs.refreshJob(job.jobId)).status, "delivered");
    assert.equal(fake.db.transfers[0].view_only, false);

    assert.equal((await app.jobs.refundJob(job.jobId)).status, "refunded");
    assert.equal(fake.db.transfers[0].view_only, true);
  });
});

test("an existing contact is reused, never duplicated", async () => {
  const fake = fakeTarkle({ existingContact: { contactId: "11111111-1111-4111-8111-111111111111", email: "ana@example.com", portalAccess: true } });
  await withTarkle(async (app) => {
    await app.jobs.createJob(wedding);
    assert.equal(fake.db.contacts.length, 1);
    assert.deepEqual(fake.db.transfers[0].contactIds, ["11111111-1111-4111-8111-111111111111"]);
    assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path === "/contacts").length, 0);
  }, fake);
});

test("every Tarkle write carries a fixed idempotency key per job and step", async () => {
  await withTarkle(async (app, fake) => {
    const job = await app.jobs.createJob(wedding);
    await app.jobs.sendInvoice(job.jobId);
    const posts = fake.calls.filter((c) => c.method === "POST");
    assert.ok(posts.every((c) => c.idem && c.idem.startsWith(`paypal-demo:${job.jobId}:`)), JSON.stringify(posts.map((c) => c.idem)));
    assert.equal(new Set(posts.map((c) => c.idem)).size, posts.length, "one key per step");
  });
});

test("if Tarkle fails to unlock, the paid webhook is retried and nothing is lost", async () => {
  await withTarkle(async (app, fake) => {
    const job = await app.jobs.createJob(wedding);
    const sent = await app.jobs.sendInvoice(job.jobId);
    app.paypal.payInvoice(sent.invoiceId);
    fake.failNextPatches(1);
    const event = { id: "WH-T1", event_type: "INVOICING.INVOICE.PAID", resource: { id: sent.invoiceId } };
    const deliver = () => fetch(`${app.baseUrl}/paypal/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-mock-signature": "valid" }, body: JSON.stringify(event) });
    assert.notEqual((await deliver()).status, 200, "a failed unlock answers an error so PayPal retries");
    assert.equal(app.jobs.getJob(job.jobId).status, "invoiced");
    const retried = await (await deliver()).json();
    assert.equal(retried.status, "delivered");
    assert.equal(fake.db.transfers[0].view_only, false);
  });
});

test("in Tarkle mode the app's own page points to the portal and never serves the files", async () => {
  await withTarkle(async (app) => {
    const job = await app.jobs.createJob(wedding);
    const sent = await app.jobs.sendInvoice(job.jobId);
    app.paypal.payInvoice(sent.invoiceId);
    await app.jobs.refreshJob(job.jobId);
    const key = app.jobs.accessKeyFor(job.jobId);
    const html = await (await fetch(`${app.baseUrl}/client/${job.jobId}?key=${key}`)).text();
    assert.match(html, /Open your client portal/);
    assert.match(html, /https:\/\/acme\.tarkle\.com\/portal/);
    assert.doesNotMatch(html, /\/file\/0/);
    assert.equal((await fetch(`${app.baseUrl}/client/${job.jobId}/file/0?key=${key}`)).status, 403);
  });
});

test("Tarkle settings are checked, and the API key is only ever sent to the API", async () => {
  assert.throws(() => createTarkleStore({ apiBase: "http://evil.example/api/v1", apiKey: "k", workspaceKey: "abcd1234" }), /https/);
  assert.throws(() => createTarkleStore({ apiBase: "https://tarkle.com/api/v1", apiKey: "", workspaceKey: "abcd1234" }), /TARKLE_API_KEY/);
  assert.throws(() => createTarkleStore({ apiBase: "https://tarkle.com/api/v1", apiKey: "k", workspaceKey: "not-a-key" }), /8-character/);
  const seen = [];
  const fake = fakeTarkle();
  const store = createTarkleStore({ apiBase: "https://tarkle.test/api/v1", apiKey: "tk_test", workspaceKey: "abcd1234", fetchImpl: (url, init) => (seen.push({ url: String(url), auth: init?.headers?.Authorization }), fake.handle(url, init)) });
  await store.prepare({ id: "job_x", title: "T", client: { name: "A", email: "a@example.com" }, files: [{ name: "a.txt", content: "x" }] });
  for (const s of seen.filter((x) => x.url.startsWith("https://storage.test"))) assert.equal(s.auth, undefined, "the storage upload never gets the Tarkle key");
});

test("a Tarkle failure while preparing drops the job with a plain error, and nothing is invoiced", async () => {
  const fake = fakeTarkle();
  const broken = { ...fake, handle: (url, init) => (String(url).endsWith("/folders") ? new Response(JSON.stringify({ code: "forbidden", detail: "You do not have permission" }), { status: 403 }) : fake.handle(url, init)) };
  await withTarkle(async (app) => {
    await assert.rejects(app.jobs.createJob(wedding), /could not be prepared for the client: .*permission/);
    assert.deepEqual(app.jobs.listJobs(), []);
    assert.equal(fake.db.transfers.length, 0);
  }, broken);
});

test("folder and file names follow Tarkle's name rules (no slash, no control characters)", async () => {
  await withTarkle(async (app, fake) => {
    await app.jobs.createJob({ ...wedding, title: "Smith/Jones wedding\u0007", files: [{ name: "a/b.jpg", content: "x" }] });
    assert.match(fake.db.folders[0].name, /^Smith-Jones wedding \(job_[0-9a-f]+\)$/);
    assert.equal(fake.db.files[0].name, "a-b.jpg");
  });
});
