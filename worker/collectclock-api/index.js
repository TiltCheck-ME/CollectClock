// CollectClock API: Discord webhook proxy + Discord-login sync of collected timers + TiltCheck player settings.
const SITE = 'https://tiltcheck-me.github.io';
const SITE_PATH = '/CollectClock/';

function cors(body, init = {}) {
  const h = new Headers(init.headers || {});
  h.set('Access-Control-Allow-Origin', SITE);
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  h.set('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  return new Response(body, { ...init, headers: h });
}
const json = (o, status = 200) => cors(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

async function limited(env, key, max, ttl) {
  const k = 'rl:' + key;
  const n = Number((await env.CC.get(k)) || 0);
  if (n >= max) return true;
  await env.CC.put(k, String(n + 1), { expirationTtl: ttl });
  return false;
}

async function userFor(env, req) {
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!tok || tok.length < 20) return null;
  return await env.CC.get('sess:' + tok);
}

function clean(s, n) { return String(s || '').replace(/@/g, '@\u200b').slice(0, n); }


// ---- Player settings for the TiltCheck extension + tiltcheck.me dashboard ----
// One flat object per Discord user, stored at tcset:<discord id>. GET returns it, PUT merges a
// validated patch into it. Auth: a CollectClock session OR the player's Discord access token
// (what tiltcheck.me and the extension already hold). Keep in step with
// tiltcheck-monorepo apps/chrome-extension/src/player-settings.ts (PLAYER_SETTINGS_RULES).
const SETTINGS_MAX_BYTES = 8192;
const TC_ORIGINS = ['https://tiltcheck.me', 'https://www.tiltcheck.me', SITE];
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const GOAL_ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const num = (min, max, int) => ({ t: 'num', min, max, int });
const SETTINGS_SCHEMA = {
  enabled: { t: 'bool' },
  clickCheck: { t: 'bool' },
  tiltSensitivity: { t: 'enum', v: ['conservative', 'moderate', 'degen'] },
  sneakyBet: { t: 'bool' },
  sneakyBetThreshold: num(0.01, 1000),
  timeCheck: { t: 'bool' },
  hourlyWage: num(5, 2000, true),
  timeCheckHours: num(0.5, 24),
  depositBlock: { t: 'bool' },
  autoBreak: { t: 'bool' },
  autoBreakHours: num(1, 720, true),
  autoBreakScore: num(50, 95, true),
  keepTheWin: { t: 'bool' },
  winSkim: { t: 'bool' },
  winSkimPercent: num(10, 90, true),
  winSkimMinProfit: num(10, 10000, true),
  cashoutGoals: { t: 'bool' },
  goals: { t: 'goals', max: 10 },
  bonusTracker: { t: 'bool' },
  bonusName: { t: 'str', max: 60 },
  bonusTargetWager: num(0, 100000000),
  bonusMaxBet: num(0, 1000000),
  bonusBlockOver: { t: 'bool' },
  nopeList: { t: 'bool' },
  nopeGames: { t: 'slugs', max: 64, len: 48 },
  nopeCategories: { t: 'slugs', max: 24, len: 32 },
  sounds: { t: 'bool' },
  soundVolume: num(0, 1),
};
function checkSetting(rule, v) {
  switch (rule.t) {
    case 'bool': return typeof v === 'boolean' ? { ok: v } : null;
    case 'num':
      if (typeof v !== 'number' || !Number.isFinite(v) || v < rule.min || v > rule.max) return null;
      if (rule.int && !Number.isInteger(v)) return null;
      return { ok: v };
    case 'enum': return rule.v.includes(v) ? { ok: v } : null;
    case 'str':
      if (typeof v !== 'string' || v.length > rule.max || /[\u0000-\u001f<>]/.test(v)) return null;
      return { ok: v.trim() };
    case 'slugs':
      if (!Array.isArray(v) || v.length > rule.max) return null;
      if (!v.every(x => typeof x === 'string' && x.length <= rule.len && SLUG_RE.test(x))) return null;
      return { ok: [...new Set(v)] };
    case 'goals': {
      if (!Array.isArray(v) || v.length > rule.max) return null;
      const out = [];
      for (const g of v) {
        if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
        const extra = Object.keys(g).filter(k => !['id', 'name', 'targetAmount', 'metric', 'enabled'].includes(k));
        if (extra.length) return null;
        if (typeof g.id !== 'string' || !GOAL_ID_RE.test(g.id)) return null;
        if (typeof g.name !== 'string' || !g.name.trim() || g.name.length > 40 || /[\u0000-\u001f<>]/.test(g.name)) return null;
        if (typeof g.targetAmount !== 'number' || !Number.isFinite(g.targetAmount) || g.targetAmount < 1 || g.targetAmount > 10000000) return null;
        if (g.metric !== undefined && g.metric !== 'balance' && g.metric !== 'profit') return null;
        if (g.enabled !== undefined && typeof g.enabled !== 'boolean') return null;
        out.push({ id: g.id, name: g.name.trim(), targetAmount: g.targetAmount, metric: g.metric === 'profit' ? 'profit' : 'balance', enabled: g.enabled !== false });
      }
      return { ok: out };
    }
  }
  return null;
}
// Only functions are exported: the live worker already exports parseDrop the same way.
// Strict: unknown keys or bad values reject the whole patch, naming the first offender.
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'settings must be an object' };
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    const rule = SETTINGS_SCHEMA[k];
    if (!rule) return { error: `unknown setting: ${String(k).slice(0, 40)}` };
    const r = checkSetting(rule, v);
    if (!r) return { error: `bad value for ${k}` };
    out[k] = r.ok;
  }
  return { settings: out };
}
async function sha256Hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
// Signed-in Discord user for /settings: CollectClock session first, else verify the Discord token
// with Discord once and cache token-hash -> id for 15 minutes (the raw token is never stored).
export async function settingsUser(env, req, ip, fetchImpl = fetch) {
  const sess = await userFor(env, req);
  if (sess) return sess;
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (tok.length < 20 || tok.length > 256 || !/^[A-Za-z0-9._~+/=-]+$/.test(tok)) return null;
  const key = 'dtok:' + (await sha256Hex('tc-settings:' + tok));
  const cached = await env.CC.get(key);
  if (cached) return cached;
  if (await limited(env, 'dtokv:' + ip, 60, 3600)) return null;
  const r = await fetchImpl('https://discord.com/api/v10/users/@me', { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) return null;
  const me = await r.json().catch(() => null);
  if (!me || !/^[0-9]{5,25}$/.test(String(me.id || ''))) return null;
  await env.CC.put(key, String(me.id), { expirationTtl: 900 });
  return String(me.id);
}
function settingsCors(req, body, status = 200) {
  const o = req.headers.get('Origin');
  const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' });
  if (o && TC_ORIGINS.includes(o)) {
    h.set('Access-Control-Allow-Origin', o);
    h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    h.set('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    h.set('Access-Control-Max-Age', '600');
  }
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: h });
}
export async function handleSettings(req, env, ip, fetchImpl = fetch) {
  if (req.method === 'OPTIONS') return settingsCors(req, null, 204);
  if (req.method !== 'GET' && req.method !== 'PUT') return settingsCors(req, { error: 'GET or PUT' }, 405);
  const uid = await settingsUser(env, req, ip, fetchImpl);
  if (!uid) return settingsCors(req, { error: 'not signed in' }, 401);
  const key = 'tcset:' + uid;
  const stored = JSON.parse((await env.CC.get(key)) || 'null') || { settings: {}, updatedAt: null };
  if (req.method === 'GET') return settingsCors(req, { settings: stored.settings || {}, updatedAt: stored.updatedAt || null });
  if (await limited(env, 'tcset:' + uid, 120, 3600)) return settingsCors(req, { error: 'slow down' }, 429);
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > SETTINGS_MAX_BYTES) return settingsCors(req, { error: 'too big' }, 413);
  const text = await req.text();
  if (text.length > SETTINGS_MAX_BYTES) return settingsCors(req, { error: 'too big' }, 413);
  let body; try { body = JSON.parse(text); } catch { return settingsCors(req, { error: 'bad json' }, 400); }
  const v = validateSettingsPatch(body && body.settings);
  if (v.error) return settingsCors(req, { error: v.error }, 400);
  const next = { settings: { ...(stored.settings || {}), ...v.settings }, updatedAt: Date.now() };
  const out = JSON.stringify(next);
  if (out.length > SETTINGS_MAX_BYTES) return settingsCors(req, { error: 'too big' }, 413);
  await env.CC.put(key, out);
  return settingsCors(req, { ok: true, settings: next.settings, updatedAt: next.updatedAt });
}


