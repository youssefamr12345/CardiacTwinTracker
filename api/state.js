const { Redis } = require("@upstash/redis");
const crypto = require("crypto");
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});
const KEY = "cardiac-twin-state";   // do not rename: your saved data lives here
const PKEY = "cardiac-twin-pending";
const RKEY = "cardiac-twin-reqs";
const AKEY = "cardiac-twin-avatars";
const CKEY = "cardiac-twin-cheers";
const TKEY = "cardiac-twin-comments";
const HKEY = "cardiac-twin-duels";
const DEFAULT = {"members":[{"id":"m1","n":"Youssef Amr","r":"Team Leader"},{"id":"m2","n":"Hassan Tamer"},{"id":"m3","n":"Youssef Islam"},{"id":"m4","n":"Momen Ahmed"},{"id":"m5","n":"Omar Adel"},{"id":"m6","n":"Hazem Elrefaie"},{"id":"m7","n":"Momen Saber"},{"id":"m8","n":"Menna Allah Tarek"}],"tasks":[],"subs":{},"adj":[]};
const h = (x) => crypto.createHash("sha256").update(String(x || "")).digest();
const same = (a, b) => crypto.timingSafeEqual(h(a), h(b));
const mine = (t, m) => !t.a || !t.a.length || t.a.includes(m);
async function getH(key) {
  const raw = (await redis.hgetall(key)) || {}, out = {};
  for (const [k, v] of Object.entries(raw)) { try { out[k] = typeof v === "string" ? JSON.parse(v) : v; } catch (e) { out[k] = v; } }
  return out;
}
const getReqs = () => getH(RKEY);
const isAdmin = (b) =>
  !!(b.user && b.pass && process.env.ADMIN_USER && process.env.ADMIN_PASS &&
    same(String(b.user).toLowerCase(), process.env.ADMIN_USER.toLowerCase()) && same(b.pass, process.env.ADMIN_PASS));

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const s = (await redis.get(KEY)) || DEFAULT;
      const [pend, reqs, av, cheers, comm, ch] = await Promise.all([
        redis.hgetall(PKEY), getReqs(), getH(AKEY), getH(CKEY), getH(TKEY), getH(HKEY),
      ]);
      return res.status(200).json({ ...s, pend: pend || {}, reqs, av, cheers, comm, ch });
    }
    if (req.method !== "POST") return res.status(405).end();
    const body = req.body || {};

    // ---- Public actions (team members) ----
    if (["done", "ext", "swap", "avatar", "cheer", "comment", "chal"].includes(body.act)) {
      const st = (await redis.get(KEY)) || DEFAULT;
      const tk = (id) => (st.tasks || []).find((t) => t.id === id);
      const mb = (id) => (st.members || []).find((m) => m.id === id);
      const busy = (t, m) => (st.subs && st.subs[t + "|" + m] && !st.subs[t + "|" + m].rej);
      const OK = () => res.status(200).json({ ok: true });
      const uid = (p) => p + Date.now() + Math.floor(Math.random() * 1000);

      if (body.act === "done") {
        const T = tk(body.task), M = mb(body.member);
        if (!T || !M) return res.status(400).json({ error: "Unknown task or member" });
        if (!mine(T, M.id)) return res.status(403).json({ error: "Not assigned" });
        const k = T.id + "|" + M.id;
        if (busy(T.id, M.id)) return res.status(409).json({ error: "Already recorded" });
        await redis.hsetnx(PKEY, k, Date.now());
        return OK();
      }

      if (body.act === "avatar") {
        const M = mb(body.member);
        if (!M) return res.status(400).json({ error: "Unknown member" });
        const e = String(body.e || "").slice(0, 8), hh = Math.max(0, Math.min(360, +body.h || 0));
        await redis.hset(AKEY, { [M.id]: { e, h: hh } });
        return OK();
      }

      if (body.act === "cheer") {
        const M = mb(body.member), key = String(body.key || "").slice(0, 80);
        if (!M || !key || key.includes("~")) return res.status(400).json({ error: "Invalid" });
        await redis.hset(CKEY, { [key + "~" + M.id]: 1 });
        return OK();
      }

      if (body.act === "comment") {
        const T = tk(body.task), x = String(body.text || "").trim().slice(0, 300);
        if (!T || !x) return res.status(400).json({ error: "Invalid" });
        let who = "admin";
        if (!isAdmin(body)) {
          const M = mb(body.member);
          if (!M || !mine(T, M.id)) return res.status(403).json({ error: "Not allowed" });
          who = M.id;
        }
        await redis.hset(TKEY, { [uid("c")]: { t: T.id, m: who, x, at: Date.now() } });
        return OK();
      }

      if (body.act === "chal") {
        const M = mb(body.member);
        if (!M) return res.status(400).json({ error: "Unknown member" });
        const all = await getH(HKEY);
        if (body.op === "new") {
          const T = tk(body.task), B = mb(body.b);
          if (!T || !B || B.id === M.id || body.a !== M.id || !mine(T, M.id) || !mine(T, B.id) || busy(T.id, M.id) || busy(T.id, B.id))
            return res.status(409).json({ error: "Invalid challenge" });
          if (Object.values(all).some((c) => c && c.t === T.id && c.st !== "no" &&
            ((c.a === M.id && c.b === B.id) || (c.a === B.id && c.b === M.id))))
            return res.status(409).json({ error: "Already challenged" });
          await redis.hset(HKEY, { [uid("d")]: { t: T.id, a: M.id, b: B.id, st: "pend", at: Date.now() } });
          return OK();
        }
        const c = all[body.id];
        if (!c || c.b !== M.id || c.st !== "pend" || !["acc", "dec"].includes(body.op))
          return res.status(409).json({ error: "Not allowed" });
        await redis.hset(HKEY, { [body.id]: { ...c, st: body.op === "acc" ? "on" : "no" } });
        return OK();
      }

      const reqs = Object.values(await getReqs());
      const id = "r" + Date.now() + Math.floor(Math.random() * 1000);
      if (body.act === "ext") {
        const T = tk(body.task), M = mb(body.member);
        if (!T || !M || !mine(T, M.id)) return res.status(400).json({ error: "Invalid" });
        const k = T.id + "|" + M.id, ext = st.ext || {};
        const used = Object.keys(ext).filter((x) => x.endsWith("|" + M.id)).length;
        const pend = await redis.hget(PKEY, k);
        if (busy(T.id, M.id) || pend || ext[k] || used >= 3 || reqs.some((r) => r.ty === "ext" && r.t === T.id && r.m === M.id))
          return res.status(409).json({ error: "Not allowed" });
        await redis.hset(RKEY, { [id]: { ty: "ext", t: T.id, m: M.id, at: Date.now() } });
        return OK();
      }
      const { t1, m1, t2, m2 } = body, A = tk(t1), B = tk(t2);
      if (!A || !B || !mb(m1) || !mb(m2) || t1 === t2 || m1 === m2 || !A.a || !B.a ||
        !A.a.includes(m1) || !B.a.includes(m2) || A.a.includes(m2) || B.a.includes(m1) || busy(t1, m1) || busy(t2, m2))
        return res.status(409).json({ error: "Invalid swap" });
      if (reqs.some((r) => r.ty === "swap" && r.t1 === t1 && r.m1 === m1 && r.t2 === t2 && r.m2 === m2))
        return res.status(409).json({ error: "Already requested" });
      await redis.hset(RKEY, { [id]: { ty: "swap", t1, m1, t2, m2, at: Date.now() } });
      return OK();
    }

    // ---- Admin only ----
    if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS)
      return res.status(500).json({ error: "ADMIN_USER / ADMIN_PASS env vars are not set" });
    const { user, pass, login, state, clear, clearReq } = body;
    if (!isAdmin({ user, pass })) return res.status(401).json({ error: "Wrong username or password" });
    if (login) return res.status(200).json({ ok: true });
    const { pend, reqs, av, cheers, comm, ch, ...rest } = state || {};
    const valid = Array.isArray(rest.members) && Array.isArray(rest.tasks) && Array.isArray(rest.adj) &&
      rest.subs && typeof rest.subs === "object" && JSON.stringify(rest).length < 200000;
    if (!valid) return res.status(400).json({ error: "Invalid state" });
    await redis.set(KEY, rest);
    if (Array.isArray(clear) && clear.length) await redis.hdel(PKEY, ...clear.map(String));
    if (Array.isArray(clearReq) && clearReq.length) await redis.hdel(RKEY, ...clearReq.map(String));
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
