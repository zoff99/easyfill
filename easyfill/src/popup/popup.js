(() => {
  "use strict";
  const NS = globalThis.EasyFill;
  const $ = (id) => document.getElementById(id);
  let tab = null;
  let data = { values: [], forms: [], settings: {} };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function status(text, isErr) {
    const s = $("status");
    s.hidden = !text;
    s.textContent = text || "";
    s.classList.toggle("err", !!isErr);
  }

  function render() {
    $("site").textContent = NS.hostOf(tab && tab.url) || "this page";
    $("count").textContent = data.values.length + " values | unlimited";
    const list = $("forms");
    list.textContent = "";
    const sorted = [...data.forms].sort((a, b) => {
      const ma = NS.sameHost(a.urlPattern || a.host, tab && tab.url) ? 1 : 0;
      const mb = NS.sameHost(b.urlPattern || b.host, tab && tab.url) ? 1 : 0;
      return mb - ma || (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    $("empty").hidden = sorted.length > 0;
    for (const f of sorted) {
      const row = el("div", "form");
      const info = el("div", "info");
      const name = el("div", "name", f.name || "Saved form");
      if (NS.sameHost(f.urlPattern || f.host, tab && tab.url)) {
        name.appendChild(el("span", "badge", "this site"));
      }
      info.appendChild(name);
      info.appendChild(el("div", "meta", (f.fields || []).length + " fields | " + (f.host || "page")));
      const btn = el("button", null, "Fill");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        status("Filling...");
        const res = await browser.runtime.sendMessage({ type: "ef-fill-form", tabId: tab.id, formId: f.id }).catch(() => null);
        btn.disabled = false;
        if (res && res.ok) status(`Filled ${res.filled}/${res.total} fields.`);
        else status("Could not fill - fields not found on this page.", true);
      });
      row.appendChild(info);
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  $("save").addEventListener("click", async () => {
    $("save").disabled = true;
    status("Saving...");
    const res = await browser.runtime.sendMessage({ type: "ef-save-form", tabId: tab.id }).catch(() => null);
    $("save").disabled = false;
    if (res && res.ok) {
      status(`Saved ${(res.form.fields || []).length} fields.`);
      data = await NS.loadAll();
      render();
    } else {
      status("No fillable fields found on this page.", true);
    }
  });

  $("settings").addEventListener("click", (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
    window.close();
  });

  (async () => {
    data = await NS.loadAll();
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    render();
  })();
})();
