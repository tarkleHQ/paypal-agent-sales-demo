// In-memory stand-in for the PayPal client so the demo and tests run with no credentials.
// It follows the same rules that matter here: an order cannot be captured until the buyer approves it.
import { PayPalError } from "./paypal.js";

export function createMockPayPal({ baseUrl = "http://localhost:3000" } = {}) {
  const orders = new Map();
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
      const order = [...orders.values()].find((o) => o.captureId === captureId);
      if (!order) throw new PayPalError("RESOURCE_NOT_FOUND", 404);
      if (order.refunded) throw new PayPalError("CAPTURE_FULLY_REFUNDED", 422);
      order.refunded = true;
      return { id: `MOCKREFUND${order.id}`, status: "COMPLETED" };
    },
  };
}
