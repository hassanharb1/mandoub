/* The server (worker/index.js + worker/push.js) on a local D1, through `wrangler dev`:
   accounts, sync, the colleague's link, and push reminders delivered to a fake push service that decrypts them.
   Needs wrangler: `npx wrangler` (devDependency) or the path in $WRANGLER. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { ROOT, wait } from "./helpers.mjs";

const W = process.env.WRANGLER ? [process.env.WRANGLER] : ["npx", "wrangler"];
const wr = (args, opts = {}) => spawnSync(W[0], [...W.slice(1), ...args], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, ...opts });
const freePort = () => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

let dir, dev, base, push, pushPort, inbox = [];
// the "browser" side of a push subscription: its keys, and a server that decrypts what arrives (RFC 8291)
const ua = crypto.createECDH("prime256v1"); ua.generateKeys();
const authSecret = crypto.randomBytes(16);
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, len));
function decrypt(buf) {
  const salt = buf.subarray(0, 16), idlen = buf[20], asPub = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
  const ecdh = ua.computeSecret(asPub);
  const ikm = hkdf(authSecret, ecdh, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16), nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(pt.subarray(0, pt.lastIndexOf(2)).toString());
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "salesgo-test-"));
  const s = wr(["d1", "execute", "salesgo", "--local", "--persist-to", dir, "--file", "worker/schema.sql"]);
  assert.equal(s.status, 0, s.stderr);
  // test VAPID keys, so the real private key is never needed here
  const k = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const pub = Buffer.from(await crypto.webcrypto.subtle.exportKey("raw", k.publicKey)).toString("base64url");
  const jwk = JSON.stringify(await crypto.webcrypto.subtle.exportKey("jwk", k.privateKey));
  pushPort = await freePort();
  push = http.createServer((q, r) => { const b = []; q.on("data", c => b.push(c)); q.on("end", () => {
    try { inbox.push({ path: q.url, auth: q.headers.authorization, data: decrypt(Buffer.concat(b)) }); r.writeHead(q.url.includes("gone") ? 410 : 201); }
    catch (e) { inbox.push({ error: e.message }); r.writeHead(400); }
    r.end(); }); }).listen(pushPort, "127.0.0.1");
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  dev = spawn(W[0], [...W.slice(1), "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", dir, "--test-scheduled",
    "--var", `VAPID_JWK:${jwk}`, "--var", `VAPID_PUBLIC:${pub}`, "--var", "PUSH_ANYTIME:1", "--var", "SIGNUPS_PER_IP:1000"],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, shell: process.platform === "win32" });
  let log = ""; dev.stdout.on("data", d => log += d); dev.stderr.on("data", d => log += d);
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + "/")).ok) return; } catch {} await wait(500); }
  throw new Error("wrangler dev didn't start:\n" + log.slice(-2000));
});
after(async () => { dev?.kill(); push?.close(); await wait(300); try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const J = { "content-type": "application/json" };
const post = (path, body, token) => fetch(base + path, { method: "POST", headers: { ...J, ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const get = (path, token) => fetch(base + path, { headers: token ? { authorization: "Bearer " + token } : {} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const email = () => `t${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.com`;

test("the app and the colleague page are served; /api needs a token", async () => {
  const page = await fetch(base + "/"); assert.equal(page.status, 200); assert.match(await page.text(), /SalesGo/);
  const z = await fetch(base + "/z/anything"); assert.equal(z.status, 200); assert.match(await z.text(), /طلبات المندوب/);
  assert.equal((await post("/api/sync", { since: 0 })).status, 401);
});

test("sign-up checks the email, the password and duplicates; login rejects a wrong password", async () => {
  assert.equal((await post("/api/signup", { email: "bad", password: "abcdef" })).status, 400);
  assert.equal((await post("/api/signup", { email: email(), password: "123" })).status, 400);
  const e = email(), r = await post("/api/signup", { email: e, password: "abc123", name: "تجربة" });
  assert.equal(r.status, 200); assert.ok(r.body.token);
  assert.equal((await post("/api/signup", { email: e, password: "abc123" })).status, 409);
  assert.equal((await post("/api/login", { email: e, password: "wrong!" })).status, 401);
  const ok = await post("/api/login", { email: e.toUpperCase(), password: "abc123" });
  assert.equal(ok.status, 200); assert.equal(ok.body.email, e);
});

test("sync: the newest change wins, deletes travel, and accounts never see each other", async () => {
  const A = (await post("/api/signup", { email: email(), password: "abc123" })).body.token;
  const B = (await post("/api/signup", { email: email(), password: "abc123" })).body.token;
  let r = await post("/api/sync", { since: 0, changes: [{ kind: "customers", id: "c1", data: { id: "c1", name: "جديد" }, rev: 10 }] }, A);
  assert.equal(r.body.rows.length, 1);
  await post("/api/sync", { since: r.body.cursor, changes: [{ kind: "customers", id: "c1", data: { id: "c1", name: "قديم" }, rev: 5 }] }, A);
  r = await post("/api/sync", { since: 0 }, A);
  assert.equal(r.body.rows.find(x => x.id === "c1").data.name, "جديد", "an older change overwrote a newer one");
  await post("/api/sync", { since: 0, changes: [{ kind: "customers", id: "c1", deleted: true, rev: 20 }] }, A);
  r = await post("/api/sync", { since: 0 }, A);
  assert.equal(r.body.rows.find(x => x.id === "c1").deleted, true);
  assert.equal((await post("/api/sync", { since: 0 }, B)).body.rows.length, 0, "account B saw A's data");
  assert.equal((await post("/api/sync", { since: 0, changes: [{ kind: "nope", id: "x", data: {}, rev: 1 }] }, B)).body.rows.length, 0);
});

test("the colleague's link: sees sent orders only, moves them forward, and the rep pulls the step", async () => {
  const T = (await post("/api/signup", { email: email(), password: "abc123" })).body.token;
  await post("/api/sync", { since: 0, changes: [
    { kind: "settings", id: "s", data: { rep: "سامح", colleague: "مصطفى" }, rev: 1 },
    { kind: "customers", id: "c1", data: { id: "c1", name: "النور", area: "سيدي بشر" }, rev: 1 },
    { kind: "orders", id: "o1", data: { id: "o1", no: 7, customerId: "c1", status: "sent", created: 1, hist: { sent: Date.now() }, items: [{ name: "لمبة", qty: 2, unit: "ق", price: 10 }] }, rev: 1 },
    { kind: "orders", id: "o2", data: { id: "o2", no: 8, customerId: "c1", status: "draft", created: 1, hist: {}, items: [] }, rev: 1 }] }, T);
  const link = (await post("/api/link", {}, T)).body.token;
  let z = await get(`/api/z/${link}`);
  assert.equal(z.status, 200); assert.equal(z.body.rep, "سامح");
  assert.deepEqual(z.body.orders.map(o => o.no), [7], "a draft reached the colleague");
  assert.equal(z.body.orders[0].cust.name, "النور");
  assert.equal((await post(`/api/z/${link}/step`, { id: "o1", status: "draft" })).status, 400);
  assert.equal((await post(`/api/z/${link}/step`, { id: "o1", status: "registered" })).status, 200);
  z = await get(`/api/z/${link}`);
  assert.equal(z.body.orders[0].status, "registered");
  const pull = await post("/api/sync", { since: 0 }, T);
  assert.equal(pull.body.rows.find(r => r.kind === "ostat" && r.id === "o1").data.status, "registered");
  await post("/api/link/off", {}, T);
  assert.equal((await get(`/api/z/${link}`)).status, 404, "a closed link still works");
});

test("push: a test push and the cron reminders arrive encrypted, once a day per item, gone subscriptions are dropped", async () => {
  const T = (await post("/api/signup", { email: email(), password: "abc123" })).body.token;
  const keys = { p256dh: ua.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") };
  assert.equal((await get("/api/push/key", T)).body.key.length > 80, true);
  // the endpoint must be https in the real app; the test service is http, so it's put straight in D1
  const me = await get("/api/me", T); assert.ok(me.body.email);
  const uid = JSON.parse(wr(["d1", "execute", "salesgo", "--local", "--persist-to", dir, "--json", "--command", `SELECT id FROM users WHERE email = '${me.body.email}'`]).stdout)[0].results[0].id;
  assert.equal(wr(["d1", "execute", "salesgo", "--local", "--persist-to", dir, "--command",
    `INSERT INTO push_subs VALUES ('http://127.0.0.1:${pushPort}/ok', '${uid}', '${keys.p256dh}', '${keys.auth}', 0)`]).status, 0);
  inbox = [];
  const t = await post("/api/push/test", {}, T);
  assert.equal(t.body.ok, true, JSON.stringify(t.body));
  assert.match(inbox[0].data.body, /الإشعارات شغالة/);
  assert.match(inbox[0].auth, /^vapid t=.+, k=/);
  const now = Date.now();
  await post("/api/push/plan", { items: [
    { k: "draft", t: "طلب الحاج سيد لسه ما اتبعتش", due: now - 1000 },
    { k: "money", t: "النور عليه 1,200 ج", due: now - 500 },
    { k: "late", t: "لسه بدري", due: now + 864e5 }] }, T);
  inbox = [];
  await fetch(base + "/__scheduled?cron=*/15+*+*+*+*"); await wait(800);
  await fetch(base + "/__scheduled?cron=*/15+*+*+*+*"); await wait(800);
  assert.equal(inbox.length, 1, "the same reminders were pushed twice, or not at all");
  assert.equal(inbox[0].data.title, "محتاج تفتكر (2)");
  assert.match(inbox[0].data.body, /الحاج سيد/); assert.doesNotMatch(inbox[0].data.body, /لسه بدري/);
  // a subscription the push service says is gone (410) is deleted
  wr(["d1", "execute", "salesgo", "--local", "--persist-to", dir, "--command",
    `INSERT INTO push_subs VALUES ('http://127.0.0.1:${pushPort}/gone', '${uid}', '${keys.p256dh}', '${keys.auth}', 0)`]);
  await post("/api/push/test", {}, T); await wait(300);
  const left = JSON.parse(wr(["d1", "execute", "salesgo", "--local", "--persist-to", dir, "--json", "--command", `SELECT endpoint FROM push_subs WHERE user_id = '${uid}'`]).stdout)[0].results;
  assert.ok(!left.some(r => r.endpoint.includes("gone")), "a 410 subscription was kept");
});

