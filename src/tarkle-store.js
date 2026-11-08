// Delivers a job's gallery into the client's own Tarkle client portal, through Tarkle's public API v1 only (no Tarkle code here).
//
//   prepare(job)  find or create the client as a Tarkle contact, upload the files into a new folder, share the folder as a
//                 VIEW-ONLY transfer and deliver it to the contact's portal. The client sees the files there but cannot download
//                 them: Tarkle enforces view only on every download route (in the portal and on the transfer's link). No password:
//                 the portal opens the transfer through its link, and a password would lock the signed-in client out.
//   invite(job)   turn the contact's portal access on. Tarkle emails the portal invite the first time. Called only after the
//                 photographer approved sending the invoice, because it emails the client.
//   unlock(job)   PATCH /transfers/{id} { view_only: false }: downloads work in the portal. Called only after PayPal says paid.
//   lock(job)     PATCH /transfers/{id} { view_only: true }: after a refund or reversal.
//
// Every write sends an Idempotency-Key fixed per job and step, so a retry after a timeout never makes a second contact, folder,
// upload or transfer (Tarkle answers a repeat with the first answer). The API key never leaves this server.

export class TarkleError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "TarkleError";
    this.status = status;
    this.code = code;
  }
}

export function createTarkleStore({ apiBase, apiKey, workspaceKey, portalUrl = null, fetchImpl = fetch }) {
  if (!/^https:\/\//.test(apiBase || "") && !/^http:\/\/localhost[:/]/.test(apiBase || "")) throw new Error("TARKLE_API_BASE must be an https URL, for example https://tarkle.com/api/v1");
  if (!apiKey) throw new Error("TARKLE_API_KEY is required.");
  if (!/^[A-Za-z0-9]{8}$/.test(workspaceKey || "")) throw new Error("TARKLE_WORKSPACE_KEY must be the workspace's 8-character key (GET /api/v1/workspaces lists them).");
  const base = apiBase.replace(/\/+$/, "");
  const state = new Map(); // job id -> { contactId, folderId, transferId, password, unlocked }

  async function call(method, path, body, idempotencyKey) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Workspace-Key": workspaceKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new TarkleError(`Tarkle ${method} ${path.split("?")[0]}: ${data.detail || data.title || data.error?.message || res.status}`, res.status, data.code);
    return data;
  }

  const key = (job, step) => `paypal-demo:${job.id}:${step}`;
  // Tarkle refuses "/" and control characters in a name and caps it at 255 bytes; keep names readable and inside those rules.
  const safeName = (name, fallback) => {
    let out = String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\//g, "-").trim();
    if (!out || out === "." || out === "..") out = fallback;
    while (Buffer.byteLength(out, "utf8") > 200) out = out.slice(0, -1);
    return out;
  };
  const mustState = (job) => {
    const s = state.get(job.id);
    if (!s?.transferId) throw new Error("This job has no Tarkle delivery yet.");
    return s;
  };

  async function findOrCreateContact(job) {
    const { contacts = [] } = await call("GET", `/contacts?query=${encodeURIComponent(job.client.email)}&limit=50`);
    const existing = contacts.find((c) => String(c.email || "").toLowerCase() === job.client.email);
    if (existing) return existing.contactId;
    const [first, ...rest] = (job.client.name || job.client.email.split("@")[0]).split(/\s+/);
    const created = await call("POST", "/contacts", { email: job.client.email, first_name: first, ...(rest.length ? { last_name: rest.join(" ") } : {}) }, key(job, "contact"));
    return created.contactId;
  }

  async function uploadFile(job, folderId, file, index) {
    const bytes = Buffer.from(file.content ?? "", "utf8");
    const started = await call("POST", "/uploads", { name: safeName(file.name, `file-${index + 1}`), size: bytes.length, folder_id: folderId }, key(job, `upload-${index}`));
    if (started.action === "created") return started.file?.id;
    if (started.action === "skip") return started.existing?.id;
    if (!Array.isArray(started.uploads) || started.uploads.length !== 1) throw new Error(`${file.name} is too large for this demo's single-part upload.`);
    const put = await fetchImpl(started.uploads[0].url, { method: "PUT", body: bytes, headers: { "Content-Type": started.content_type || "application/octet-stream" } });
    if (!put.ok) throw new TarkleError(`Storage refused ${file.name} (${put.status})`, put.status);
    const done = await call("POST", `/uploads/${encodeURIComponent(started.id)}/complete`, {}, key(job, `complete-${index}`));
    return done.id;
  }

  return {
    kind: "tarkle",

    async prepare(job) {
      const s = state.get(job.id) || { unlocked: false };
      state.set(job.id, s);
      s.contactId ??= await findOrCreateContact(job);
      if (!s.folderId) {
        const folder = await call("POST", "/folders", { name: `${safeName(job.title, "Client delivery").slice(0, 150)} (${job.id})` }, key(job, "folder"));
        s.folderId = folder.id;
      }
      for (let i = 0; i < job.files.length; i++) await uploadFile(job, s.folderId, job.files[i], i);
      if (!s.transferId) {
        const transfer = await call(
          "POST",
          "/transfers",
          { items: [{ id: s.folderId, type: "folder" }], access: "public", view_only: true, title: job.title },
          key(job, "transfer"),
        );
        s.transferId = transfer.id;
      }
      await call("POST", `/transfers/${encodeURIComponent(s.transferId)}/contacts`, { contact_ids: [s.contactId] }, key(job, "deliver"));
      return { clientUrl: portalUrl };
    },

    async invite(job) {
      const s = mustState(job);
      await call("POST", `/contacts/${encodeURIComponent(s.contactId)}/portal-access`, { enabled: true }, key(job, "portal"));
    },

    async unlock(job) {
      const s = mustState(job);
      await call("PATCH", `/transfers/${encodeURIComponent(s.transferId)}`, { view_only: false });
      s.unlocked = true;
    },

    async lock(job) {
      const s = mustState(job);
      await call("PATCH", `/transfers/${encodeURIComponent(s.transferId)}`, { view_only: true });
      s.unlocked = false;
    },

    isUnlocked: (job) => state.get(job.id)?.unlocked === true,
    // After a restart: take back a delivery rebuilt from the job's PayPal invoice memo.
    adopt(job, delivery, unlocked = false) {
      if (!delivery?.transferId) throw new Error("This job has no Tarkle delivery to resume.");
      state.set(job.id, { contactId: delivery.contactId, folderId: delivery.folderId, transferId: String(delivery.transferId), unlocked });
    },
    deliveryOf: (job) => {
      const s = state.get(job.id);
      return s ? { contactId: s.contactId, folderId: s.folderId, transferId: s.transferId } : null;
    },
  };
}
