# PayPal agent sales demo

An AI assistant delivers a photographer's client gallery, paid by PayPal invoice, and sells files and tickets through PayPal checkout. It runs as an MCP server, so any MCP client (Claude, for example) can call its tools. **PayPal sandbox only**: the code refuses any other PayPal URL, and no real money moves.

## Client delivery: a photographer's gallery, paid by PayPal invoice

The main flow. A photographer tells the assistant what to deliver; the assistant creates a **job** (the client, the files, the price), and after the photographer approves, sends a **PayPal invoice**. The client opens their gallery and sees the files locked, with a button to pay. When PayPal reports the invoice paid, the gallery unlocks. A refund locks it again.

| Tool | What the assistant can do |
| --- | --- |
| `create_client_job` | Start a delivery for one client: title, client name and email, price, files. Sends nothing. |
| `send_job_invoice` | Create and send the PayPal invoice. Asks for the photographer's approval first. |
| `get_job_status` | Where a job stands, re-read from PayPal. Without a job id, lists every job. |
| `refund_job` | Refund the client in full and lock the files. Asks for approval first. |

Rules the code enforces:

- The gallery unlocks only after the invoice is **read back from PayPal** with status `PAID` and the full amount and currency. A webhook is signature-checked, then only tells the app to look; its body is never trusted.
- A partial payment unlocks nothing. A payment for the wrong amount puts the job in `review` and unlocks nothing.
- A refund (from the assistant, or made in PayPal) or a reversal locks the gallery again. A cancelled invoice cancels the job.
- Sending or refunding needs a second call with an approval code bound to that job and action, valid for 15 minutes. A model cannot invent one.
- If the webhook is late or missing, opening the gallery re-reads the invoice.
- Optional: set `ZAPIER_WEBHOOK_URL` to a Zapier Catch Hook to receive `job.paid`, `job.delivered` and `job.refunded`. A failing hook never blocks an unlock.

PayPal webhooks for this flow: `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.REFUNDED`, `INVOICING.INVOICE.CANCELLED`, plus the capture events below.

### Deliver into the client's Tarkle portal

Without Tarkle settings, the gallery is a page of this app, so everything runs with no accounts. Set these to deliver into the client's own [Tarkle](https://tarkle.com) client portal instead (the workspace must be on Pro, which includes the client portal):

| Variable | Value |
| --- | --- |
| `TARKLE_API_BASE` | `https://tarkle.com/api/v1` |
| `TARKLE_API_KEY` | An API key from Tarkle's Settings > API. Keep it on the server only. |
| `TARKLE_WORKSPACE_KEY` | The workspace's 8-character key (`GET /api/v1/workspaces` lists them) |
| `TARKLE_PORTAL_URL` | The portal address to show the client, for example `https://yourstudio.tarkle.com/portal` |

What happens, all through Tarkle's public API:

1. **Job created:** the client is found or added as a contact, the files are uploaded into a new folder, and the folder is shared as a **view-only** transfer with a random password nobody is told. The transfer is delivered to the contact's portal. No email yet.
2. **Invoice sent** (after the photographer approves): the contact's portal access is turned on, and Tarkle emails the portal invite.
3. **Invoice paid:** `PATCH /transfers/{id} { "view_only": false }`, so the client can download in their portal.
4. **Refund or reversal:** `{ "view_only": true }` again.

Every write sends an `Idempotency-Key` fixed per job and step, so a retry never creates anything twice. If Tarkle fails to unlock, the webhook answers an error so PayPal retries it.

## Selling files and tickets (earlier flow)

## What it does

| Tool | What the assistant can do |
| --- | --- |
| `create_paid_share` | Make a file that must be paid for before it downloads. Returns a buyer link. |
| `create_event` | Make an event with paid tickets and a seat limit. Returns a buyer link. |
| `get_sales_status` | See paid and refunded orders, revenue and seats left. |
| `refund_order` | Refund an order in full. Access is revoked and the seat is released. |

Buyers open the link, pay with PayPal, and come back to a page that unlocks the file or shows a ticket code.

## Rules the code enforces

