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
