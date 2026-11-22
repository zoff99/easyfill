(() => {
  "use strict";
  const NS = globalThis.EasyFill;
  const $ = (id) => document.getElementById(id);
  const { KEYS, uid, truthy, preview } = NS;

  let state = { values: [], forms: [], settings: { ...NS.DEFAULT_SETTINGS } };
  let filter = "";
  let dragId = null;      // id of the row being dragged
  let dropTarget = null;  // { id, before } under the pointer
  const expanded = new Set(); // expanded form ids

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------------- persistence ---------------- */

  const dirty = new Set();
  let saveTimer = null;
  function markDirty(key) {
    dirty.add(key);
    $("saveState").textContent = "Saving...";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const payload = {};
      for (const k of dirty) payload[k] = state[k];
      dirty.clear();
      try {
        await browser.storage.local.set(payload);
        $("saveState").textContent = "Saved";
        setTimeout(() => { if ($("saveState").textContent === "Saved") $("saveState").textContent = ""; }, 1600);
      } catch (e) {
        $("saveState").textContent = "Save failed";
        console.error(e);
      }
    }, 400);
  }

  function grow(t) {
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight + 2, 260) + "px";
  }

  /* ---------------- values (short name -> value), unlimited ---------------- */

  function renderValues() {
    const list = $("valuesList");
    list.textContent = "";
    const q = filter.trim().toLowerCase();
    const shown = state.values.filter((v) =>
      !q || (v.name || "").toLowerCase().includes(q) || String(v.value || "").toLowerCase().includes(q));
    $("valueCount").textContent =
      state.values.length + (q ? ` (${shown.length} shown)` : "") + " - no limits";
    for (const v of shown) {
      const row = el("div", "vrow");
      row.dataset.id = v.id;

      const grip = el("div", "grip");
      grip.draggable = !q;
      grip.title = q ? "Clear the filter to reorder" : "Drag to reorder";
      if (!q) {
        grip.addEventListener("dragstart", (e) => {
          dragId = v.id;
          e.dataTransfer.setData("text/plain", v.id);
          e.dataTransfer.effectAllowed = "move";
          try { e.dataTransfer.setDragImage(row, 24, 12); } catch (_) { }
          row.classList.add("dragging");
        });
        grip.addEventListener("dragend", () => {
          dragId = null;
          clearDrop();
          row.classList.remove("dragging");
        });
      }

      const name = document.createElement("input");
      name.type = "text";
      name.placeholder = "Short name";
      name.value = v.name || "";
      name.addEventListener("input", () => { v.name = name.value; markDirty(KEYS.VALUES); });

      const val = document.createElement("textarea");
      val.rows = 1;
      val.placeholder = "Value - the text inserted into the field";
      val.value = String(v.value ?? "");
      val.addEventListener("input", () => { v.value = val.value; grow(val); markDirty(KEYS.VALUES); });

      // Sensitive flag: inserting this value will ask for confirmation first.
      const sens = el("label", "sens");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!v.sensitive;
      cb.title = "Sensitive: ask for confirmation before inserting this value";
      cb.setAttribute("aria-label", (v.name || "value") + " is sensitive");
      cb.addEventListener("change", () => { v.sensitive = cb.checked; markDirty(KEYS.VALUES); });
      sens.appendChild(cb);

      // Keyboard/mouse-free reordering: plain buttons, focus kept on the
      // moved row so repeated presses keep working.
      const move = el("div", "move");
      const idx = state.values.findIndex((x) => x.id === v.id);
      const up = el("button", "icon", "^");
      up.title = q ? "Clear the filter to reorder" : "Move up";
      up.setAttribute("aria-label", "Move " + (v.name || "value") + " up");
      up.disabled = !!q || idx === 0;
      up.addEventListener("click", () => moveValue(v.id, -1, 0));
      const down = el("button", "icon", "v");
      down.title = q ? "Clear the filter to reorder" : "Move down";
      down.setAttribute("aria-label", "Move " + (v.name || "value") + " down");
      down.disabled = !!q || idx === state.values.length - 1;
      down.addEventListener("click", () => moveValue(v.id, 1, 1));
      move.append(up, down);

      const del = el("button", "icon danger", "x");
      del.title = "Delete value";
      del.addEventListener("click", () => {
        state.values = state.values.filter((x) => x.id !== v.id);
        markDirty(KEYS.VALUES);
        renderValues();
      });

      row.append(grip, name, val, sens, move, del);
      list.appendChild(row);
      grow(val);
    }
    if (!shown.length) {
      list.appendChild(el("p", "hint", q ? "No values match the filter." : "No values yet - add your first one above."));
    }
  }

  function moveValue(id, dir, which) {
    const next = NS.moveItem(state.values, id, dir);
    if (next === state.values) return;
    state.values = next;
    markDirty(KEYS.VALUES);
    renderValues();
    const btns = $("valuesList").querySelectorAll(`.vrow[data-id="${CSS.escape(id)}"] .move button`);
    const btn = btns[which];
    if (btn) (btn.disabled ? btns[1 - which] : btn).focus();
  }

  function clearDrop() {
    dropTarget = null;
    for (const r of $("valuesList").querySelectorAll(".drop-above, .drop-below")) {
      r.classList.remove("drop-above", "drop-below");
    }
  }

  const valuesList = $("valuesList");
  valuesList.addEventListener("dragover", (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const row = e.target.closest && e.target.closest(".vrow");
    clearDrop();
    if (!row || row.dataset.id === dragId) return;
    const r = row.getBoundingClientRect();
    const before = (e.clientY - r.top) < r.height / 2;
    row.classList.add(before ? "drop-above" : "drop-below");
    dropTarget = { id: row.dataset.id, before };
  });
  valuesList.addEventListener("drop", (e) => {
    if (!dragId || !dropTarget) return;
    e.preventDefault();
    const next = NS.reorderItem(state.values, dragId, dropTarget.id, dropTarget.before);
    dragId = null;
    clearDrop();
    if (next === state.values) return;
    state.values = next;
    markDirty(KEYS.VALUES);
    renderValues();
  });
  valuesList.addEventListener("dragleave", (e) => {
    if (!valuesList.contains(e.relatedTarget)) clearDrop();
  });

  $("addValue").addEventListener("click", () => {
    const v = { id: uid(), name: "", value: "", createdAt: Date.now() };
    state.values.push(v);
    filter = "";
    $("filter").value = "";
    markDirty(KEYS.VALUES);
    renderValues();
    const inputs = $("valuesList").querySelectorAll("input[type=text]");
    const last = inputs[inputs.length - 1];
    if (last) { last.focus(); last.scrollIntoView({ block: "center" }); }
  });

  $("filter").addEventListener("input", () => { filter = $("filter").value; renderValues(); });

  /* ---------------- saved forms ---------------- */

  function fieldEditor(f) {
    let ed;
    if (f.kind === "checkbox") {
      ed = document.createElement("input");
      ed.type = "checkbox";
      ed.checked = truthy(f.value);
      ed.addEventListener("change", () => { f.value = ed.checked; markDirty(KEYS.FORMS); });
      return ed;
    }
    if (f.kind === "textarea" || f.kind === "richtext") {
      ed = document.createElement("textarea");
      ed.rows = 1;
      ed.value = String(f.value ?? "");
      ed.addEventListener("input", () => { f.value = ed.value; grow(ed); markDirty(KEYS.FORMS); });
      requestAnimationFrame(() => grow(ed));
      return ed;
    }
    ed = document.createElement("input");
    ed.type = "text";
    if (f.kind === "select-multiple") {
      ed.placeholder = "Comma-separated values";
      ed.value = Array.isArray(f.value) ? f.value.join(", ") : String(f.value ?? "");
    } else if (f.kind === "radio") {
      ed.placeholder = "Option value to select";
      ed.value = f.value == null ? "" : String(f.value);
    } else {
      ed.value = String(f.value ?? "");
    }
    ed.addEventListener("input", () => {
      f.value = f.kind === "radio" && ed.value === "" ? null : ed.value;
      markDirty(KEYS.FORMS);
    });
    return ed;
  }

  function renderForms() {
    const list = $("formsList");
    list.textContent = "";
    $("formCount").textContent = state.forms.length ? String(state.forms.length) : "";
    $("formsEmpty").hidden = state.forms.length > 0;
    const sorted = [...state.forms].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const f of sorted) {
      const card = el("div", "fcard");
      const head = el("div", "fhead");

      const name = document.createElement("input");
      name.type = "text";
      name.value = f.name || "";
      name.placeholder = "Form name";
      name.addEventListener("input", () => { f.name = name.value; f.updatedAt = Date.now(); markDirty(KEYS.FORMS); });

      const toggle = el("button", "icon", expanded.has(f.id) ? "- Fields" : "+ Fields");
      toggle.addEventListener("click", () => {
        if (expanded.has(f.id)) expanded.delete(f.id); else expanded.add(f.id);
        renderForms();
      });

      const del = el("button", "icon danger", "Delete");
      del.addEventListener("click", () => {
        if (!confirm(`Delete saved form "${f.name}"?`)) return;
        state.forms = state.forms.filter((x) => x.id !== f.id);
        expanded.delete(f.id);
        markDirty(KEYS.FORMS);
        renderForms();
      });

      head.append(name, toggle, del);
      card.appendChild(head);
      card.appendChild(el("div", "fmeta",
        `${(f.fields || []).length} fields | ${f.host || "page"} | ${f.urlPattern || ""}`));

      if (expanded.has(f.id)) {
        const fields = el("div", "fields");
        (f.fields || []).forEach((field, i) => {
          const row = el("div", "frow");
          const lab = el("div", "flabel");
          lab.title = field.selector || "";
          lab.append(document.createTextNode(preview(field.label || field.fp?.name || field.selector || "field", 34)));
          lab.appendChild(el("span", "kind", field.kind));
          const ed = fieldEditor(field);
          const rm = el("button", "icon danger", "x");
          rm.title = "Remove this field from the saved form";
          rm.addEventListener("click", () => {
            f.fields.splice(i, 1);
            f.updatedAt = Date.now();
            markDirty(KEYS.FORMS);
            renderForms();
          });
          row.append(lab, ed, rm);
          fields.appendChild(row);
        });
        card.appendChild(fields);
      }
      list.appendChild(card);
    }
  }

  /* ---------------- options & backup ---------------- */

  $("includePasswords").addEventListener("change", () => {
    state.settings.includePasswords = $("includePasswords").checked;
    markDirty(KEYS.SETTINGS);
  });

  $("export").addEventListener("click", () => {
    const payload = { app: "easyfill", version: 1, exportedAt: new Date().toISOString(), ...state };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "easyfill-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $("import").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async () => {
    const file = $("importFile").files[0];
    $("importFile").value = "";
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      if (!Array.isArray(obj.values) && !Array.isArray(obj.forms)) throw new Error("Not an EasyFill backup.");
      if (!confirm("Importing replaces your current values and saved forms. Continue?")) return;
      state.values = (obj.values || []).map((v) => ({
        id: v.id || uid(), name: String(v.name ?? ""), value: String(v.value ?? ""),
        sensitive: !!v.sensitive, createdAt: v.createdAt || Date.now()
      }));
      state.forms = (obj.forms || []).filter((f) => Array.isArray(f.fields)).map((f) => ({
        id: f.id || uid(), name: String(f.name ?? "Saved form"), host: f.host || "",
        urlPattern: f.urlPattern || "", fields: f.fields,
        createdAt: f.createdAt || Date.now(), updatedAt: f.updatedAt || Date.now()
      }));
      state.settings = { ...NS.DEFAULT_SETTINGS, ...(obj.settings || {}) };
      markDirty(KEYS.VALUES); markDirty(KEYS.FORMS); markDirty(KEYS.SETTINGS);
      renderAll();
    } catch (e) {
      alert("Import failed: " + (e && e.message || e));
    }
  });

  /* ---------------- sync & init ---------------- */

  // Re-render on changes made elsewhere (popup/background), but never
  // clobber what the user is typing right now.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes[KEYS.VALUES] && !changes[KEYS.FORMS] && !changes[KEYS.SETTINGS]) return;
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
    NS.loadAll().then((d) => { state = d; renderAll(); });
  });

  function renderAll() {
    renderValues();
    renderForms();
    $("includePasswords").checked = !!state.settings.includePasswords;
  }

  (async () => {
    $("ver").textContent = "v" + NS.VERSION;
    state = await NS.loadAll();
    renderAll();
  })();
})();
