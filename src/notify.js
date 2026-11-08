// Optional outgoing events (for example a Zapier Catch Hook in ZAPIER_WEBHOOK_URL): job.paid, job.delivered, job.refunded.
// Best effort: a failure is logged and never blocks or changes a job.
export function createNotifier({ url, fetchImpl = fetch, log = (...a) => console.error(...a) } = {}) {
  if (!url) return async () => {};
  if (!/^https:\/\//.test(url)) throw new Error("ZAPIER_WEBHOOK_URL must be an https URL.");
  return async (type, payload) => {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, occurred_at: new Date().toISOString(), ...payload }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) log(`[notify] ${type} answered ${res.status}`);
    } catch (err) {
      log(`[notify] ${type} failed: ${err.message}`);
    }
  };
}
