const { Redis } = require("@upstash/redis");
const crypto = require("crypto");
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});
const KEY = "cardiac-twin-state";
const DEFAULT = {"members": [{"id": "m1", "n": "Youssef Amr", "r": "Team Leader"}, {"id": "m2", "n": "Hassan Tamer"}, {"id": "m3", "n": "Youssef Islam"}, {"id": "m4", "n": "Momen Ahmed"}, {"id": "m5", "n": "Omar Adel"}, {"id": "m6", "n": "Hazem Elrefaie"}, {"id": "m7", "n": "Momen Saber"}, {"id": "m8", "n": "Menna Allah Tarek"}], "tasks": [], "subs": {}, "adj": []};
const h = (x) => crypto.createHash("sha256").update(String(x || "")).digest();
const same = (a, b) => crypto.timingSafeEqual(h(a), h(b));

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const s = await redis.get(KEY);
      return res.status(200).json(s || DEFAULT);
    }
    if (req.method !== "POST") return res.status(405).end();
    if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS)
      return res.status(500).json({ error: "ADMIN_USER / ADMIN_PASS env vars are not set" });
    const { user, pass, login, state } = req.body || {};
    const ok = same(String(user || "").toLowerCase(), process.env.ADMIN_USER.toLowerCase()) && same(pass, process.env.ADMIN_PASS);
    if (!ok) return res.status(401).json({ error: "Wrong username or password" });
    if (login) return res.status(200).json({ ok: true });
    const valid = state && Array.isArray(state.members) && Array.isArray(state.tasks) && Array.isArray(state.adj) &&
      state.subs && typeof state.subs === "object" && JSON.stringify(state).length < 200000;
    if (!valid) return res.status(400).json({ error: "Invalid state" });
    await redis.set(KEY, state);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
