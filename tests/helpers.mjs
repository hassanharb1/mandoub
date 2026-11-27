/* Shared pieces for the tests: a tiny static server for ./public (with a test hook injected into the page),
   Playwright from wherever it is installed, and a phone-sized page that records JS errors. */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// Playwright: the project's devDependency, or the one installed globally (CJS require honours NODE_PATH)
export function playwright() {
  try { return require("playwright"); }
  catch { throw new Error("Playwright مش متثبت: npm install && npx playwright install chromium"); }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp" };
// everything the tests reach inside the app's script (functions, and S through a getter)
const HOOK = `window.__T={get S(){return S},set S(v){S=v},balance,stmtData,total,ordOn,custLedger,parseNoteLine,matchCust,sameName,dupPairs,unsentPays,orderMoney,markSent,
  mergeSheet,multiSendSheet,collectSheet,noteSheet,orderEditor,sendSheet,ledgerSheet,go,render,save,closeSheet,signedIn,alerts};\n`;

// serves ./public on a free port; index.html gets the hook right before the app boots
export function staticServer() {
  return new Promise(res => {
    const srv = createServer((req, rsp) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const f = join(ROOT, "public", p);
      if (!f.startsWith(join(ROOT, "public")) || !existsSync(f) || statSync(f).isDirectory()) { rsp.writeHead(404); return rsp.end("not found"); }
      let body = readFileSync(f);
      if (p === "/index.html") body = body.toString().replace("/* ---------- boot ---------- */", HOOK + "/* ---------- boot ---------- */");
      rsp.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream", "cache-control": "no-store" });
      rsp.end(body);
    });
    srv.listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(r => srv.close(r)) }));
  });
}

export async function browser() {
  const { chromium } = playwright();
  // Claude's cloud sessions keep Chromium here; elsewhere Playwright finds its own
  const exe = "/opt/pw-browsers/chromium";
  return chromium.launch(existsSync(exe) && !process.env.PW_OWN_BROWSER ? { executablePath: exe } : {});
}

// a 390×800 phone page; page.errors collects uncaught errors and console errors
export async function phone(b, url, opts = {}) {
  const ctx = await b.newContext({ viewport: { width: opts.width || 390, height: 800 }, colorScheme: opts.dark ? "dark" : "light", serviceWorkers: "block" });
  let page = null;
  ctx.on("page", p => { if (page && p !== page) p.close().catch(() => {}); }); // wa.me / share fallbacks open tabs
  page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR|fonts\.g/.test(m.text())) page.errors.push(m.text()); });
  await page.goto(url + (opts.path || "/"));
  await page.waitForFunction(() => window.__T && document.querySelector("#view").children.length > 0);
  return page;
}
export const wait = ms => new Promise(r => setTimeout(r, ms));
// the demo data marked as real, so every feature that skips demo data runs
export async function realData(page) {
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem("mandoub.v1")); s.demo = false; localStorage.setItem("mandoub.v1", JSON.stringify(s)); });
  await page.reload();
  await page.waitForFunction(() => window.__T && !__T.S.demo);
}
