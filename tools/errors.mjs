#!/usr/bin/env node
/* What broke on the phones (sent by the app to /api/err), newest first.
   node tools/errors.mjs            → the last 7 days, live database
   node tools/errors.mjs 30         → the last 30 days
   node tools/errors.mjs 7 --local  → the wrangler dev database
   In Claude's session: WRANGLER=<path> CLOUDFLARE_API_TOKEN=proxy-injected CLOUDFLARE_ACCOUNT_ID=… */
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2), local = args.includes("--local"), days = +args.find(a => /^\d+$/.test(a)) || 7;
const W = process.env.WRANGLER ? [process.env.WRANGLER] : ["npx", "wrangler"];
const sql = `SELECT e.count, e.first, e.last, e.ver, e.view, e.kind, e.msg, e.src, e.line, e.col, e.stack, e.ua, u.email
  FROM errors e LEFT JOIN users u ON u.id = e.user_id WHERE e.last > ${Date.now() - days * 864e5} ORDER BY e.last DESC LIMIT 50`;
const r = spawnSync(W[0], [...W.slice(1), "d1", "execute", "salesgo", local ? "--local" : "--remote", "--json", "--command", sql], { encoding: "utf8", shell: process.platform === "win32" });
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
const rows = JSON.parse(r.stdout)[0].results;
if (!rows.length) { console.log(`✓ مفيش أخطاء في آخر ${days} يوم`); process.exit(0); }
const d = t => new Date(t).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "short", timeStyle: "short" });
for (const e of rows) {
  const phone = /Android/.test(e.ua) ? "Android" : /iPhone|iPad/.test(e.ua) ? "iPhone" : /Windows|Macintosh|Linux/.test(e.ua) ? "Desktop" : "?";
  console.log(`\n✘ ${e.msg}\n  ${e.count}× · first ${d(e.first)} · last ${d(e.last)} · v${e.ver} · screen: ${e.view || "-"} · ${e.kind} · ${phone}${e.email ? " · " + e.email : ""}\n  at ${e.src}:${e.line}:${e.col}`);
  if (e.stack) console.log("  " + e.stack.split("\n").slice(0, 4).join("\n  "));
}
