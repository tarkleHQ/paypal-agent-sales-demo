// The tools an AI assistant can call. Each maps to one service method.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });

// Two-step approval for anything that emails a client or moves money: the first call changes nothing and returns a preview and a code
// bound to these exact inputs; only a second call with that code acts. A model cannot invent the code, and a code for one job or
// action does not work for another. Codes last 15 minutes.
const APPROVAL_MS = 15 * 60 * 1000;
function createApprovals(secret = randomBytes(32), now = () => Date.now()) {
  const sign = (action, inputs, issuedAt) => createHmac("sha256", secret).update(`${action}:${JSON.stringify(inputs)}:${issuedAt}`).digest("base64url");
  return {
    issue(action, inputs) {
      const issuedAt = now();
      return `${issuedAt}.${sign(action, inputs, issuedAt)}`;
    },
    valid(action, inputs, code) {
      if (typeof code !== "string" || !code.includes(".")) return false;
      const [at, mac] = code.split(".");
      const issuedAt = Number(at);
      if (!Number.isFinite(issuedAt) || now() - issuedAt > APPROVAL_MS || issuedAt > now()) return false;
      const expected = Buffer.from(sign(action, inputs, issuedAt));
      const given = Buffer.from(mac || "");
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
  };
}

export function createTools(service, jobs, { approvals = createApprovals() } = {}) {
  const approval = (action, inputs, what, preview) => ({
    approvalRequired: true,
    what,
    preview,
    approvalCode: approvals.issue(action, inputs),
    next: "Show this to the photographer. Only if they approve, call the same tool again with the same inputs and this approvalCode.",
  });

  const sellingTools = [
    {
      name: "create_paid_share",
      description: "Create a file that buyers must pay for through PayPal before they can download it. Returns the buyer link.",
      inputSchema: {
        type: "object",
        properties: {
          title: str("Name shown to the buyer"),
          fileName: str("File name, e.g. brand-kit.zip"),
          content: str("Text content of the file (demo files are text)"),
          price: num("Price, e.g. 20 or 19.99"),
          currency: str("USD, EUR or GBP (default USD)"),
        },
        required: ["title", "fileName", "price"],
      },
      run: (a) => service.createPaidShare(a),
    },
    {
      name: "create_event",
      description: "Create an event with paid tickets and a seat limit. Returns the buyer link.",
      inputSchema: {
        type: "object",
        properties: {
          title: str("Event name"),
          startsAt: str("Start time, ISO 8601"),
          capacity: num("Number of seats"),
          price: num("Ticket price"),
          currency: str("USD, EUR or GBP (default USD)"),
        },
        required: ["title", "startsAt", "capacity", "price"],
      },
      run: (a) => service.createEvent(a),
    },
    {
      name: "get_sales_status",
      description: "List every product with paid and refunded counts, revenue, seats left and each order's status.",
      inputSchema: { type: "object", properties: {} },
      run: () => service.salesStatus(),
    },
    {
      name: "refund_order",
      description: "Refund a paid order in full. The buyer's download or ticket stops working and a seat is released.",
      inputSchema: { type: "object", properties: { orderId: str("Order id from get_sales_status") }, required: ["orderId"] },
      run: (a) => service.refund(a.orderId),
    },
  ];
  if (!jobs) return sellingTools;

  const jobTools = [
    {
      name: "create_client_job",
      description:
        "Start a client delivery: a photographer's finished files for one client, delivered locked in the client's portal and unlocked when the client pays the PayPal invoice. From what the photographer says, write a short title (for example 'Smith wedding, full gallery'), the client's name and email, the price, and an optional short note to the client. Sends nothing and charges nothing; use send_job_invoice next.",
      inputSchema: {
        type: "object",
        properties: {
          title: str("What is delivered, shown on the invoice"),
          clientName: str("The client's name"),
          clientEmail: str("The client's email; PayPal sends the invoice there"),
          price: num("Total price, e.g. 1500 or 1499.99"),
          currency: str("USD, EUR or GBP (default USD)"),
          note: str("Optional short note to the client, shown on the invoice"),
          files: { type: "array", description: "The files to deliver", items: { type: "object", properties: { name: str("File name"), content: str("Text content (demo files are text)") }, required: ["name"] } },
        },
        required: ["title", "clientEmail", "price", "files"],
      },
      run: (a) => jobs.createJob(a),
    },
    {
      name: "send_job_invoice",
      description:
        "Create and send the PayPal invoice for a job. PayPal emails the client a pay link. Needs the photographer's approval: the first call sends nothing and returns a preview and an approvalCode; call again with the same jobId and the approvalCode only after they approve.",
      inputSchema: { type: "object", properties: { jobId: str("From create_client_job"), approvalCode: str("From the first call, after the photographer approved") }, required: ["jobId"] },
      run: async ({ jobId, approvalCode }) => {
        const job = jobs.getJob(jobId);
        if (job.status !== "draft") return job;
        if (!approvals.valid("send_job_invoice", { jobId }, approvalCode)) {
          return approval("send_job_invoice", { jobId }, "Email this client a PayPal invoice", { to: job.client.email, title: job.title, amount: `${job.price} ${job.currency}`, files: job.files.length });
        }
        return jobs.sendInvoice(jobId);
      },
    },
    {
      name: "get_job_status",
      description: "Where a job stands (draft, invoiced, delivered, refunded, cancelled, or review when a payment did not match). Re-reads the invoice from PayPal. Without jobId, lists every job.",
      inputSchema: { type: "object", properties: { jobId: str("Optional: one job") } },
      run: async ({ jobId } = {}) => (jobId ? jobs.refreshJob(jobId) : jobs.listJobs()),
    },
    {
      name: "refund_job",
      description:
        "Refund a paid job in full through PayPal and lock the client's files again. Needs the photographer's approval: the first call refunds nothing and returns a preview and an approvalCode; call again with the same jobId and the approvalCode only after they approve.",
      inputSchema: { type: "object", properties: { jobId: str("From create_client_job"), approvalCode: str("From the first call, after the photographer approved") }, required: ["jobId"] },
      run: async ({ jobId, approvalCode }) => {
        const job = jobs.getJob(jobId);
        if (!approvals.valid("refund_job", { jobId }, approvalCode)) {
          return approval("refund_job", { jobId }, "Refund this client in full and lock their files", { to: job.client.email, title: job.title, amount: `${job.price} ${job.currency}`, status: job.status });
        }
        return jobs.refundJob(jobId);
      },
    },
  ];
  return [...jobTools, ...sellingTools];
}

export { createApprovals };
