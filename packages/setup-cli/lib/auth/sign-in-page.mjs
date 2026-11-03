/**
 * The browser pages for `nexus login`, served by the localhost listener in
 * browser-auth.mjs: the sign-in page and the result page after sign-in.
 * Cognito stays the auth backend, and passwords are only ever typed on
 * Cognito's own hosted UI, never on these pages.
 *
 * Self-contained — no external assets, so the pages render without touching
 * the network. The one interpolated value (the authorize URL) is HTML-escaped.
 */

/** Account creation happens on the web app. */
export const WEB_SIGNUP_URL = "https://nexus.fireworks.ai/signup";

// The horizon is drawn with brand gradient stops, and the lockup is the
// symbol beside "Fireworks" in Georgia.
const SYMBOL = `<svg class="sym" viewBox="0 0 638 315" fill="none" aria-hidden="true">
<path d="M318.563 221.755C300.863 221.755 284.979 211.247 278.206 194.978L196.549 0H244.342L318.842 178.361L393.273 0H441.066L358.92 195.048C352.112 211.247 336.263 221.755 318.563 221.755Z"/>
<path d="M425.111 314.933C407.481 314.933 391.667 304.494 384.824 288.366C377.947 272.097 381.507 253.524 393.936 240.921L542.657 90.2803L561.229 134.094L425.076 271.748L619.147 270.666L637.72 314.479L425.146 315.003L425.076 314.933H425.111Z"/>
<path d="M0 314.408L18.5727 270.595L212.643 271.677L76.525 133.988L95.0977 90.1748L243.819 240.816C256.247 253.384 259.843 272.026 252.93 288.26C246.088 304.424 230.203 314.827 212.643 314.827L0.0698221 314.339L0 314.408Z"/>
</svg>`;

// Google's "G" mark, as Cognito's own hosted UI serves it.
const GOOGLE_G = `<svg class="g" viewBox="0 0 256 262" aria-hidden="true">
<path d="M255.878 133.451c0-10.734-.871-18.567-2.756-26.69H130.55v48.448h71.947c-1.45 12.04-9.283 30.172-26.69 42.356l-.244 1.622 38.755 30.023 2.685.268c24.659-22.774 38.875-56.282 38.875-96.027" fill="#4285F4"/>
<path d="M130.55 261.1c35.248 0 64.839-11.605 86.453-31.622l-41.196-31.913c-11.024 7.688-25.82 13.055-45.257 13.055-34.523 0-63.824-22.773-74.269-54.25l-1.531.13-40.298 31.187-.527 1.465C35.393 231.798 79.49 261.1 130.55 261.1" fill="#34A853"/>
<path d="M56.281 156.37c-2.756-8.123-4.351-16.827-4.351-25.82 0-8.994 1.595-17.697 4.206-25.82l-.073-1.73L15.26 71.312l-1.335.635C5.077 89.644 0 109.517 0 130.55s5.077 40.905 13.925 58.602l42.356-32.782" fill="#FBBC05"/>
<path d="M130.55 50.479c24.514 0 41.05 10.589 50.479 19.438l36.844-35.974C195.245 12.91 165.798 0 130.55 0 79.49 0 35.393 29.301 13.925 71.947l42.211 32.783c10.59-31.477 39.891-54.251 74.414-54.251" fill="#EA4335"/>
</svg>`;

// GitHub and LinkedIn marks, as the web app's Nexus login uses them.
const GITHUB_MARK = `<svg class="g" viewBox="0 0 24 24" fill="#24292F" aria-hidden="true"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>`;
const LINKEDIN_MARK = `<svg class="g" viewBox="0 0 17 16" fill="none" aria-hidden="true"><rect width="16" height="16" x=".5" fill="#1275B1" rx="8"/><path fill="#fff" d="M6.568 4.396c0 .534-.463.967-1.034.967S4.5 4.93 4.5 4.396s.463-.967 1.034-.967c.57 0 1.034.433 1.034.967ZM4.641 6.073H6.41v5.356H4.64V6.073Zm4.613 0H7.487v5.356h1.767v-2.74c0-.633.216-1.269 1.078-1.269.974 0 .968.828.964 1.47-.006.838.008 1.694.008 2.539h1.767V8.602c-.014-1.804-.485-2.636-2.032-2.636-.919 0-1.488.417-1.785.794v-.687Z"/></svg>`;
const MAIL_MARK = `<svg class="g" viewBox="0 0 24 24" fill="none" stroke="#280016" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`;

