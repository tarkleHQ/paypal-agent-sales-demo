// Minimal MCP (JSON-RPC 2.0) handler: initialize, tools/list, tools/call, ping.
const PROTOCOL_VERSION = "2024-11-05";

export function createMcpHandler(tools, info = { name: "paypal-agent-sales-demo", version: "0.1.0" }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  return async function handle(msg) {
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

    if (id === undefined) return null; // notifications get no response

    switch (method) {
      case "initialize":
        return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: info });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = byName.get(params?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
        try {
          const out = await tool.run(params.arguments || {});
          return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
        } catch (err) {
          return reply({ content: [{ type: "text", text: err.message }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  };
}
