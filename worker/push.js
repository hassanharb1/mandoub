/* Web Push from the Worker: VAPID (ES256 JWT) + RFC 8291 aes128gcm payload encryption, WebCrypto only.
   The phone sends its reminder plan (the same items as «محتاج تفتكر», each with the time it becomes due);
   a cron every 15 minutes pushes what came due, at most once a day per item, never at night (Cairo time). */
const enc = new TextEncoder();
const b64u = buf => { const u = new Uint8Array(buf); let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0), o = new Uint8Array(n); let i = 0; for (const y of a) { o.set(y, i); i += y.length; } return o; };
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
// RFC 8291: encrypt `payload` for one subscription (p256dh = the browser's public key, auth = its 16-byte secret)
export async function encrypt(payload, p256dh, auth) {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(secret, ecdh, cat(enc.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function vapidAuth(endpoint, env) {
  const jwk = JSON.parse(env.VAPID_JWK);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUB || "https://mandoub-mestk.hassan-mestkawy.workers.dev" })));
  const sig = b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body)));
  return `vapid t=${head}.${body}.${sig}, k=${env.VAPID_PUBLIC}`;
}
// one push; returns the HTTP status (404/410 = the subscription is gone)
export async function sendPush(sub, data, env) {
  const body = await encrypt(JSON.stringify(data), sub.p256dh, sub.auth);
  const r = await fetch(sub.endpoint, { method: "POST", body, headers: {
    authorization: await vapidAuth(sub.endpoint, env), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "43200", urgency: "normal" } });
  return r.status;
}

const DAY = 864e5;
// hour in Egypt: UTC+2, and UTC+3 in summer time (since 2023: from the last Friday of April to the last Thursday of October)
function cairoHour(t) {
  const d = new Date(t), y = d.getUTCFullYear();
  const lastDow = (m, dow) => { const x = new Date(Date.UTC(y, m + 1, 0)); while (x.getUTCDay() !== dow) x.setUTCDate(x.getUTCDate() - 1); return x.getTime(); };
  const dst = t >= lastDow(3, 5) && t < lastDow(9, 4) + DAY;
  return (d.getUTCHours() + (dst ? 3 : 2)) % 24;
}
export async function runPush(env, now = Date.now(), force = false) {
  if (!env.VAPID_JWK) return { skipped: "no keys" };
  const h = cairoHour(now);
  if (!force && !env.PUSH_ANYTIME && (h < 9 || h >= 21)) return { skipped: "night" }; // PUSH_ANYTIME: local tests only
  const { results } = await env.DB.prepare("SELECT p.user_id, p.items, p.sent FROM push_plan p WHERE p.next_due <= ? AND EXISTS (SELECT 1 FROM push_subs s WHERE s.user_id = p.user_id)").bind(now).all();
  let pushed = 0;
  for (const row of results) {
    const items = JSON.parse(row.items || "[]"), sent = JSON.parse(row.sent || "{}");
    const key = i => i.k + "|" + i.t;
    const due = items.filter(i => i.due <= now && !(sent[key(i)] > now - DAY));
    if (due.length) {
      const subs = (await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?").bind(row.user_id).all()).results;
      const data = { title: due.length > 1 ? `محتاج تفتكر (${due.length})` : "محتاج تفتكر", body: due.slice(0, 4).map(i => "• " + i.t).join("\n") + (due.length > 4 ? `\nو ${due.length - 4} كمان` : ""), tag: "mandoub-remind" };
      for (const s of subs) {
        try { const st = await sendPush(s, data, env); if (st === 404 || st === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(s.endpoint).run(); else if (st < 300) pushed++; }
        catch (e) { /* one bad subscription never stops the others */ }
      }
      due.forEach(i => { sent[key(i)] = now; });
    }
    // forget old marks; the next run looks at this user again when the next item comes due (or tomorrow for repeats)
    for (const k in sent) if (sent[k] < now - 3 * DAY) delete sent[k];
    const next = Math.min(...items.map(i => (sent[key(i)] ? sent[key(i)] + DAY : i.due)), now + 7 * DAY);
    await env.DB.prepare("UPDATE push_plan SET sent = ?, next_due = ? WHERE user_id = ?").bind(JSON.stringify(sent), Math.max(next, now + 10 * 60e3), row.user_id).run();
  }
  return { users: results.length, pushed };
}
export async function savePlan(req, env, uid) {
  const { items } = await req.json().catch(() => ({}));
  const list = (Array.isArray(items) ? items : []).slice(0, 300)
    .filter(i => i && typeof i.t === "string" && Number.isFinite(+i.due)).map(i => ({ k: String(i.k || "").slice(0, 20), t: i.t.slice(0, 160), due: Math.floor(+i.due) }));
  const prev = await env.DB.prepare("SELECT sent FROM push_plan WHERE user_id = ?").bind(uid).first();
  const sent = JSON.parse((prev && prev.sent) || "{}"), now = Date.now();
  const next = Math.min(...list.map(i => (sent[i.k + "|" + i.t] ? sent[i.k + "|" + i.t] + DAY : i.due)), now + 7 * DAY);
  await env.DB.prepare(`INSERT INTO push_plan (user_id, items, sent, next_due, updated) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET items = excluded.items, next_due = excluded.next_due, updated = excluded.updated`).bind(uid, JSON.stringify(list), JSON.stringify(sent), next, now).run();
  return new Response(JSON.stringify({ ok: true, next }), { headers: { "content-type": "application/json" } });
}
