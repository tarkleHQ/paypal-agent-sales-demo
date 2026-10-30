#!/usr/bin/env node
// Runs the MCP server on stdio and the buyer web pages on PORT, in one process.
import { createInterface } from "node:readline";
import { bootstrap } from "./bootstrap.js";
import { createMcpHandler } from "./mcp.js";

const app = bootstrap();
const handle = createMcpHandler(app.tools);

app.web.listen(app.port, () => {
  // stdout is reserved for the protocol, so logs go to stderr.
  console.error(`Buyer pages on ${app.baseUrl} (${app.paypal.mock ? "mock PayPal" : "PayPal sandbox"})`);
});

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const out = await handle(msg);
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
});
