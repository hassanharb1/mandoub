/* SalesGo by MESTK — the Worker in front of the app.
   /api/*  : accounts and sync (D1 binding DB). Everything else: the static app in ./public (ASSETS).
   Same address as the app, so nothing new can be blocked in Egypt and no CORS is needed. */

import { runPush, savePlan, sendPush } from "./push.js";

const ITER = 10000; // PBKDF2 rounds: low enough for the Workers free CPU budget; sign-up is closed and wrong passwords lock the account
const LOCK_AFTER = 8, LOCK_MS = 15 * 60e3;
const MAX_CHANGES = 60, ROWS_PER_INSERT = 12, PULL_LIMIT = 400;
const KINDS = new Set(["customers", "orders", "payments", "handovers", "adjusts", "requests", "settings", "cat", "meta", "img"]);
const STEPS = ["draft", "sent", "registered", "shipped", "delivered"];

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const b64 = buf => { const u = new Uint8Array(buf); let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const sha256 = async s => b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

export async function hashPass(password, salt = crypto.getRandomValues(new Uint8Array(16)), iter = ITER) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${b64(salt)}$${b64(bits)}`;
}
async function checkPass(password, stored) {
  const [, iter, salt] = String(stored).split("$");
  if (!iter || !salt) return false;
  const again = await hashPass(password, unb64(salt), +iter);
  if (again.length !== stored.length) return false;
  let d = 0; for (let i = 0; i < again.length; i++) d |= again.charCodeAt(i) ^ stored.charCodeAt(i);
  return d === 0;
}

async function login(req, env) {
  const { email, password } = await req.json().catch(() => ({}));
  const e = String(email || "").trim().toLowerCase();
  if (!e || !password) return json({ error: "اكتب الإيميل والباسورد" }, 400);
  const u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(e).first();
  const now = Date.now();
  if (u && u.lock_until > now) return json({ error: "الحساب اتقفل ربع ساعة بسبب باسورد غلط كذا مرة. جرّب بعد شوية" }, 429);
  if (!u || !(await checkPass(String(password), u.pass))) {
    if (u) await env.DB.prepare("UPDATE users SET fails = fails + 1, lock_until = CASE WHEN fails + 1 >= ? THEN ? ELSE 0 END WHERE id = ?").bind(LOCK_AFTER, now + LOCK_MS, u.id).run();
    return json({ error: "الإيميل أو الباسورد غلط" }, 401);
  }
  if (u.off) return json({ error: "الحساب ده متوقف. كلّم MESTK" }, 403);
  return newSession(env, u, [env.DB.prepare("UPDATE users SET fails = 0, lock_until = 0 WHERE id = ?").bind(u.id)]);
}

async function newSession(env, u, extra = [], more = {}) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))), now = Date.now();
  await env.DB.batch([...extra,
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created, seen) VALUES (?, ?, ?, ?)").bind(await sha256(token), u.id, now, now)]);
  return json({ token, email: u.email, name: u.name || "", ...more });
}

/* ---------- forgotten passwords, with no email: a recovery code ----------
   Each account has one code (shown once: at sign-up, or when the rep asks for a new one in Settings), kept only as a hash.
   «نسيت الباسورد؟» = email + code + new password → signed in, all other sessions out, and a fresh code (the old one is spent).
   Wrong codes count against the same lock as wrong passwords. Lost the code too → MESTK resets it with tools/account.mjs. */
const CODE_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function recoveryCode() { const r = crypto.getRandomValues(new Uint8Array(12)); let c = ""; r.forEach((x, i) => { c += CODE_ABC[x % CODE_ABC.length] + (i % 4 === 3 && i < 11 ? "-" : ""); }); return c; }
const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
async function newRecovery(env, uid) {
  const code = recoveryCode();
  await env.DB.prepare("INSERT INTO recovery (user_id, hash, created) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET hash = excluded.hash, created = excluded.created")
    .bind(uid, await hashPass(normCode(code)), Date.now()).run();
  return code;
}
async function reset(req, env) {
  const { email, code, password } = await req.json().catch(() => ({}));
  const e = String(email || "").trim().toLowerCase(), pw = String(password || "");
  if (!e || !code) return json({ error: "اكتب الإيميل وكود الاسترجاع" }, 400);
  if (pw.length < 6) return json({ error: "الباسورد الجديد لازم 6 حروف أو أرقام على الأقل" }, 400);
  const u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(e).first(), now = Date.now();
  if (u && u.lock_until > now) return json({ error: "الحساب اتقفل ربع ساعة بسبب محاولات غلط كتير. جرّب بعد شوية" }, 429);
  const r = u && await env.DB.prepare("SELECT hash FROM recovery WHERE user_id = ?").bind(u.id).first();
  if (!u || !r || !(await checkPass(normCode(code), r.hash))) {
    if (u) await env.DB.prepare("UPDATE users SET fails = fails + 1, lock_until = CASE WHEN fails + 1 >= ? THEN ? ELSE 0 END WHERE id = ?").bind(LOCK_AFTER, now + LOCK_MS, u.id).run();
    return json({ error: "الإيميل أو كود الاسترجاع غلط" }, 401);
  }
  if (u.off) return json({ error: "الحساب ده متوقف. كلّم MESTK" }, 403);
  const fresh = recoveryCode();
  return newSession(env, u, [
    env.DB.prepare("UPDATE users SET pass = ?, fails = 0, lock_until = 0 WHERE id = ?").bind(await hashPass(pw), u.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
    env.DB.prepare("UPDATE recovery SET hash = ?, created = ? WHERE user_id = ?").bind(await hashPass(normCode(fresh)), now, u.id),
  ], { recovery: fresh });
}
async function changePass(req, env, a) {
  const { old, password } = await req.json().catch(() => ({}));
  const pw = String(password || "");
  if (pw.length < 6) return json({ error: "الباسورد الجديد لازم 6 حروف أو أرقام على الأقل" }, 400);
  const u = await env.DB.prepare("SELECT pass FROM users WHERE id = ?").bind(a.uid).first();
  if (!u || !(await checkPass(String(old || ""), u.pass))) return json({ error: "الباسورد الحالي غلط" }, 401);
  // the other phones are signed out; this one stays in
  await env.DB.batch([env.DB.prepare("UPDATE users SET pass = ? WHERE id = ?").bind(await hashPass(pw), a.uid),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").bind(a.uid, a.h)]);
  return json({ ok: true });
}

/* POST /api/signup {email, password, name}: anyone can open an account (each account sees only its own data).
   At most SIGNUPS_PER_IP new accounts a day from one address, so nobody can flood the database. */
const SIGNUPS_PER_IP = 5;
async function signup(req, env) {
  const { email, password, name } = await req.json().catch(() => ({}));
  const e = String(email || "").trim().toLowerCase(), pw = String(password || ""), nm = String(name || "").trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 120) return json({ error: "اكتب إيميل صحيح" }, 400);
  if (pw.length < 6) return json({ error: "الباسورد لازم 6 حروف أو أرقام على الأقل" }, 400);
  if (pw.length > 200) return json({ error: "الباسورد طويل قوي" }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "", now = Date.now();
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM signups WHERE ip = ? AND at > ?").bind(ip, now - 864e5).first();
  if (n && n.n >= (+env.SIGNUPS_PER_IP || SIGNUPS_PER_IP)) return json({ error: "اتعمل حسابات كتير من النت ده النهارده. جرّب بكرة" }, 429);
  if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(e).first()) return json({ error: "الإيميل ده عليه حساب قبل كده. ادخل بيه" }, 409);
  const u = { id: crypto.randomUUID(), email: e, name: nm }, code = recoveryCode();
  return newSession(env, u, [
    env.DB.prepare("INSERT INTO recovery (user_id, hash, created) VALUES (?, ?, ?)").bind(u.id, await hashPass(normCode(code)), now),
    env.DB.prepare("INSERT INTO users (id, email, pass, name, created) VALUES (?, ?, ?, ?, ?)").bind(u.id, e, await hashPass(pw), nm, now),
    env.DB.prepare("INSERT INTO signups (ip, at) VALUES (?, ?)").bind(ip, now),
  ], { recovery: code });
}

async function auth(req, env) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!t) return null;
  const h = await sha256(t);
  const s = await env.DB.prepare("SELECT s.user_id, s.seen, u.off FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?").bind(h).first();
  if (!s || s.off) return null;
  if (Date.now() - s.seen > 864e5) await env.DB.prepare("UPDATE sessions SET seen = ? WHERE token_hash = ?").bind(Date.now(), h).run();
  return { uid: s.user_id, h };
}

/* POST /api/sync {since, changes:[{kind,id,data,deleted,rev}]}
   writes the changes (an older rev never overwrites a newer one), then returns the rows written after `since`. */
async function sync(req, env, a) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "bad request" }, 400);
  const since = Math.max(0, +body.since || 0);
  const changes = (Array.isArray(body.changes) ? body.changes : []).slice(0, MAX_CHANGES)
    .filter(c => c && KINDS.has(c.kind) && typeof c.id === "string" && c.id && c.id.length < 200 && Number.isFinite(+c.rev));
  if (changes.length) {
    const st = [env.DB.prepare("UPDATE users SET seq = seq + 1 WHERE id = ?").bind(a.uid)];
    for (let i = 0; i < changes.length; i += ROWS_PER_INSERT) {
      const part = changes.slice(i, i + ROWS_PER_INSERT), args = [];
      const values = part.map(c => {
        args.push(a.uid, c.kind, c.id, c.deleted ? null : JSON.stringify(c.data ?? null), c.deleted ? 1 : 0, Math.floor(+c.rev), a.uid);
        return "(?, ?, ?, ?, ?, ?, (SELECT seq FROM users WHERE id = ?))";
      }).join(", ");
      st.push(env.DB.prepare(`INSERT INTO records (user_id, kind, id, data, deleted, rev, sv) VALUES ${values}
        ON CONFLICT (user_id, kind, id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted, rev = excluded.rev, sv = excluded.sv
        WHERE excluded.rev >= records.rev`).bind(...args));
    }
    await env.DB.batch(st); // one transaction: the seq bump and its rows land together
  }
  const { results } = await env.DB.prepare("SELECT kind, id, data, deleted, rev, sv FROM records WHERE user_id = ? AND sv > ? ORDER BY sv LIMIT ?")
    .bind(a.uid, since, PULL_LIMIT + 1).all();
  let rows = results, more = false;
  if (results.length > PULL_LIMIT) {
    // a page ends on a whole seq, so one write is never split between two pulls
    const last = results[PULL_LIMIT].sv, whole = results.filter(r => r.sv < last);
    rows = whole.length ? whole : results.filter(r => r.sv === results[0].sv);
    more = true;
  }
  return json({
    cursor: rows.length ? rows[rows.length - 1].sv : since, more,
    rows: rows.map(r => ({ kind: r.kind, id: r.id, deleted: !!r.deleted, rev: r.rev, data: r.deleted ? null : JSON.parse(r.data) })),
  });
}

/* ---------- the colleague's screen (/z/<token>) ----------
   The rep makes a link from Settings; whoever has it sees his sent orders and moves them forward
   (اتسجل → اتشحن → اتسلم). Those steps are written as "ostat" records (one per order) that the rep's phone
   merges on its next sync, so they never clash with the rep's own edits of the order. */
async function linkMake(env, a) {
  const token = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM links WHERE user_id = ?").bind(a.uid),
    env.DB.prepare("INSERT INTO links (token_hash, user_id, created) VALUES (?, ?, ?)").bind(await sha256(token), a.uid, Date.now()),
  ]);
  return json({ token });
}
async function linkUser(env, token) {
  if (!token || token.length > 100) return null;
  const r = await env.DB.prepare("SELECT l.user_id FROM links l JOIN users u ON u.id = l.user_id WHERE l.token_hash = ? AND u.off = 0").bind(await sha256(token)).first();
  return r && r.user_id;
}
async function zOrders(env, uid) {
  const { results } = await env.DB.prepare("SELECT kind, id, data FROM records WHERE user_id = ? AND deleted = 0 AND kind IN ('orders','customers','settings','ostat')").bind(uid).all();
  const st = {}, cust = {}, orders = []; let settings = {};
  for (const r of results) {
    const d = JSON.parse(r.data || "null"); if (!d) continue;
    if (r.kind === "ostat") st[r.id] = d; else if (r.kind === "customers") cust[r.id] = d; else if (r.kind === "settings") settings = d; else orders.push(d);
  }
  const since = Date.now() - 45 * 864e5, out = [];
  for (const o of orders) {
    const x = st[o.id]; let status = o.status, hist = { ...(o.hist || {}) };
    if (x && STEPS.indexOf(x.status) > STEPS.indexOf(status)) status = x.status;
    if (x && x.hist) hist = { ...hist, ...x.hist };
    if (status === "draft") continue;
    const at = hist.sent || o.created;
    if (status === "delivered" && at < since) continue;
    const c = cust[o.customerId] || {};
    out.push({ ...o, status, hist, cust: { name: c.name || "", owner: c.owner || "", area: c.area || "", phone: c.phone || "" } });
  }
  out.sort((a, b) => (b.hist.sent || b.created) - (a.hist.sent || a.created));
  return json({ rep: settings.rep || "", colleague: settings.colleague || "", orders: out });
}
async function zStep(req, env, uid) {
  const { id, status } = await req.json().catch(() => ({}));
  if (typeof id !== "string" || !STEPS.includes(status) || status === "draft" || status === "sent") return json({ error: "bad request" }, 400);
  const o = await env.DB.prepare("SELECT data FROM records WHERE user_id = ? AND kind = 'orders' AND id = ? AND deleted = 0").bind(uid, id).first();
  if (!o) return json({ error: "الطلب ده مش موجود" }, 404);
  const prev = await env.DB.prepare("SELECT data FROM records WHERE user_id = ? AND kind = 'ostat' AND id = ?").bind(uid, id).first();
  const old = prev ? JSON.parse(prev.data || "{}") : {}, now = Date.now();
  const data = { status, hist: { ...(old.hist || {}), [status]: now }, by: "colleague" };
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET seq = seq + 1 WHERE id = ?").bind(uid),
    env.DB.prepare(`INSERT INTO records (user_id, kind, id, data, deleted, rev, sv) VALUES (?, 'ostat', ?, ?, 0, ?, (SELECT seq FROM users WHERE id = ?))
      ON CONFLICT (user_id, kind, id) DO UPDATE SET data = excluded.data, rev = excluded.rev, sv = excluded.sv`).bind(uid, id, JSON.stringify(data), now, uid),
  ]);
  return json({ ok: true, status, at: now });
}
// the page itself: public/colleague.html, whatever /z/<token> is
async function colleaguePage(req, env) {
  const u = new URL(req.url); u.pathname = "/colleague.html"; u.search = "";
  let r = await env.ASSETS.fetch(new Request(u, { headers: req.headers }));
  if (r.status >= 300 && r.status < 400 && r.headers.get("location")) r = await env.ASSETS.fetch(new Request(new URL(r.headers.get("location"), u)));
  return r;
}

export default {
  // every 15 minutes (wrangler triggers): push the reminders that came due
  async scheduled(ev, env, ctx) { ctx.waitUntil(runPush(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/z/")) return colleaguePage(req, env);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (!env.DB) return json({ error: "السيرفر لسه ما اتربطش بقاعدة البيانات" }, 503);
    try {
      if (req.method === "POST" && url.pathname === "/api/login") return await login(req, env);
      if (req.method === "POST" && url.pathname === "/api/signup") return await signup(req, env);
      if (req.method === "POST" && url.pathname === "/api/reset") return await reset(req, env);
      const z = url.pathname.match(/^\/api\/z\/([A-Za-z0-9_-]+)(\/step)?$/);
      if (z) {
        const uid = await linkUser(env, z[1]);
        if (!uid) return json({ error: "الرابط ده اتقفل أو مش صحيح. اطلب من المندوب رابط جديد" }, 404);
        if (!z[2] && req.method === "GET") return await zOrders(env, uid);
        if (z[2] && req.method === "POST") return await zStep(req, env, uid);
      }
      const a = await auth(req, env);
      if (!a) return json({ error: "سجّل دخول تاني" }, 401);
      if (req.method === "POST" && url.pathname === "/api/sync") return await sync(req, env, a);
      if (req.method === "POST" && url.pathname === "/api/link") return await linkMake(env, a);
      // push notifications: the phone's subscription and its reminder plan
      if (req.method === "POST" && url.pathname === "/api/push/sub") {
        const { endpoint, keys } = await req.json().catch(() => ({}));
        if (!/^https:\/\//.test(endpoint || "") || !keys || !keys.p256dh || !keys.auth) return json({ error: "bad subscription" }, 400);
        await env.DB.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`).bind(endpoint, a.uid, keys.p256dh, keys.auth, Date.now()).run();
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/push/unsub") {
        const { endpoint } = await req.json().catch(() => ({}));
        await env.DB.prepare("DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?").bind(a.uid, String(endpoint || "")).run();
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/push/plan") return await savePlan(req, env, a.uid);
      if (req.method === "POST" && url.pathname === "/api/push/test") {
        const subs = (await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?").bind(a.uid).all()).results;
        if (!subs.length) return json({ error: "الموبايل ده مش مشترك في الإشعارات لسه" }, 404);
        const st = [];
        for (const s of subs) {
          try { const x = await sendPush(s, { title: "SalesGo", body: "الإشعارات شغالة ✓ هيوصلك تذكير في ميعاده حتى لو البرنامج مقفول", tag: "mandoub-test" }, env); st.push(x);
            if (x === 404 || x === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(s.endpoint).run(); } // gone: forget it
          catch (e) { st.push(String(e.message || e)); } }
        return json({ ok: st.some(x => x >= 200 && x < 300), status: st });
      }
      if (req.method === "POST" && url.pathname === "/api/link/off") { await env.DB.prepare("DELETE FROM links WHERE user_id = ?").bind(a.uid).run(); return json({ ok: true }); }
      if (req.method === "GET" && url.pathname === "/api/push/key") return json({ key: env.VAPID_PUBLIC || "" });
      if (req.method === "GET" && url.pathname === "/api/me") return json(await env.DB.prepare("SELECT email, name, EXISTS (SELECT 1 FROM recovery r WHERE r.user_id = users.id) AS recovery FROM users WHERE id = ?").bind(a.uid).first() || {});
      if (req.method === "POST" && url.pathname === "/api/recovery") return json({ recovery: await newRecovery(env, a.uid) });
      if (req.method === "POST" && url.pathname === "/api/password") return await changePass(req, env, a);
      if (req.method === "POST" && url.pathname === "/api/logout") {
        await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(a.h).run();
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "حصلت مشكلة في السيرفر", detail: String((e && e.message) || e) }, 500);
    }
  },
};
