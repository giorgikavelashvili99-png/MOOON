/**
 * MOON optimizer gate — Cloudflare Worker
 * ------------------------------------------------------------
 * ინახავს გეგმებს/ლიმიტებს და გასცემს ხელმოწერილ "ბილეთებს", რომლითაც
 * patcheri.onrender.com იღებს ვიდეოს. ლიმიტი ამით სერვერზე აღსრულდება,
 * ბრაუზერში არა (ბრაუზერის ლიმიტი ადვილად გვერდავლებადია).
 *
 * SETUP
 *  1) Workers & Pages > Create Worker > ჩასვი ეს ფაილი
 *  2) KV namespace შექმენი და მიაბი binding-ით:  OPT
 *  3) Settings > Variables (Secrets):
 *       ADMIN_KEY      - შენი ადმინ გასაღები (გრძელი შემთხვევითი ტექსტი)
 *       TICKET_SECRET  - ბილეთის HMAC საიდუმლო (იგივე ჩაწერე patcheri-ზეც)
 *       ALLOWED_ORIGINS- შენი საიტის origin(ები), მძიმით, მაგ: https://yoursite.com
 *       AUTH_SECRET    - (არასავალდებულო, მაგრამ რეკომენდებული) იხილე ქვემოთ
 *  4) Worker URL ჩასვი საიტის ფაილში:  CFG.GATE = '...'
 *
 * IDENTITY (რეკომენდებული)
 *  ახლანდელი moon-discord-auth worker-ის სესია cookie-ზეა, ამ worker-მა კი
 *  ვერ იცის ვინ არის მომხმარებელი. თუ AUTH_SECRET დაყენებულია, კლიენტმა უნდა
 *  გამოაგზავნოს sig = HMAC_SHA256_hex(AUTH_SECRET, uid + "." + sigExp).
 *  moon-discord-auth worker-ში /me და /exchange პასუხში დაამატე:
 *     const exp = Date.now() + 6*3600*1000;
 *     user.optSigExp = exp; user.optSig = await hmacHex(env.AUTH_SECRET, user.id + "." + exp);
 *  (იგივე AUTH_SECRET ორივე worker-ზე.) AUTH_SECRET-ის გარეშე uid-ს ენდობა
 *  უკითხავად — ეს გასაყალბებელია.
 */
const TZ_OFFSET_MS = 4 * 3600 * 1000;           // Asia/Tbilisi (UTC+4)
const DAY = 86400000;
const FREE_WEEKLY = 3;
const PLANS = {
  free: { h: 1080, fps: 30,  weekly: FREE_WEEKLY },   // უფასო: 1080p30 (შეცვალე თუ გინდა)
  p1:   { h: 1080, fps: 60,  weekly: Infinity },      // 5.99 ₾
  p2:   { h: 1080, fps: 120, weekly: Infinity },      // 7.99 ₾
  p3:   { h: 2160, fps: 120, weekly: Infinity },      // 14.99 ₾
};
const PRESETS = {
  '1080p30': { h: 1080, fps: 30 }, '1080p60': { h: 1080, fps: 60 }, '1080p120': { h: 1080, fps: 120 },
  '4k60': { h: 2160, fps: 60 }, '4k120': { h: 2160, fps: 120 },
};
const TICKET_TTL = 45 * 60 * 1000;

// კვირა: ორშაბათი 00:00 (თბილისის დრო) -> შემდეგი ორშაბათი
function weekIndex(now) { return Math.floor((Math.floor((now + TZ_OFFSET_MS) / DAY) + 3) / 7); }
function weekResetAt(now) { return ((weekIndex(now) + 1) * 7 - 3) * DAY - TZ_OFFSET_MS; }

const enc = new TextEncoder();
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const b64u = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !list.length || list.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : 'null',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (o, status, h) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json', ...h } });

async function getUser(env, uid) {
  const u = await env.OPT.get('u:' + uid, 'json');
  const rec = u || { plan: 'free', expiresAt: null, weeklyLimit: null, blocked: false };
  let expired = false;
  if (rec.plan !== 'free' && rec.expiresAt && rec.expiresAt < Date.now()) { rec.plan = 'free'; expired = true; }
  return { rec, expired };
}
async function usage(env, uid, now) { return parseInt(await env.OPT.get(`w:${uid}:${weekIndex(now)}`) || '0', 10); }
function describe(rec, used, now) {
  const plan = PLANS[rec.plan] || PLANS.free;
  const limit = plan.weekly === Infinity ? null : (rec.weeklyLimit != null ? rec.weeklyLimit : plan.weekly);
  return {
    plan: rec.plan, blocked: !!rec.blocked, unlimited: limit === null,
    limit: limit, used, remaining: limit === null ? null : Math.max(0, limit - used),
    resetAt: weekResetAt(now), expiresAt: rec.expiresAt || null, maxH: plan.h, maxFps: plan.fps,
  };
}
async function verifyIdentity(env, body) {
  const uid = String(body.uid || '');
  if (!/^\d{5,25}$/.test(uid)) return null;
  if (env.AUTH_SECRET) {
    const exp = Number(body.sigExp || 0);
    if (!body.sig || !exp || exp < Date.now()) return null;
    if (!safeEq(await hmacHex(env.AUTH_SECRET, uid + '.' + exp), String(body.sig))) return null;
  }
  return uid;
}
function isAdmin(req, env) { const k = req.headers.get('X-Admin-Key') || ''; return !!env.ADMIN_KEY && safeEq(k, env.ADMIN_KEY); }

