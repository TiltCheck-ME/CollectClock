// Tests for GET/PUT /settings (TiltCheck player settings). Run: node --test worker/collectclock-api/test/*.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { handleSettings, validateSettingsPatch } from '../index.js';

function kv(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
  };
}
const TOKEN = 'discordAccessToken_abcdefghijklmnop';
const discordOk = (id = '123456789012345678') => async (url, init) => {
  assert.equal(url, 'https://discord.com/api/v10/users/@me');
  assert.equal(init.headers.Authorization, 'Bearer ' + TOKEN);
  return new Response(JSON.stringify({ id }), { status: 200 });
};
const discordNo = async () => new Response('{}', { status: 401 });
function req(method, { token = TOKEN, body, origin = 'https://tiltcheck.me', headers = {} } = {}) {
  const h = new Headers(headers);
  if (token) h.set('Authorization', 'Bearer ' + token);
  if (origin) h.set('Origin', origin);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  return new Request('https://collectclock-api.example/settings', { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
}

test('validator: accepts every known setting with good values', () => {
  const r = validateSettingsPatch({
    enabled: false, clickCheck: true, tiltSensitivity: 'degen', sneakyBet: true, sneakyBetThreshold: 0.5,
    timeCheck: true, hourlyWage: 25, timeCheckHours: 1.5, depositBlock: true, autoBreak: false, autoBreakHours: 24,
    autoBreakScore: 75, keepTheWin: true, winSkim: true, winSkimPercent: 50, winSkimMinProfit: 50, cashoutGoals: true,
    goals: [{ id: 'rent', name: 'Rent', targetAmount: 900, metric: 'balance', enabled: true }],
    bonusTracker: false, bonusName: 'Deposit Bonus', bonusTargetWager: 1000, bonusMaxBet: 5, bonusBlockOver: true,
    nopeList: true, nopeGames: ['plinko', 'sweet-bonanza'], nopeCategories: ['crash', 'bonus_buy'], sounds: true, soundVolume: 0.25,
  });
  assert.equal(r.error, undefined);
  assert.equal(Object.keys(r.settings).length, 28);
});

test('validator: rejects unknown keys, wrong types, out-of-range, and markup', () => {
  assert.match(validateSettingsPatch({ isAdmin: true }).error, /unknown setting/);
  assert.match(validateSettingsPatch({ enabled: 'yes' }).error, /enabled/);
  assert.match(validateSettingsPatch({ winSkimPercent: 95 }).error, /winSkimPercent/);
  assert.match(validateSettingsPatch({ hourlyWage: 25.5 }).error, /hourlyWage/);
  assert.match(validateSettingsPatch({ bonusName: '<img onerror=x>' }).error, /bonusName/);
  assert.match(validateSettingsPatch({ nopeGames: ['Bad Slug'] }).error, /nopeGames/);
  assert.match(validateSettingsPatch({ nopeGames: Array.from({ length: 65 }, (_, i) => 'g' + i) }).error, /nopeGames/);
  assert.match(validateSettingsPatch({ goals: [{ id: 'x', name: 'x', targetAmount: 5, sneaky: 1 }] }).error, /goals/);
  assert.match(validateSettingsPatch(null).error, /object/);
  assert.match(validateSettingsPatch([]).error, /object/);
});

test('GET without auth is 401; bad Discord token is 401', async () => {
  const env = { CC: kv() };
  assert.equal((await handleSettings(req('GET', { token: null }), env, '1.1.1.1', discordOk())).status, 401);
  assert.equal((await handleSettings(req('GET'), env, '1.1.1.1', discordNo)).status, 401);
});

test('GET with a Discord token returns empty settings for a new player, with tiltcheck.me CORS', async () => {
  const env = { CC: kv() };
  const res = await handleSettings(req('GET'), env, '1.1.1.1', discordOk());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://tiltcheck.me');
  assert.deepEqual(await res.json(), { settings: {}, updatedAt: null });
  // The raw token is never stored, only a hash -> id cache.
  for (const [k, v] of env.CC.m) { assert.ok(!k.includes(TOKEN) && !v.includes(TOKEN)); }
});

test('PUT merges a validated patch, scoped to the signed-in user', async () => {
  const env = { CC: kv() };
  let r = await handleSettings(req('PUT', { body: { settings: { winSkimPercent: 30, nopeList: true } } }), env, 'ip', discordOk('111111111111111111'));
  assert.equal(r.status, 200);
  r = await handleSettings(req('PUT', { body: { settings: { enabled: false } } }), env, 'ip', discordOk('111111111111111111'));
  const body = await r.json();
  assert.deepEqual(body.settings, { winSkimPercent: 30, nopeList: true, enabled: false });
  assert.equal(typeof body.updatedAt, 'number');
  assert.ok(env.CC.m.has('tcset:111111111111111111'));

  // Another player sees nothing of it.
  const other = await handleSettings(req('GET', { token: 'otherDiscordToken_abcdefghijklmnop' }), env, 'ip', async () => new Response(JSON.stringify({ id: '222222222222222222' })));
  assert.deepEqual((await other.json()).settings, {});
});

test('PUT rejects bad patches and leaves stored settings alone', async () => {
  const env = { CC: kv({ 'tcset:123456789012345678': JSON.stringify({ settings: { sounds: true }, updatedAt: 1 }) }) };
  const bad = await handleSettings(req('PUT', { body: { settings: { sounds: true, rootAccess: 1 } } }), env, 'ip', discordOk());
  assert.equal(bad.status, 400);
  const notJson = await handleSettings(req('PUT', { body: '{nope' }), env, 'ip', discordOk());
  assert.equal(notJson.status, 400);
  assert.deepEqual(JSON.parse(env.CC.m.get('tcset:123456789012345678')), { settings: { sounds: true }, updatedAt: 1 });
});

test('PUT over the size cap is 413', async () => {
  const env = { CC: kv() };
  const huge = JSON.stringify({ settings: { bonusName: 'x'.repeat(9000) } });
  const r = await handleSettings(req('PUT', { body: huge }), env, 'ip', discordOk());
  assert.equal(r.status, 413);
});

test('CORS: preflight for tiltcheck.me, nothing for other origins', async () => {
  const env = { CC: kv() };
  const pre = await handleSettings(req('OPTIONS', { token: null }), env, 'ip', discordOk());
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /PUT/);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  const evil = await handleSettings(req('GET', { origin: 'https://evil.example' }), env, 'ip', discordOk());
  assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);
});

test('a CollectClock session also works', async () => {
  const sess = 'ccsession_' + 'a'.repeat(30);
  const env = { CC: kv({ ['sess:' + sess]: '333333333333333333' }) };
  const r = await handleSettings(req('PUT', { token: sess, body: { settings: { sounds: false } } }), env, 'ip', async () => { throw new Error('should not call Discord'); });
  assert.equal(r.status, 200);
  assert.ok(env.CC.m.has('tcset:333333333333333333'));
});

test('worker routes /settings before the old CORS catch-all', async () => {
  const env = { CC: kv() };
  const res = await worker.fetch(new Request('https://collectclock-api.example/settings', { method: 'OPTIONS', headers: { Origin: 'https://tiltcheck.me' } }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://tiltcheck.me');
});
