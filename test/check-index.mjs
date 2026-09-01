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

try {
    new Function(script);
} catch (err) {
    assert.fail(`inline script does not parse: ${err.message}`);
}

console.log("index.html script is complete and parses");
