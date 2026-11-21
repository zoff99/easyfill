/*
 * EasyFill - smoke tests for the capture/fill engine (no browser needed).
 * Run:  npm install linkedom   (anywhere node can resolve it)
 *       node tests/smoke.test.mjs
 *
 * Exercises the exact code shipped in src/content.js and src/shared.js.
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

let parseHTML;
try {
  ({ parseHTML } = await import("linkedom"));
} catch {
  // sandbox fallback: point EF_TOOLS at a dir whose node_modules has linkedom
  const { createRequire } = await import("node:module");
  const candidates = [
    process.env.EF_TOOLS,
    "/tmp/ef-tools/package.json",
    "/home/user/easyfill-tests/package.json"
  ].filter(Boolean);
  for (const c of candidates) {
    try { ({ parseHTML } = createRequire(c)("linkedom")); break; } catch { /* next */ }
  }
  if (!parseHTML) throw new Error("linkedom not found - run: npm install linkedom");
}

await import(pathToFileURL(new URL("../src/shared.js", import.meta.url).pathname));
await import(pathToFileURL(new URL("../src/content.js", import.meta.url).pathname));

const NS = globalThis.EasyFill;
const C = NS.content;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.error("  FAIL " + name); }
}

const dom = parseHTML(`<!DOCTYPE html><html><body>
<form id="signup" action="/submit">
  <label for="fn">Full name</label>
  <input id="fn" name="fullname" type="text" value="Jane Doe">
  <input name="email" type="email" value="jane@example.com" placeholder="Email address">
  <input name="age" type="number" value="33">
  <input name="start" type="date" value="2026-12-01">
  <input name="secret" type="password" value="hunter2">
  <input name="csrf" type="hidden" value="tok123">
  <input name="off" type="text" value="x" disabled>
  <textarea name="bio">Hello world</textarea>
  <select name="plan">
    <option value="s">Starter</option>
    <option value="p" selected>Pro</option>
    <option value="t">Team</option>
  </select>
  <select name="tops" multiple>
    <option value="a" selected>A</option><option value="b">B</option><option value="c" selected>C</option>
  </select>
  <label><input type="checkbox" name="tos" checked> Accept terms</label>
  <input type="checkbox" name="news">
  <input type="radio" name="color" value="red">
  <input type="radio" name="color" value="blue" checked>
  <input type="radio" name="color" value="green">
  <div contenteditable="true" id="editor">Rich <b>text</b> here</div>
  <input type="text" aria-label="City" placeholder="Your city" value="Berlin">
</form>
</body></html>`);

for (const k of ["document", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "Node"]) {
  if (dom[k] !== undefined) globalThis[k] = dom[k];
}
globalThis.window = dom.window ?? dom;
const document = dom.document;

console.log("\n- shared helpers -");
check("truthy strings", NS.truthy("TRUE") && NS.truthy("1") && NS.truthy("on") && !NS.truthy("false") && !NS.truthy(""));
check("normalizeUrl strips query/hash", NS.normalizeUrl("https://a.com/p?x=1#y") === "https://a.com/p");
check("sameHost subdomains", NS.sameHost("https://www.a.com/x", "https://a.com/y") && !NS.sameHost("https://a.com", "https://b.com"));
check("preview collapses + caps", NS.preview("a\n  b   c", 4) === "a b...");
check("menuTitle escapes &", NS.menuTitle("Tom & Jerry") === "Tom && Jerry");

console.log("\n- capture -");
const fields = C.captureFields(document, { includePasswords: false });
const byName = (n) => fields.find((f) => f.fp.name === n);
check("password skipped by default", !byName("secret"));
check("hidden skipped", !byName("csrf"));
check("disabled skipped", !byName("off"));
check("text captured", byName("fullname")?.value === "Jane Doe");
check("number captured", byName("age")?.value === "33");
check("date captured", byName("start")?.value === "2026-12-01");
check("textarea captured", byName("bio")?.kind === "textarea" && byName("bio").value === "Hello world");
check("select captured", byName("plan")?.kind === "select" && byName("plan").value === "p");
check("multi-select captured", JSON.stringify(byName("tops")?.value) === '["a","c"]');
check("checkbox states captured", byName("tos")?.value === true && byName("news")?.value === false);
const radio = fields.find((f) => f.kind === "radio");
check("radio group captured once, checked value", fields.filter((f) => f.kind === "radio").length === 1 && radio.value === "blue");
check("richtext captured", fields.some((f) => f.kind === "richtext" && /Rich/.test(f.value)));
check("label resolved", byName("fullname")?.label === "Full name");
check("password included when enabled", C.captureFields(document, { includePasswords: true }).some((f) => f.fp.name === "secret"));

console.log("\n- selectors resolve back to the same elements -");
let allResolve = true;
for (const f of fields) {
  const el = document.querySelector(f.selector);
  if (!el) { allResolve = false; console.error("    unresolved:", f.selector); }
}
check("every captured selector resolves", allResolve);
check("radio selector targets checked member", document.querySelector(radio.selector)?.value === "blue");

