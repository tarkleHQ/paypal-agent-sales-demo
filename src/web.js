// Buyer-facing pages: product page, PayPal return, download. No dependencies.
import { createServer } from "node:http";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout demo</title>
<style>body{font:16px system-ui;max-width:480px;margin:10vh auto;padding:0 16px;color:#111}button,a.btn{background:#0070ba;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:16px;cursor:pointer;text-decoration:none;display:inline-block}small{color:#555}</style></head>
<body>${body}<p><small>Sandbox demo. No real money moves.</small></p></body></html>`;

export function createWebServer({ service, paypal, baseUrl }) {
  const send = (res, status, html, headers = {}) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
    res.end(html);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
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

      send(res, 404, page("<h1>Not found</h1>"));
    } catch (err) {
      send(res, 400, page(`<h1>Something went wrong</h1><p>${esc(err.message)}</p>`));
    }
  });
}
