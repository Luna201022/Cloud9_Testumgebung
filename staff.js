/* Cloud9 Staff (Orders + Service Requests)
 * Lists:
 *  - GET /api/orders        -> { ok:true, orders:[...] }
 *  - GET /api/requests      -> { ok:true, requests:[...] }
 * Actions (Admin PIN via Bearer):
 *  - POST /api/staff/order  -> legacy: { key, status:"DONE" } / { key, action:"delete" }
 *                             new:    { action:"partial_done", ops:[{ key, itemIndex, qty }] }
 *                             new:    { action:"clear_table", tableId }
 *  - POST /api/staff/request-> { id, action:"done"|"delete" }
 */

(function () {
  "use strict";

  const API_ORDERS = "/api/orders";
  const API_REQUESTS = "/api/requests";
  const API_ACT_ORDER = "/api/staff/order";
  const API_ACT_REQ = "/api/staff/request";
  const API_ORDER = "/api/order";

  const LS_PIN = "cloud9_admin_pin";
  const LS_SOUND = "cloud9_staff_sound";

  const el = (id) => document.getElementById(id);

  const rowsEl = el("rows");
  const emptyEl = el("empty");
  const errorEl = el("error");
  const hintEl = el("hint");
  const metaEl = el("meta");

  const pinInput = el("pinInput");
  const savePinBtn = el("savePinBtn");
  const reloadBtn = el("reloadBtn");

  const autoEverySel = el("autoEvery");
  const autoToggle = el("autoToggle");
  const statusFilter = el("statusFilter");
  const soundBtn = el("soundBtn");

  const toastEl = el("toast");

  const state = {
    pin: localStorage.getItem(LS_PIN) || "",
    sound: localStorage.getItem(LS_SOUND) === "1",
    timer: null,
    lastKeys: new Set(),
    lastOk: true,
    lastMs: 0,
    lastAt: null,
    lastCounts: { orders: 0, requests: 0 },
    selectedTable: null,
    tableSelections: Object.create(null),
    lastOrders: [],
    lastRequests: []
  };

  let tableTools = null;
  let tableTabsEl = null;
  let tableDetailEl = null;
  let tableEmptyEl = null;
  let cachedTableGroups = [];

  function safe(str) {
    return String(str ?? "").replace(/[&<>"]/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
    }[c]));
  }

  function nowClock() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.opacity = "1";
    setTimeout(() => { toastEl.style.opacity = "0"; }, 1400);
  }

  function playBeep() {
    if (!state.sound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.value = 0.001;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.20);
      o.stop(ctx.currentTime + 0.21);
      setTimeout(() => { try { ctx.close(); } catch {} }, 400);
    } catch {}
  }

  function money(n) {
    try { return (Number(n) || 0).toFixed(2).replace(".", ",") + " €"; }
    catch { return "0,00 €"; }
  }

  function toInt(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : def;
  }

  function optionText(options) {
    if (!options || typeof options !== "object") return "";
    return Object.values(options).filter(Boolean).map((x) => String(x)).join(", ");
  }

  function normalizeItem(it) {
    const qty = Math.max(0, toInt(it?.qty ?? it?.quantity, 1));
    const done = Math.max(0, Math.min(qty, toInt(it?.done, 0)));
    return {
      id: (it?.id ?? "").toString(),
      name: (it?.name || it?.id || "Artikel").toString(),
      qty,
      done,
      open: Math.max(0, qty - done),
      unitPrice: Number(it?.unitPrice) || 0,
      options: it?.options && typeof it.options === "object" ? it.options : {},
      optionText: optionText(it?.options)
    };
  }

  function summarizeItems(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    return items.map((raw) => {
      const it = normalizeItem(raw);
      const line = `${it.qty}× ${it.name}${it.optionText ? " (" + it.optionText + ")" : ""}`;
      if (it.done > 0 && it.open > 0) return safe(`${line} · ${it.done} erledigt`);
      if (it.done > 0 && it.open === 0) return `<span style="opacity:.55">${safe(`${line} · erledigt`)}</span>`;
      return safe(line);
    }).join("<br>");
  }

  function orderDisplayStatus(obj) {
    if (!obj || !Array.isArray(obj.items)) return String(obj?.status || "NEW").toUpperCase();
    let hasOpen = false;
    let hasDone = false;
    for (const raw of obj.items) {
      const it = normalizeItem(raw);
      if (it.open > 0) hasOpen = true;
      if (it.done > 0) hasDone = true;
    }
    if (hasOpen && hasDone) return "TEILWEISE";
    if (!hasOpen && hasDone) return "DONE";
    return String(obj.status || "NEW").toUpperCase();
  }

  function statusPill(kind, obj) {
    let label = (obj?.status || "NEW").toUpperCase();
    let cls = "pill new";

    if (kind === "request") {
      label = String(obj?.type || label).toUpperCase();
      cls = (obj?.status || "NEW").toUpperCase() === "DONE" ? "pill done" : "pill new";
      return `<span class="${cls}">${safe(label)}</span>`;
    }

    label = orderDisplayStatus(obj);
    if (label === "DONE") cls = "pill done";
    else if (label === "TEILWEISE") cls = "pill";
    else cls = "pill new";

    return `<span class="${cls}">${safe(label)}</span>`;
  }

  async function fetchJson(url, opts = {}, withAuth = false) {
    const headers = Object.assign({}, opts.headers || {});
    if (withAuth) {
      const pin = state.pin || localStorage.getItem(LS_PIN) || "";
      if (pin) headers["Authorization"] = "Bearer " + pin;
    }
    const t0 = performance.now();
    const res = await fetch(url, Object.assign({ cache: "no-store" }, opts, { headers }));
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);

    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) ? (data.error || data.message) : (text || ("HTTP " + res.status));
      const err = new Error(String(msg));
      err.status = res.status;
      err.ms = ms;
      throw err;
    }
    data = data || {};
    data._ms = ms;
    return data;
  }

  function findLinksCardContainer() {
    const wanted = ["kunden-frontend", "menü-admin", "menu-admin"];
    const nodes = Array.from(document.querySelectorAll("a,button"));
    for (const node of nodes) {
      const txt = String(node.textContent || "").trim().toLowerCase();
      if (!wanted.includes(txt)) continue;
      const card = node.closest(".card, .panel, .box, section, article");
      if (card) return card;
      if (node.parentElement) return node.parentElement;
    }
    return null;
  }

  function ensureTableTools() {
    if (tableTools) return;
    if (!rowsEl || !rowsEl.parentNode) return;

    tableTools = document.createElement("section");
    tableTools.id = "tableTools";
    tableTools.style.margin = "16px 0 0 0";
    tableTools.innerHTML = `
      <div style="border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px;background:rgba(255,255,255,.03)">
        <div style="font-weight:800;font-size:16px;margin:0 0 10px 0">Tische mit offenen Bestellungen</div>
        <div id="tableTabs" style="display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px 0"></div>
        <div id="tableEmptyInfo" class="muted small2" style="display:none">Keine offenen Tische.</div>
        <div id="tableDetail"></div>
      </div>
    `;

    const linksCard = findLinksCardContainer();
    if (linksCard) {
      linksCard.appendChild(tableTools);
    } else {
      const anchor = rowsEl.closest("table") || rowsEl.parentNode;
      anchor.parentNode.insertBefore(tableTools, anchor);
    }

    tableTabsEl = tableTools.querySelector("#tableTabs");
    tableDetailEl = tableTools.querySelector("#tableDetail");
    tableEmptyEl = tableTools.querySelector("#tableEmptyInfo");

    tableTabsEl?.addEventListener("click", onTableTabsClick);
    tableDetailEl?.addEventListener("click", onTableDetailClick);
    tableDetailEl?.addEventListener("input", onTableDetailInput);
  }

  function groupKeyFor(item) {
    return [
      item.id || "",
      item.name || "",
      item.optionText || "",
      Number(item.unitPrice || 0).toFixed(2)
    ].join("||");
  }

  function buildTableGroups(orders) {
    const map = new Map();

    for (const rawOrder of (orders || [])) {
      if (!rawOrder) continue;
      const tableId = toInt(rawOrder.tableId ?? rawOrder.table ?? rawOrder.table_id, 0);
      if (!tableId) continue;

      let table = map.get(tableId);
      if (!table) {
        table = {
          tableId,
          orders: [],
          itemsMap: new Map(),
          openQty: 0,
          doneQty: 0,
          openTotal: 0,
          totalAll: 0
        };
        map.set(tableId, table);
      }

      const order = {
        ...rawOrder,
        items: Array.isArray(rawOrder.items) ? rawOrder.items.map(normalizeItem) : []
      };
      table.orders.push(order);

      order.items.forEach((it, itemIndex) => {
        const gk = groupKeyFor(it);
        let row = table.itemsMap.get(gk);
        if (!row) {
          row = {
            groupKey: gk,
            name: it.name,
            optionText: it.optionText,
            unitPrice: it.unitPrice,
            totalQty: 0,
            openQty: 0,
            doneQty: 0,
            segments: []
          };
          table.itemsMap.set(gk, row);
        }

        row.totalQty += it.qty;
        row.openQty += it.open;
        row.doneQty += it.done;

        table.openQty += it.open;
        table.doneQty += it.done;
        table.openTotal += it.open * it.unitPrice;
        table.totalAll += it.qty * it.unitPrice;

        row.segments.push({
          key: order.key || order.id || "",
          itemIndex,
          orderId: order.id || "",
          openQty: it.open,
          doneQty: it.done,
          qty: it.qty,
          unitPrice: it.unitPrice
        });
      });
    }

    return Array.from(map.values())
      .map((table) => ({
        ...table,
        items: Array.from(table.itemsMap.values()).sort((a, b) => {
          if (b.openQty !== a.openQty) return b.openQty - a.openQty;
          return a.name.localeCompare(b.name, "de");
        })
      }))
      .sort((a, b) => a.tableId - b.tableId);
  }

  function getSelectedMap(tableId) {
    const key = String(tableId || "");
    if (!state.tableSelections[key]) state.tableSelections[key] = Object.create(null);
    return state.tableSelections[key];
  }

  function selectedQty(tableId, groupKey) {
    return Math.max(0, toInt(getSelectedMap(tableId)[groupKey], 0));
  }

  function setSelectedQty(tableId, groupKey, qty, maxQty) {
    const map = getSelectedMap(tableId);
    const clean = Math.max(0, Math.min(Math.max(0, toInt(maxQty, 0)), toInt(qty, 0)));
    if (clean > 0) map[groupKey] = clean;
    else delete map[groupKey];
  }

  function calcSelectedTotal(table) {
    return (table.items || []).reduce((sum, item) => {
      const qty = selectedQty(table.tableId, item.groupKey);
      return sum + qty * Number(item.unitPrice || 0);
    }, 0);
  }

  function renderTableTools(orders) {
    ensureTableTools();
    if (!tableTools || !tableTabsEl || !tableDetailEl || !tableEmptyEl) return;

    cachedTableGroups = buildTableGroups(orders);
    const openTables = cachedTableGroups.filter((t) => t.openQty > 0);

    if (!state.selectedTable || !openTables.some((t) => String(t.tableId) === String(state.selectedTable))) {
      state.selectedTable = openTables.length ? String(openTables[0].tableId) : null;
    }

    tableTabsEl.innerHTML = openTables.map((table) => {
      const active = String(table.tableId) === String(state.selectedTable);
      return `
        <button
          type="button"
          data-table-tab="${safe(table.tableId)}"
          class="btn2 ${active ? "primary" : ""}"
          style="border-radius:999px"
        >
          Tisch ${safe(table.tableId)} · ${safe(table.openQty)}
        </button>
      `;
    }).join("");

    tableEmptyEl.style.display = openTables.length ? "none" : "block";
    renderSelectedTableDetail();
  }

  function renderSelectedTableDetail() {
    if (!tableDetailEl) return;

    const table = cachedTableGroups.find((t) => String(t.tableId) === String(state.selectedTable));
    if (!table) {
      tableDetailEl.innerHTML = "";
      return;
    }

    const selectedTotal = calcSelectedTotal(table);
    const rows = table.items.map((item) => {
      const currentSelected = selectedQty(table.tableId, item.groupKey);
      const canSelect = item.openQty > 0;
      const allDone = item.openQty === 0 && item.doneQty > 0;
      const rowStyle = allDone
        ? "opacity:.58;background:rgba(255,255,255,.03)"
        : "";
      return `
        <div style="display:flex;gap:12px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px;margin:0 0 8px 0;${rowStyle}">
          <div style="min-width:180px;flex:1 1 220px">
            <div style="font-weight:800;line-height:1.25">${safe(item.name)}${item.optionText ? ` <span class="small2 muted" style="font-weight:500">(${safe(item.optionText)})</span>` : ""}</div>
            <div class="small2 muted" style="margin-top:6px;line-height:1.35">
              Offen: ${safe(item.openQty)} · Erledigt: ${safe(item.doneQty)} · Gesamt: ${safe(item.totalQty)}
            </div>
          </div>
          <div style="display:grid;grid-template-columns:auto auto;column-gap:10px;row-gap:4px;align-items:center;min-width:150px;flex:0 0 auto">
            <div class="small2 muted">Einzel</div>
            <div class="mono" style="font-weight:700;text-align:right">${money(item.unitPrice)}</div>
            <div class="small2 muted">Offen</div>
            <div class="mono" style="font-weight:700;text-align:right">${money(item.openQty * item.unitPrice)}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;justify-content:flex-end;flex:0 0 auto">
            <button type="button" class="btn2" data-minus-group="${safe(item.groupKey)}" ${canSelect ? "" : "disabled"}>-</button>
            <input
              type="number"
              min="0"
              max="${safe(item.openQty)}"
              value="${safe(currentSelected)}"
              data-qty-group="${safe(item.groupKey)}"
              style="width:58px;padding:7px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;text-align:center"
              ${canSelect ? "" : "disabled"}
            />
            <button type="button" class="btn2" data-plus-group="${safe(item.groupKey)}" ${canSelect ? "" : "disabled"}>+</button>
          </div>
        </div>
      `;
    }).join("");

    tableDetailEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin:0 0 10px 0">
        <div>
          <div style="font-size:18px;font-weight:900">Tisch ${safe(table.tableId)}</div>
          <div class="small2 muted">Hier werden offene und bereits erledigte Positionen des Tisches zusammen angezeigt.</div>
        </div>
        <div style="display:grid;gap:4px;text-align:right">
          <div class="mono">Offen gesamt: <b>${money(table.openTotal)}</b></div>
          <div class="mono">Ausgewählt: <b>${money(selectedTotal)}</b></div>
          <div class="small2 muted">Tisch komplett: ${money(table.totalAll)}</div>
        </div>
      </div>
      <div>${rows || `<div class="muted small2">Keine Positionen gefunden.</div>`}</div>
      <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px">
        <button type="button" class="btn2" data-table-select-all="${safe(table.tableId)}">Alles auswählen</button>
        <button type="button" class="btn2" data-table-manual-add="${safe(table.tableId)}">Manuell hinzufügen</button>
        <button type="button" class="btn2 primary" data-table-apply="${safe(table.tableId)}">Löschen</button>
        <button type="button" class="btn2 danger" data-table-clear="${safe(table.tableId)}">Tisch leeren</button>
      </div>
    `;
  }

  function onTableTabsClick(ev) {
    const btn = ev.target.closest("button[data-table-tab]");
    if (!btn) return;
    state.selectedTable = String(btn.getAttribute("data-table-tab") || "");
    renderTableTools(state.lastOrders);
  }

  function onTableDetailInput(ev) {
    const input = ev.target.closest("input[data-qty-group]");
    if (!input) return;
    const table = cachedTableGroups.find((t) => String(t.tableId) === String(state.selectedTable));
    if (!table) return;
    const groupKey = input.getAttribute("data-qty-group") || "";
    const item = table.items.find((x) => x.groupKey === groupKey);
    if (!item) return;
    setSelectedQty(table.tableId, groupKey, input.value, item.openQty);
    renderSelectedTableDetail();
  }

  async function onTableDetailClick(ev) {
    const minusBtn = ev.target.closest("button[data-minus-group]");
    const plusBtn = ev.target.closest("button[data-plus-group]");
    const selectAllBtn = ev.target.closest("button[data-table-select-all]");
    const manualAddBtn = ev.target.closest("button[data-table-manual-add]");
    const applyBtn = ev.target.closest("button[data-table-apply]");
    const clearBtn = ev.target.closest("button[data-table-clear]");

    const table = cachedTableGroups.find((t) => String(t.tableId) === String(state.selectedTable));
    if (!table) return;

    if (minusBtn || plusBtn) {
      const groupKey = (minusBtn || plusBtn).getAttribute(minusBtn ? "data-minus-group" : "data-plus-group") || "";
      const item = table.items.find((x) => x.groupKey === groupKey);
      if (!item) return;
      const current = selectedQty(table.tableId, groupKey);
      const next = current + (plusBtn ? 1 : -1);
      setSelectedQty(table.tableId, groupKey, next, item.openQty);
      renderSelectedTableDetail();
      return;
    }

    if (selectAllBtn) {
      selectAllOpenForTable(table);
      renderSelectedTableDetail();
      return;
    }

    if (manualAddBtn) {
      await openManualAddPrompt(table.tableId);
      return;
    }

    if (applyBtn) {
      await applySelectedDone(table);
      return;
    }

    if (clearBtn) {
      await clearWholeTable(table.tableId);
    }
  }

  function buildPartialOps(table) {
    const ops = [];
    for (const item of (table.items || [])) {
      let wanted = selectedQty(table.tableId, item.groupKey);
      if (!wanted) continue;

      for (const seg of (item.segments || [])) {
        if (wanted <= 0) break;
        const canTake = Math.max(0, toInt(seg.openQty, 0));
        if (!canTake) continue;
        const take = Math.min(wanted, canTake);
        if (take > 0) {
          ops.push({
            key: seg.key,
            itemIndex: seg.itemIndex,
            qty: take
          });
          wanted -= take;
        }
      }
    }
    return ops;
  }

  function clearSelectionsForTable(tableId) {
    delete state.tableSelections[String(tableId || "")];
  }

  function selectAllOpenForTable(table) {
    const map = getSelectedMap(table.tableId);
    Object.keys(map).forEach((k) => delete map[k]);
    for (const item of (table.items || [])) {
      if (item.openQty > 0) map[item.groupKey] = item.openQty;
    }
  }

  async function applySelectedDone(table) {
    if (!state.pin && !localStorage.getItem(LS_PIN)) {
      errorEl.textContent = "PIN fehlt. Bitte oben speichern.";
      return;
    }

    const ops = buildPartialOps(table);
    if (!ops.length) {
      toast("Keine Menge ausgewählt");
      return;
    }

    errorEl.textContent = "";
    await actOrder({ action: "partial_done", ops });
    clearSelectionsForTable(table.tableId);
    toast("Ausgewählte Positionen grau gesetzt");
    await refreshOnce(true);
  }

  async function clearWholeTable(tableId) {
    if (!state.pin && !localStorage.getItem(LS_PIN)) {
      errorEl.textContent = "PIN fehlt. Bitte oben speichern.";
      return;
    }
    if (!confirm(`Tisch ${tableId} wirklich komplett leeren?`)) return;

    errorEl.textContent = "";
    await actOrder({ action: "clear_table", tableId });
    clearSelectionsForTable(tableId);
    if (String(state.selectedTable) === String(tableId)) state.selectedTable = null;
    toast(`Tisch ${tableId} geleert`);
    await refreshOnce(true);
  }

  async function openManualAddPrompt(tableId) {
    const name = (window.prompt(`Was soll zu Tisch ${tableId} hinzugebucht werden?`, "") || "").trim();
    if (!name) return;

    const priceRaw = (window.prompt(`Einzelpreis für „${name}“ in Euro`, "0") || "").replace(',', '.').trim();
    const unitPrice = Number(priceRaw);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      errorEl.textContent = "Ungültiger Preis";
      return;
    }

    const qtyRaw = (window.prompt(`Menge für „${name}“`, "1") || "1").trim();
    const qty = Math.max(1, toInt(qtyRaw, 1));

    errorEl.textContent = "";
    await createManualOrder(tableId, name, unitPrice, qty);
    toast(`Zu Tisch ${tableId} hinzugebucht`);
    await refreshOnce(true);
  }

  if (pinInput) pinInput.value = "";

  function syncSoundBtn() {
    if (!soundBtn) return;
    if (state.sound) {
      soundBtn.textContent = "Sound deaktivieren";
      soundBtn.classList.add("primary");
    } else {
      soundBtn.textContent = "Sound aktivieren";
      soundBtn.classList.remove("primary");
    }
  }
  syncSoundBtn();

  if (savePinBtn) {
    savePinBtn.addEventListener("click", () => {
      state.pin = (pinInput?.value || "").trim();
      localStorage.setItem(LS_PIN, state.pin);
      if (pinInput) pinInput.value = "";
      toast("PIN gespeichert");
      refreshOnce(true);
    });
  }

  if (reloadBtn) reloadBtn.addEventListener("click", () => refreshOnce(true));

  if (soundBtn) {
    soundBtn.addEventListener("click", () => {
      state.sound = !state.sound;
      localStorage.setItem(LS_SOUND, state.sound ? "1" : "0");
      syncSoundBtn();
      if (state.sound) playBeep();
    });
  }

  function schedule() {
    if (state.timer) clearInterval(state.timer);
    if (!autoToggle || !autoToggle.checked) return;
    const sec = parseInt(autoEverySel?.value || "5", 10);
    state.timer = setInterval(() => refreshOnce(false), Math.max(1, sec) * 1000);
  }

  if (autoToggle) autoToggle.addEventListener("change", schedule);
  if (autoEverySel) autoEverySel.addEventListener("change", schedule);
  if (statusFilter) statusFilter.addEventListener("change", () => refreshOnce(true));

  async function actOrder(payload) {
    return fetchJson(API_ACT_ORDER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }, true);
  }

  async function actRequest(payload) {
    return fetchJson(API_ACT_REQ, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }, true);
  }

  async function createManualOrder(tableId, name, unitPrice, qty) {
    return fetchJson(API_ORDER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tableId,
        items: [{
          id: `manual:${String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'artikel'}`,
          name,
          qty,
          unitPrice,
          options: { quelle: "Theke" }
        }],
        note: "Manuell an Theke hinzugefügt",
        total: Math.round((qty * unitPrice) * 100) / 100
      })
    }, false);
  }

  rowsEl?.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;

    const keyDone = btn.getAttribute("data-done");
    const keyDel = btn.getAttribute("data-del");
    const openTable = btn.getAttribute("data-open-table");
    const clearTable = btn.getAttribute("data-clear-table");
    const kind = btn.getAttribute("data-kind") || "order";

    try {
      errorEl.textContent = "";

      if (openTable) {
        state.selectedTable = String(openTable);
        renderTableTools(state.lastOrders);
        const target = document.getElementById("tableTools");
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      if (clearTable) {
        await clearWholeTable(clearTable);
        return;
      }

      if (keyDone) {
        if (!state.pin && !localStorage.getItem(LS_PIN)) {
          errorEl.textContent = "PIN fehlt. Bitte oben speichern.";
          return;
        }
        if (kind === "request") {
          await actRequest({ id: keyDone, action: "done" });
          toast("Service erledigt");
        } else {
          await actOrder({ key: keyDone, status: "DONE" });
          toast("Auf DONE gesetzt");
        }
        await refreshOnce(true);
        return;
      }

      if (keyDel) {
        if (!state.pin && !localStorage.getItem(LS_PIN)) {
          errorEl.textContent = "PIN fehlt. Bitte oben speichern.";
          return;
        }
        const q = kind === "request" ? "Service-Eintrag wirklich löschen?" : "Bestellung wirklich löschen?";
        if (!confirm(q)) return;

        if (kind === "request") {
          await actRequest({ id: keyDel, action: "delete" });
          toast("Service gelöscht");
        } else {
          await actOrder({ key: keyDel, action: "delete" });
          toast("Gelöscht");
        }
        await refreshOnce(true);
      }
    } catch (e) {
      errorEl.textContent = String(e?.message || e);
    }
  });

  function render(list) {
    if (!rowsEl) return;

    const filter = (statusFilter?.value || "NEW").toUpperCase();
    const shown = list.filter((x) => {
      if (x.kind === "request") {
        if (filter === "ALL") return true;
        return String(x.status || "NEW").toUpperCase() === filter;
      }
      if (filter === "ALL") return true;
      return String(x.status || "NEW").toUpperCase() === filter;
    });

    rowsEl.innerHTML = shown.map((x) => {
      const isReq = x.kind === "request";
      const tableId = x.tableId ?? x.table ?? x.table_id ?? "";
      const id = x.id || x.key || "";
      const itemsHtml = isReq
        ? safe(String(x.type || "").toUpperCase() === "PAY" ? "Bezahlen" : "Bedienung rufen")
        : summarizeItems(x.items);

      const sumHtml = isReq ? "—" : money(x.total ?? 0);
      const orderButtons = `
        <button class="btn2 primary" type="button" data-open-table="${safe(tableId)}">Tisch öffnen</button>
        <button class="btn2 danger" type="button" data-clear-table="${safe(tableId)}">Tisch leeren</button>
      `;
      const requestButtons = `
        <button class="btn2 primary" type="button" data-kind="request" data-done="${safe(id)}">Erledigt</button>
        <button class="btn2 danger" type="button" data-kind="request" data-del="${safe(id)}">Löschen</button>
      `;

      return `
<tr>
  <td class="mono"><b>${safe(tableId)}</b></td>
  <td>
    <div style="font-weight:800">${itemsHtml}</div>
    <div class="small2 muted mono">${safe(id)}</div>
  </td>
  <td class="mono">${sumHtml}</td>
  <td>${statusPill(x.kind, x)}</td>
  <td>${isReq ? requestButtons : orderButtons}</td>
</tr>`;
    }).join("");

    if (emptyEl) emptyEl.style.display = shown.length ? "none" : "block";
  }

  async function refreshOnce(force) {
    try {
      errorEl.textContent = "";

      const t0 = performance.now();
      const [ordersData, reqData] = await Promise.all([
        fetchJson(API_ORDERS, {}, false),
        fetchJson(API_REQUESTS, {}, false)
      ]);
      const ms = Math.round(performance.now() - t0);

      const orders = Array.isArray(ordersData.orders) ? ordersData.orders : [];
      const requests = Array.isArray(reqData.requests) ? reqData.requests : [];

      state.lastOrders = orders;
      state.lastRequests = requests;
      renderTableTools(orders);

      const merged = [
        ...requests.map((r) => ({ ...r, kind: "request" })),
        ...orders.map((o) => ({ ...o, kind: "order" }))
      ].sort((a, b) => {
        const ta = Number(a.updatedAt ?? Date.parse(a.createdAt || 0) ?? 0);
        const tb = Number(b.updatedAt ?? Date.parse(b.createdAt || 0) ?? 0);
        return tb - ta;
      });

      const currentKeys = new Set(merged.map((x) => x.id || x.key).filter(Boolean));
      let newCount = 0;
      for (const k of currentKeys) if (!state.lastKeys.has(k)) newCount++;
      if (newCount > 0 && !force) playBeep();
      state.lastKeys = currentKeys;

      state.lastOk = true;
      state.lastMs = ms;
      state.lastAt = new Date();
      state.lastCounts = { orders: orders.length, requests: requests.length };

      if (metaEl) {
        metaEl.textContent = `OK • o:${orders.length} • r:${requests.length} • ${ms} ms • ${nowClock()}`;
      }

      render(merged);
    } catch (e) {
      state.lastOk = false;
      if (metaEl) metaEl.textContent = `ERR • ${nowClock()}`;
      errorEl.textContent = String(e?.message || e);
      renderTableTools([]);
      render([]);
    }
  }

  hintEl && (hintEl.style.display = "block");
  emptyEl && (emptyEl.style.display = "block");
  refreshOnce(true);
  schedule();

})();
