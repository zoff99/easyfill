/*
 * EasyFill - shared helpers
 *
 * Loaded as a classic script in the background page, content scripts,
 * popup and options page. Everything hangs off globalThis.EasyFill.
 */
(() => {
  "use strict";
  const NS = globalThis.EasyFill || (globalThis.EasyFill = {});

  NS.VERSION = "1.0.0";

  // storage.local keys
  NS.KEYS = { VALUES: "values", FORMS: "forms", SETTINGS: "settings" };

  NS.DEFAULT_SETTINGS = { includePasswords: false };

  // First-run example values so the right-click menu works immediately.
  NS.SEED_VALUES = [
    { name: "Full name", value: "Alex Morgan" },
    { name: "Email", value: "alex@example.com" },
    { name: "Phone", value: "+1 555 010 2030" }
  ];

  NS.uid = () => {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch (_) { /* non-secure context */ }
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  };

  // Interpret a stored value as a checkbox state.
  NS.truthy = (v) =>
    v === true ||
    ["true", "1", "yes", "on", "checked", "y"].includes(String(v ?? "").trim().toLowerCase());

  // origin + pathname, no query/fragment - stable identity for a page.
  NS.normalizeUrl = (u) => {
    try { const x = new URL(u); return x.origin + x.pathname; }
    catch (_) { return String(u ?? ""); }
  };

  NS.hostOf = (u) => {
    try { return new URL(u).hostname; } catch (_) { return ""; }
  };

  // Host match incl. subdomains (www.example.com ~ example.com).
  NS.sameHost = (a, b) => {
    const ha = NS.hostOf(a), hb = NS.hostOf(b);
    if (!ha || !hb) return false;
    return ha === hb || ha.endsWith("." + hb) || hb.endsWith("." + ha);
  };

  NS.loadAll = async () => {
    const d = await browser.storage.local.get([NS.KEYS.VALUES, NS.KEYS.FORMS, NS.KEYS.SETTINGS]);
    return {
      values: Array.isArray(d[NS.KEYS.VALUES]) ? d[NS.KEYS.VALUES] : [],
      forms: Array.isArray(d[NS.KEYS.FORMS]) ? d[NS.KEYS.FORMS] : [],
      settings: { ...NS.DEFAULT_SETTINGS, ...(d[NS.KEYS.SETTINGS] || {}) }
    };
  };

  // One-line, length-capped preview for menus and lists.
  NS.preview = (s, n = 60) => {
    s = String(s ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n).trimEnd() + "..." : s;
  };

  // "&" is the access-key marker in Firefox menu titles - escape it.
  NS.menuTitle = (s) => String(s ?? "").replace(/&/g, "&&");

  NS.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Reorder helpers (pure, return a new array; same array if the move is a no-op).
  NS.moveItem = (arr, id, dir) => {
    const i = arr.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return arr;
    const out = arr.slice();
    const [item] = out.splice(i, 1);
    out.splice(j, 0, item);
    return out;
  };

  NS.reorderItem = (arr, dragId, targetId, before) => {
    if (dragId === targetId) return arr;
    if (arr.findIndex((x) => x.id === dragId) < 0) return arr;
    if (!arr.some((x) => x.id === targetId)) return arr;
    const out = arr.slice();
    const [item] = out.splice(out.findIndex((x) => x.id === dragId), 1);
    const to = out.findIndex((x) => x.id === targetId);
    out.splice(before ? to : to + 1, 0, item);
    return out;
  };
})();
