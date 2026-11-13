import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "alerts.js"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");

new vm.Script(js);
new vm.Script(sw);
assert.match(html, /<script src="alerts\.js"><\/script>\s*<\/body>/, "alerts.js loads last, after the inline scripts it uses");
assert.match(sw, /'\.\/alerts\.js'/, "service worker caches alerts.js");
assert.match(sw, /addEventListener\('push'/, "service worker handles push");
assert.match(sw, /addEventListener\('notificationclick'/, "service worker handles notification taps");
assert.match(sw, /cc-focus/, "a tap focuses the open app on the site");

// Permission is only asked from a tap: one call, inside turnOn(), and no auto-ask on any pointerup.
const asks = [...(js + html).matchAll(/requestPermission\(/g)].length;
assert.equal([...js.matchAll(/requestPermission\(/g)].length, 1, "alerts.js asks for permission in one place");
assert.match(js, /async function turnOn\(\)[\s\S]{0,400}Notification\.requestPermission\(\)/, "that place is turnOn()");
assert.match(js, /data-al="on"/, "turnOn() is wired to a button");
assert.doesNotMatch(html, /addEventListener\('pointerup',ask\)/, "no permission prompt on a random tap");
assert.ok(asks <= 2, "only the legacy enableAlerts() and turnOn() mention requestPermission");

// Opt-in defaults and the iPhone path.
assert.match(js, /sites: \{\} \}/, "no site alerts on by default");
assert.match(js, /quiet: \{ on: false/, "quiet hours default off");
assert.match(js, /navigator\.standalone === true/, "detects the Home Screen app");
assert.match(js, /Add to Home Screen/);
assert.match(js, /16\.4/, "mentions the iOS version push needs");

// In-page notifications stand down when push is on (no doubles).
assert.match(html, /state\.alerts&&!\(state\.push&&state\.push\.on\)/);

// Plain copy: no hype words in anything that becomes a notification or the alerts UI.
assert.doesNotMatch(js, /\b(jackpot|huge|massive|don'?t miss|hurry|win big|free money|🔥|💰|🚀)\b/i);
console.log("alerts.js + sw.js: parse, permission on tap only, opt-in defaults, push + click handlers present");
