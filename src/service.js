// Commerce core: products, checkout, access and refunds. The payment provider is injected.
import { randomBytes } from "node:crypto";

const HOLD_MS = 10 * 60 * 1000;
const CURRENCIES = ["USD", "EUR", "GBP"];
const MAX_CENTS = 1_000_000;

export function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Price must be a positive number.");
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6) throw new Error("Price can have at most 2 decimals.");
  if (cents > MAX_CENTS) throw new Error("Price is above the demo limit of 10,000.00.");
  return cents;
}

export const fromCents = (cents) => (cents / 100).toFixed(2);

export function createService({ paypal, baseUrl, now = () => Date.now() }) {
  const products = new Map();
  const orders = new Map();
  const seenEvents = new Set();
  const newId = (prefix) => `${prefix}_${randomBytes(5).toString("hex")}`;

  function currencyOf(currency = "USD") {
    const c = String(currency).toUpperCase();
    if (!CURRENCIES.includes(c)) throw new Error(`Currency must be one of ${CURRENCIES.join(", ")}.`);
    return c;
  }

  function takenSeats(productId, exceptOrderId) {
    let taken = 0;
    for (const o of orders.values()) {
      if (o.productId !== productId || o.id === exceptOrderId) continue;
      if (o.status === "paid" || (o.status === "pending" && o.heldUntil > now())) taken += 1;
    }
    return taken;
  }

  function available(product, exceptOrderId) {
    return product.kind === "ticket" ? product.capacity - takenSeats(product.id, exceptOrderId) : null;
  }

  function mustGetProduct(id) {
    const p = products.get(id);
    if (!p) throw new Error("Unknown product.");
    return p;
  }

  return {
    createPaidShare({ title, fileName, content, price, currency }) {
      if (!title || !fileName) throw new Error("title and fileName are required.");
      const product = {
        id: newId("share"),
        kind: "file",
        title: String(title),
        fileName: String(fileName),
        content: String(content ?? ""),
        cents: toCents(price),
        currency: currencyOf(currency),
      };
      products.set(product.id, product);
      return { productId: product.id, buyUrl: `${baseUrl}/buy/${product.id}` };
    },

    createEvent({ title, startsAt, capacity, price, currency }) {
      if (!title || !startsAt) throw new Error("title and startsAt are required.");
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10_000) throw new Error("capacity must be a whole number from 1 to 10000.");
      const product = {
        id: newId("event"),
        kind: "ticket",
        title: String(title),
        startsAt: String(startsAt),
        capacity,
        cents: toCents(price),
        currency: currencyOf(currency),
      };
      products.set(product.id, product);
      return { productId: product.id, buyUrl: `${baseUrl}/buy/${product.id}` };
    },

    publicProduct(id) {
      const p = mustGetProduct(id);
      return {
        id: p.id,
        kind: p.kind,
        title: p.title,
        startsAt: p.startsAt,
        price: fromCents(p.cents),
        currency: p.currency,
        seatsLeft: available(p),
      };
    },

    // Creates the PayPal order and, for tickets, holds a seat until it is paid or the hold ends.
    async startCheckout(productId) {
      const product = mustGetProduct(productId);
      if (product.kind === "ticket" && available(product) <= 0) throw new Error("Sold out.");
      const orderId = newId("order");
      const created = await paypal.createOrder({
        amount: fromCents(product.cents),
        currency: product.currency,
        description: product.title.slice(0, 120),
        referenceId: orderId,
        returnUrl: `${baseUrl}/paypal/return`,
        cancelUrl: `${baseUrl}/buy/${product.id}`,
      });
      orders.set(orderId, {
        id: orderId,
        productId,
        paypalOrderId: created.id,
        status: "pending",
        heldUntil: now() + HOLD_MS,
        accessKey: randomBytes(16).toString("hex"),
      });
      return { orderId, approveUrl: created.approveUrl };
    },

    // Called when the buyer returns from PayPal. Access is granted only after a verified capture.
    async completeCheckout(paypalOrderId) {
      const order = [...orders.values()].find((o) => o.paypalOrderId === paypalOrderId);
      if (!order) throw new Error("Unknown order.");
      if (order.status === "paid" || order.status === "refunded") return this.orderView(order.id);
      const product = mustGetProduct(order.productId);

      if (product.kind === "ticket" && order.heldUntil <= now() && available(product, order.id) <= 0) {
        order.status = "expired";
        throw new Error("The seat hold expired and the event sold out. You were not charged.");
      }

      const capture = await paypal.captureOrder(paypalOrderId);
      if (capture.status !== "COMPLETED") {
        order.status = "failed";
        throw new Error(`Payment was not completed (${capture.status}).`);
      }
      if (capture.amount !== fromCents(product.cents) || capture.currency !== product.currency) {
        order.status = "failed";
        throw new Error("Captured amount does not match the price. Order flagged for review.");
      }
      order.status = "paid";
      order.captureId = capture.captureId;
      order.paidAt = now();
      return this.orderView(order.id);
    },

    orderView(orderId) {
      const order = orders.get(orderId);
      if (!order) throw new Error("Unknown order.");
      const product = mustGetProduct(order.productId);
      return {
        orderId: order.id,
        productId: product.id,
        kind: product.kind,
        title: product.title,
        status: order.status,
        accessKey: order.status === "paid" ? order.accessKey : undefined,
      };
    },

    findOrderByPayPalId(paypalOrderId) {
      return [...orders.values()].find((o) => o.paypalOrderId === paypalOrderId)?.id;
    },

    // The file is returned only for a paid, non-refunded order with the matching key.
    download(orderId, accessKey) {
      const order = orders.get(orderId);
      if (!order || order.status !== "paid" || order.accessKey !== accessKey) return null;
      const product = mustGetProduct(order.productId);
      if (product.kind !== "file") return null;
      return { fileName: product.fileName, content: product.content };
    },

    async refund(orderId) {
      const order = orders.get(orderId);
      if (!order) throw new Error("Unknown order.");
      if (order.status !== "paid") throw new Error(`Only paid orders can be refunded (this one is ${order.status}).`);
      const product = mustGetProduct(order.productId);
      await paypal.refundCapture(order.captureId, { amount: fromCents(product.cents), currency: product.currency });
      order.status = "refunded";
      return { orderId, status: "refunded", amount: fromCents(product.cents), currency: product.currency };
    },

    // Handles a webhook event that has already passed signature verification. Safe to deliver twice.
    async handleWebhookEvent(event) {
      if (!event?.id || !event.event_type) return { handled: false, reason: "malformed event" };
      if (seenEvents.has(event.id)) return { handled: false, reason: "duplicate" };
      const r = event.resource || {};
      const byCapture = (id) => [...orders.values()].find((o) => o.captureId && o.captureId === id);
      const byPayPalOrder = (id) => [...orders.values()].find((o) => o.paypalOrderId === id);
      let result = { handled: false, reason: `ignored ${event.event_type}` };

      switch (event.event_type) {
        // The buyer approved but may have closed the tab before returning: capture now.
        case "CHECKOUT.ORDER.APPROVED": {
          const order = byPayPalOrder(r.id);
          if (!order) break;
          try {
            const view = await this.completeCheckout(r.id);
            result = { handled: true, orderId: view.orderId, status: view.status };
          } catch (err) {
            if (err.name === "PayPalError" && (err.status ?? 500) >= 500) throw err; // let PayPal retry
            result = { handled: false, reason: err.message };
          }
          break;
        }
        // Capture finished on PayPal's side. Same amount check as the return path.
        case "PAYMENT.CAPTURE.COMPLETED": {
          const order = byPayPalOrder(r.supplementary_data?.related_ids?.order_id);
          if (!order || order.status === "paid" || order.status === "refunded") break;
          const product = mustGetProduct(order.productId);
          if (r.amount?.value === fromCents(product.cents) && r.amount?.currency_code === product.currency) {
            order.status = "paid";
            order.captureId = r.id;
            order.paidAt = now();
          } else {
            order.status = "failed";
          }
          result = { handled: true, orderId: order.id, status: order.status };
          break;
        }
        // Money went back to the buyer outside this app (a dispute, or a refund made in PayPal).
        case "PAYMENT.CAPTURE.REFUNDED":
        case "PAYMENT.CAPTURE.REVERSED": {
          const upLink = r.links?.find((l) => l.rel === "up")?.href;
          const captureId = event.event_type === "PAYMENT.CAPTURE.REVERSED" ? r.id : upLink?.split("/").pop();
          const order = byCapture(captureId);
          if (!order || order.status !== "paid") break;
          order.status = "refunded";
          result = { handled: true, orderId: order.id, status: "refunded" };
          break;
        }
        case "PAYMENT.CAPTURE.DENIED": {
          const order = byPayPalOrder(r.supplementary_data?.related_ids?.order_id);
          if (!order || order.status !== "pending") break;
          order.status = "failed";
          result = { handled: true, orderId: order.id, status: "failed" };
          break;
        }
      }
      seenEvents.add(event.id);
      return result;
    },

    salesStatus() {
      return [...products.values()].map((p) => {
        const list = [...orders.values()].filter((o) => o.productId === p.id);
        const paid = list.filter((o) => o.status === "paid");
        return {
          productId: p.id,
          kind: p.kind,
          title: p.title,
          price: fromCents(p.cents),
          currency: p.currency,
          paid: paid.length,
          refunded: list.filter((o) => o.status === "refunded").length,
          revenue: fromCents(paid.length * p.cents),
          seatsLeft: available(p),
          orders: list.map((o) => ({ orderId: o.id, status: o.status })),
        };
      });
    },
  };
}
