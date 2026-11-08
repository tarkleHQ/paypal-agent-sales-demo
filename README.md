# DUC Agency: client galleries, delivered the moment the client pays

A demo for **DUC Agency**, a photography studio for weddings, events and brands, built for the PayPal AI Hackathon on **PayPal** (Invoicing v2 and webhooks, sandbox) and **[Tarkle](https://tarkle.com)** (file storage and client portals).

**Live demo:** https://paypal-agent-sales-demo.onrender.com (free Render instance: the first visit after a quiet spell takes about a minute to wake up).

## The problem

A photographer finishes a wedding, then spends days chasing the invoice. Send the gallery first and some clients never pay; hold it back and the client waits, emails, and waits again. Payment and delivery live in two different places, and the photographer is the glue between them.

## What this does

The photographer says one sentence to an AI assistant:

> Deliver the Smith wedding gallery to Ana Smith (ana@example.com), $1,500.

1. **The assistant prepares the delivery.** It uploads the gallery into DUC Agency's Tarkle workspace and puts it in the client's own **client portal**, visible but locked.
2. **The photographer approves once.** The assistant shows who gets emailed and for how much; nothing is sent until the photographer says yes.
3. **PayPal sends the invoice.** The client gets PayPal's invoice email and a portal invite from Tarkle.
4. **The client pays. The gallery unlocks.** PayPal's webhook arrives; the app reads the invoice back from PayPal, checks it is fully paid for the right amount, and only then unlocks downloads in the client's portal.
5. **A refund locks it again**, whether the photographer asks the assistant or the money goes back through PayPal (a refund or a reversal).

No chasing, no "did you get my payment?", and the photographer never touches a download link.

## How it is built

```
 Photographer ──► AI assistant (any MCP client, e.g. Claude Desktop)
                     │  MCP tools: create_client_job · send_job_invoice · get_job_status · refund_job
                     ▼
          ┌──────────────────────────┐   Invoicing v2: create, send, read     ┌──────────────┐
          │  This app (Node, Render) │ ─────────────────────────────────────► │ PayPal       │
          │  jobs, approvals,        │ ◄───── webhooks (signature verified) ── │ (sandbox)    │
          │  webhook handling        │                                         └──────────────┘
          └──────────────────────────┘
                     │  Tarkle public API v1: contacts, folders, uploads, transfers
                     ▼
          ┌──────────────────────────┐        signs in         ┌──────────────┐
          │ Tarkle workspace         │ ◄──────────────────────── │ The client   │
          │ (DUC Agency) + portal    │   views, then downloads  └──────────────┘
          └──────────────────────────┘
```

**PayPal, used for real (sandbox):**

- **Invoicing v2:** create a draft invoice (the job id is the reference and the idempotency key), send it to the client, read it back.
- **Webhooks:** `INVOICING.INVOICE.PAID`, `.REFUNDED`, `.CANCELLED`, `PAYMENT.CAPTURE.REFUNDED`, `.REVERSED`. Every delivery is verified with `verify-webhook-signature`, de-duplicated, and only tells the app to **look**: the invoice is re-read from PayPal before anything changes.
- **Refunds:** `/v2/payments/captures/{id}/refund` with the payment recorded on the invoice.
- **PayPal's own MCP server** (`@paypal/mcp`) can run beside this one, for "how much did I earn this week?" or "any open disputes?" (see `mcp-config.example.json`).

**AI:** the assistant is any MCP client (we use Claude Desktop). It turns the photographer's sentence into the job (title, client, price, note) and calls the tools. Anything that emails a client or moves money needs a **second call with an approval code** bound to that exact job and action, valid for 15 minutes: a model cannot invent one, and a code for one job does not work for another.

**Tarkle:** the gallery is a view-only transfer delivered to the client's contact in DUC Agency's workspace; paying flips it to downloadable (`PATCH /transfers/{id} { "view_only": false }`). The app talks to Tarkle only through its public API, with an API key kept on the server.

## Rules the code enforces

- Unlock only on an invoice read back from PayPal with status `PAID`, the full amount and the right currency. A partial payment unlocks nothing; a wrong amount goes to `review` and unlocks nothing.
- A webhook body is never trusted, and a forged one is refused before anything is read.
- A refund or a reversal locks the gallery again; a cancelled invoice cancels the job.
- The client is not emailed before the photographer approves.
- Every Tarkle write carries an `Idempotency-Key` fixed per job and step, so a retry never creates a second contact, folder, upload or transfer. If Tarkle fails to unlock, the webhook answers an error so PayPal retries it.
- **Survives restarts with no database.** Each job also lives in its PayPal invoice: the reference is the job id, and the private memo holds the client's page key and the Tarkle delivery ids. After a restart (a sleeping free instance is woken by the very webhook that says "paid"), jobs are rebuilt from PayPal's own records.
- Sandbox only: the PayPal client refuses any non-sandbox URL.

## Try it

### 1. Hosted (no setup)

Open https://paypal-agent-sales-demo.onrender.com and select **Client portal login** to see DUC Agency's portal. The assistant connects to `https://paypal-agent-sales-demo.onrender.com/mcp` with a bearer token; the judges' token and the sandbox buyer account to pay a test invoice are in the submission's testing notes.

### 2. On your machine, no accounts at all

Needs Node 20 or later. No dependencies.

```sh
git clone https://github.com/tarkleHQ/paypal-agent-sales-demo && cd paypal-agent-sales-demo
npm test                      # 47 tests, no credentials needed
MCP_TOKEN=local npm start     # http://localhost:3000, MCP at /mcp
```

Without credentials, PayPal is an in-memory mock (with a "pay" page) and the gallery is a page of this app. The whole flow runs: create a job, approve, open the pay link, see the gallery unlock.

Connect an MCP client, for example Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "duc-agency": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3000/mcp", "--header", "Authorization: Bearer local"] } } }
```

or run it over stdio: `{ "command": "node", "args": ["/path/to/src/mcp-server.js"] }`.

### 3. Against the real PayPal sandbox and a Tarkle workspace

| Variable | What it is |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | A **sandbox** REST app from developer.paypal.com (Apps & Credentials, Sandbox), with Invoicing |
| `PAYPAL_WEBHOOK_ID` | A sandbox webhook pointing at `<your url>/paypal/webhook`, with the events listed above |
| `BASE_URL` | This app's public address (Render sets `RENDER_EXTERNAL_URL` itself) |
| `MCP_TOKEN` | The bearer token MCP clients must send; `/mcp` is off without it |
| `TARKLE_API_BASE` | Tarkle's API, e.g. `https://tarkle.com/api/v1` |
| `TARKLE_API_KEY` | An API key from Tarkle's Settings > API, for a workspace on Pro (the client portal is a Pro feature) |
| `TARKLE_WORKSPACE_KEY` | The workspace's 8-character key |
| `TARKLE_PORTAL_URL` | The client portal address shown to clients |
| `STUDIO_NAME` | Optional, defaults to `DUC Agency` |
| `ZAPIER_WEBHOOK_URL` | Optional Zapier Catch Hook: receives `job.paid`, `job.delivered`, `job.refunded` (best effort, never blocks an unlock) |

`node scripts/paypal-token.js` checks the PayPal credentials; `node scripts/live-check.js` creates one real job and sends its invoice.

## Deploy on Render

`render.yaml` is a Render Blueprint (one free web service, nothing else). Connect the repo, set the variables above in the dashboard (never in the repo), and register the PayPal webhook at `<service url>/paypal/webhook`.

## Built during the hackathon

This repo started on Oct 30, 2026 as a small "sell a file or a ticket through PayPal checkout" MCP demo (still here: `create_paid_share`, `create_event`, `get_sales_status`, `refund_order`). During the hackathon we built the client delivery flow: PayPal Invoicing v2, invoice webhooks, approval-gated assistant tools, the Tarkle client portal delivery, restart recovery from PayPal invoices, Zapier events and this home page. On the Tarkle side, the public API gained the portal and delivery endpoints this needs (`/contacts/{id}/portal-invite`, `/contacts/{id}/storage-limit`, `/transfers/{id}/contacts`, `PATCH /transfers/{id}`), and the public download routes now enforce view-only, passwords and email gates.

## Known limits

- Demo files are text; real photos would upload the same way (single-part uploads up to Tarkle's single-PUT size).
- Refunds are always full.
- The newest 100 invoices are read back after a restart.
- View only hides downloads; the client can still see the files in the portal before paying, so a studio would deliver watermarked previews first.

## Licence

MIT.
