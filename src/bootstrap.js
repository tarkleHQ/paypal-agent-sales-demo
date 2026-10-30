// Picks the real PayPal sandbox client when credentials exist, otherwise the in-memory mock.
import { createPayPalClient } from "./paypal.js";
import { createMockPayPal } from "./mock-paypal.js";
import { createService } from "./service.js";
import { createWebServer } from "./web.js";
import { createTools } from "./tools.js";
import { createMcpHandler } from "./mcp.js";

export function bootstrap(env = process.env) {
  const port = Number(env.PORT || 3000);
  // Render sets RENDER_EXTERNAL_URL; BASE_URL wins if given.
  const baseUrl = env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  const paypal =
    env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
      ? createPayPalClient({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET })
      : createMockPayPal({ baseUrl });
  const service = createService({ paypal, baseUrl });
  const tools = createTools(service);
  const mcp = createMcpHandler(tools);
  const web = createWebServer({ service, paypal, baseUrl, mcp, mcpToken: env.MCP_TOKEN, webhookId: env.PAYPAL_WEBHOOK_ID });
  return { port, baseUrl, paypal, service, web, tools, mcp };
}
