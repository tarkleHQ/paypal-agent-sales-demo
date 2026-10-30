// Prints a PayPal sandbox access token. PayPal's local MCP server (@paypal/mcp) reads it from
// PAYPAL_ACCESS_TOKEN. Sandbox tokens last a few hours, so run this again when it expires.
//   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/paypal-token.js
import { SANDBOX_BASE } from "../src/paypal.js";

const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox REST app).");
  process.exit(1);
}
const res = await fetch(`${SANDBOX_BASE}/v1/oauth2/token`, {
  method: "POST",
  headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`PayPal said ${res.status}: ${data.error_description || data.error || "auth failed"}`);
  process.exit(1);
}
console.error(`Token valid for about ${Math.round(data.expires_in / 3600)} hours.`);
console.log(data.access_token);
