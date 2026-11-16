/*
 * EasyFill - background page (persistent, Manifest V2)
 *
 * Responsibilities:
 *   - build the right-click menu (values, saved forms, save/settings)
 *   - orchestrate capture & fill across all frames of a tab
 *   - seed example values on first install
 *   - serve the popup (save-form / fill-form requests)
 *
 * Makes ZERO network requests. All data lives in browser.storage.local.
 */
(() => {
  "use strict";
  const NS = globalThis.EasyFill;
  const { KEYS, uid, preview, menuTitle, normalizeUrl, hostOf, sameHost, sleep } = NS;

  let data = { values: [], forms: [], settings: { ...NS.DEFAULT_SETTINGS } };
  const refresh = async () => { data = await NS.loadAll(); };

  /* ------------------------------------------------------------------ *
   * Context menus
   * ------------------------------------------------------------------ */

  let menuTimer = null;
  function scheduleMenuRebuild() {
    clearTimeout(menuTimer);
    menuTimer = setTimeout(rebuildMenus, 250);
  }

  async function rebuildMenus() {
    await browser.menus.removeAll();
    const page = ["editable", "page"];

    browser.menus.create({ id: "ef-root", title: "EasyFill", contexts: page });

    // Saved values, listed directly (only when right-clicking a field)
    if (data.values.length === 0) {
      browser.menus.create({
        id: "ef-novalues", parentId: "ef-root", contexts: ["editable"],
        title: "No values yet - open Settings"
      });
    } else {
      for (const v of data.values) {
        const p = preview(v.value, 42);
        browser.menus.create({
          id: "ef-value:" + v.id, parentId: "ef-root", contexts: ["editable"],
          title: menuTitle(preview(v.name, 28) + (p ? " - " + p : ""))
        });
      }
    }

    browser.menus.create({ id: "ef-sep1", parentId: "ef-root", type: "separator", contexts: ["editable"] });

    // Fill form ->
    browser.menus.create({ id: "ef-forms", parentId: "ef-root", title: "Fill form", contexts: page });
    if (data.forms.length === 0) {
      browser.menus.create({
        id: "ef-noforms", parentId: "ef-forms", contexts: page,
        title: "No saved forms yet", enabled: false
      });
    } else {
      const sorted = [...data.forms].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      for (const f of sorted) {
        browser.menus.create({
          id: "ef-fill:" + f.id, parentId: "ef-forms", contexts: page,
          title: menuTitle(preview(f.name, 44) + " | " + (f.fields || []).length + " fields")
        });
      }
    }

    browser.menus.create({ id: "ef-save", parentId: "ef-root", title: "Save this form", contexts: page });
    browser.menus.create({ id: "ef-sep2", parentId: "ef-root", type: "separator", contexts: page });
    browser.menus.create({ id: "ef-settings", parentId: "ef-root", title: "Settings - values & forms", contexts: page });
  }

  browser.menus.onClicked.addListener(async (info, tab) => {
    const id = String(info.menuItemId);
    try {
      if (id === "ef-settings" || id === "ef-novalues") {
        await browser.runtime.openOptionsPage();
      } else if (id === "ef-save") {
        await saveForm(tab, info);
      } else if (id.startsWith("ef-fill:")) {
        const form = data.forms.find((f) => f.id === id.slice(8));
        if (form) await fillTab(tab.id, form);
      } else if (id.startsWith("ef-value:")) {
        const v = data.values.find((x) => x.id === id.slice(9));
        if (v && tab && tab.id != null) {
          await browser.tabs.sendMessage(
            tab.id,
            { type: "ef-insert-value", value: v.value, targetElementId: info.targetElementId },
            { frameId: info.frameId ?? 0 }
          ).catch(() => { });
        }
      }
    } catch (e) {
      console.error("EasyFill menu action failed:", e);
    }
  });

  /* ------------------------------------------------------------------ *
   * Cross-frame orchestration
   *
   * tabs.sendMessage without a frameId reaches every frame in the tab.
   * Each frame reports back via runtime.sendMessage; we collect results
   * for a short window, then finish.
   * ------------------------------------------------------------------ */

  const captures = new Map(); // requestId -> { fields: [] }
  const fills = new Map();    // requestId -> { remaining:Set, filled, failed }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "ef-capture-result") {
      const c = captures.get(msg.requestId);
      if (c) for (const f of msg.fields || []) c.fields.push({ ...f, frameUrl: msg.frameUrl });
      return;
    }
    if (msg.type === "ef-fill-result") {
      const st = fills.get(msg.requestId);
      if (st) for (const r of msg.results || []) {
        st.remaining.delete(r.index);
        if (r.ok) st.filled++; else st.failed.push(r.index);
      }
      return;
    }
    if (msg.type === "ef-save-form") return saveFormById(msg.tabId);
    if (msg.type === "ef-fill-form") return fillFormById(msg.tabId, msg.formId);
  });

  function pageToast(tabId, text, kind) {
    browser.tabs.sendMessage(tabId, { type: "ef-toast", text, kind }).catch(() => { });
  }

  async function captureTab(tabId, targetElementId) {
    const requestId = uid();
    const c = { fields: [] };
    captures.set(requestId, c);
    await browser.tabs.sendMessage(tabId, { type: "ef-capture", requestId, targetElementId }).catch(() => { });
    await sleep(500); // let every frame answer
    captures.delete(requestId);
    return c.fields;
  }

  function formSignature(fields) {
    return fields.map((f) => f.kind + "|" + f.selector).join("\n");
  }

  async function saveForm(tab, info) {
    if (!tab || tab.id == null) return { ok: false, error: "no-tab" };
    const fields = await captureTab(tab.id, info && info.targetElementId);
    if (!fields.length) {
      pageToast(tab.id, "EasyFill: no fillable fields found on this page.", "err");
      return { ok: false, error: "no-fields" };
    }
    const url = tab.url || fields[0].frameUrl || "";
    const pattern = normalizeUrl(url);
    const sig = formSignature(fields);
    const existing = data.forms.find((f) => f.urlPattern === pattern && formSignature(f.fields || []) === sig);

    let form;
    if (existing) {
      existing.fields = fields;
      existing.updatedAt = Date.now();
      form = existing;
    } else {
      form = {
        id: uid(),
        name: preview(tab.title || hostOf(url) || "Saved form", 48),
        host: hostOf(url),
        urlPattern: pattern,
        fields,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      data.forms.push(form);
    }
    await browser.storage.local.set({ [KEYS.FORMS]: data.forms });
    pageToast(tab.id, `EasyFill: ${existing ? "updated" : "saved"} "${preview(form.name, 36)}" - ${fields.length} fields.`);
    return { ok: true, form };
  }

  async function fillTab(tabId, form) {
    const fields = (form.fields || []).map((f, i) => ({ ...f, index: i }));
    if (!fields.length) return { ok: false, filled: 0, total: 0 };

    const requestId = uid();
    const st = { remaining: new Set(fields.map((f) => f.index)), filled: 0, failed: [] };
    fills.set(requestId, st);

    // Pass 1: each frame fills fields captured from the same URL.
    await browser.tabs.sendMessage(tabId, { type: "ef-fill", requestId, fields, relaxed: false }).catch(() => { });
    await sleep(450);

    // Pass 2: anything left (moved iframes, about:blank...) - try everywhere.
    if (st.remaining.size) {
      const rest = fields.filter((f) => st.remaining.has(f.index));
      await browser.tabs.sendMessage(tabId, { type: "ef-fill", requestId, fields: rest, relaxed: true }).catch(() => { });
      await sleep(450);
    }
    fills.delete(requestId);

    const total = fields.length;
    if (st.filled > 0) {
      pageToast(tabId, `EasyFill: filled ${st.filled}/${total} fields.`);
    } else {
      pageToast(tabId, "EasyFill: could not find the saved fields on this page.", "err");
    }
    return { ok: st.filled > 0, filled: st.filled, total };
  }

  async function saveFormById(tabId) {
    try {
      const tab = await browser.tabs.get(tabId);
      return await saveForm(tab, null);
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  async function fillFormById(tabId, formId) {
    const form = data.forms.find((f) => f.id === formId);
    if (!form) return { ok: false, error: "form-not-found" };
    return await fillTab(tabId, form);
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[KEYS.VALUES] || changes[KEYS.FORMS] || changes[KEYS.SETTINGS]) {
      refresh().then(scheduleMenuRebuild);
    }
  });

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === "install") {
      const d = await browser.storage.local.get(KEYS.VALUES);
      if (!Array.isArray(d[KEYS.VALUES])) {
        await browser.storage.local.set({
          [KEYS.VALUES]: NS.SEED_VALUES.map((v) => ({ id: uid(), ...v, createdAt: Date.now() }))
        });
      }
      browser.runtime.openOptionsPage().catch(() => { });
    }
    await refresh();
    await rebuildMenus();
  });

  // Persistent background page: also runs at browser startup.
  refresh().then(rebuildMenus).catch((e) => console.error("EasyFill init:", e));
})();
