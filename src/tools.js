// The tools an AI assistant can call. Each maps to one service method.
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });

export function createTools(service) {
  return [
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
}