const DROP_CHANNEL = '1488256038665981982';
function walk(cs, out) {
  for (const c of cs || []) {
    if (c.type === 10 && c.content) out.text.push(c.content);
    if (c.type === 2 && c.url) out.buttons.push({ label: c.label || '', url: c.url });
    if (c.components) walk(c.components, out);
  }
  return out;
}
export function parseDrop(m) {
  const o = walk(m.components, { text: [], buttons: [] });
  const text = o.text.join('\n');
  const title = (text.match(/^#\s+(.+)$/m) || [])[1];
  if (!title) return null;
  const code = (text.match(/```\s*\n?([^`\n]+)\n?```/) || [])[1] || null;
  const claim = (o.buttons.find(b => /claim/i.test(b.label)) || o.buttons.find(b => !/sign ?up|ref=/i.test(b.label + b.url)) || {}).url || null;
  return { id: m.id, ts: Date.parse(m.timestamp), title: title.trim().slice(0, 120), code: code && code.trim().slice(0, 40), claim };
}
async function pullDrops(env) {
  if (!env.BOT_TOKEN) return;
  const r = await fetch(`https://discord.com/api/v10/channels/${DROP_CHANNEL}/messages?limit=50`, { headers: { Authorization: 'Bot ' + env.BOT_TOKEN } });
  if (!r.ok) { await env.CC.put('drops:err', `${r.status} ${new Date().toISOString()}`); return; }
  const cutoff = Date.now() - 48 * 3600 * 1000;
  const drops = (await r.json()).map(parseDrop).filter(d => d && d.ts >= cutoff);
  await env.CC.put('drops', JSON.stringify({ updated: Date.now(), drops }));
}


// ---- TiltCheck Discord roles: Beta Tester (opt-in) and OG (linked before 2027) ----
const TC_GUILD = '1488253239643078787', BETA_ROLE = '1492283508456947904', OG_ROLE = '1569374202430234814', DEGEN_ROLE = '1569374414150176879', COLLECTOR_ROLE = '1569374662209839104', TILTED_ROLE = '1569374728937013429', GAMER_ROLE = '1569374876152635392', TC_INVITE = 'https://discord.gg/gdBsEJfCar';
const OG_CUTOFF = Date.parse('2027-01-01T06:00:00Z'); // midnight Central, Jan 1 2027
async function giveRole(env, uid, role) {
  if (!env.BOT_TOKEN) return { member: null };
  const H = { Authorization: 'Bot ' + env.BOT_TOKEN };
  const m = await fetch(`https://discord.com/api/v10/guilds/${TC_GUILD}/members/${uid}`, { headers: H });
  if (m.status === 404) return { member: false };
  if (!m.ok) return { member: null };
  const mem = await m.json();
  if ((mem.roles || []).includes(role)) return { member: true, role: true };
  const r = await fetch(`https://discord.com/api/v10/guilds/${TC_GUILD}/members/${uid}/roles/${role}`, { method: 'PUT', headers: { ...H, 'X-Audit-Log-Reason': 'CollectClock' } });
  return { member: true, role: r.status === 204 || r.ok };
}
async function queueRole(env, uid, role) {
  const pend = JSON.parse((await env.CC.get('roles:pending')) || '[]');
  const k = uid + ':' + role;
  if (!pend.includes(k)) { pend.push(k); await env.CC.put('roles:pending', JSON.stringify(pend.slice(-4000))); }
}
async function roleSweep(env) {
  const old = JSON.parse((await env.CC.get('beta:pending')) || '[]');
  let pend = JSON.parse((await env.CC.get('roles:pending')) || '[]').concat(old.map(u => u + ':' + BETA_ROLE));
  if (old.length) await env.CC.delete('beta:pending');
  if (!pend.length) return;
  const left = [];
  for (const k of pend.slice(0, 25)) { const [u, r] = k.split(':'); const g = await giveRole(env, u, r); if (!g.role) left.push(k); }
  await env.CC.put('roles:pending', JSON.stringify(left.concat(pend.slice(25)).slice(-4000)));
}
async function tokenLogin(env, token) {
  const r = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + String(token || '') } });
  if (!r.ok) return { error: 'discord rejected token' };
  const me = await r.json();
  if (!me.id) return { error: 'no user' };
  const sess = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  await env.CC.put('sess:' + sess, me.id, { expirationTtl: 60 * 60 * 24 * 90 });
  await countMember(env, me.id);
  const avatar = me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(me.id) >> 22n) % 6n)}.png`;
  let roles = {}; try { roles = await linkRoles(env, me.id, false); } catch {}
  return { session: sess, name: me.global_name || me.username || 'you', avatar, og: roles.og || null, invite: TC_INVITE };
}
async function appRoles(env, uid, role) {
  const out = {};
  for (const [k, r] of [['app', role], ['degen', DEGEN_ROLE]].concat(Date.now() < OG_CUTOFF ? [['og', OG_ROLE]] : [])) { out[k] = await giveRole(env, uid, r); if (!out[k].role) await queueRole(env, uid, r); }
  return out;
}
async function linkRoles(env, uid, wantBeta) {
  const out = {};
  out.degen = await giveRole(env, uid, DEGEN_ROLE); if (!out.degen.role) await queueRole(env, uid, DEGEN_ROLE);
  if (Date.now() < OG_CUTOFF) { out.og = await giveRole(env, uid, OG_ROLE); if (!out.og.role) await queueRole(env, uid, OG_ROLE); }
  out.collector = await giveRole(env, uid, COLLECTOR_ROLE); if (!out.collector.role) await queueRole(env, uid, COLLECTOR_ROLE);
  if (wantBeta) { out.beta = await giveRole(env, uid, BETA_ROLE); if (!out.beta.role) await queueRole(env, uid, BETA_ROLE); }
  return out;
}

// ---- Community casino reports (feeds TiltCheck casino trust engine) ----
const CR_CATS = {
  withdrawal_delay: { label: 'Slow withdrawal', engine: 'financialPayouts', delta: -3 },
  withdrawal_denied: { label: 'Withdrawal denied', engine: 'financialPayouts', delta: -6 },
  kyc_stall: { label: 'KYC stalled', engine: 'financialPayouts', delta: -3 },
  account_closed: { label: 'Account closed or limited', engine: 'fairnessTransparency', delta: -4 },
  terms_changed: { label: 'Bonus or terms changed', engine: 'promotionalHonesty', delta: -3 },
  support_ghosted: { label: 'Support unresponsive', engine: 'operationalSupport', delta: -2 },
  bonus_wrong: { label: 'Daily bonus missing or wrong', engine: 'promotionalHonesty', delta: -1 },
};
const COOL_MS = 3600 * 1000, WINDOW_MS = 30 * 86400 * 1000, MIN_REPORTERS = 3;
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
async function hashId(id) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cc:' + id)); return [...new Uint8Array(b)].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join(''); }
function weigh(r) {
  const rant = /\b(rigged|scam|scammers?|fraud|thie(f|ves)|steal|stole)\b/i.test(r.details || '');
  const evidence = !!(r.ticket || r.amount || r.days);
  if (rant && !evidence) return 0;
  return evidence ? 1.5 : 1;
}
async function crList(env, cs) { return JSON.parse((await env.CC.get('cr:' + cs)) || '[]'); }
function crSummary(list, now = Date.now()) {
  const by = {};
  for (const r of list) {
    if (r.withdrawn || r.weight <= 0 || now - r.at < COOL_MS || now - r.at > WINDOW_MS) continue;
    (by[r.category] ||= new Set()).add(r.who);
  }
  return Object.entries(by).filter(([, w]) => w.size >= MIN_REPORTERS).map(([c, w]) => ({ category: c, label: CR_CATS[c].label, reporters: w.size }));
}

// ---- Verified rug flags: 3+ players or a staff ✅ in #reports. Persist until replaced or cleared. ----
async function getRug(env) { return JSON.parse((await env.CC.get('rug:live')) || '{}'); }
async function verifyRug(env, cs, casino, category, how) {
  const rug = await getRug(env);
  const cur = rug[cs] || { casino, flags: {} };
  if (cur.flags[category]) return false;
  cur.casino = casino;
  cur.flags[category] = { label: CR_CATS[category].label, at: Date.now(), ...how };
  rug[cs] = cur;
  await env.CC.put('rug:live', JSON.stringify(rug));
  if (env.TRUST_WEBHOOK) {
    const c = CR_CATS[category];
    const why = how.staff ? `verified by staff (${txt(how.staff, 40)})` : `${how.reporters} players reported it`;
    try { await fetch(env.TRUST_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'TiltCheck Trust Alerts',
      embeds: [{ title: `🚩 ${txt(casino, 60)}: ${c.label}`, description: `${why}. Showing on CollectClock now. Trust hit: ${c.engine} ${c.delta}.`, color: 0xff3d8b, url: 'https://tiltcheck-me.github.io/CollectClock/', timestamp: new Date().toISOString() }],
      allowed_mentions: { parse: [] } }) }); } catch {}
  }
  return true;
}
async function trustSweep(env) {
  try {
    const idx = JSON.parse((await env.CC.get('cr:index')) || '[]');
    const owner = await guildOwner(env);
    let checks = 0;
    for (const cs of idx) {
      const list = await crList(env, cs);
      if (!list.length) continue;
      for (const s of crSummary(list)) await verifyRug(env, cs, list[0].casino, s.category, { reporters: s.reporters });
      const rug = await getRug(env);
      for (const r of list) {
        if (!r.msg || r.withdrawn || r.staffOk || Date.now() - r.at > 14 * 86400000 || checks >= 25) continue;
        if (rug[cs] && rug[cs].flags[r.category]) continue;
        checks++;
        const rr = await fetch(`https://discord.com/api/v10/channels/${r.ch}/messages/${r.msg}/reactions/${encodeURIComponent('✅')}?limit=25`, { headers: { Authorization: 'Bot ' + env.BOT_TOKEN } });
        if (!rr.ok) continue;
        const users = (await rr.json()).filter(u => !u.bot);
        for (const u of users) {
          const w = await whoIs(env, u.id);
          if (w.staff || u.id === owner) { r.staffOk = true; await verifyRug(env, cs, r.casino, r.category, { staff: w.name || u.username || 'staff' }); break; }
        }
      }
      if (list.some(r => r.staffOk)) await env.CC.put('cr:' + cs, JSON.stringify(list));
    }
  } catch {}
}

