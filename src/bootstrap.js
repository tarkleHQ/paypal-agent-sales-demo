// Picks the real PayPal sandbox client when credentials exist, otherwise the in-memory mock.
import { createPayPalClient } from "./paypal.js";
import { createMockPayPal } from "./mock-paypal.js";
import { createService } from "./service.js";
import { createWebServer } from "./web.js";
import { createTools } from "./tools.js";

export function bootstrap(env = process.env) {
  const port = Number(env.PORT || 3000);
  const baseUrl = env.BASE_URL || `http://localhost:${port}`;
  const paypal =
    env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET
      ? createPayPalClient({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET })
      : createMockPayPal({ baseUrl });
  const service = createService({ paypal, baseUrl });
  const web = createWebServer({ service, paypal, baseUrl });
  return { port, baseUrl, paypal, service, web, tools: createTools(service) };
}
