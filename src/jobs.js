// Client delivery jobs: a photographer's gallery for one client, paid by a PayPal invoice, unlocked only after PayPal says it is paid.
//
// Lifecycle: draft -> invoiced -> delivered (paid, gallery unlocked) -> refunded (gallery locked again).
// Side branches: cancelled (invoice cancelled before payment) and review (paid, but not the amount we asked for: nothing unlocks).
//
// The rules that matter:
// - The gallery unlocks only after the invoice is re-read from PayPal and shows status PAID with the full amount and currency.
//   A webhook only tells us to look; it is never trusted on its own (and it is signature-checked before it gets here).
// - INVOICING.INVOICE.PAID also fires for partial payments, so a partial payment unlocks nothing.
// - Any refund (full or partial) or a reversal locks the gallery again.
// - Webhook events are de-duplicated, and an event is remembered only after it was applied, so a failed unlock is retried.
// - The storage side is a `store` (MockStore here, TarkleStore for the real client portal); the job decides, the store obeys.
import { randomBytes } from "node:crypto";
import { fromCents, toCents } from "./service.js";

const CURRENCIES = ["USD", "EUR", "GBP"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FILES = 500;
const REFUNDED = new Set(["REFUNDED", "PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED", "REFUNDED_EXTERNAL"]);
const CANCELLED = new Set(["CANCELLED", "AUTO_CANCELLED"]);

const cents = (value) => (value == null || value === "" ? null : Math.round(Number(value) * 100));

export function createJobService({ paypal, store, baseUrl, notify = async () => {}, now = () => Date.now() }) {
  const jobs = new Map();
  const seenEvents = new Set();
  const running = new Map();
  const newId = () => `job_${randomBytes(5).toString("hex")}`;

  // One state change at a time per job, so a webhook and the client's return page cannot unlock twice.
  function serialize(jobId, fn) {
    const before = running.get(jobId) || Promise.resolve();
    const next = before.then(fn);
    const settled = next.catch(() => {});
    running.set(jobId, settled);
    settled.then(() => running.get(jobId) === settled && running.delete(jobId));
    return next;
  }

  function mustGet(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new Error("Unknown job.");
    return job;
  }

  const view = (job) => ({
    jobId: job.id,
    title: job.title,
    client: { name: job.client.name, email: job.client.email },
    files: job.files.map((f) => f.name),
    price: fromCents(job.cents),
    currency: job.currency,
    status: job.status,
    invoiceId: job.invoiceId ?? null,
    payUrl: job.payUrl ?? null,
    clientUrl: job.clientUrl ?? null,
    note: job.reviewReason ?? null,
    createdAt: new Date(job.createdAt).toISOString(),
    deliveredAt: job.deliveredAt ? new Date(job.deliveredAt).toISOString() : null,
  });

  async function emit(type, job) {
    try {
      await notify(type, { job_id: job.id, title: job.title, client_email: job.client.email, amount: fromCents(job.cents), currency: job.currency, client_url: job.clientUrl ?? null });
    } catch {
      // Notifications are best effort and never change the job.
    }
  }

  // Applies what PayPal says about the invoice. Returns the job view. `silent` (a job rebuilt after a restart) sends no notifications:
  // they went out when it happened.
  async function applyInvoice(job, invoice, { silent = false } = {}) {
    const say = silent ? async () => {} : emit;
    if (invoice.reference && invoice.reference !== job.id) throw new Error("This invoice belongs to another job.");
    if (invoice.paymentIds?.length) job.paymentIds = invoice.paymentIds;

    if (invoice.status === "PAID" && job.status === "invoiced") {
      const fullyPaid = cents(invoice.paidAmount) === job.cents && cents(invoice.amount) === job.cents && invoice.currency === job.currency;
      if (!fullyPaid) {
        job.status = "review";
        job.reviewReason = `PayPal reports ${invoice.paidAmount ?? "?"} ${invoice.currency ?? ""} paid, expected ${fromCents(job.cents)} ${job.currency}. Nothing was unlocked.`;
        return view(job);
      }
      await store.unlock(job);
      job.status = "delivered";
      job.deliveredAt = now();
      await say("job.paid", job);
      await say("job.delivered", job);
    } else if (REFUNDED.has(invoice.status) && (job.status === "delivered" || job.status === "review")) {
      await store.lock(job);
      job.status = "refunded";
      await say("job.refunded", job);
    } else if (CANCELLED.has(invoice.status) && job.status === "invoiced") {
      job.status = "cancelled";
    }
    return view(job);
  }

  // ---- Surviving a restart. Render's free instances lose memory and disk when they sleep, so each job also lives in its PayPal
  // invoice: the reference is the job id and the private memo holds the client's page key and the store's delivery ids. After a
  // restart, jobs are rebuilt from the invoices (amount, client and status are PayPal's own), then brought up to date.
  const MEMO_PREFIX = "tarkle-demo:v1 ";
  const memoOf = (job) => MEMO_PREFIX + JSON.stringify({ k: job.accessKey, d: job.delivery || null });

  function parseMemo(memo) {
    if (typeof memo !== "string" || !memo.startsWith(MEMO_PREFIX)) return null;
    try {
      const data = JSON.parse(memo.slice(MEMO_PREFIX.length));
      return typeof data.k === "string" && /^[0-9a-f]{32}$/.test(data.k) ? data : null;
    } catch {
      return null;
    }
  }

  async function rebuild(invoiceId, { apply = true } = {}) {
    const invoice = await paypal.getInvoice(invoiceId);
    const memo = parseMemo(invoice.memo);
    if (!memo || !/^job_[0-9a-f]{10}$/.test(invoice.reference || "") || jobs.has(invoice.reference)) return jobs.get(invoice.reference) ?? null;
    if (invoice.status === "DRAFT") return null;
    const job = {
      id: invoice.reference,
      title: invoice.itemName || "Client delivery",
      client: { name: invoice.recipientName || "", email: String(invoice.recipientEmail || "").toLowerCase() },
      note: invoice.note || "",
      files: [],
      cents: cents(invoice.amount),
      currency: invoice.currency,
      status: "invoiced",
      accessKey: memo.k,
      delivery: memo.d,
      invoiceId: invoice.id,
      payUrl: invoice.payUrl,
      invited: true,
      createdAt: now(),
    };
    const wasUnlocked = invoice.status === "PAID" || REFUNDED.has(invoice.status);
    store.adopt(job, memo.d, wasUnlocked);
    if (REFUNDED.has(invoice.status)) job.status = "delivered"; // so the refund below locks it again (repeat-safe)
    jobs.set(job.id, job);
    // Brought up to date quietly; a webhook that triggered the rebuild applies the invoice itself, with its notifications.
    if (apply) await serialize(job.id, () => applyInvoice(job, invoice, { silent: true }));
    return job;
  }

  let recovered = null;
  function recoverAll() {
    recovered ??= (async () => {
      const ids = await paypal.listInvoiceIds();
      for (const id of ids) {
        if ([...jobs.values()].some((j) => j.invoiceId === id)) continue;
        try {
          await rebuild(id);
        } catch (err) {
          console.error(`[jobs] could not rebuild invoice ${id}: ${err.message}`);
        }
      }
    })().catch((err) => {
      recovered = null; // try again next time
      throw err;
    });
    return recovered;
  }

  async function loadJob(jobId) {
    if (jobs.has(jobId)) return jobs.get(jobId);
    await recoverAll();
    return mustGet(jobId);
  }

  return {
    async createJob({ title, clientName, clientEmail, price, currency = "USD", note, files = [] }) {
      if (!title || !String(title).trim()) throw new Error("title is required.");
      if (!clientEmail || !EMAIL.test(String(clientEmail).trim())) throw new Error("clientEmail must be a valid email address.");
      const c = String(currency).toUpperCase();
      if (!CURRENCIES.includes(c)) throw new Error(`Currency must be one of ${CURRENCIES.join(", ")}.`);
      if (!Array.isArray(files) || files.length === 0) throw new Error("files: add at least one file to deliver.");
      if (files.length > MAX_FILES) throw new Error(`A job can hold at most ${MAX_FILES} files.`);
      const list = files.map((f, i) => {
        if (!f || !f.name) throw new Error(`files[${i}] needs a name.`);
        return { name: String(f.name), content: f.content == null ? "" : String(f.content), url: f.url ? String(f.url) : null };
      });
      const job = {
        id: newId(),
        title: String(title).trim().slice(0, 200),
        client: { name: String(clientName || "").trim().slice(0, 200), email: String(clientEmail).trim().toLowerCase() },
        note: note ? String(note).slice(0, 1000) : "",
        files: list,
        cents: toCents(price),
        currency: c,
        status: "draft",
        accessKey: randomBytes(16).toString("hex"),
        createdAt: now(),
      };
      jobs.set(job.id, job);
      try {
        const prepared = await store.prepare(job);
        job.clientUrl = prepared.clientUrl;
        job.delivery = store.deliveryOf?.(job) ?? null;
      } catch (err) {
        // Nothing was sent or charged; the job is dropped so a retry starts clean. A folder the store already made may remain.
        jobs.delete(job.id);
        throw new Error(`The files could not be prepared for the client: ${err.message}`);
      }
      return view(job);
    },

    // Creates and sends the PayPal invoice. Repeat-safe: the job id is the invoice reference and the request idempotency key.
    sendInvoice(jobId) {
      return serialize(jobId, async () => {
        const job = await loadJob(jobId);
        // A send whose portal invite failed is finished here on the next try; anything else after draft is already done.
        if (job.status === "invoiced" && store.invite && !job.invited) {
          await store.invite(job);
          job.invited = true;
          return view(job);
        }
        if (job.status !== "draft") return view(job);
        const draft = await paypal.createInvoice({
          reference: job.id,
          currency: job.currency,
          amount: fromCents(job.cents),
          itemName: job.title,
          itemDescription: `${job.files.length} ${job.files.length === 1 ? "file" : "files"}, delivered in your client portal once paid.`,
          note: job.note || undefined,
          memo: memoOf(job),
          recipient: job.client,
        });
        const sent = await paypal.sendInvoice(draft.id);
        job.invoiceId = sent.id || draft.id;
        job.payUrl = sent.payUrl;
        job.status = "invoiced";
        // The client may now be emailed: the photographer approved this send. (Tarkle emails the portal invite the first time.)
        if (store.invite) {
          await store.invite(job);
          job.invited = true;
        }
        return view(job);
      });
    },

    // Re-reads the invoice from PayPal and applies it: the fallback when a webhook is late or missing.
    refreshJob(jobId) {
      return serialize(jobId, async () => {
        const job = await loadJob(jobId);
        if (!job.invoiceId) return view(job);
        return applyInvoice(job, await paypal.getInvoice(job.invoiceId));
      });
    },

    // Refunds the client in full through PayPal and locks the gallery again.
    refundJob(jobId) {
      return serialize(jobId, async () => {
        const job = await loadJob(jobId);
        if (job.status !== "delivered" && job.status !== "review") throw new Error(`Only a paid job can be refunded (this one is ${job.status}).`);
        if (!job.paymentIds?.length) job.paymentIds = (await paypal.getInvoice(job.invoiceId)).paymentIds;
        const paymentId = job.paymentIds?.[0];
        if (!paymentId) throw new Error("PayPal shows no payment on this invoice to refund.");
        await paypal.refundCapture(paymentId, { amount: fromCents(job.cents), currency: job.currency });
        await store.lock(job);
        job.status = "refunded";
        await emit("job.refunded", job);
        return view(job);
      });
    },

    // A signature-checked webhook event. Returns null when it is not about a job, so the caller can pass it on.
    async handleWebhookEvent(event) {
      if (!event?.id || !event.event_type) return null;
      const r = event.resource || {};
      let job = null;
      if (event.event_type.startsWith("INVOICING.INVOICE.")) {
        const invoiceId = r.invoice?.id || r.id;
        job = [...jobs.values()].find((j) => j.invoiceId && j.invoiceId === invoiceId);
        // After a restart (a sleeping free instance is woken by this very webhook), rebuild the job from its invoice first.
        if (!job && invoiceId) job = await rebuild(invoiceId, { apply: false });
        if (!job) return { handled: false, reason: "unknown invoice" };
      } else if (event.event_type === "PAYMENT.CAPTURE.REFUNDED" || event.event_type === "PAYMENT.CAPTURE.REVERSED") {
        const upLink = r.links?.find((l) => l.rel === "up")?.href;
        const paymentId = event.event_type === "PAYMENT.CAPTURE.REVERSED" ? r.id : upLink?.split("/").pop();
        const byPayment = () => [...jobs.values()].find((j) => j.paymentIds?.includes(paymentId));
        job = byPayment();
        if (!job && paymentId) {
          await recoverAll();
          job = byPayment();
        }
        if (!job) return null;
      } else {
        return null;
      }
      if (seenEvents.has(event.id)) return { handled: false, reason: "duplicate" };

      const result = await serialize(job.id, async () => {
        if (event.event_type.startsWith("PAYMENT.CAPTURE.")) {
          if (job.status !== "delivered" && job.status !== "review") return view(job);
          await store.lock(job);
          job.status = "refunded";
          await emit("job.refunded", job);
          return view(job);
        }
        // Never trust the event body: read the invoice from PayPal.
        return applyInvoice(job, await paypal.getInvoice(job.invoiceId));
      });
      seenEvents.add(event.id);
      return { handled: true, jobId: result.jobId, status: result.status };
    },

    getJob: (jobId) => view(mustGet(jobId)),
    listJobs: () => [...jobs.values()].map(view),
    // The same, rebuilding jobs from PayPal first when this instance restarted.
    loadJob: async (jobId) => view(await loadJob(jobId)),
    async listAllJobs() {
      await recoverAll();
      return [...jobs.values()].map(view);
    },

    // What the client's page may show: the job, and whether files can be downloaded. Null for a wrong key.
    clientView(jobId, key) {
      const job = jobs.get(jobId);
      if (!job || !key || key !== job.accessKey) return null;
      return { ...view(job), unlocked: job.status === "delivered" && store.isUnlocked(job), inPortal: store.kind === "tarkle" };
    },

    clientFile(jobId, key, index) {
      const job = jobs.get(jobId);
      if (!job || !key || key !== job.accessKey) return null;
      // In Tarkle mode the files are only in the client's portal, never served by this app.
      if (store.kind !== "mock" || job.status !== "delivered" || !store.isUnlocked(job)) return null;
      return job.files[Number(index)] ?? null;
    },

    accessKeyFor: (jobId) => mustGet(jobId).accessKey,
  };
}