console.log("\n- fill round-trip (values changed, then restored) -");
const set = (n, v) => { document.querySelector(`[name="${n}"]`).value = v; };
set("fullname", "CHANGED"); set("bio", "CHANGED"); set("age", "99");
for (const o of document.querySelector('[name="plan"]').options) o.selected = o.value === "s";
document.querySelector('[name="tos"]').checked = false;
document.querySelector('input[name="color"][value="red"]').checked = true;
document.querySelector('input[name="color"][value="blue"]').checked = false;
let events = 0;
document.querySelector('[name="fullname"]').addEventListener("input", () => events++);
document.querySelector('[name="fullname"]').addEventListener("change", () => events++);
let okAll = true;
for (const f of fields) {
  const el = C.resolveField(f);
  const ok = el && C.applyValue(el, f.kind, f.value);
  if (!ok) { okAll = false; console.error("    fill failed:", f.kind, f.fp.name || f.label); }
}
check("all fields filled successfully", okAll);
check("text restored", document.querySelector('[name="fullname"]').value === "Jane Doe");
check("input + change events fired", events >= 2);
check("select restored", document.querySelector('[name="plan"]').options[1].selected === true);
check("checkbox restored", document.querySelector('[name="tos"]').checked === true);
check("radio restored", document.querySelector('input[name="color"][value="blue"]').checked === true);
check("richtext restored", /Rich/.test(document.getElementById("editor").textContent));

console.log("\n- framework value-tracker bypass (React-style) -");
{
  const el = document.querySelector('[name="email"]');
  const desc = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value");
  let trackerSaw = null;
  Object.defineProperty(el, "value", {
    configurable: true,
    get() { return desc.get.call(el); },
    set(v) { trackerSaw = v; } // intercepts naive el.value = ... assignments
  });
  const ok = C.applyValue(el, "text", "new@example.com");
  check("native setter bypasses instance tracker", ok && el.value === "new@example.com" && trackerSaw === null);
  delete el.value;
}

console.log("\n- flexible matching -");
{
  const sel = document.querySelector('[name="plan"]');
  check("select by visible text", C.applyValue(sel, "select", "Team") && sel.options[2].selected === true);
  const cb = document.querySelector('[name="news"]');
  check("checkbox from string 'yes'", C.applyValue(cb, "checkbox", "yes") && cb.checked === true);
  const r = C.resolveField(radio);
  check("radio re-targets by value", C.applyValue(r, "radio", "green") && document.querySelector('input[name="color"][value="green"]').checked === true);
}

console.log("\n- fingerprint fallback after DOM mutation -");
{
  const city = document.querySelector('input[aria-label="City"]');
  const f = C.captureFields(document, {}).find((x) => x.fp.label === "City");
  check("city captured", !!f);
  city.removeAttribute("name"); city.removeAttribute("id"); city.setAttribute("placeholder", "");
  const wrap = document.createElement("section");
  document.querySelector("form").appendChild(wrap);
  wrap.appendChild(city); // path selector now stale
  const found = C.resolveField(f);
  check("re-found via label fingerprint", found === city);
  check("fill still works", C.applyValue(found, "text", "Munich") && city.value === "Munich");
}

console.log("\n- reorder helpers -");
{
  const arr = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const ids = (a) => a.map((x) => x.id).join("");
  check("move down", ids(NS.moveItem(arr, "a", 1)) === "bac");
  check("move up", ids(NS.moveItem(arr, "c", -1)) === "acb");
  check("move up at top is no-op", NS.moveItem(arr, "a", -1) === arr);
  check("move down at bottom is no-op", NS.moveItem(arr, "c", 1) === arr);
  check("drag before target", ids(NS.reorderItem(arr, "c", "a", true)) === "cab");
  check("drag after target", ids(NS.reorderItem(arr, "a", "c", false)) === "bca");
  check("drag onto self is no-op", NS.reorderItem(arr, "b", "b", true) === arr);
  check("unknown ids are no-ops", NS.reorderItem(arr, "zz", "a", true) === arr && NS.moveItem(arr, "zz", 1) === arr);
  check("original array untouched", ids(arr) === "abc");
}

console.log("\n- menu titles -");
{
  // Firefox treats a single "&" in a menu title as an access-key marker
  // (it eats the "&" and underlines the next char). Static titles must
  // contain none; dynamic ones go through menuTitle() which doubles it.
  const src = readFileSync(new URL("../src/background.js", import.meta.url), "utf-8");
  const titles = [...src.matchAll(/title:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  check("static menu titles found", titles.length >= 6);
  check("no raw access-key & in static menu titles",
    titles.every((t) => !/(^|[^&])&([^&]|$)/.test(t)));
}

console.log("\n- privacy: toasts show keys, not values -");
{
  const content = readFileSync(new URL("../src/content.js", import.meta.url), "utf-8");
  const bg = readFileSync(new URL("../src/background.js", import.meta.url), "utf-8");
  check("insert toast labels with the key (msg.name)", /"Filled: " \+ label/.test(content) && /NS\.preview\(msg\.name, 30\)/.test(content));
  check("no toast ever previews the inserted value", !/preview\(msg\.value/.test(content));
  check("background sends the key with the value", /"ef-insert-value", name: v\.name, value: v\.value/.test(bg));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