test("forgotten password: the recovery code resets it once, wrong codes fail, and changing the password signs other phones out", async () => {
  const e = email(), up = await post("/api/signup", { email: e, password: "abc123" });
  const code = up.body.recovery; assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await get("/api/me", up.body.token)).body.recovery, 1);
  assert.equal((await post("/api/reset", { email: e, code: "AAAA-BBBB-CCCC", password: "new123" })).status, 401);
  assert.equal((await post("/api/reset", { email: e, code, password: "123" })).status, 400);
  const r = await post("/api/reset", { email: e, code: code.toLowerCase().replace(/-/g, " "), password: "new123" });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.token); assert.ok(r.body.recovery && r.body.recovery !== code);
  assert.equal((await post("/api/sync", { since: 0 }, up.body.token)).status, 401, "the old session survived a reset");
  assert.equal((await post("/api/reset", { email: e, code, password: "x12345" })).status, 401, "a used code worked twice");
  assert.equal((await post("/api/login", { email: e, password: "abc123" })).status, 401);
  const t2 = (await post("/api/login", { email: e, password: "new123" })).body.token, t3 = r.body.token;
  assert.equal((await post("/api/password", { old: "wrong", password: "zzz999" }, t2)).status, 401);
  assert.equal((await post("/api/password", { old: "new123", password: "zzz999" }, t2)).status, 200);
  assert.equal((await post("/api/sync", { since: 0 }, t2)).status, 200, "this phone was signed out");
  assert.equal((await post("/api/sync", { since: 0 }, t3)).status, 401, "the other phone stayed in");
  const fresh = (await post("/api/recovery", {}, t2)).body.recovery;
  assert.equal((await post("/api/reset", { email: e, code: r.body.recovery, password: "abc999" })).status, 401, "the replaced code still works");
  assert.equal((await post("/api/reset", { email: e, code: fresh, password: "abc999" })).status, 200);
});