/** Social sign-in buttons: Cognito identity provider name, label, mark. */
const PROVIDERS = [
  ["Google", "Continue with Google", GOOGLE_G],
  ["GitHub", "Continue with GitHub", GITHUB_MARK],
  ["LinkedIn", "Continue with LinkedIn", LINKEDIN_MARK],
];

// Tick ruler on both edges of the horizon panel: [top %, opacity].
const TICKS = [[11, 1], [40, 1], [43, 0.9], [48, 0.9], [56, 1], [72, 0.5], [89, 0.9]];

/**
 * Response headers for every page: no framing (clickjacking), no caching,
 * no referrer, and a CSP that allows nothing but inline styles and inline
 * SVG.
 */
export const PAGE_HEADERS = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
});

const escapeHtml = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const ticks = (side) => TICKS
  .map(([top, opacity]) => `<i class="t ${side}" style="top:${top}%;opacity:${opacity}"></i>`)
  .join("");

/**
 * The split layout every page shares: horizon panel on the left, the page's
 * own content (`main`) centered on the right, and the legal line at the foot
 * when `legal` is set (the sign-in page only).
 * @param {{ title: string, main: string, legal?: boolean }} page
 */
function shell({ title, main, legal = false }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;grid-template-columns:1fr 1fr;background:#FFFFFF;color:#280016;
  font-family:Inter,-apple-system,"Segoe UI",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.hero{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:48px 124px;
  background:linear-gradient(180deg,#1E0010 0%,#280016 30%,#46031F 52%,#811F43 64%,#D84162 74%,#E24969 79%,#FFC0E7 86%,#FBB29D 93%,#F98461 100%);
  color:#F9F7F5;text-align:center}
.t{position:absolute;width:30px;height:2px;background:#F9F7F5}
.t.l{left:58px}.t.r{right:76px}
.hero-in{max-width:440px}
.lockup{display:inline-flex;align-items:center;gap:12px;margin-bottom:40px;font-family:Georgia,serif;font-size:28px;letter-spacing:-.01em}
.sym{width:42px;height:auto}.sym path{fill:#F9F7F5}
.hero h2{margin:0 0 24px;font-family:Georgia,serif;font-weight:400;font-size:clamp(30px,3.2vw,52px);line-height:1.12;letter-spacing:-.02em}
.hero p{margin:0;font-size:clamp(15px,1.2vw,19px);line-height:1.4;color:#F4F0EC}
.side{display:flex;flex-direction:column;padding:48px 24px 32px}
.main{flex:1;display:flex;align-items:center;justify-content:center}
.card{width:320px;max-width:100%;text-align:center}
h1{margin:0;font-family:Georgia,serif;font-weight:400;font-size:28px;line-height:1.2;letter-spacing:-.02em}
.sub{margin:8px 0 28px;font-size:14px;line-height:1.4;color:#706666}
.btn{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;height:42px;border:1px solid #E2DDD8;
  border-radius:8px;background:#FFFFFF;color:#280016;font-size:14px;text-decoration:none}
.btn:hover{background:#F9F7F5;border-color:#BDB6AF}
.btn:focus-visible{outline:2px solid #280016;outline-offset:2px}
.g{width:16px;height:16px}
.providers{display:grid;gap:8px}
.or{display:flex;align-items:center;gap:12px;margin:20px 0;font-size:12px;color:#706666}
.or::before,.or::after{content:"";flex:1;height:1px;background:#E2DDD8}
.new{margin:24px 0 0;font-size:14px}
.new a{color:#7E2A55;text-decoration:none;margin-left:6px}
.new a:hover{text-decoration:underline}
.status{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;min-height:42px;padding:10px 16px;
  border:1px solid #E2DDD8;border-radius:8px;font-size:14px}
.dot{flex:none;width:8px;height:8px;border-radius:50%}
.alt{display:inline-block;margin-top:20px;font-size:14px;color:#280016;text-underline-offset:3px}
.legal{margin:0;text-align:center;font-size:13px;line-height:1.4;color:#706666}
.legal a{color:#280016;text-underline-offset:2px}
@media(max-width:960px){
  body{grid-template-columns:1fr;grid-template-rows:auto 1fr}
  .hero{padding:56px 24px 96px}.t{display:none}
  .hero h2{font-size:34px}.hero p{font-size:16px}.lockup{margin-bottom:28px}
  .side{padding:40px 16px 24px}.main{padding-bottom:40px}
}
</style></head>
<body>
<section class="hero">${ticks("l")}${ticks("r")}
<div class="hero-in">
<div class="lockup">${SYMBOL}<span>Fireworks</span></div>
<h2>Keep your tools.<br>Lower your AI bill.</h2>
<p>Nexus works inside the coding tools you already use and picks the right model for each task.</p>
</div>
</section>
<section class="side">
<div class="main"><div class="card">
${main}
</div></div>${legal ? `
<p class="legal">By signing in, you agree to our <a href="https://fireworks.ai/terms-of-service">Terms of service</a> and <a href="https://fireworks.ai/dpa">Data Processing Agreement</a>.</p>` : ""}
</section>
</body></html>`;
}

/**
 * The page `nexus login` opens. Each social button is the Cognito authorize
 * URL plus identity_provider, so Cognito skips its own UI and goes straight to
 * that provider. Email opens Cognito's hosted UI (the authorize URL as
 * is), so the password goes straight to Cognito; account creation happens on
 * the web app.
 * @param {string} authorizeUrl
 */
export function signInPage(authorizeUrl) {
  const buttons = PROVIDERS.map(([provider, label, mark]) => {
    const href = `${authorizeUrl}&${new URLSearchParams({ identity_provider: provider })}`;
    return `<a class="btn" href="${escapeHtml(href)}">${mark}<span>${label}</span></a>`;
  }).join("\n");
  return shell({
    title: "Sign in | Nexus",
    legal: true,
    main: `<h1>Welcome to Nexus</h1>
<p class="sub">Cut coding costs, keep frontier quality</p>
<div class="providers">
${buttons}
</div>
<div class="or">OR</div>
<a class="btn" href="${escapeHtml(authorizeUrl)}">${MAIL_MARK}<span>Continue with email</span></a>
<p class="new">New to Nexus?<a href="${WEB_SIGNUP_URL}" target="_blank" rel="noopener">Create an account</a></p>`,
  });
}

/**
 * A short holding page that reloads itself (the response's Refresh header):
 * for a second tab that opened the sign-in link before the first one's
 * cookie was stored. Carries no sign-in state.
 */
/**
 * Served for a load of the sign-in page that carries no cookie at all, after
 * the one retry: a browser that blocks localhost cookies, a prerender or a
 * restored tab. It holds no state, and the first window can still finish.
 */
export function firstWindowPage() {
  return shell({
    title: "Sign-in already open | Nexus",
    main: `<h1>Sign-in is already open</h1>
<p class="sub">Finish signing in in the window that opened first, or run nexus login again.</p>`,
  });
}

export function openingPage() {
  return shell({
    title: "Opening sign-in | Nexus",
    main: `<h1>Opening sign-in…</h1>
<p class="sub">This page reloads in a moment.</p>`,
  });
}

/**
 * The page served after the redirect lands. Its only job is to send the user
 * back to where sign-in started: the terminal, or the Nexus app. It shows
 * before the token exchange and key creation, so success reads as "finishing",
 * and the terminal or app reports the outcome.
 * @param {boolean} ok
 * @param {{ returnTo?: "terminal" | "app" }} [options]
 */
export function callbackPage(ok, { returnTo = "terminal" } = {}) {
  const app = returnTo === "app";
  const where = app ? "the Nexus app" : "your terminal";
  // Pasting an API key is a CLI fallback; the app has its own retry.
  const fallback = ok || app
    ? ""
    : `\n<a class="alt" href="https://app.fireworks.ai/settings/users/api-keys">Use an API key instead</a>`;
  return shell({
    title: ok ? "Finishing sign-in | Nexus" : "Sign-in failed | Nexus",
    main: `<h1>${ok ? "Finishing sign-in" : "Sign-in didn't finish"}</h1>
<p class="sub">${ok ? "Nexus is completing your sign-in. You can close this tab." : "Nothing was saved."}</p>
<div class="status"><span class="dot" style="background:${ok ? "#078E09" : "#E51D1D"}"></span>${ok ? `Return to ${where}.` : `Return to ${where} to try again.`}</div>${fallback}`,
  });
}
