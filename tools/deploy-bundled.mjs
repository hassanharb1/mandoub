#!/usr/bin/env node
/* Deploy without Workers Static Assets: every file in ./public is packed into the worker script itself.
   Same app, same address, same /api (worker/index.js); only the way the files are uploaded differs.
   Used from Claude's cloud sessions, where the proxy that adds the Cloudflare token also replaces the
   one-time token wrangler uses to upload static assets (401). On your own machine `npx wrangler deploy` is fine.
     node tools/deploy-bundled.mjs            → mandoub-mestk (wrangler.jsonc)
     node tools/deploy-bundled.mjs --trial    → mandoub-trial (wrangler.trial.jsonc) */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { join, relative, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const trial = process.argv.includes("--trial");
const cfgFile = trial ? "wrangler.trial.jsonc" : "wrangler.jsonc";
const cfg = JSON.parse(readFileSync(cfgFile, "utf8").replace(/^\s*\/\/.*$/gm, ""));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp", ".jpg": "image/jpeg", ".css": "text/css; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
const TEXT = new Set([".html", ".js", ".json", ".svg", ".css", ".txt"]);

// the tests run first (tests/: the app in a browser + the server on a local D1); --skip-tests only in an emergency
if (!process.argv.includes("--skip-tests") && !process.argv.includes("--dry-run")) {
  console.log("▶ running the tests before deploying…");
  const t = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "tests/app.test.mjs", "tests/api.test.mjs"], { stdio: "inherit" });
  if (t.status !== 0) { console.error("✘ a test failed, not deploying (fix it, or --skip-tests in an emergency)"); process.exit(1); }
}
// safety: never ship an empty key file, and VERSION in index.html must match CACHE in sw.js
for (const f of ["index.html", "sw.js", "catalog.js", "catalog-img.js", "manifest.json"]) {
  if (!statSync(join("public", f)).size) { console.error(`✘ public/${f} is empty, not deploying`); process.exit(1); }
}
const ver = (readFileSync("public/index.html", "utf8").match(/const VERSION=(\d+)/) || [])[1], cache = (readFileSync("public/sw.js", "utf8").match(/mandoub-v(\d+)/) || [])[1];
if (!ver || ver !== cache) { console.error(`✘ VERSION ${ver} in index.html ≠ mandoub-v${cache} in sw.js, not deploying`); process.exit(1); }
const files = {};
const walk = d => readdirSync(d).forEach(n => { const p = join(d, n); if (statSync(p).isDirectory()) return walk(p);
  const ext = extname(n).toLowerCase(), buf = readFileSync(p), path = "/" + relative("public", p).split("\\").join("/");
  files[path] = { t: TYPES[ext] || "application/octet-stream", e: '"' + createHash("sha1").update(buf).digest("hex").slice(0, 16) + '"',
    ...(TEXT.has(ext) ? { s: buf.toString("utf8") } : { b: buf.toString("base64") }) }; });
walk("public");

const out = join(tmpdir(), `salesgo-bundle-${trial ? "trial" : "main"}`);
mkdirSync(join(out, "worker"), { recursive: true });
for (const f of readdirSync("worker")) if (f.endsWith(".js")) copyFileSync(join("worker", f), join(out, "worker", f));
writeFileSync(join(out, "files.js"), "export default " + JSON.stringify(files) + ";\n");
writeFileSync(join(out, "entry.js"), `import api from "./worker/index.js";
import FILES from "./files.js";
const bin = {};
const body = f => f.s != null ? f.s : (bin[f.e] ||= Uint8Array.from(atob(f.b), c => c.charCodeAt(0)));
// what Workers Static Assets did: "/" and "/index.html" serve the page, the rest by exact path, ETag + no-cache so updates show
const ASSETS = { async fetch(req) {
  const u = new URL(req.url); let p = decodeURIComponent(u.pathname); if (p.endsWith("/")) p += "index.html";
  const f = FILES[p] || FILES[p + ".html"];
  if (!f) return new Response("Not found", { status: 404 });
  const h = { "content-type": f.t, etag: f.e, "cache-control": "public, max-age=0, must-revalidate" };
  if (req.headers.get("if-none-match") === f.e) return new Response(null, { status: 304, headers: h });
  return new Response(req.method === "HEAD" ? null : body(f), { headers: h });
} };
export default { fetch: (req, env, ctx) => api.fetch(req, { ...env, ASSETS }, ctx), scheduled: (ev, env, ctx) => api.scheduled(ev, env, ctx) };
`);
const w = { name: cfg.name, main: "entry.js", compatibility_date: cfg.compatibility_date, d1_databases: cfg.d1_databases, triggers: cfg.triggers, vars: cfg.vars };
writeFileSync(join(out, "wrangler.json"), JSON.stringify(w, null, 2));
console.log(`packed ${Object.keys(files).length} files into ${out}`);
const extra = process.argv.includes("--dry-run") ? ["--dry-run"] : [];
const [cmd, ...pre] = process.env.WRANGLER ? [process.env.WRANGLER] : ["npx", "wrangler"];
execFileSync(cmd, [...pre, "deploy", "-c", join(out, "wrangler.json"), ...extra], { stdio: "inherit", shell: process.platform === "win32", cwd: resolve(out) });