- A file unlocks only after PayPal reports the payment **captured**, and the captured amount matches the price.
- Returning from PayPal without approving unlocks nothing.
- Tickets are held for 10 minutes while the buyer pays. An expired hold releases the seat. If it sold out meanwhile, the late buyer is **not charged**.
- Refunds revoke access immediately and cannot be repeated.
- Orders and refunds send PayPal idempotency ids, so a retry does not double charge or double refund.

## Run it

Needs Node 20 or later. No dependencies to install.

```sh
npm test        # 43 tests, no credentials needed
npm run demo    # scripted story: sell a file, sell a ticket, refund
npm start       # hosted mode: buyer pages plus HTTP MCP at /mcp on http://localhost:3000
npm run stdio   # MCP over stdio for local clients, plus the buyer pages
```

Without credentials it uses an in-memory mock of PayPal. To use the real sandbox, create a sandbox REST app at developer.paypal.com and set:

```sh
export PAYPAL_CLIENT_ID=...
export PAYPAL_CLIENT_SECRET=...
export BASE_URL=http://localhost:3000   # where PayPal sends the buyer back
```

Add it to an MCP client, for example in Claude Desktop's config:

```json
{ "mcpServers": { "paypal-sales": { "command": "node", "args": ["/path/to/src/mcp-server.js"] } } }
```

## Webhooks

Register a webhook in the PayPal developer dashboard pointing at `<your url>/paypal/webhook`, subscribe it to `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED` and `PAYMENT.CAPTURE.DENIED`, and set its id as `PAYPAL_WEBHOOK_ID`.

- Every delivery is checked with PayPal's `verify-webhook-signature` call before anything changes. Without `PAYPAL_WEBHOOK_ID` the endpoint does not exist in real mode.
- `CHECKOUT.ORDER.APPROVED` captures the payment when the buyer approved on PayPal but closed the tab before coming back.
- `PAYMENT.CAPTURE.REFUNDED` and `REVERSED` revoke access when money goes back to the buyer outside this app, for example in a dispute.
- Deliveries are de-duplicated by event id, and the captured amount is checked against the price.

## Use it with PayPal's own MCP server

PayPal publishes an MCP server of its own (`@paypal/mcp`, also hosted at `https://mcp.sandbox.paypal.com`). The two servers do different jobs, so an assistant can use both:

- **This server** sells access-gated files and tickets: it creates the product, holds seats, unlocks only after a verified capture, and refunds.
- **PayPal's server** covers the PayPal side: invoices, transactions, disputes and merchant insights (see PayPal's tool list at developer.paypal.com/ai-tools/agent-tools/).

Example prompts once both are connected: "Sell this brand kit for $20", "How much did I earn this week?", "Do I have any open disputes?", "Refund the last order."

`mcp-config.example.json` shows both servers in a Claude Desktop style config. PayPal's local server needs a sandbox access token, which `node scripts/paypal-token.js` prints (it expires after a few hours). PayPal's own docs give the remote server's header as `Authorization: Bearer <auth_header>` without saying how to build the value, so this repo uses the local `npx` server for PayPal. The config format for Claude Code specifically is not covered by PayPal's docs.

## Host it on Render

`render.yaml` is a Render Blueprint. Connect the repo in Render, then set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in the dashboard. Render generates `MCP_TOKEN` for you and supplies the public URL.

The server then exposes:

- `/buy/...` buyer pages, and the PayPal return URL
- `/healthz` health check
- `/mcp` MCP over HTTP (one JSON-RPC message per POST), protected by `Authorization: Bearer <MCP_TOKEN>`

`/mcp` is switched off when `MCP_TOKEN` is not set. Its tools create products and refund orders, so it should never be open on a public URL.

Run a single instance only, because state is in memory. A free instance sleeps when idle, so use a paid one while people are testing.

## Known limits

- Storage is in memory. A restart forgets everything.
- Files are text only, and refunds are always full.
- The real-sandbox path, including webhook verification, is covered by unit tests against a stubbed `fetch`, but it has not yet been run against live PayPal sandbox credentials.

## Licence

MIT.