export default {
  async fetch(req, env) {
    const H = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });
    const url = new URL(req.url), now = Date.now();
    try {
      if (url.pathname === '/status' && req.method === 'GET') {
        const uid = url.searchParams.get('uid') || '';
        if (!/^\d{5,25}$/.test(uid)) return json({ error: 'bad_uid' }, 400, H);
        const { rec, expired } = await getUser(env, uid);
        return json({ ...describe(rec, await usage(env, uid, now), now), expired }, 200, H);
      }

      if (url.pathname === '/ticket' && req.method === 'POST') {
        const body = await req.json();
        const uid = await verifyIdentity(env, body);
        if (!uid) return json({ error: 'auth', message: 'ვერ დადასტურდა Discord სესია' }, 401, H);
        const preset = PRESETS[body.preset];
        if (!preset) return json({ error: 'preset', message: 'უცნობი ხარისხი' }, 400, H);
        const { rec } = await getUser(env, uid);
        if (rec.blocked) return json({ error: 'blocked', message: 'წვდომა შეზღუდულია' }, 403, H);
        const plan = PLANS[rec.plan] || PLANS.free;
        if (preset.h > plan.h || preset.fps > plan.fps) return json({ error: 'plan', message: 'ეს ხარისხი შენს გეგმაში არ შედის' }, 403, H);
        const d0 = describe(rec, await usage(env, uid, now), now);
        const key = `w:${uid}:${weekIndex(now)}`;
        if (!d0.unlimited) {
          // KV არ არის ატომური; ერთ მომხმარებელზე პარალელური მოთხოვნები იშვიათია. მკაცრი ატომურობისთვის გამოიყენე Durable Object.
          const used = await usage(env, uid, now);
          if (used >= d0.limit) return json({ error: 'quota', message: 'ლიმიტი ამოიწურა', resetAt: weekResetAt(now) }, 429, H);
          await env.OPT.put(key, String(used + 1), { expirationTtl: 15 * DAY / 1000 });
        }
        const payload = { uid, jid: crypto.randomUUID(), preset: body.preset, maxH: preset.h, maxFps: preset.fps, exp: now + TICKET_TTL, wk: weekIndex(now), counted: !d0.unlimited };
        const p = b64u(JSON.stringify(payload));
        const ticket = p + '.' + await hmacHex(env.TICKET_SECRET, p);
        const rec2 = await getUser(env, uid);
        return json({ ticket, jobId: payload.jid, status: describe(rec2.rec, await usage(env, uid, now), now) }, 200, H);
      }

      if (url.pathname === '/refund' && req.method === 'POST') {   // patcheri-ის შეცდომისას ლიმიტს აბრუნებს (ერთხელ)
        const { ticket } = await req.json();
        const [p, sig] = String(ticket || '').split('.');
        if (!p || !sig || !safeEq(await hmacHex(env.TICKET_SECRET, p), sig)) return json({ error: 'bad_ticket' }, 400, H);
        const t = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
        if (t.counted && !(await env.OPT.get('r:' + t.jid))) {
          await env.OPT.put('r:' + t.jid, '1', { expirationTtl: 2 * DAY / 1000 });
          const key = `w:${t.uid}:${t.wk}`, used = parseInt(await env.OPT.get(key) || '0', 10);
          await env.OPT.put(key, String(Math.max(0, used - 1)), { expirationTtl: 15 * DAY / 1000 });
        }
        return json({ ok: true }, 200, H);
      }

      if (url.pathname.startsWith('/admin/')) {
        if (!isAdmin(req, env)) return json({ error: 'forbidden', message: 'არასწორი ადმინ გასაღები' }, 403, H);
        if (url.pathname === '/admin/list') {
          const users = []; let cursor;
          do {
            const l = await env.OPT.list({ prefix: 'u:', cursor }); cursor = l.list_complete ? null : l.cursor;
            for (const k of l.keys) { const v = await env.OPT.get(k.name, 'json'); if (v) users.push({ uid: k.name.slice(2), ...v }); }
          } while (cursor);
          return json({ users }, 200, H);
        }
        if (url.pathname === '/admin/set' && req.method === 'POST') {
          const b = await req.json(), uid = String(b.uid || '');
          if (!/^\d{5,25}$/.test(uid) || !PLANS[b.plan]) return json({ error: 'bad_input' }, 400, H);
          const user = { name: String(b.name || '').slice(0, 60), plan: b.plan, expiresAt: b.plan === 'free' ? null : (Number(b.expiresAt) || Date.now() + 30 * DAY),
            weeklyLimit: b.weeklyLimit == null ? null : Math.max(0, Math.floor(Number(b.weeklyLimit))), blocked: !!b.blocked };
          await env.OPT.put('u:' + uid, JSON.stringify(user));
          return json({ ok: true, user: { uid, ...user } }, 200, H);
        }
        if (url.pathname === '/admin/reset-usage' && req.method === 'POST') {
          const b = await req.json(); await env.OPT.delete(`w:${String(b.uid)}:${weekIndex(now)}`);
          return json({ ok: true }, 200, H);
        }
      }
      return json({ error: 'not_found' }, 404, H);
    } catch (e) {
      return json({ error: 'server', message: String(e && e.message || e) }, 500, H);
    }
  },
};
