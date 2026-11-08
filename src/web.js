// Buyer-facing pages: product page, PayPal return, download. No dependencies.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { homePage } from "./home.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout demo</title>
<style>body{font:16px system-ui;max-width:480px;margin:10vh auto;padding:0 16px;color:#111}button,a.btn{background:#0070ba;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:16px;cursor:pointer;text-decoration:none;display:inline-block}small{color:#555}</style></head>
<body>${body}<p><small>Sandbox demo. No real money moves.</small></p></body></html>`;

const MAX_BODY = 100_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) tooLarge = true; // keep draining so the client can read our 413
      else chunks.push(c);
    });
    req.on("end", () => (tooLarge ? reject(Object.assign(new Error("Body too large"), { status: 413 })) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

function tokenMatches(header, token) {
  const given = Buffer.from((header || "").replace(/^Bearer /i, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// `mcp` is a JSON-RPC handler. /mcp exists only when `mcpToken` is set, because the tools
// create products and refund orders, so an open endpoint on a public URL would be unsafe.
export function createWebServer({ service, jobs, paypal, baseUrl, mcp, mcpToken, webhookId, studioName, portalUrl }) {
  const send = (res, status, html, headers = {}) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
    res.end(html);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (url.pathname === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, homePage({ studioName, portalUrl }));

      // PayPal webhooks. A real delivery is trusted only after PayPal confirms its signature.
      if (url.pathname === "/paypal/webhook" && (paypal.mock || webhookId)) {
        if (req.method !== "POST") return send(res, 405, "Use POST", { "Content-Type": "text/plain", Allow: "POST" });
        const rawBody = await readBody(req);
        let verified = false;
        try {
          verified = await paypal.verifyWebhook({ headers: req.headers, rawBody, webhookId });
        } catch {
          verified = false;
        }
        if (!verified) return send(res, 400, "Signature check failed", { "Content-Type": "text/plain" });
        const event = JSON.parse(rawBody);
        // Job (invoice) events first; anything that is not about a job goes to the order flow.
        const outcome = (jobs && (await jobs.handleWebhookEvent(event))) || (await service.handleWebhookEvent(event));
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(outcome));
      }

      if (url.pathname === "/mcp" && mcp && mcpToken) {
        const json = (status, body) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(body === undefined ? "" : JSON.stringify(body));
        };
        if (!tokenMatches(req.headers.authorization, mcpToken)) {
          res.setHeader("WWW-Authenticate", "Bearer");
          return json(401, { error: "Unauthorized" });
        }
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          return json(405, { error: "Use POST" });
        }
        let msg;
        try {
          msg = JSON.parse(await readBody(req));
        } catch (err) {
          if (err.status === 413) return json(413, { error: "Body too large" });
          return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        }
        if (Array.isArray(msg) || typeof msg !== "object" || msg === null) {
          return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send one JSON-RPC message per request" } });
        }
        const out = await mcp(msg);
        return out ? json(200, out) : json(202);
      }

      if (req.method === "GET" && parts[0] === "buy" && parts.length === 2) {
        const p = service.publicProduct(parts[1]);
        const soldOut = p.seatsLeft === 0;
        return send(res, 200, page(`<h1>${esc(p.title)}</h1>
<p>${p.kind === "ticket" ? `Starts ${esc(p.startsAt)} · ${p.seatsLeft} seats left` : "File download"}</p>
<p><strong>${esc(p.price)} ${esc(p.currency)}</strong></p>
${soldOut ? "<p>Sold out.</p>" : `<form method="post" action="/buy/${esc(p.id)}/checkout"><button>Pay with PayPal</button></form>`}`));
      }

      if (req.method === "POST" && parts[0] === "buy" && parts[2] === "checkout") {
        const { approveUrl } = await service.startCheckout(parts[1]);
        res.writeHead(303, { Location: approveUrl });
        return res.end();
      }

      // Mock approval page, only reachable when running without PayPal credentials.
      if (req.method === "GET" && url.pathname === "/mock/approve" && paypal.mock) {
        const token = url.searchParams.get("token");
        paypal.approve(token);
        res.writeHead(302, { Location: `/paypal/return?token=${encodeURIComponent(token)}` });
        return res.end();
      }

      if (req.method === "GET" && url.pathname === "/paypal/return") {
        const order = await service.completeCheckout(url.searchParams.get("token"));
        res.writeHead(302, { Location: `/order/${order.orderId}?key=${order.accessKey}` });
        return res.end();
      }

      if (req.method === "GET" && parts[0] === "order" && parts.length === 2) {
        const view = service.orderView(parts[1]);
        const key = url.searchParams.get("key") || "";
        if (view.status !== "paid" || view.accessKey !== key) return send(res, 403, page(`<h1>No access</h1><p>This order is ${esc(view.status)}.</p>`));
        const action = view.kind === "file"
          ? `<a class="btn" href="/download/${esc(view.orderId)}?key=${esc(key)}">Download file</a>`
          : `<p>Your ticket code: <strong>${esc(view.orderId.toUpperCase())}</strong></p>`;
        return send(res, 200, page(`<h1>Payment received</h1><p>${esc(view.title)}</p>${action}`));
      }

      if (req.method === "GET" && parts[0] === "download" && parts.length === 2) {
        const file = service.download(parts[1], url.searchParams.get("key"));
        if (!file) return send(res, 403, page("<h1>No access</h1><p>This order is not paid or was refunded.</p>"));
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${file.fileName.replace(/[^\w.\- ]/g, "_")}"`,
        });
        return res.end(file.content);
      }

      // The client's gallery (mock store). Looking at it also re-reads the invoice, the fallback when a webhook is late.
      if (jobs && req.method === "GET" && parts[0] === "client" && parts.length === 2) {
        const key = url.searchParams.get("key") || "";
        if (!jobs.clientView(parts[1], key)) return send(res, 403, page("<h1>No access</h1><p>This link is not valid.</p>"));
        if (jobs.clientView(parts[1], key).status === "invoiced") await jobs.refreshJob(parts[1]).catch(() => {});
        const v = jobs.clientView(parts[1], key);
        const files = v.inPortal
          ? ""
          : v.files
              .map((name, i) => (v.unlocked ? `<li><a href="/client/${esc(v.jobId)}/file/${i}?key=${esc(key)}">${esc(name)}</a></li>` : `<li>${esc(name)} <small>(locked)</small></li>`))
              .join("");
        const portal = v.inPortal && v.clientUrl ? `<p><a class="btn" href="${esc(v.clientUrl)}">Open your client portal</a></p>` : "";
        const action = v.unlocked
          ? v.inPortal
            ? `<p>Your files are ready to download in your client portal.</p>${portal}`
            : "<p>Your files are ready to download.</p>"
          : v.status === "invoiced" && v.payUrl
            ? `<p>Pay the invoice to unlock your files.</p><p><a class="btn" href="${esc(v.payUrl)}">Pay ${esc(v.price)} ${esc(v.currency)} with PayPal</a></p>${portal}`
            : v.status === "refunded"
              ? "<p>This delivery was refunded.</p>"
              : v.status === "review"
                ? "<p>We received a payment that needs a check. Your photographer will be in touch.</p>"
                : "<p>Your photographer has not sent the invoice yet.</p>";
        return send(res, 200, page(`<h1>${esc(v.title)}</h1>${action}${files ? `<ul>${files}</ul>` : ""}`));
      }

      if (jobs && req.method === "GET" && parts[0] === "client" && parts[2] === "file" && parts.length === 4) {
        const file = jobs.clientFile(parts[1], url.searchParams.get("key"), parts[3]);
        if (!file) return send(res, 403, page("<h1>No access</h1><p>These files unlock once the invoice is paid.</p>"));
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${file.name.replace(/[^\w.\- ]/g, "_")}"`,
        });
        return res.end(file.content);
      }

      // Mock invoice page, only reachable when running without PayPal credentials: the client pays the invoice in full.
      if (jobs && req.method === "GET" && url.pathname === "/mock/invoice" && paypal.mock) {
        const invoiceId = url.searchParams.get("id") || "";
        const job = jobs.listJobs().find((j) => j.invoiceId === invoiceId);
        if (!job) return send(res, 404, page("<h1>Not found</h1>"));
        paypal.payInvoice(invoiceId);
        res.writeHead(302, { Location: `/client/${job.jobId}?key=${jobs.accessKeyFor(job.jobId)}` });
        return res.end();
      }

      send(res, 404, page("<h1>Not found</h1>"));
    } catch (err) {
      send(res, 400, page(`<h1>Something went wrong</h1><p>${esc(err.message)}</p>`));
    }
  });
}
