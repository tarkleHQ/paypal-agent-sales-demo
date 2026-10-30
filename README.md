# PayPal agent sales demo

An AI assistant sells things through PayPal checkout. It runs as an MCP server, so any MCP client (Claude, for example) can call its tools. **PayPal sandbox only**: the code refuses any other PayPal URL, and no real money moves.

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
npm test        # 11 tests, no credentials needed
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
- Confirmation happens when the buyer returns from PayPal. A production app would also verify PayPal webhooks (`PAYMENT.CAPTURE.COMPLETED`) so a buyer who closes the tab is still handled.
- Files are text only, and refunds are always full.
- The real-sandbox path is covered by unit tests against a stubbed `fetch`, but it has not yet been run against live PayPal sandbox credentials.

## Licence

MIT.
