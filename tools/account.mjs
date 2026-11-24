#!/usr/bin/env node
/* SalesGo accounts (sign-up is closed: accounts are made here).
   node tools/account.mjs add   <email> <password> [name]   new account, or a new password for an existing one
   node tools/account.mjs off   <email>                     stop an account (and sign it out everywhere)
   node tools/account.mjs on    <email>                     start it again
   node tools/account.mjs list                              show the accounts
   Add --local to work on the local test database (npx wrangler dev) instead of the live one. */
import { execFileSync } from "node:child_process";
import { webcrypto as crypto, randomUUID } from "node:crypto";

const ITER = 10000; // must match worker/index.js
const b64 = buf => Buffer.from(buf).toString("base64");
async function hashPass(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256);
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(bits)}`;
}
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const args = process.argv.slice(2), local = args.includes("--local"), [cmd, email, password, ...rest] = args.filter(a => a !== "--local");
const run = sql => execFileSync("npx", ["wrangler", "d1", "execute", "salesgo", local ? "--local" : "--remote", "--command", sql], { stdio: "inherit", shell: process.platform === "win32" });
const e = String(email || "").trim().toLowerCase();

if (cmd === "add" && e && password) {
  if (String(password).length < 6) { console.error("الباسورد لازم 6 حروف أو أكتر"); process.exit(1); }
  const pass = await hashPass(String(password)), name = rest.join(" ");
  run(`INSERT INTO users (id, email, pass, name, created) VALUES (${q(randomUUID())}, ${q(e)}, ${q(pass)}, ${q(name)}, ${Date.now()})
       ON CONFLICT (email) DO UPDATE SET pass = excluded.pass, fails = 0, lock_until = 0${name ? ", name = excluded.name" : ""};`);
  console.log(`\n✓ الحساب ${e} جاهز`);
} else if ((cmd === "off" || cmd === "on") && e) {
  run(`UPDATE users SET off = ${cmd === "off" ? 1 : 0} WHERE email = ${q(e)};` + (cmd === "off" ? ` DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ${q(e)});` : ""));
  console.log(`\n✓ ${e}: ${cmd === "off" ? "اتوقف" : "اشتغل تاني"}`);
} else if (cmd === "list") {
  run("SELECT email, name, off, datetime(created/1000, 'unixepoch') AS created, (SELECT COUNT(*) FROM records r WHERE r.user_id = users.id) AS records FROM users ORDER BY created;");
} else {
  console.log(`الاستخدام:
  node tools/account.mjs add <email> <password> [name]
  node tools/account.mjs off <email>
  node tools/account.mjs on <email>
  node tools/account.mjs list
  (زوّد --local للتجربة على الجهاز)`);
}
