// The home page: a demo studio site for DUC Agency, a photography studio. Same navigation and hero as Tarkle's own home page
// (sticky 58px bar, 1024px wide; white hero with a faint drifting smoke, a two-tone headline and two rounded actions), drawn with
// plain HTML and CSS because this app has no build step. The only links are the client portal and this demo's source.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function homePage({ studioName = "DUC Agency", portalUrl = null, sourceUrl = "https://github.com/tarkleHQ/paypal-agent-sales-demo", year = new Date().getFullYear() } = {}) {
  const name = esc(studioName);
  const portal = portalUrl ? esc(portalUrl) : null;
  const navAction = portal
    ? `<a class="btn btn-primary btn-md" href="${portal}">Client portal login<span aria-hidden="true" class="arrow">→</span></a>`
    : "";
  const primary = portal
    ? `<a class="btn btn-primary btn-lg" href="${portal}">Log in to your client portal<span aria-hidden="true" class="arrow">→</span></a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} · Client galleries</title>
<meta name="description" content="${name} is a photography studio. Your finished gallery waits in your private client portal and unlocks the moment you pay the PayPal invoice.">
<style>
  :root { --brand: #714cb6; --ink: #1f1f30; --muted: #475467; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: #fff; -webkit-font-smoothing: antialiased; min-height: 100vh; display: flex; flex-direction: column; }
  a { color: inherit; }
  a:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; border-radius: 999px; }

  header { position: sticky; top: 0; z-index: 50; background: #fff; font-size: 13px; line-height: 24px; }
  .bar { margin: 0 auto; display: flex; height: 58px; width: 100%; max-width: 1024px; align-items: center; justify-content: space-between; padding: 0 16px; }
  .wordmark { font-size: 16px; font-weight: 600; letter-spacing: -0.3px; text-decoration: none; }

  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border-radius: 999px; font-weight: 500; text-decoration: none; white-space: nowrap; transition: background-color .15s; }
  .btn-md { height: 35px; padding: 0 16px; font-size: 14px; }
  .btn-lg { height: 40px; padding: 0 20px; font-size: 14px; }
  .btn-primary { background: var(--brand); color: #fff; }
  .btn-primary:hover { background: rgb(113 76 182 / .9); }
  .btn-secondary { border: 1px solid var(--brand); background: #fff; color: var(--ink); }
  .btn-secondary:hover { background: rgb(113 76 182 / .06); }
  .arrow { font-size: 15px; line-height: 1; }

  main { flex: 1; }
  .hero { position: relative; isolation: isolate; overflow: hidden; padding: 112px 0; text-align: center; }
  .smoke { pointer-events: none; position: absolute; inset: 0; z-index: -1; }
  .smoke div { position: absolute; }
  .s1 { left: -12%; top: 8%; height: 70%; width: 55%; background: radial-gradient(closest-side, rgba(110,115,140,.055), rgba(110,115,140,0)); animation: smoke-a 26s ease-in-out infinite; }
  .s2 { right: -10%; bottom: 0; height: 75%; width: 60%; background: radial-gradient(closest-side, rgba(113,76,182,.035), rgba(113,76,182,0)); animation: smoke-b 34s ease-in-out infinite; }
  .s3 { left: 28%; top: 30%; height: 55%; width: 45%; background: radial-gradient(closest-side, rgba(150,155,175,.045), rgba(150,155,175,0)); animation: smoke-a 26s ease-in-out infinite; animation-delay: -12s; }
  .wrap { margin: 0 auto; width: 100%; max-width: 760px; padding: 0 16px; }
  h1 { margin: 0; font-size: 40px; font-weight: 600; line-height: 1.08; letter-spacing: -1.2px; text-wrap: balance; }
  h1 .soft { color: rgb(31 31 48 / .4); }
  .lead { margin: 24px auto 0; max-width: 580px; font-size: 17px; line-height: 28px; color: var(--muted); text-wrap: balance; }
  .actions { margin-top: 36px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
  .note { margin: 28px auto 0; max-width: 520px; font-size: 13px; line-height: 20px; color: var(--muted); }
  .reveal { animation: reveal .8s cubic-bezier(.22,1,.36,1) both; }
  .d1 { animation-delay: 120ms; } .d2 { animation-delay: 240ms; } .d3 { animation-delay: 360ms; }

  footer { padding: 32px 16px; text-align: center; font-size: 13px; color: var(--muted); }

  @keyframes reveal { 0% { opacity: 0; transform: translateY(14px); } 100% { opacity: 1; transform: translateY(0); } }
  @keyframes smoke-a { 0%, 100% { transform: translate(0,0) scale(1); } 50% { transform: translate(6%,4%) scale(1.12); } }
  @keyframes smoke-b { 0%, 100% { transform: translate(0,0) scale(1.05); } 50% { transform: translate(-7%,-3%) scale(.95); } }
  @media (min-width: 640px) {
    .hero { padding: 160px 0; }
    h1 { font-size: 60px; letter-spacing: -2px; }
    .lead { font-size: 19px; line-height: 32px; }
    .actions { flex-direction: row; }
  }
  @media (prefers-reduced-motion: reduce) { .reveal, .smoke div { animation: none; } }
</style>
</head>
<body>
<header>
  <div class="bar">
    <a class="wordmark" href="/" aria-label="${name} home">${name}</a>
    <nav aria-label="Main navigation">${navAction}</nav>
  </div>
</header>
<main>
  <section class="hero" aria-labelledby="hero-title">
    <div class="smoke" aria-hidden="true"><div class="s1"></div><div class="s2"></div><div class="s3"></div></div>
    <div class="wrap">
      <h1 id="hero-title" class="reveal"><span class="soft">${name}.</span> Your photos, delivered the moment you pay</h1>
      <p class="lead reveal d1">${name} is a photography studio for weddings, events and brands. Your finished gallery waits in your private client portal. Pay the PayPal invoice and every photo unlocks for download right away.</p>
      <div class="actions reveal d2">
        ${primary}
        <a class="btn btn-secondary btn-lg" href="${esc(sourceUrl)}">See how it works</a>
      </div>
      <p class="note reveal d3">A demo for ${name}, built on Tarkle and the PayPal sandbox. No real money moves.</p>
    </div>
  </section>
</main>
<footer>© ${esc(year)} Tarkle</footer>
</body>
</html>`;
}
