import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const admin = fs.readFileSync(path.join(root, "admin.html"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");

assert.match(html, /<\/body>/, "index.html must close the body");
assert.match(html, /<\/html>/, "index.html must close the html document");

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.ok(scripts.length >= 1, "expected inline scripts");

// Classic scripts share one global scope: a second top-level let/const of the same name
// throws at load and silently kills that whole <script>. Parsing them as one script surfaces it.
scripts.forEach((code, i) => {
  try { new vm.Script(code); } catch (err) { assert.fail(`inline script ${i} does not parse: ${err.message}`); }
});
try { new vm.Script(scripts.join("\n;\n")); } catch (err) { assert.fail(`inline scripts clash at top level: ${err.message}`); }

const all = scripts.join("\n");
for (const fn of ["card", "render", "claim", "withOv", "loadOv", "beacon", "starEl", "favEl", "bonusEl", "openEdit", "openSupport", "loadMembers", "refreshAll", "showInstall", "discordLogin", "pollHandoff", "betaLink", "openReport", "dropChip"]) {
  assert.match(all, new RegExp(`function ${fn}\\s*\\(`), `script must define ${fn}`);
}
for (const id of ["grid", "sectionTitle", "refreshBtn", "loginBtn", "reportDialog", "editDialog", "supportDialog", "memberCount", "jump", "betaBtn", "installChip"]) {
  assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
}
assert.match(html, /<div class="section-title"><div class="st-left"><h2 id="sectionTitle">[^<]*<\/h2><button[^>]*id="refreshBtn"/, "refresh button sits next to the section title");
assert.doesNotMatch(html.split("<main")[0], /id="refreshBtn"/, "refresh button is no longer in the header");
assert.match(all, /fetch\(API\+'\/overrides',\{cache:'no-cache'\}\)/, "overrides load with no-cache");
assert.match(all, /fetch\('bonus-data\.json',\{cache:'no-cache'\}\)/, "bonus data loads with no-cache");
assert.match(html, /ko-fi\.com\/jmenichole7/, "Ko-fi chip stays");
assert.match(all, /hark\.com\/r\//, "Hark referral stays");
assert.match(all, /Verb Data/, "paid sites list must still include Verb Data");
assert.match(all, /you set the price/i);
assert.doesNotMatch(html, /JustTheHelper/);
assert.doesNotMatch(html, /discord\.gg/, "invites come from the API, not hard-coded in the page");

assert.match(admin, /<meta name="robots" content="noindex/, "admin page must be noindex");
assert.match(admin, /\/admin\/stats/, "admin page reads /admin/stats");
assert.doesNotMatch(html, /admin\.html/, "admin page must not be linked from the main page");
assert.match(html, /ko-fi\.com\/s\/98072eb812/, "advertise sheet links the Ko-fi ad product");
assert.match(html, /DgeYJvpRQGmYgyXQNqm2nGxwoxABa43dvQY5HJU57ET1/, "advertise sheet shows the Solana address");
assert.doesNotMatch(html, /advertise@example\.com|Google Form/, "placeholder advertise form is gone");
assert.match(sw, /const CACHE='collect-clock-v\d+'/);

console.log(`index.html: ${scripts.length} inline scripts parse, no top-level name clashes; admin.html ok`);
