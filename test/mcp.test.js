import test from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "../src/bootstrap.js";
import { createMcpHandler } from "../src/mcp.js";

test("MCP: list tools and sell a file end to end over HTTP", async () => {
  const app = bootstrap({ PORT: "3199" });
  const handle = createMcpHandler(app.tools);
  await new Promise((r) => app.web.listen(app.port, r));
  try {
    const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(init.result.serverInfo.name, "paypal-agent-sales-demo");
    assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);

    const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(list.result.tools.map((t) => t.name), ["create_paid_share", "create_event", "get_sales_status", "refund_order"]);

    const created = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_paid_share", arguments: { title: "Kit", fileName: "kit.txt", content: "hello", price: 20 } } });
    const { productId } = JSON.parse(created.result.content[0].text);

    const checkout = await fetch(`${app.baseUrl}/buy/${productId}/checkout`, { method: "POST", redirect: "manual" });
    const approved = await fetch(checkout.headers.get("location"), { redirect: "manual" });
    const done = await fetch(`${app.baseUrl}${approved.headers.get("location")}`, { redirect: "manual" });
    const loc = done.headers.get("location");
    const orderId = loc.split("?")[0].split("/")[2];
    const key = new URL(loc, app.baseUrl).searchParams.get("key");

    const file = await fetch(`${app.baseUrl}/download/${orderId}?key=${key}`);
    assert.equal(await file.text(), "hello");

    const refunded = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "refund_order", arguments: { orderId } } });
    assert.equal(JSON.parse(refunded.result.content[0].text).status, "refunded");
    assert.equal((await fetch(`${app.baseUrl}/download/${orderId}?key=${key}`)).status, 403);

    const bad = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "refund_order", arguments: { orderId: "nope" } } });
    assert.equal(bad.result.isError, true);
  } finally {
    app.web.close();
  }
});

test("HTTP /mcp: disabled without a token, bearer auth, one message per POST", async () => {
  const post = (app, body, token) =>
    fetch(`${app.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const open = bootstrap({ PORT: "3198" });
  await new Promise((r) => open.web.listen(open.port, r));
  try {
    assert.equal((await post(open, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 404);
  } finally {
    open.web.close();
  }

  const app = bootstrap({ PORT: "3197", MCP_TOKEN: "s3cret" });
  await new Promise((r) => app.web.listen(app.port, r));
  try {
    assert.equal((await post(app, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);
    assert.equal((await post(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong!")).status, 401);

    const ok = await post(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "s3cret");
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).result.tools.length, 4);

    assert.equal((await post(app, { jsonrpc: "2.0", method: "notifications/initialized" }, "s3cret")).status, 202);
    assert.equal((await post(app, "{nope", "s3cret")).status, 400);
    assert.equal((await post(app, [{ jsonrpc: "2.0", id: 1, method: "ping" }], "s3cret")).status, 400);
    assert.equal((await post(app, "x".repeat(200_000), "s3cret")).status, 413);
    assert.equal((await fetch(`${app.baseUrl}/mcp`, { headers: { Authorization: "Bearer s3cret" } })).status, 405);
    assert.equal((await fetch(`${app.baseUrl}/healthz`)).status, 200);
  } finally {
    app.web.close();
  }
});
