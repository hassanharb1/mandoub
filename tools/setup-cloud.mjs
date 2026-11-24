#!/usr/bin/env node
/* SalesGo: one-time Cloudflare setup for accounts and sync. Run from the project folder:
     node tools/setup-cloud.mjs <rep-email> <rep-password> ["rep name"]
   It (1) creates the D1 database "salesgo" (or reuses it), (2) writes its id into wrangler.jsonc and wrangler.trial.jsonc,
   (3) creates the tables, (4) deploys mandoub-mestk (and mandoub-trial), (5) makes the rep's account.
   Safe to run again: nothing is created twice and no data is deleted. Needs `npx wrangler login` once. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const win = process.platform === "win32";
const sh = (args, opts = {}) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", shell: win, stdio: opts.show ? "inherit" : ["inherit", "pipe", "inherit"] });
const step = t => console.log(`\n▶ ${t}`);
const [email, password, ...nameParts] = process.argv.slice(2);
if (!email || !password) { console.log('الاستخدام: node tools/setup-cloud.mjs <إيميل المندوب> <الباسورد> ["اسمه"]'); process.exit(1); }

step("بتأكد إنك داخل على Cloudflare");
try { console.log(sh(["whoami"]).split("\n").filter(l => /@|Account/i.test(l)).join("\n")); }
catch { console.log("ادخل الأول:  npx wrangler login   وبعدين شغّل السكريبت تاني"); process.exit(1); }

step("قاعدة البيانات salesgo");
let id = "";
try { id = (JSON.parse(sh(["d1", "list", "--json"])).find(d => d.name === "salesgo") || {}).uuid || ""; } catch {}
if (id) console.log("موجودة قبل كده ✓");
else {
  const out = sh(["d1", "create", "salesgo"]);
  id = (out.match(/"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/) || out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/) || [])[1] || "";
  if (!id) { console.log(out); console.log("مقدرتش أقرا الـ id، ابعت الكلام اللي فوق ده لـ Claude"); process.exit(1); }
  console.log("اتعملت ✓");
}
console.log("database_id:", id);

step("بكتب الـ id في wrangler.jsonc و wrangler.trial.jsonc");
for (const f of ["wrangler.jsonc", "wrangler.trial.jsonc"]) {
  const t = readFileSync(f, "utf8"), n = t.replace(/("database_id":\s*")[^"]*(")/, `$1${id}$2`);
  if (n !== t) writeFileSync(f, n);
}
console.log("✓");

step("بعمل الجداول");
sh(["d1", "execute", "salesgo", "--remote", "--file", "worker/schema.sql", "-y"], { show: true });

step("برفع البرنامج (mandoub-mestk)");
sh(["deploy"], { show: true });
step("برفع النسخة التجريبية (mandoub-trial)");
try { sh(["deploy", "-c", "wrangler.trial.jsonc"], { show: true }); } catch { console.log("النسخة التجريبية ما اترفعتش، مش مشكلة للمندوب الأساسي"); }

step(`بعمل حساب ${email}`);
execFileSync("node", ["tools/account.mjs", "add", email, password, ...nameParts], { stdio: "inherit", shell: win });

console.log(`\n✓ خلاص. على موبايل المندوب: افتح البرنامج ← الإعدادات ← «حسابك» ← ادخل بـ ${email}`);
console.log("مهم: اعمل commit للتغيير في wrangler.jsonc و wrangler.trial.jsonc (فيهم الـ database_id) أو ابعتهولي.");
