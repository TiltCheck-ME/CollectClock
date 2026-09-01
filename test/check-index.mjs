import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

assert.match(html, /<\/script>/, "index.html must close its inline script");
assert.match(html, /<\/body>/, "index.html must close the body");
assert.match(html, /<\/html>/, "index.html must close the html document");

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.ok(scripts.length >= 1, "expected an inline script that renders the directory");

const script = scripts.at(-1);
assert.match(script, /function renderAll\s*\(/, "script must define renderAll");
assert.match(script, /function createCard\s*\(/, "script must define createCard");
assert.match(script, /function renderSection\s*\(/, "script must define renderSection");
assert.match(html, /id="links-grid"/);
assert.match(html, /id="intl-grid"/);
assert.match(html, /id="paid-grid"/);
assert.match(script, /Verb Data/, "paid sites list must still include Verb Data");
assert.match(script, /you set the price/i, "Verb Data should describe paid data uploads, not surveys");
assert.doesNotMatch(script, /Get paid for daily surveys/, "Verb Data should not be described as surveys");
assert.match(script, /name: "Copper"/);
assert.doesNotMatch(script, /like FreeCash/i, "Copper should not compare itself to FreeCash");
assert.match(html, /JustTheBuilder/, "JustTheBuilder house ad should remain");
assert.doesNotMatch(html, /JustTheHelper/, "JustTheHelper card should be removed");
assert.doesNotMatch(html, /JustTheBots Discord/, "JustTheBots Discord card should be removed");
assert.doesNotMatch(html, />Discord<\/a>/, "header Discord button should be removed");
assert.doesNotMatch(html, /discord\.gg/, "Discord invite link should be removed from the page");

try {
    new Function(script);
} catch (err) {
    assert.fail(`inline script does not parse: ${err.message}`);
}

console.log("index.html script is complete and parses");
