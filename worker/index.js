/* SalesGo by MESTK — the Worker in front of the app.
   /api/*  : accounts and sync (D1 binding DB). Everything else: the static app in ./public (ASSETS).
   Same address as the app, so nothing new can be blocked in Egypt and no CORS is needed. */

const ITER = 10000; // PBKDF2 rounds: low enough for the Workers free CPU budget; sign-up is closed and wrong passwords lock the account
const LOCK_AFTER = 8, LOCK_MS = 15 * 60e3;
const MAX_CHANGES = 60, ROWS_PER_INSERT = 12, PULL_LIMIT = 400;
const KINDS = new Set(["customers", "orders", "payments", "handovers", "adjusts", "requests", "settings", "cat", "meta", "img"]);

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

async function newSession(env, u, extra = []) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))), now = Date.now();
  await env.DB.batch([...extra,
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created, seen) VALUES (?, ?, ?, ?)").bind(await sha256(token), u.id, now, now)]);
  return json({ token, email: u.email, name: u.name || "" });
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
  if (n && n.n >= SIGNUPS_PER_IP) return json({ error: "اتعمل حسابات كتير من النت ده النهارده. جرّب بكرة" }, 429);
  if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(e).first()) return json({ error: "الإيميل ده عليه حساب قبل كده. ادخل بيه" }, 409);
  const u = { id: crypto.randomUUID(), email: e, name: nm };
  return newSession(env, u, [
    env.DB.prepare("INSERT INTO users (id, email, pass, name, created) VALUES (?, ?, ?, ?, ?)").bind(u.id, e, await hashPass(pw), nm, now),
    env.DB.prepare("INSERT INTO signups (ip, at) VALUES (?, ?)").bind(ip, now),
  ]);
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (!env.DB) return json({ error: "السيرفر لسه ما اتربطش بقاعدة البيانات" }, 503);
    try {
      if (req.method === "POST" && url.pathname === "/api/login") return await login(req, env);
      if (req.method === "POST" && url.pathname === "/api/signup") return await signup(req, env);
      const a = await auth(req, env);
      if (!a) return json({ error: "سجّل دخول تاني" }, 401);
      if (req.method === "POST" && url.pathname === "/api/sync") return await sync(req, env, a);
      if (req.method === "GET" && url.pathname === "/api/me") return json(await env.DB.prepare("SELECT email, name FROM users WHERE id = ?").bind(a.uid).first() || {});
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