// ---- Members, click stats, staff checks, info overrides, support inbox, admin ----
const STAFF_ROLE = '1488256012807966751';
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const seenMem = new Set();
async function countMember(env, uid) {
  if (!uid || seenMem.has(uid)) return;
  seenMem.add(uid);
  try {
    if (await env.CC.get('mem:' + uid)) return;
    await env.CC.put('mem:' + uid, String(Date.now()));
    const n = Number((await env.CC.get('stat:members')) || 0) + 1;
    await env.CC.put('stat:members', String(n));
    const days = JSON.parse((await env.CC.get('stat:newdays')) || '{}');
    const d = dayKey(); days[d] = (days[d] || 0) + 1;
    for (const k of Object.keys(days).sort().slice(0, -60)) delete days[k];
    await env.CC.put('stat:newdays', JSON.stringify(days));
  } catch {}
}
// Who is this Discord user in the TiltCheck guild? Cached ~4 min. Fails closed (no staff/beta on any error).
async function guildOwner(env) {
  let o = await env.CC.get('guild:owner');
  if (o) return o;
  try {
    const r = await fetch(`https://discord.com/api/v10/guilds/${TC_GUILD}`, { headers: { Authorization: 'Bot ' + env.BOT_TOKEN } });
    if (!r.ok) return null;
    o = (await r.json()).owner_id || null;
    if (o) await env.CC.put('guild:owner', o, { expirationTtl: 86400 });
    return o;
  } catch { return null; }
}
async function whoIs(env, uid) {
  const none = { staff: false, beta: false, name: null };
  if (!uid || !env.BOT_TOKEN) return none;
  const c = await env.CC.get('who:' + uid);
  if (c) { try { return JSON.parse(c); } catch {} }
  try {
    const r = await fetch(`https://discord.com/api/v10/guilds/${TC_GUILD}/members/${uid}`, { headers: { Authorization: 'Bot ' + env.BOT_TOKEN } });
    let out;
    if (r.status === 404) out = { staff: false, beta: !!(await env.CC.get('beta:' + uid)), name: null, member: false };
    else if (!r.ok) return none; // don't cache failures
    else {
      const m = await r.json(), roles = m.roles || [];
      const owner = await guildOwner(env);
      out = { staff: roles.includes(STAFF_ROLE) || (!!owner && owner === uid), beta: roles.includes(BETA_ROLE) || !!(await env.CC.get('beta:' + uid)),
        name: (m.nick || (m.user && (m.user.global_name || m.user.username)) || null), member: true };
    }
    await env.CC.put('who:' + uid, JSON.stringify(out), { expirationTtl: 240 });
    return out;
  } catch { return none; }
}
function httpUrl(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.length > 400) return null;
  try { const u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') ? u.href : null; } catch { return null; }
}
const txt = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').replace(/@/g, '@\u200b').trim().slice(0, n);
async function getOv(env) { return JSON.parse((await env.CC.get('ov:live')) || '{"updated":0,"items":{}}'); }
async function applyOv(env, e, by) {
  const ov = await getOv(env);
  const cur = { ...(ov.items[e.slug] || {}) };
  for (const f of ['claim', 'bonus', 'note', 'hours', 'logo']) { if (e[f]) cur[f] = e[f]; else delete cur[f]; }
  cur.casino = e.casino; cur.at = Date.now(); cur.by = by;
  if (cur.claim || cur.bonus || cur.note || cur.hours || cur.logo) ov.items[e.slug] = cur; else delete ov.items[e.slug];
  ov.updated = Date.now();
  await env.CC.put('ov:live', JSON.stringify(ov));
  return ov.items[e.slug] || null;
}
async function hook(env, content) {
  if (!env.WEBHOOK_URL) return false;
  try {
    const r = await fetch(env.WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Collect Clock', avatar_url: 'https://tiltcheck-me.github.io/CollectClock/assets/icon.png', content: content.slice(0, 1900), allowed_mentions: { parse: [] } }) });
    return r.ok;
  } catch { return false; }
}
const beaconHits = new Map();
const EV_TYPES = ['collect', 'icon', 'signup', 'visit'];
async function adminStats(env) {
  const now = Date.now(), days = [];
  for (let i = 0; i < 30; i++) days.push(dayKey(now - i * 86400000));
  const evs = await Promise.all(days.map(d => env.CC.get('ev:' + d).then(v => [d, v ? JSON.parse(v) : {}])));
  const casinos = {}, perDay = [];
  evs.forEach(([d, o], i) => {
    let dayCollects = 0, dayClicks = 0;
    for (const [cs, c] of Object.entries(o)) {
      const row = casinos[cs] ||= { name: c.n || cs, collect7: 0, collect30: 0, clicks7: 0, clicks30: 0, icon30: 0, signup30: 0 };
      const clicks = (c.collect || 0) + (c.icon || 0) + (c.signup || 0) + (c.visit || 0);
      row.collect30 += c.collect || 0; row.clicks30 += clicks; row.icon30 += c.icon || 0; row.signup30 += c.signup || 0;
      if (i < 7) { row.collect7 += c.collect || 0; row.clicks7 += clicks; }
      dayCollects += c.collect || 0; dayClicks += clicks;
    }
    perDay.push({ day: d, collects: dayCollects, clicks: dayClicks });
  });
  const idx = JSON.parse((await env.CC.get('cr:index')) || '[]');
  const reports = [], summary = {};
  for (const cs of idx) {
    const list = await crList(env, cs);
    const sm = crSummary(list); if (sm.length) summary[cs] = sm;
    for (const r of list.slice(0, 20)) reports.push({ casino: r.casino, category: r.category, label: (CR_CATS[r.category] || {}).label || r.category, at: r.at, amount: r.amount, days: r.days, ticket: r.ticket, details: r.details, weight: r.weight, withdrawn: !!r.withdrawn, who: r.who });
  }
  reports.sort((a, b) => b.at - a.at);
  const drops = JSON.parse((await env.CC.get('drops')) || '{"drops":[]}');
  return {
    generated: now,
    members: Number((await env.CC.get('stat:members')) || 0),
    newUsers: JSON.parse((await env.CC.get('stat:newdays')) || '{}'),
    casinos, perDay,
    reports: reports.slice(0, 40), reportSummary: summary, minReporters: MIN_REPORTERS,
    support: JSON.parse((await env.CC.get('sup:list')) || '[]'),
    rug: await getRug(env),
    pending: JSON.parse((await env.CC.get('ov:pending')) || '[]'),
    overrides: (await getOv(env)).items,
    drops: { count: (drops.drops || []).length, updated: drops.updated || null, error: await env.CC.get('drops:err') },
    rolesPending: JSON.parse((await env.CC.get('roles:pending')) || '[]').length,
  };
}

export default {
  async scheduled(evt, env, ctx) { ctx.waitUntil(Promise.all([pullDrops(env), roleSweep(env), trustSweep(env)])); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/settings') return handleSettings(req, env, req.headers.get('CF-Connecting-IP') || 'x');

    if (url.pathname === '/casino-report' && req.method === 'POST') {
      const uid = await userFor(env, req);
      if (!uid) return json({ error: 'sign in with Discord to report' }, 401);
      let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const cs = slug(b.casino), cat = String(b.category || '');
      if (!cs || !CR_CATS[cat]) return json({ error: 'pick a casino and a problem type' }, 400);
      const who = await hashId(uid);
      if (await env.CC.get(`crlock:${who}:${cs}`)) return json({ error: 'You already reported this casino in the last 30 days.' }, 429);
      if (await limited(env, 'crday:' + who, 5, 86400)) return json({ error: 'slow down' }, 429);
      const r = {
        id: crypto.randomUUID(), casino: String(b.casino).slice(0, 60), category: cat, who, at: Date.now(),
        amount: Number(b.amount) > 0 ? Math.min(Number(b.amount), 1e7) : null,
        days: Number(b.days) > 0 ? Math.min(Math.round(Number(b.days)), 365) : null,
        ticket: b.ticket ? String(b.ticket).slice(0, 40) : null,
        details: String(b.details || '').replace(/@/g, '').slice(0, 300),
      };
      r.weight = weigh(r);
      const list = (await crList(env, cs)).filter(x => Date.now() - x.at < 90 * 86400 * 1000);
      list.unshift(r);
      await env.CC.put('cr:' + cs, JSON.stringify(list.slice(0, 500)));
      await env.CC.put(`crlock:${who}:${cs}`, r.id, { expirationTtl: 30 * 86400 });
      const idx = JSON.parse((await env.CC.get('cr:index')) || '[]');
      if (!idx.includes(cs)) { idx.push(cs); await env.CC.put('cr:index', JSON.stringify(idx)); }
      if (env.REPORTS_WEBHOOK) {
        const rw = await whoIs(env, uid);
        const bits = [CR_CATS[cat] && CR_CATS[cat].label ? CR_CATS[cat].label : cat, r.amount ? `$${r.amount}` : '', r.days ? `${r.days} days waiting` : '', r.ticket ? `ticket ${txt(r.ticket, 40)}` : ''].filter(Boolean).join(' · ');
        const content = [`🚩 Got rugged: **${txt(r.casino, 60)}** · ${bits}`, `From **${txt((rw && rw.name) || '', 40) || 'a signed-in user'}**`, r.details ? `> ${txt(r.details, 300)}` : ''].filter(Boolean).join('\n');
        try {
          const wr = await fetch(env.REPORTS_WEBHOOK + '?wait=true', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'CollectClock Reports', content: content + '\nStaff: tap ✅ to verify, it goes live on CollectClock and #trust-alerts.', allowed_mentions: { parse: [] } }) });
          if (wr.ok) {
            const m = await wr.json();
            r.msg = m.id; r.ch = m.channel_id;
            const l2 = await crList(env, cs); const t = l2.find(x => x.id === r.id); if (t) { t.msg = m.id; t.ch = m.channel_id; await env.CC.put('cr:' + cs, JSON.stringify(l2)); }
            await fetch(`https://discord.com/api/v10/channels/${m.channel_id}/messages/${m.id}/reactions/${encodeURIComponent('✅')}/@me`, { method: 'PUT', headers: { Authorization: 'Bot ' + env.BOT_TOKEN } });
          }
        } catch {}
      }
      return json({ ok: true, id: r.id, counts_after: new Date(r.at + COOL_MS).toISOString(), weight: r.weight });
    }
    if (url.pathname === '/casino-report/withdraw' && req.method === 'POST') {
      const uid = await userFor(env, req);
      if (!uid) return json({ error: 'not signed in' }, 401);
      let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const cs = slug(b.casino), who = await hashId(uid);
      const list = await crList(env, cs);
      const r = list.find(x => x.id === b.id && x.who === who);
      if (!r) return json({ error: 'not found' }, 404);
      r.withdrawn = true;
      await env.CC.put('cr:' + cs, JSON.stringify(list));
      return json({ ok: true });
    }
    if (url.pathname === '/casino-reports/summary' && req.method === 'GET') {
      const idx = JSON.parse((await env.CC.get('cr:index')) || '[]');
      const out = {};
      for (const cs of idx) { const sm = crSummary(await crList(env, cs)); if (sm.length) out[cs] = sm; }
      const rug = await getRug(env);
      for (const [cs, v] of Object.entries(rug)) {
        const arr = out[cs] || [];
        for (const [cat, f] of Object.entries(v.flags)) {
          const ex = arr.find(a => a.category === cat);
          if (ex) { ex.verified = true; ex.staff = !!f.staff; } else arr.push({ category: cat, label: f.label, reporters: f.reporters || 0, verified: true, staff: !!f.staff, at: f.at });
        }
        if (arr.length) out[cs] = arr;
      }
      return json({ updated: Date.now(), minReporters: MIN_REPORTERS, casinos: out });
    }
    if (url.pathname === '/casino-reports/export' && req.method === 'GET') {
      // Trust-engine shaped events (trust.casino.updated payload style). Reporter ids are hashed.
      const idx = JSON.parse((await env.CC.get('cr:index')) || '[]');
      const events = [];
      for (const cs of idx) {
        const list = await crList(env, cs);
        for (const s of crSummary(list)) {
          const c = CR_CATS[s.category];
          events.push({ casinoName: list[0].casino, category: c.engine, delta: c.delta * Math.min(s.reporters, 10) / MIN_REPORTERS, reason: `Community: ${s.reporters} verified reports of "${c.label}" in 30 days`, source: 'collectclock-community', reporters: s.reporters });
        }
      }
      const rug = await getRug(env);
      for (const v of Object.values(rug)) for (const [cat, f] of Object.entries(v.flags)) if (f.staff) { const c = CR_CATS[cat]; events.push({ casinoName: v.casino, category: c.engine, delta: c.delta, reason: `Staff verified: "${c.label}"`, source: 'collectclock-staff', at: new Date(f.at).toISOString() }); }
      return json({ generated: new Date().toISOString(), events });
    }
    if (url.pathname === '/drops' && req.method === 'GET') {
      const v = await env.CC.get('drops');
      return json(v ? JSON.parse(v) : { drops: [] });
    }
    if (req.method === 'OPTIONS') return cors(null, { status: 204 });
    const ip = req.headers.get('CF-Connecting-IP') || 'x';

    if (url.pathname === '/stats/members' && req.method === 'GET') {
      return json({ count: Number((await env.CC.get('stat:members')) || 0) });
    }
    if (url.pathname === '/beacon' && req.method === 'POST') {
      // Fire-and-forget click counter (navigator.sendBeacon, text/plain). Clicks, not confirmed sign-ups.
      const o = req.headers.get('Origin');
      if (o && o !== SITE) return new Response(null, { status: 204 });
      const n = (beaconHits.get(ip) || 0) + 1; beaconHits.set(ip, n);
      if (beaconHits.size > 5000) beaconHits.clear();
      if (n > 120) return new Response(null, { status: 204 });
      let b; try { b = JSON.parse((await req.text()).slice(0, 500)); } catch { return new Response(null, { status: 204 }); }
      const cs = slug(b.c), t = String(b.t || '');
      if (!cs || !EV_TYPES.includes(t)) return new Response(null, { status: 204 });
      const k = 'ev:' + dayKey();
      const day = JSON.parse((await env.CC.get(k)) || '{}');
      if (!day[cs] && Object.keys(day).length >= 400) return new Response(null, { status: 204 });
      const row = day[cs] ||= {}; row[t] = (row[t] || 0) + 1; if (b.n) row.n = txt(b.n, 60);
      await env.CC.put(k, JSON.stringify(day), { expirationTtl: 40 * 86400 });
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': SITE } });
    }
    if (url.pathname === '/overrides' && req.method === 'GET') {
      const ov = await getOv(env); for (const k in ov.items) { const { by, ...rest } = ov.items[k]; ov.items[k] = rest; }
      return cors(JSON.stringify(ov), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } });
    }
    if (url.pathname === '/me' && req.method === 'GET') {
      const uid = await userFor(env, req);
      if (!uid) return json({ error: 'not signed in' }, 401);
      const w = await whoIs(env, uid);
      return json({ staff: !!w.staff, beta: !!w.beta, canEdit: !!(w.staff || w.beta) });
    }
    if (url.pathname === '/overrides' && req.method === 'POST') {
      const uid = await userFor(env, req);
      if (!uid) return json({ error: 'sign in with Discord first' }, 401);
      const w = await whoIs(env, uid);
      if (!w.staff && !w.beta) return json({ error: 'Beta Testers and staff only' }, 403);
      if (await limited(env, (w.staff ? 'ovs:' : 'ovb:') + uid, w.staff ? 60 : 10, w.staff ? 3600 : 86400)) return json({ error: 'slow down' }, 429);
      let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const cs = slug(b.casino);
      if (!cs) return json({ error: 'which casino?' }, 400);
      const claim = httpUrl(b.claim);
      if (claim === null) return json({ error: 'Link must be a full http(s) URL' }, 400);
      const hrs = Number(b.hours) > 0 ? Math.min(720, Math.max(0.25, Math.round(Number(b.hours) * 4) / 4)) : 0;
      let logo = '';
      if (b.logo) {
        const L = String(b.logo);
        if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(L) && L.length <= 60000) logo = L;
        else { const u = httpUrl(L); if (!u || !u.startsWith('https:')) return json({ error: 'Logo must be an uploaded image or an https link' }, 400); logo = u; }
      }
      const e = { slug: cs, casino: txt(b.casino, 60), claim, bonus: txt(b.bonus, 200), note: txt(b.note, 200), hours: hrs || '', logo };
      const who = { id: await hashId(uid), name: txt(w.name || '', 40) || null };
      const det = [e.bonus && `Amount: ${e.bonus}`, e.claim && `Collect page: <${e.claim}>`, e.hours && `Every: ${e.hours}h`, e.logo && 'Logo: updated', e.note && `Notes: ${e.note}`].filter(Boolean).join('\n');
      if (w.staff) { const item = await applyOv(env, e, { ...who, staff: true }); await hook(env, `★ **${e.casino}** info updated (live) · by **${who.name || 'staff'}**` + (det ? '\n' + det : '')); return json({ ok: true, live: true, item }); }
      const pend = JSON.parse((await env.CC.get('ov:pending')) || '[]');
      if (pend.filter(p => p.by.id === who.id).length >= 20) return json({ error: 'You have a lot waiting for review already' }, 429);
      const p = { id: crypto.randomUUID(), ...e, by: who, at: Date.now() };
      pend.unshift(p);
      await env.CC.put('ov:pending', JSON.stringify(pend.slice(0, 200)));
      await hook(env, `📝 **${e.casino}** edit waiting for review · from **${who.name || 'a beta tester'}**` + (det ? '\n' + det : ''));
      return json({ ok: true, live: false, pending: true, id: p.id });
    }
    if (url.pathname === '/support' && req.method === 'POST') {
      const uid = await userFor(env, req);
      if (!uid) return json({ error: 'sign in with Discord to send this' }, 401);
      const who = await hashId(uid);
      if (await limited(env, 'sup:' + who, 5, 86400)) return json({ error: 'slow down' }, 429);
      let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      let item;
      if (b.kind === 'casino') {
        const name = txt(b.name, 60), link = httpUrl(b.url), ref = httpUrl(b.ref);
        if (!name || !link) return json({ error: 'Casino name and a full http(s) URL, please' }, 400);
        if (ref === null) return json({ error: 'Referral link must be a full http(s) URL' }, 400);
        item = { kind: 'casino', name, url: link, ref: ref || null, note: txt(b.note, 300) };
      } else if (b.kind === 'contact' || b.kind === 'feedback') {
        const msg = txt(b.message, 1000);
        if (!msg) return json({ error: 'Say something first' }, 400);
        item = { kind: b.kind, message: msg, contact: txt(b.contact, 120) || null };
      } else return json({ error: 'bad kind' }, 400);
      const w = await whoIs(env, uid);
      const byName = txt(w.name || '', 40) || null;
      Object.assign(item, { id: crypto.randomUUID(), at: Date.now(), who, byName });
      if (item.kind !== 'casino') item.name = byName;
      const list = JSON.parse((await env.CC.get('sup:list')) || '[]');
      list.unshift(item);
      await env.CC.put('sup:list', JSON.stringify(list.slice(0, 300)));
      await hook(env, item.kind === 'casino' ? `➕ Casino suggestion: **${item.name}** <${item.url}> · from **${item.byName || 'someone'}**` : item.kind === 'feedback' ? `💡 Feedback · from **${item.byName || 'someone'}**\n${item.message.slice(0, 600)}` : `📬 New contact message · from **${item.byName || 'someone'}** (see admin page)`);
      return json({ ok: true });
    }
    if (url.pathname === '/admin/stats' && req.method === 'GET') {
      const uid = await userFor(env, req);
      if (!uid) return json({ error: 'not signed in' }, 401);
      const w = await whoIs(env, uid);
      if (!w.staff) return json({ error: 'forbidden' }, 403);
      return json(await adminStats(env));
    }
    if (url.pathname === '/admin/rug-clear' && req.method === 'POST') {
      const uid = await userFor(env, req);
      if (!uid) return json({ error: 'not signed in' }, 401);
      const w = await whoIs(env, uid);
      if (!w.staff) return json({ error: 'forbidden' }, 403);
      let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const rug = await getRug(env); const cs = slug(b.casino);
      if (rug[cs]) { if (b.category) delete rug[cs].flags[b.category]; else rug[cs].flags = {}; if (!Object.keys(rug[cs].flags).length) delete rug[cs]; await env.CC.put('rug:live', JSON.stringify(rug)); }
      return json({ ok: true });
    }
    if (url.pathname === '/admin/review' && req.method === 'POST') {
      const uid = await userFor(env, req);
      if (!uid) return json({ error: 'not signed in' }, 401);
      const w = await whoIs(env, uid);
      if (!w.staff) return json({ error: 'forbidden' }, 403);
      let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const pend = JSON.parse((await env.CC.get('ov:pending')) || '[]');
      const p = pend.find(x => x.id === b.id);
      if (!p) return json({ error: 'not found' }, 404);
      if (b.action !== 'approve' && b.action !== 'reject') return json({ error: 'approve or reject' }, 400);
      await env.CC.put('ov:pending', JSON.stringify(pend.filter(x => x.id !== b.id)));
      let item = null;
      if (b.action === 'approve') item = await applyOv(env, p, { ...p.by, approvedBy: txt(w.name || '', 40) || 'staff' });
      return json({ ok: true, action: b.action, item });
    }

    if (url.pathname === '/report' && req.method === 'POST') {
      if (await limited(env, 'rep:' + ip, 20, 3600)) return json({ error: 'slow down' }, 429);
      let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const brand = clean(b.brand, 60);
      if (!brand) return json({ error: 'missing brand' }, 400);
      const ruid = await userFor(env, req);
      const rw = ruid ? await whoIs(env, ruid) : null;
      const by = ruid ? ` · from **${txt((rw && rw.name) || '', 40) || 'a signed-in user'}**` : ' · from a signed-out user';
      const lines0 = b.type === 'confirm'
        ? [`✅ **${brand}** confirmed: ${clean(b.listed, 120) || '(no amount listed)'}${by}`]
        : [`✏️ **${brand}** update`, `Listed: ${clean(b.listed, 120) || '(none)'}`, `Got: ${clean(b.got, 120)}`,
           b.hours ? `Reset: ${Number(b.hours) || '?'}h` : '', b.note ? `Note: ${clean(b.note, 200)}` : ''].filter(Boolean);
      const lines = b.type === 'confirm' ? lines0 : [lines0[0] + by, ...lines0.slice(1)];
      const r = await fetch(env.WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Collect Clock', avatar_url: 'https://tiltcheck-me.github.io/CollectClock/assets/icon.png', content: lines.join('\n'), allowed_mentions: { parse: [] } }) });
      return json({ ok: r.ok }, r.ok ? 200 : 502);
    }

    if (url.pathname === '/auth/discord') {
      if (!env.DISCORD_CLIENT_ID) return json({ error: 'discord login not configured' }, 503);
      const state = crypto.randomUUID();
      await env.CC.put('st:' + state, '1', { expirationTtl: 600 });
      const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, redirect_uri: url.origin + '/auth/callback',
        response_type: 'code', scope: 'identify', state, prompt: 'none' });
      return Response.redirect('https://discord.com/oauth2/authorize?' + q, 302);
    }

    if (url.pathname === '/auth/callback' && !url.searchParams.get('code')) {
      // Implicit (token) flow: the token is in the URL fragment, so hand it to the site.
      const html = `<!doctype html><meta name="viewport" content="width=device-width"><title>Signing in…</title><script>
var p=new URLSearchParams(location.hash.slice(1));var t=p.get('access_token');var st=p.get('state')||'';
if(st==='h.web'||st==='tc'){location.replace(t?'https://tiltcheck.me/login/#access_token='+encodeURIComponent(t):'https://tiltcheck.me/login/?error=1');}else
if(st.indexOf('h.')===0){history.replaceState(null,'',location.pathname);var m=function(h,x){document.body.innerHTML='<div style="font:600 20px system-ui;text-align:center;padding:60px 24px"><div style="font-size:48px">'+h+'</div><p>'+x+'</p></div>'};
if(!t)m('😬','Sign-in did not finish. Go back to CollectClock and try again.');else fetch('/auth/handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:st.slice(2),access_token:t})}).then(function(r){return r.json()}).then(function(d){d.ok?m('✅','Signed in'+(d.name?' as '+d.name:'')+'. Head back to CollectClock, it will pick you up.'):m('😬','Sign-in failed. Go back to CollectClock and try again.')}).catch(function(){m('😬','Sign-in failed. Go back to CollectClock and try again.')});}
else location.replace('${SITE}${SITE_PATH}#'+(t?'cc_dtoken='+encodeURIComponent(t):'cc_login=failed'));
</script><body>Signing in…`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' } });
    }

    if (url.pathname === '/roles/app') {
      const any = (o, st = 200) => new Response(o === null ? null : JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
      if (req.method === 'OPTIONS') return any(null, 204);
      if (req.method !== 'POST') return any({ error: 'POST only' }, 405);
      let b; try { b = await req.json(); } catch { return any({ error: 'bad json' }, 400); }
      const role = { tiltcheck: TILTED_ROLE, game: GAMER_ROLE, collectclock: COLLECTOR_ROLE }[b.app];
      if (!role || typeof b.access_token !== 'string') return any({ error: 'need app and access_token' }, 400);
      const me = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: 'Bearer ' + b.access_token } });
      if (!me.ok) return any({ error: 'discord token rejected' }, 401);
      const uid = (await me.json()).id;
      if (await limited(env, 'approles:' + uid, 20, 3600)) return any({ error: 'slow down' }, 429);
      await countMember(env, uid);
      return any({ ...(await appRoles(env, uid, role)), invite: TC_INVITE });
    }
    if (url.pathname === '/roles/link' && req.method === 'POST') {
      const uid = await userFor(env, req);
      if (!uid) return json({ error: 'sign in first' }, 401);
      if (await limited(env, 'roles:' + uid, 10, 3600)) return json({ error: 'slow down' }, 429);
      await countMember(env, uid);
      return json({ ...(await linkRoles(env, uid, false)), invite: TC_INVITE });
    }
    if (url.pathname === '/beta/link' && req.method === 'POST') {
      const uid = await userFor(env, req);
      if (!uid) return json({ error: 'sign in first' }, 401);
      if (await limited(env, 'beta:' + uid, 20, 3600)) return json({ error: 'slow down' }, 429);
      await env.CC.put('beta:' + uid, String(Date.now()));
      await countMember(env, uid);
      const g = await giveRole(env, uid, BETA_ROLE);
      if (!g.role) await queueRole(env, uid, BETA_ROLE);
      return json({ ...g, invite: TC_INVITE });
    }

    if (url.pathname === '/auth/token' && req.method === 'POST') {
      if (await limited(env, 'auth:' + ip, 30, 3600)) return json({ error: 'slow down' }, 429);
      let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const out = await tokenLogin(env, b.access_token);
      return json(out, out.session ? 200 : 401);
    }
    if (url.pathname === '/auth/handoff') {
      // App (PWA) sign-in: Discord opens in the Discord app / Safari, the callback page posts here, the app polls for it.
      if (req.method === 'POST') {
        if (await limited(env, 'auth:' + ip, 30, 3600)) return json({ error: 'slow down' }, 429);
        let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
        if (!/^[a-f0-9-]{20,64}$/.test(String(b.nonce || ''))) return json({ error: 'bad nonce' }, 400);
        const out = await tokenLogin(env, b.access_token);
        if (!out.session) return json(out, 401);
        await env.CC.put('ho:' + b.nonce, JSON.stringify(out), { expirationTtl: 600 });
        return json({ ok: true, name: out.name });
      }
      const n = url.searchParams.get('n') || '';
      if (!/^[a-f0-9-]{20,64}$/.test(n)) return json({ error: 'bad nonce' }, 400);
      const v = await env.CC.get('ho:' + n);
      if (!v) return json({ pending: true });
      await env.CC.delete('ho:' + n);
      return json(JSON.parse(v));
    }

    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      if (!code || !state || !(await env.CC.get('st:' + state))) return Response.redirect(SITE + SITE_PATH + '#cc_login=failed', 302);
      await env.CC.delete('st:' + state);
      const tr = await fetch('https://discord.com/api/oauth2/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code', code, redirect_uri: url.origin + '/auth/callback' }) });
      if (!tr.ok) return Response.redirect(SITE + SITE_PATH + '#cc_login=failed', 302);
      const { access_token } = await tr.json();
      const me = await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + access_token } })).json();
      if (!me.id) return Response.redirect(SITE + SITE_PATH + '#cc_login=failed', 302);
      const sess = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
      await env.CC.put('sess:' + sess, me.id, { expirationTtl: 60 * 60 * 24 * 90 });
      const name = encodeURIComponent(me.global_name || me.username || 'you');
      return Response.redirect(`${SITE}${SITE_PATH}#cc_session=${sess}&cc_name=${name}`, 302);
    }

    if (url.pathname === '/sync') {
      const uid = await userFor(env, req);
      if (!uid) return json({ error: 'not signed in' }, 401);
      await countMember(env, uid);
      if (req.method === 'GET') return json(JSON.parse((await env.CC.get('user:' + uid)) || '{}'));
      if (req.method === 'PUT') {
        if (await limited(env, 'sync:' + uid, 300, 86400)) return json({ error: 'slow down' }, 429);
        const text = await req.text();
        if (text.length > 60000) return json({ error: 'too big' }, 413);
        try { JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }
        await env.CC.put('user:' + uid, text);
        return json({ ok: true });
      }
    }
    if (url.pathname === '/logout' && req.method === 'POST') {
      const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (tok) await env.CC.delete('sess:' + tok);
      return json({ ok: true });
    }
    return json({ ok: true, service: 'collectclock-api' });
  }
};
