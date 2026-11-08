// Picks the real PayPal sandbox client when credentials exist, otherwise the in-memory mock.
import { createPayPalClient } from "./paypal.js";
import { createMockPayPal } from "./mock-paypal.js";
import { createService } from "./service.js";
import { createJobService } from "./jobs.js";
import { createMockStore } from "./stores.js";
import { createNotifier } from "./notify.js";
import { createWebServer } from "./web.js";
import { createTools } from "./tools.js";
import { createMcpHandler } from "./mcp.js";

export function bootstrap(env = process.env, { fetchImpl = fetch } = {}) {
  const port = Number(env.PORT || 3000);
  // Render sets RENDER_EXTERNAL_URL; BASE_URL wins if given.
  const baseUrl = env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  const paypal =
    env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
      ? createPayPalClient({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, fetchImpl })
      : createMockPayPal({ baseUrl });
  const service = createService({ paypal, baseUrl });
  const store = createMockStore({ baseUrl });
  const notify = createNotifier({ url: env.ZAPIER_WEBHOOK_URL, fetchImpl });
  const jobs = createJobService({ paypal, store, baseUrl, notify });
  const tools = createTools(service, jobs);
  const mcp = createMcpHandler(tools);
  const web = createWebServer({ service, jobs, paypal, baseUrl, mcp, mcpToken: env.MCP_TOKEN, webhookId: env.PAYPAL_WEBHOOK_ID });
  return { port, baseUrl, paypal, service, jobs, store, web, tools, mcp };
}
