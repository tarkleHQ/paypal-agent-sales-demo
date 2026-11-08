#!/usr/bin/env node
// Live check against the real PayPal sandbox and a real Tarkle workspace: creates one job, sends its invoice, then prints where things
// stand. Pay the invoice as the sandbox Personal account, then run again with JOB_ID=... to re-read and unlock.
// Needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, TARKLE_API_BASE, TARKLE_API_KEY, TARKLE_WORKSPACE_KEY in the environment.
import { bootstrap } from "../src/bootstrap.js";

const app = bootstrap({ ...process.env, PORT: process.env.PORT || "3399" });
if (app.paypal.mock || app.store.kind !== "tarkle") {
  console.error("Set the PayPal and Tarkle variables first (this script never runs in mock mode).");
  process.exit(1);
}
const job = await app.jobs.createJob({
  title: "Live check gallery",
  clientName: "Sandbox Client",
  clientEmail: process.env.CLIENT_EMAIL || "client@example.com",
  price: Number(process.env.PRICE || 25),
  note: "Sandbox test. No real money moves.",
  files: [{ name: "preview-1.txt", content: "Live check file 1" }, { name: "preview-2.txt", content: "Live check file 2" }],
});
console.log("created:", job.jobId, job.status, "| tarkle:", JSON.stringify(app.store.deliveryOf({ id: job.jobId })));
const sent = await app.jobs.sendInvoice(job.jobId);
console.log("sent:", sent.status, "| invoice:", sent.invoiceId, "| pay at:", sent.payUrl);
