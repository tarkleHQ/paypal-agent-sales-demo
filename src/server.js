#!/usr/bin/env node
// Hosted mode (for example on Render): buyer pages plus the HTTP MCP endpoint at /mcp, no stdio.
import { bootstrap } from "./bootstrap.js";

const app = bootstrap();
if (!app.paypal.mock && !process.env.BASE_URL && !process.env.RENDER_EXTERNAL_URL) {
  console.error("Set BASE_URL so PayPal can send buyers back to this server.");
  process.exit(1);
}
app.web.listen(app.port, "0.0.0.0", () => {
  console.error(
    `Listening on ${app.port} (${app.paypal.mock ? "mock PayPal" : "PayPal sandbox"}); /mcp ${process.env.MCP_TOKEN ? "enabled" : "disabled, set MCP_TOKEN"}`,
  );
});
