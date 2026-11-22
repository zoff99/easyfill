/*
 * EasyFill - content script
 *
 * Runs in every frame. Responsibilities:
 *   - capture: scan a form/page and record field selectors + current values
 *   - fill:    re-find saved fields and set their values (framework-safe)
 *   - insert:  put a saved "value" into the right-clicked field
 *   - toast:   small non-intrusive feedback in the page
 *
 * All DOM helpers are pure functions exposed on EasyFill.content so they can
 * be unit-tested outside the browser (see tests/).
 */
(() => {
  "use strict";
  const NS = globalThis.EasyFill || (globalThis.EasyFill = {});
  const C = NS.content || (NS.content = {});

  /* ------------------------------------------------------------------ *
   * Field kinds
   * ------------------------------------------------------------------ */

  const SKIP_TYPES = new Set(["hidden", "file", "submit", "button", "reset", "image"]);
  const CE_VALUES = new Set(["", "true", "plaintext-only"]);

  function isEditableEl(n) {
    if (!n || n.nodeType !== 1) return false;
    if (n.isContentEditable === true) return true;
    const a = n.getAttribute && n.getAttribute("contenteditable");
    return a != null && CE_VALUES.has(String(a).toLowerCase());
  }

  // Outermost contenteditable ancestor-or-self (never body/html).
  function topEditable(el) {
    if (!isEditableEl(el)) return null;
    let node = el, top = el;
    while (node.parentElement) {
      node = node.parentElement;
      if (node.tagName === "BODY" || node.tagName === "HTML") break;
      if (isEditableEl(node)) top = node;
    }
    return top;
  }

  // Returns: text | password | textarea | select | select-multiple |
  //          checkbox | radio | richtext | null (not fillable)
  function kindOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return "textarea";
    if (tag === "SELECT") return (el.multiple || el.hasAttribute("multiple")) ? "select-multiple" : "select";
    if (tag === "INPUT") {
      const t = String(el.type || "text").toLowerCase();
      if (SKIP_TYPES.has(t)) return null;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "password") return "password";
      return "text";
    }
    if (typeof document !== "undefined" && document.designMode === "on") return null;
    if (isEditableEl(el)) {
      const top = topEditable(el);
      if (top && top.tagName !== "BODY" && top.tagName !== "HTML") return "richtext";
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Tree walking (incl. open shadow roots) & visibility
   * ------------------------------------------------------------------ */

  function* walk(root) {
    let els;
    try { els = root.querySelectorAll("*"); } catch (_) { return; }
    for (const el of els) {
      yield el;
      if (el.shadowRoot) yield* walk(el.shadowRoot);
    }
  }

  function eachRoot(cb) {
    const seen = new Set();
    const rec = (root) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      cb(root);
      let els;
      try { els = root.querySelectorAll("*"); } catch (_) { return; }
      for (const el of els) if (el.shadowRoot) rec(el.shadowRoot);
    };
    rec(typeof document !== "undefined" ? document : null);
  }

  function isVisible(el) {
    if (typeof el.checkVisibility === "function") {
      try { return el.checkVisibility({ visibilityProperty: true }); } catch (_) { /* fall through */ }
    }
    if (typeof el.getClientRects === "function") return el.getClientRects().length > 0;
    return true; // no layout engine (unit tests) - assume visible
  }

  /* ------------------------------------------------------------------ *
   * Selectors & fingerprints
   * ------------------------------------------------------------------ */

  const cssEsc = (s) =>
    typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape(s)
      : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");

  // Ids that look machine-generated are unstable across page loads.
  const GENERATED_ID =
    /^[:\u00AB]|^(radix[-_:]|headlessui-|ember\d|ext-gen|yui_|react-select|mui-\d)|^\d+$|[0-9a-f]{8}-[0-9a-f]{4}-|\d{6,}/i;

  // checked state, with an attribute fallback for DOMs without the property
  const isChecked = (el) =>
    typeof el.checked === "boolean" ? el.checked : el.hasAttribute("checked");

  function labelText(el) {
    let t = "";
    try { if (el.labels && el.labels.length) t = el.labels[0].textContent || ""; } catch (_) { }
    if (!t.trim() && el.id) {
      try {
        const lab = el.getRootNode().querySelector(`label[for="${cssEsc(el.id)}"]`);
        if (lab) t = lab.textContent || "";
      } catch (_) { }
    }
    if (!t.trim()) t = (el.getAttribute && el.getAttribute("aria-label")) || "";
    if (!t.trim()) {
      const ids = el.getAttribute && el.getAttribute("aria-labelledby");
      if (ids) {
        const root = el.getRootNode();
        t = ids.split(/\s+/)
          .map((id) => (root.getElementById ? root.getElementById(id) : null)?.textContent || "")
          .join(" ");
      }
    }
    if (!t.trim()) {
      const wrap = el.closest && el.closest("label");
      if (wrap) t = wrap.textContent || "";
    }
    if (!t.trim()) t = (el.getAttribute && el.getAttribute("placeholder")) || "";
    if (!t.trim()) t = el.name || el.id || "";
    return String(t).replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function pathSelector(el) {
    const root = el.getRootNode();
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== root) {
      if (node.id && !GENERATED_ID.test(node.id)) {
        let n = 0;
        try { n = root.querySelectorAll("#" + cssEsc(node.id)).length; } catch (_) { }
        if (n === 1) { parts.unshift("#" + cssEsc(node.id)); return parts.join(" > "); }
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function uniqueIn(root, sel, el) {
    try {
      const r = root.querySelectorAll(sel);
      return r.length === 1 && r[0] === el ? sel : null;
    } catch (_) { return null; }
  }

  function buildSelector(el, kind) {
    const root = el.getRootNode();
    if (kind === "radio" && el.name) {
      const sel = `input[type="radio"][name="${cssEsc(el.name)}"][value="${cssEsc(el.value)}"]`;
      const u = uniqueIn(root, sel, el);
      if (u) return u;
      return pathSelector(el);
    }
    if (el.name) {
      const u = uniqueIn(root, `[name="${cssEsc(el.name)}"]`, el);
      if (u) return u;
    }
    if (el.id && !GENERATED_ID.test(el.id)) {
      const u = uniqueIn(root, "#" + cssEsc(el.id), el);
      if (u) return u;
    }
    return pathSelector(el);
  }

  function fingerprint(el) {
    return {
      tag: el.tagName,
      type: String(el.type || "").toLowerCase(),
      name: el.name || "",
      id: el.id || "",
      label: labelText(el),
      placeholder: (el.getAttribute && el.getAttribute("placeholder")) || ""
    };
  }

  function fpMatches(el, fp) {
    if (!fp) return false;
    return (
      (!!fp.name && el.name === fp.name) ||
      (!!fp.id && el.id === fp.id) ||
      (!!fp.label && labelText(el).toLowerCase() === fp.label.toLowerCase()) ||
      (!!fp.placeholder && (el.getAttribute && el.getAttribute("placeholder")) === fp.placeholder)
    );
  }

  /* ------------------------------------------------------------------ *
   * Capture
   * ------------------------------------------------------------------ */

  const radioGroupMembers = (el) => {
    const root = el.getRootNode();
    let list = [];
    try { list = Array.from(root.querySelectorAll(`input[type="radio"][name="${cssEsc(el.name)}"]`)); } catch (_) { }
    return list.filter((r) => r.form === el.form);
  };

  const treeKeys = new WeakMap();
  let treeSeq = 0;
  const keyOf = (o) => {
    if (!o) return 0;
    if (!treeKeys.has(o)) treeKeys.set(o, ++treeSeq);
    return treeKeys.get(o);
  };

  function makeField(el, kind, value) {
    return { kind, value, selector: buildSelector(el, kind), label: labelText(el), fp: fingerprint(el) };
  }

  function captureFields(scope, settings) {
    settings = settings || { includePasswords: false };
    const out = [];
    const seenRadio = new Set();
    const seenEditable = new Set();
    for (const el of walk(scope)) {
      const kind = kindOf(el);
      if (!kind) continue;
      if (kind === "password" && !settings.includePasswords) continue;
      if (el.disabled) continue;
      if (!isVisible(el)) continue;

      if (kind === "richtext") {
        const top = topEditable(el);
        if (!top || seenEditable.has(top)) continue;
        seenEditable.add(top);
        const text = String(top.innerText ?? top.textContent ?? "").replace(/\s+$/, "");
        out.push(makeField(top, "richtext", text));
        continue;
      }

      if (kind === "radio" && el.name) {
        const gk = `${keyOf(el.getRootNode())}:${keyOf(el.form)}:${el.name}`;
        if (seenRadio.has(gk)) continue;
        seenRadio.add(gk);
        const members = radioGroupMembers(el);
        const checked = members.find((r) => isChecked(r));
        const target = checked || members[0] || el;
        out.push(makeField(target, "radio", checked ? checked.value : null));
        continue;
      }

      let value;
      if (kind === "checkbox") value = isChecked(el);
      else if (kind === "radio") value = isChecked(el) ? el.value : null; // nameless radio
      else if (kind === "select-multiple") value = Array.from(el.options || []).filter((o) => o.selected).map((o) => o.value);
      else value = el.value ?? "";
      out.push(makeField(el, kind, value));
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Resolution (selector first, fingerprint fallback)
   * ------------------------------------------------------------------ */

  function resolveField(field) {
    let found = null;
    eachRoot((root) => {
      if (found) return;
      let list = [];
      try { list = Array.from(root.querySelectorAll(field.selector)); } catch (_) { }
      if (!list.length) return;
      const kindMatch = list.filter((el) => kindOf(el) === field.kind);
      const pool = kindMatch.length ? kindMatch : list;
      found = pool.find((el) => fpMatches(el, field.fp)) || pool[0];
    });
    if (found) return found;

    const all = [];
    for (const el of walk(typeof document !== "undefined" ? document : null)) {
      if (kindOf(el) === field.kind) all.push(el);
    }
    const one = (pred) => { const m = all.filter(pred); return m.length === 1 ? m[0] : null; };
    const fp = field.fp || {};
    if (fp.name) { const r = one((el) => el.name === fp.name); if (r) return r; }
    if (fp.label) { const r = one((el) => labelText(el).toLowerCase() === fp.label.toLowerCase()); if (r) return r; }
    if (fp.placeholder) { const r = one((el) => (el.getAttribute && el.getAttribute("placeholder")) === fp.placeholder); if (r) return r; }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Value injection - framework-safe (React / Vue / Angular)
   * ------------------------------------------------------------------ */

  // Use the prototype's native setter so framework value-trackers
  // (React's inputValueTracking) see the change, then fire real events.
  function nativeSet(el, prop, val) {
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || globalThis;
    const proto =
      el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement && win.HTMLTextAreaElement.prototype :
      el.tagName === "SELECT" ? win.HTMLSelectElement && win.HTMLSelectElement.prototype :
      win.HTMLInputElement && win.HTMLInputElement.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (desc && desc.set) desc.set.call(el, val);
    else el[prop] = val;
  }

  function fire(el, data) {
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: data ?? null }));
    } catch (_) {
      try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) { }
    }
    try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) { }
  }

  const optText = (o) => String(o.text ?? o.textContent ?? "").trim().toLowerCase();

  function applyValue(el, kind, value) {
    if (!el || el.disabled) return false;
    switch (kind) {
      case "checkbox": {
        const want = NS.truthy(value);
        if (isChecked(el) !== want) {
          try { el.click(); } catch (_) { } // fires trusted-ish events for frameworks
          if (isChecked(el) !== want) { nativeSet(el, "checked", want); fire(el); }
        }
        return isChecked(el) === want;
      }
      case "radio": {
        if (value == null) return false;
        let target = el;
        if (String(el.value) !== String(value) && el.name) {
          target = radioGroupMembers(el).find((r) => String(r.value) === String(value)) || el;
        }
        if (String(target.value) !== String(value)) return false;
        if (!isChecked(target)) {
          try { target.click(); } catch (_) { }
          if (!isChecked(target)) { nativeSet(target, "checked", true); fire(target); }
        }
        return isChecked(target);
      }
      case "select": {
        // Select via option.selected - the DOM-native way, works with
        // framework change handlers and DOMs lacking a value setter.
        const want = String(value ?? "");
        const opts = Array.from(el.options || []);
        const opt =
          opts.find((o) => o.value === want) ||
          opts.find((o) => optText(o) === want.trim().toLowerCase());
        if (opt) {
          for (const o of opts) if (o !== opt) o.selected = false;
          opt.selected = true;
        }
        fire(el, want);
        return !!opt;
      }
      case "select-multiple": {
        const wants = Array.isArray(value)
          ? value.map(String)
          : String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        let any = false;
        const opts = Array.from(el.options || []);
        const want = (o) => wants.includes(o.value) || wants.some((w) => w.toLowerCase() === optText(o));
        for (const o of opts) if (!want(o)) o.selected = false;
        for (const o of opts) if (want(o)) { o.selected = true; any = true; }
        fire(el);
        return any || wants.length === 0;
      }
      case "richtext": {
        const text = String(value ?? "");
        try { el.focus(); } catch (_) { }
        let ok = false;
        try {
          const win = el.ownerDocument.defaultView;
          const sel = win.getSelection();
          const range = el.ownerDocument.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          ok = el.ownerDocument.execCommand("insertText", false, text);
        } catch (_) { ok = false; }
        if (!ok) {
          el.textContent = text;
          fire(el, text);
        }
        const now = String(el.innerText ?? el.textContent ?? "").trim();
        return now === text.trim() || text === "";
      }
      default: { // text, password, textarea, number, date, time, color, range...
        const want = String(value ?? "");
        nativeSet(el, "value", want);
        fire(el, want);
        return el.value === want;
      }
    }
  }

  C.kindOf = kindOf;
  C.topEditable = topEditable;
  C.walk = walk;
  C.isVisible = isVisible;
  C.labelText = labelText;
  C.buildSelector = buildSelector;
  C.pathSelector = pathSelector;
  C.fingerprint = fingerprint;
  C.captureFields = captureFields;
  C.resolveField = resolveField;
  C.applyValue = applyValue;
  C.nativeSet = nativeSet;
  C.fire = fire;

  /* ------------------------------------------------------------------ *
   * Browser-only part: target tracking, messaging, toast
   * ------------------------------------------------------------------ */

  if (typeof browser === "undefined" || !browser.runtime || !browser.runtime.onMessage) return;
  if (globalThis.__easyfillInjected) return;
  globalThis.__easyfillInjected = true;

  let settings = { ...NS.DEFAULT_SETTINGS };
  browser.storage.local.get(NS.KEYS.SETTINGS).then((d) => {
    settings = { ...NS.DEFAULT_SETTINGS, ...(d[NS.KEYS.SETTINGS] || {}) };
  }).catch(() => { });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[NS.KEYS.SETTINGS]) {
      settings = { ...NS.DEFAULT_SETTINGS, ...(changes[NS.KEYS.SETTINGS].newValue || {}) };
    }
  });

  let contextTarget = null; // last right-clicked element (composedPath -> shadow-aware)
  let lastFocused = null;
  document.addEventListener("contextmenu", (e) => {
    contextTarget = (e.composedPath && e.composedPath()[0]) || e.target;
  }, true);
  document.addEventListener("focusin", (e) => {
    lastFocused = (e.composedPath && e.composedPath()[0]) || e.target;
  }, true);

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function menuTarget(id) {
    if (id == null) return null;
    try { return browser.menus.getTargetElement(id) || null; } catch (_) { return null; }
  }

  // Right-click may land on a wrapper/label - find the real field.
  function resolveEditableFrom(el) {
    if (!el || el.nodeType !== 1) return null;
    const k = kindOf(el);
    if (k) return k === "richtext" ? topEditable(el) : el;
    const up = el.closest && el.closest("input, textarea, select, [contenteditable]");
    if (up && kindOf(up)) return kindOf(up) === "richtext" ? topEditable(up) : up;
    const down = el.querySelector && el.querySelector(
      "input:not([type=hidden]):not([type=file]), textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']"
    );
    if (down && kindOf(down)) return kindOf(down) === "richtext" ? topEditable(down) : down;
    return null;
  }

  function flash(el) {
    try {
      if (typeof el.animate !== "function") return;
      el.animate(
        [{ boxShadow: "0 0 0 3px rgba(16,185,129,.85)" }, { boxShadow: "0 0 0 6px rgba(16,185,129,0)" }],
        { duration: 800, easing: "ease-out" }
      );
    } catch (_) { }
  }

  let toastTimer = null;
  let toastRoot = null; // closed shadow roots aren't reachable via host.shadowRoot
  function toast(text, kind) {
    try {
      if (window.top !== window) return; // top frame only
      let host = document.getElementById("easyfill-toast-host");
      if (!host) {
        host = document.createElement("div");
        host.id = "easyfill-toast-host";
        host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;pointer-events:none;";
        document.documentElement.appendChild(host);
        toastRoot = host.attachShadow({ mode: "closed" });
      }
      const root = toastRoot;
      if (!root) return;
      root.innerHTML = "";
      const el = document.createElement("div");
      el.textContent = text;
      el.style.cssText =
        "font:500 13px/1.45 system-ui,sans-serif;color:#fff;padding:9px 14px;border-radius:9px;" +
        "max-width:340px;box-shadow:0 4px 16px rgba(0,0,0,.25);opacity:0;transition:opacity .18s;" +
        "background:" + (kind === "err" ? "#dc2626" : "#059669") + ";";
      root.appendChild(el);
      requestAnimationFrame(() => { el.style.opacity = "1"; });
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.style.opacity = "0";
        setTimeout(() => { try { root.innerHTML = ""; } catch (_) { } }, 250);
      }, 2600);
    } catch (_) { }
  }

  // Confirmation dialog for sensitive values. Shows ONLY the key name -
  // never the value content. Cancel is focused by default; Esc or clicking
  // the backdrop cancels. Lives in a closed shadow root, blocks the page
  // while open, and removes itself on decision.
  let confirmHost = null;
  function confirmInsert(label) {
    return new Promise((resolve) => {
      if (confirmHost) { try { confirmHost.remove(); } catch (_) { } }
      const host = document.createElement("div");
      confirmHost = host;
      host.id = "easyfill-confirm-host";
      host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
      document.documentElement.appendChild(host);
      const root = host.attachShadow({ mode: "closed" });
      const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
      const style = document.createElement("style");
      style.textContent =
        ".ov{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;font:14px/1.45 system-ui,sans-serif;}" +
        ".card{background:" + (dark ? "#0f172a" : "#ffffff") + ";color:" + (dark ? "#e2e8f0" : "#0f172a") +
        ";border-radius:12px;padding:18px 20px;max-width:340px;box-shadow:0 8px 30px rgba(0,0,0,.35);}" +
        ".t{font-weight:600;margin:0 0 6px;}" +
        ".m{margin:0 0 14px;font-size:13px;}" +
        ".b{display:flex;gap:8px;justify-content:flex-end;}" +
        "button{font:inherit;font-weight:600;border-radius:8px;padding:7px 14px;cursor:pointer;border:1px solid " +
        (dark ? "#334155" : "#e2e8f0") + ";background:" + (dark ? "#1e293b" : "#f8fafc") + ";color:inherit;}" +
        "button.ok{background:#059669;border-color:#059669;color:#fff;}";
      root.appendChild(style);
      const ov = document.createElement("div"); ov.className = "ov";
      const card = document.createElement("div"); card.className = "card";
      const t = document.createElement("p"); t.className = "t";
      t.textContent = "Insert sensitive value?";
      const m = document.createElement("p"); m.className = "m";
      m.textContent = "Insert \"" + label + "\" into this field? The value content is not shown.";
      const b = document.createElement("div"); b.className = "b";
      const cancel = document.createElement("button"); cancel.textContent = "Cancel";
      const okb = document.createElement("button"); okb.className = "ok"; okb.textContent = "Insert";
      b.append(cancel, okb);
      card.append(t, m, b);
      ov.appendChild(card);
      root.appendChild(ov);
      const done = (val) => {
        try { host.remove(); } catch (_) { }
        if (confirmHost === host) confirmHost = null;
        resolve(val);
      };
      cancel.addEventListener("click", () => done(false));
      okb.addEventListener("click", () => done(true));
      ov.addEventListener("click", (e) => { if (e.target === ov) done(false); });
      root.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); done(false); }
      });
      requestAnimationFrame(() => cancel.focus());
    });
  }

  browser.runtime.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "ef-ping") return Promise.resolve({ ok: true });

    if (msg.type === "ef-capture") {
      const hint = menuTarget(msg.targetElementId) || contextTarget || deepActive();
      const scope = (hint && hint.closest && hint.closest("form")) || document;
      const fields = captureFields(scope, settings);
      if (fields.length) {
        browser.runtime.sendMessage({
          type: "ef-capture-result", requestId: msg.requestId, fields, frameUrl: location.href
        }).catch(() => { });
      }
      return;
    }

    if (msg.type === "ef-fill") {
      const here = NS.normalizeUrl(location.href);
      const results = [];
      for (const f of msg.fields || []) {
        if (!msg.relaxed && NS.normalizeUrl(f.frameUrl) !== here) continue;
        const el = resolveField(f);
        if (!el) continue;
        results.push({ index: f.index, ok: applyValue(el, f.kind, f.value) });
      }
      if (results.length) {
        browser.runtime.sendMessage({ type: "ef-fill-result", requestId: msg.requestId, results }).catch(() => { });
      }
      return;
    }

    if (msg.type === "ef-insert-value") {
      const el =
        resolveEditableFrom(menuTarget(msg.targetElementId)) ||
        resolveEditableFrom(contextTarget) ||
        resolveEditableFrom(deepActive());
      if (!el) { toast("Right-click a form field to insert a value.", "err"); return { ok: false }; }
      // Privacy: never show the inserted value itself - only its short name.
      const label = NS.preview(msg.name, 30) || "(unnamed)";
      if (msg.sensitive) {
        const yes = await confirmInsert(label);
        if (!yes) { toast("Insert cancelled.", "err"); return { ok: false, cancelled: true }; }
      }
      const ok = applyValue(el, kindOf(el), msg.value);
      flash(el);
      toast(ok ? "Filled: " + label : "Could not fill that field.", ok ? "ok" : "err");
      return { ok };
    }

    if (msg.type === "ef-toast") { toast(msg.text, msg.kind); return; }
  });
})();
