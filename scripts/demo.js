// Scripted run of the whole story in mock mode: sell a file, sell tickets, refund. No credentials needed.
import { bootstrap } from "../src/bootstrap.js";

const app = bootstrap({ PORT: "3100" });
const call = async (name, args) => JSON.parse(JSON.stringify(await app.tools.find((t) => t.name === name).run(args)));
const say = (s) => console.log(`\n== ${s}`);
const get = (path) => fetch(`${app.baseUrl}${path}`, { redirect: "manual" });
const buy = async (productId) => {
  const res = await fetch(`${app.baseUrl}/buy/${productId}/checkout`, { method: "POST", redirect: "manual" });
  const approve = res.headers.get("location");
  const back = await fetch(approve, { redirect: "manual" });
  return back.headers.get("location");
};

await new Promise((r) => app.web.listen(app.port, r));

say("Assistant: sell a file for 20 USD");
const share = await call("create_paid_share", { title: "Brand kit", fileName: "brand-kit.txt", content: "logos, colours, fonts", price: 20 });
console.log(share);

say("Buyer opens the link before paying: download is blocked");
const view = await get(`/download/none?key=none`);
console.log("status", view.status);

say("Buyer pays with PayPal (mock approval) and gets the file");
const returnPath = await buy(share.productId);
const orderLoc = (await get(returnPath)).headers.get("location");
console.log("redirected to", orderLoc);
const [, , orderId] = orderLoc.split("?")[0].split("/");
const key = new URL(orderLoc, app.baseUrl).searchParams.get("key");
const file = await get(`/download/${orderId}?key=${key}`);
console.log("download status", file.status, "-", await file.text());

say("Assistant: create an event with 1 seat at 15 USD");
const event = await call("create_event", { title: "Launch party", startsAt: "2026-12-01T18:00:00Z", capacity: 1, price: 15 });
console.log(event);
const ticketReturn = await buy(event.productId);
await get(ticketReturn);
console.log("second buyer:", (await fetch(`${app.baseUrl}/buy/${event.productId}/checkout`, { method: "POST" })).status === 400 ? "sold out, blocked" : "unexpected");

say("Assistant: sales status, then refund the file order");
console.log(JSON.stringify(await call("get_sales_status", {}), null, 2));
console.log(await call("refund_order", { orderId }));
const after = await get(`/download/${orderId}?key=${key}`);
console.log("download after refund:", after.status);

app.web.close();