test("in the app: sign up shows the code; «نسيت الباسورد؟» with it signs back in", async () => {
  const { browser } = await import("./helpers.mjs"); const b = await browser();
  const page = await (await b.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: "block" })).newPage();
  const errs = []; page.on("pageerror", x => errs.push(x.message)); page.context().on("page", p => { if (p !== page) p.close().catch(() => {}); });
  await page.goto(base + "/"); await wait(1200);
  const e = email(), c = s => page.evaluate(q => document.querySelector(q).click(), s);
  await c("#settingsBtn"); await wait(300); await c("#amode"); await wait(200);
  await page.fill("#aem", e); await page.fill("#apw", "abc123"); await page.fill("#apw2", "abc123"); await c("#aup");
  await page.waitForSelector("#scrim2 .num", { timeout: 15000 });
  const code = (await page.evaluate(() => document.querySelector("#scrim2 .num").textContent)).trim();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await page.evaluate(() => document.querySelector("#scrim2 [data-close]").click()); await wait(200);
  await c("#aout"); await c("#aout"); await wait(500);
  await c('[data-amode="reset"]'); await wait(200);
  await page.fill("#aem", e); await page.fill("#acode", code); await page.fill("#apw", "new123"); await page.fill("#apw2", "new123"); await c("#arst");
  await page.waitForSelector("#scrim2 .num", { timeout: 15000 });
  assert.match(await page.evaluate(() => document.querySelector("#acc").innerText), new RegExp(e.replace(/[.]/g, "\\.")));
  assert.equal((await post("/api/login", { email: e, password: "new123" })).status, 200);
  assert.deepEqual(errs, []);
  await b.close();
});

test("error reports from phones are stored once per error, counted, and tied to the account", async () => {
  const T = (await post("/api/signup", { email: email(), password: "abc123" })).body.token;
  const e = { kind: "error", msg: "Cannot read properties of null (reading 'boom')", src: "index.html", line: 1234, col: 5, stack: "TypeError…", ver: 49, view: "money", ua: "Mozilla/5.0 (Linux; Android 13)" };
  assert.equal((await post("/api/err", { errors: [e] })).status, 200);
  assert.equal((await post("/api/err", { errors: [e, { ...e, line: 99 }] }, T)).status, 200);
  assert.equal((await post("/api/err", { nonsense: true })).status, 200);
  const rows = JSON.parse(wr(["d1", "execute", "salesgo", "--local", "--persist-to", dir, "--json", "--command", "SELECT line, count, user_id FROM errors ORDER BY line"]).stdout)[0].results;
  assert.deepEqual(rows.map(r => [r.line, r.count]), [[99, 1], [1234, 2]]);
  assert.ok(rows.every(r => r.user_id), "the signed-in report wasn't tied to the account");
});
