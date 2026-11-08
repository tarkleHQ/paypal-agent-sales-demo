// In-memory stand-in for the PayPal client so the demo and tests run with no credentials.
// It follows the same rules that matter here: an order cannot be captured until the buyer approves it.
import { PayPalError, normalizeInvoice } from "./paypal.js";

export function createMockPayPal({ baseUrl = "http://localhost:3000" } = {}) {
  const orders = new Map();
  const invoices = new Map();
  let counter = 0;

  function get(id) {
    const order = orders.get(id);
    if (!order) throw new PayPalError("RESOURCE_NOT_FOUND", 404);
    return order;
  }

  return {
    mock: true,

    async createOrder({ amount, currency }) {
      const id = `MOCKORDER${++counter}`;
      orders.set(id, { id, amount, currency, status: "CREATED" });
      return { id, approveUrl: `${baseUrl}/mock/approve?token=${id}` };
    },

    // What the buyer does on PayPal's approval page.
    approve(id) {
      get(id).status = "APPROVED";
    },

    async captureOrder(id) {
      const order = get(id);
      if (order.status === "COMPLETED") {
        return { status: "COMPLETED", captureId: order.captureId, amount: order.amount, currency: order.currency };
      }
      if (order.status !== "APPROVED") throw new PayPalError("ORDER_NOT_APPROVED", 422);
      order.status = "COMPLETED";
      order.captureId = `MOCKCAPTURE${id}`;
      return { status: "COMPLETED", captureId: order.captureId, amount: order.amount, currency: order.currency };
    },

    // Mock deliveries are trusted only when they carry the header the tests send.
    async verifyWebhook({ headers }) {
      return headers["x-mock-signature"] === "valid";
    },

    async refundCapture(captureId) {
      const invoice = [...invoices.values()].find((i) => i.paymentId === captureId);
      if (invoice) {
        if (invoice.status === "REFUNDED") throw new PayPalError("CAPTURE_FULLY_REFUNDED", 422);
        invoice.status = "REFUNDED";
        return { id: `MOCKREFUND${invoice.id}`, status: "COMPLETED" };
      }
      const order = [...orders.values()].find((o) => o.captureId === captureId);
      if (!order) throw new PayPalError("RESOURCE_NOT_FOUND", 404);
      if (order.refunded) throw new PayPalError("CAPTURE_FULLY_REFUNDED", 422);
      order.refunded = true;
      return { id: `MOCKREFUND${order.id}`, status: "COMPLETED" };
    },

    // ---- Invoicing, same rules as the real API: a draft is not payable until sent, and PAID only when the full amount is paid.
    async createInvoice({ reference, currency, amount, itemName, note, memo, recipient }) {
      const existing = [...invoices.values()].find((i) => i.reference === reference);
      if (existing) return view(existing);
      const id = `INV2-MOCK-${++counter}`;
      invoices.set(id, { id, reference, currency, amount, itemName, note, memo, recipient, status: "DRAFT", paid: null, paymentId: null });
      return view(invoices.get(id));
    },

    async listInvoiceIds() {
      return [...invoices.keys()].reverse();
    },

    async sendInvoice(id) {
      const invoice = getInvoiceRow(id);
      if (invoice.status === "DRAFT") invoice.status = "SENT";
      return view(invoice);
    },

    async getInvoice(id) {
      return view(getInvoiceRow(id));
    },

    // What the client does on PayPal's invoice page. `amount` lets a test pay less than the total.
    payInvoice(id, amount) {
      const invoice = getInvoiceRow(id);
      if (invoice.status !== "SENT" && invoice.status !== "UNPAID") throw new PayPalError("INVOICE_NOT_PAYABLE", 422);
      invoice.paid = amount ?? invoice.amount;
      invoice.status = invoice.paid === invoice.amount ? "PAID" : "PARTIALLY_PAID";
      invoice.paymentId = `MOCKPAY${invoice.id}`;
    },
  };

  function getInvoiceRow(id) {
    const invoice = invoices.get(id);
    if (!invoice) throw new PayPalError("RESOURCE_NOT_FOUND", 404);
    return invoice;
  }

  function view(i) {
    return normalizeInvoice({
      id: i.id,
      status: i.status,
      detail: { reference: i.reference, currency_code: i.currency, note: i.note, memo: i.memo, metadata: { recipient_view_url: i.status === "DRAFT" ? undefined : `${baseUrl}/mock/invoice?id=${encodeURIComponent(i.id)}` } },
      items: i.itemName ? [{ name: i.itemName }] : [],
      primary_recipients: i.recipient ? [{ billing_info: { email_address: i.recipient.email, name: { given_name: i.recipient.name } } }] : [],
      amount: { value: i.amount, currency_code: i.currency },
      payments: i.paid ? { paid_amount: { value: i.paid, currency_code: i.currency }, transactions: [{ type: "PAYPAL", payment_id: i.paymentId, method: "PAYPAL" }] } : undefined,
    });
  }
}
