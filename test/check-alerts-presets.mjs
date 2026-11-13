// Built-in schedules in the Alerts sheet (Nuts.gg giveaway + Bink). Runs alerts.js in jsdom with stubbed page globals.
// jsdom is not a repo dependency: set JSDOM=/path/to/jsdom (or have it resolvable); without it this check is skipped.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let JSDOM;
try { ({ JSDOM } = await import(process.env.JSDOM || "jsdom")); } catch { console.log("check-alerts-presets: SKIPPED (jsdom not found; set JSDOM=/path/to/jsdom/lib/api.js)"); process.exit(0); }

const js = fs.readFileSync(path.join(root, "alerts.js"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(root, "bonus-data.json"), "utf8"));
const errors = [];
const dom = new JSDOM(`<!doctype html><body><div class="toolbar"><div class="actions"></div></div><button id="loginBtn"></button><div id="grid"></div></body>`, { url: "https://tiltcheck-me.github.io/CollectClock/", runScripts: "outside-only" });
const w = dom.window;
w.addEventListener("error", e => errors.push(e.message));
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function () { this.open = false; };
w.matchMedia = () => ({ matches: false });
const fetched = [];
w.fetch = async (u, o) => { fetched.push([String(u), o && o.method || "GET", o && o.body]); return { ok: true, status: 200, json: async () => ({}) }; };
w.eval(`var state={session:'s',timers:{},hidden:[]};var saved=0;function save(){saved++}var API='https://api.example';
var catalog=${JSON.stringify(data.map(x => ({ brand: x.brand, url: x.url, category: x.category || 'social' })))};
function render(){};function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function isVisit(x){return false}function claimUrl(x){return x.url}var toasts=[];function toast(m){toasts.push(m)}function discordLogin(){}function signOut(){}function isReady(){return true}function claim(){}`);
w.eval(js);
assert.deepEqual(errors, [], "alerts.js runs without errors");
const J = v => JSON.parse(JSON.stringify(v));
const A = w.ccAlerts, d = w.document, sites = () => w.state.push.prefs.sites;

// Confirmed schedules (Jamie, Nov 12 2026), all Central.
assert.deepEqual(J(Object.keys(A.PRESETS)), ["nuts-giveaway", "bink-bingo", "bink-freeroll", "bink-guess", "bink-race"]);
assert.deepEqual(J(A.PRESETS["bink-bingo"].times), ["10:00", "15:00", "18:00", "21:00"]);
assert.deepEqual(J(A.PRESETS["bink-freeroll"].times), ["13:00", "19:00"]);
assert.deepEqual([A.PRESETS["bink-guess"].every, A.PRESETS["bink-guess"].anchor], [20, "00:00"]);
assert.deepEqual([A.PRESETS["bink-race"].every, A.PRESETS["bink-race"].anchor], [30, "00:05"]);
assert.deepEqual([A.PRESETS["nuts-giveaway"].every, A.PRESETS["nuts-giveaway"].anchor, A.PRESETS["nuts-giveaway"].site], [30, "00:00", "Nuts.gg"]);
assert.ok(data.some(x => x.brand === "Nuts.gg"), "Nuts preset attaches to the existing Nuts.gg card");
assert.ok(!data.some(x => /bink/i.test(x.brand)), "Bink stays a preset group, not a listing card");

// Everything is off until turned on.
A.openAlerts();
assert.deepEqual(J(Object.keys(sites())), [], "no alerts on by default");
const pre = id => d.querySelector(`[data-preset="${id}"] input[data-k="pon"]`);
for (const id of Object.keys(A.PRESETS)) { assert.ok(pre(id), `${id} has a switch`); assert.equal(pre(id).checked, false); }
assert.ok(d.querySelector('[data-site="Nuts.gg"] [data-preset="nuts-giveaway"]'), "Nuts giveaway sits on the Nuts.gg row");
assert.ok(d.querySelector('[data-group="Bink"] [data-preset="bink-bingo"]'), "Bink group row exists");
assert.equal(d.querySelectorAll('[data-group="Bink"] [data-preset]').length, 4);

// Turning one on stores a preset rule (server re-derives identity) and syncs it.
const flip = (el, v) => { el.checked = v; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
flip(pre("bink-bingo"), true);
assert.deepEqual(JSON.parse(JSON.stringify(sites()["preset:bink-bingo"])), { on: true, preset: "bink-bingo", site: "Bink", label: "Bingo", url: "https://bink.bet/", tz: "America/Chicago", times: ["10:00", "15:00", "18:00", "21:00"] });
flip(pre("bink-guess"), true);
const anchor = d.querySelector('[data-preset="bink-guess"] input[data-k="anchor"]');
assert.ok(anchor, "number guessing start is editable once on");
anchor.value = "00:07"; anchor.dispatchEvent(new w.Event("change", { bubbles: true }));
assert.equal(sites()["preset:bink-guess"].anchor, "00:07");
assert.equal(d.querySelector('[data-preset="bink-race"] input[data-k="anchor"]'), null, "race times are fixed");
flip(pre("bink-bingo"), false);
assert.equal(sites()["preset:bink-bingo"], undefined, "off removes it");
await new Promise(r => setTimeout(r, 900));
const put = fetched.filter(f => f[0].endsWith("/push/prefs") && f[1] === "PUT").pop();
assert.ok(put, "prefs synced to the worker");
assert.deepEqual(Object.keys(JSON.parse(put[2]).prefs.sites), ["preset:bink-guess"]);

// Next-time math in Central regardless of the device zone, DST-correct.
const iso = t => new Date(t).toISOString();
const bingo = A.PRESETS["bink-bingo"], tz = "America/Chicago";
assert.equal(iso(A.nextFixed(bingo, Date.parse("2026-11-12T16:00:30Z"), tz)), "2026-11-12T21:00:00.000Z", "after 10:00 CST, next is 15:00 CST");
assert.equal(iso(A.nextFixed(bingo, Date.parse("2027-03-14T03:30:00Z"), tz)), "2027-03-14T15:00:00.000Z", "DST day: 10:00 CDT is 15:00Z");
assert.equal(iso(A.nextFixed(bingo, Date.parse("2026-11-01T03:30:00Z"), tz)), "2026-11-01T16:00:00.000Z", "fall-back day: 10:00 CST is 16:00Z");
assert.equal(iso(A.nextFixed(A.PRESETS["bink-race"], Date.parse("2026-11-12T16:06:00Z"), tz)), "2026-11-12T16:35:00.000Z");
assert.equal(iso(A.nextFixed({ times: ["02:30"] }, Date.parse("2027-03-14T06:00:00Z"), tz)), "2027-03-14T08:00:00.000Z", "skipped 02:30 fires at the jump");

// Your own timers can use set times each day.
assert.deepEqual(J(A.parseTimes("9:15, 20:00 bad 09:15 25:00")), ["09:15", "20:00"]);
const up = A.upcoming(Date.parse("2026-11-12T16:06:00Z"));
assert.ok(up.some(u => u.name === "Bink Number guessing"), "floating timer names the preset plainly");

// Notification tap with a preset key opens the preset's link.
A.focusSite("Bink", "preset:bink-guess");
await new Promise(r => setTimeout(r, 4500));
const sheet = d.querySelector("#installSheet");
assert.ok(sheet && /Number guessing/.test(sheet.textContent) && d.querySelector("#alGo").textContent === "Open");
console.log("alerts presets: confirmed schedules, opt-in, Nuts on its card, Bink group, editable anchor, Central/DST next times, tap opens link");
