const { Redis } = require("@upstash/redis");
const crypto = require("crypto");
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});
const KEY = "cardiac-twin-state";   // do not rename: your saved data lives here
const PKEY = "cardiac-twin-pending";
const RKEY = "cardiac-twin-reqs";
const DEFAULT = {"members":[{"id":"m1","n":"Youssef Amr","r":"Team Leader"},{"id":"m2","n":"Hassan Tamer"},{"id":"m3","n":"Youssef Islam"},{"id":"m4","n":"Momen Ahmed"},{"id":"m5","n":"Omar Adel"},{"id":"m6","n":"Hazem Elrefaie"},{"id":"m7","n":"Momen Saber"},{"id":"m8","n":"Menna Allah Tarek"}],"tasks":[],"subs":{},"adj":[]};
const h = (x) => crypto.createHash("sha256").update(String(x || "")).digest();
const same = (a, b) => crypto.timingSafeEqual(h(a), h(b));
const mine = (t, m) => !t.a || !t.a.length || t.a.includes(m);
async function getReqs() {
  const raw = (await redis.hgetall(RKEY)) || {}, out = {};
  for (const [k, v] of Object.entries(raw)) { try { out[k] = typeof v === "string" ? JSON.parse(v) : v; } catch (e) {} }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const s = (await redis.get(KEY)) || DEFAULT;
      const pend = (await redis.hgetall(PKEY)) || {};
      return res.status(200).json({ ...s, pend, reqs: await getReqs() });
    }
    if (req.method !== "POST") return res.status(405).end();
    const body = req.body || {};

    // ---- Public actions (team members) ----
    if (["done", "ext", "swap"].includes(body.act)) {
      const st = (await redis.get(KEY)) || DEFAULT;
      const tk = (id) => (st.tasks || []).find((t) => t.id === id);
      const mb = (id) => (st.members || []).find((m) => m.id === id);
      const busy = (t, m) => (st.subs && st.subs[t + "|" + m] && !st.subs[t + "|" + m].rej);
      if (body.act === "done") {
        const T = tk(body.task), M = mb(body.member);
        if (!T || !M) return res.status(400).json({ error: "Unknown task or member" });
        if (!mine(T, M.id)) return res.status(403).json({ error: "Not assigned" });
        const k = T.id + "|" + M.id;
        if (busy(T.id, M.id)) return res.status(409).json({ error: "Already recorded" });
        await redis.hsetnx(PKEY, k, Date.now());
        return res.status(200).json({ ok: true });
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
        return res.status(200).json({ ok: true });
      }
      const { t1, m1, t2, m2 } = body, A = tk(t1), B = tk(t2);
      if (!A || !B || !mb(m1) || !mb(m2) || t1 === t2 || m1 === m2 || !A.a || !B.a ||
        !A.a.includes(m1) || !B.a.includes(m2) || A.a.includes(m2) || B.a.includes(m1) || busy(t1, m1) || busy(t2, m2))
        return res.status(409).json({ error: "Invalid swap" });
      if (reqs.some((r) => r.ty === "swap" && r.t1 === t1 && r.m1 === m1 && r.t2 === t2 && r.m2 === m2))
        return res.status(409).json({ error: "Already requested" });
      await redis.hset(RKEY, { [id]: { ty: "swap", t1, m1, t2, m2, at: Date.now() } });
      return res.status(200).json({ ok: true });
    }

    // ---- Admin only ----
    if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS)
      return res.status(500).json({ error: "ADMIN_USER / ADMIN_PASS env vars are not set" });
    const { user, pass, login, state, clear, clearReq } = body;
    const ok = same(String(user || "").toLowerCase(), process.env.ADMIN_USER.toLowerCase()) && same(pass, process.env.ADMIN_PASS);
    if (!ok) return res.status(401).json({ error: "Wrong username or password" });
    if (login) return res.status(200).json({ ok: true });
    const valid = state && Array.isArray(state.members) && Array.isArray(state.tasks) && Array.isArray(state.adj) &&
      state.subs && typeof state.subs === "object" && JSON.stringify(state).length < 200000;
    if (!valid) return res.status(400).json({ error: "Invalid state" });
    const { pend, reqs, ...rest } = state;
    await redis.set(KEY, rest);
    if (Array.isArray(clear) && clear.length) await redis.hdel(PKEY, ...clear.map(String));
    if (Array.isArray(clearReq) && clearReq.length) await redis.hdel(RKEY, ...clearReq.map(String));
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
