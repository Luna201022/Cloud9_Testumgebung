(function () {
  "use strict";

  const API_ORDERS = "/api/orders";
  const API_REQUESTS = "/api/requests";
  const API_ACT_ORDER = "/api/staff/order";
  const API_ACT_REQ = "/api/staff/request";
  const API_ORDER_CREATE = "/api/order";
  const MENU_URL = "menu.de.json";

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
    menu: null,
    selectedTableId: null,
    selection: {},
    orders: [],
    requests: []
  };

  function safe(str) {
    return String(str ?? "").replace(/[&<>"]/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
    }[c]));
  }

  function money(n) {
    const v = Number(n) || 0;
    return v.toFixed(2).replace('.', ',') + ' €';
  }

  function nowClock() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
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
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.value = 0.001;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.20);
      o.stop(ctx.currentTime + 0.21);
      setTimeout(() => { try { ctx.close(); } catch {} }, 400);
    } catch {}
  }

  function fetchJson(url, opts = {}, withAuth = false) {
    const headers = Object.assign({}, opts.headers || {});
    if (withAuth) {
      const pin = state.pin || localStorage.getItem(LS_PIN) || "";
      if (pin) headers.Authorization = 'Bearer ' + pin;
    }
    return fetch(url, Object.assign({ cache: 'no-store' }, opts, { headers })).then(async (res) => {
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (!res.ok) {
        throw new Error((data && (data.error || data.message)) || text || ('HTTP ' + res.status));
      }
      return data || {};
    });
  }

  async function loadMenu() {
    try {
      const res = await fetch(MENU_URL, { cache: 'no-store' });
      if (!res.ok) return;
      state.menu = await res.json();
    } catch {}
  }

  function syncSoundBtn() {
    if (!soundBtn) return;
    if (state.sound) {
      soundBtn.textContent = 'Sound deaktivieren';
      soundBtn.classList.add('primary');
    } else {
      soundBtn.textContent = 'Sound aktivieren';
      soundBtn.classList.remove('primary');
    }
  }

  function summarizeItems(items) {
    if (!Array.isArray(items) || !items.length) return '';
    return items.map((it) => {
      const qty = Math.trunc(Number(it?.qty) || Number(it?.quantity) || 1);
      const name = it?.name || it?.id || 'Artikel';
      const opt = (it?.options && typeof it.options === 'object') ? Object.values(it.options).filter(Boolean).join(', ') : '';
      return safe(`${qty}× ${name}${opt ? ' (' + opt + ')' : ''}`);
    }).join('<br>');
  }

  function statusPill(kind, obj) {
    let label = (obj?.status || 'NEW').toUpperCase();
    if (kind === 'request') label = String(obj?.type || label).toUpperCase();
    const cls = (obj?.status || 'NEW').toUpperCase() === 'DONE' ? 'pill done' : 'pill new';
    return `<span class="${cls}">${safe(label)}</span>`;
  }

  function itemKeyOf(it) {
    const name = it?.name || it?.id || 'Artikel';
    const opt = (it?.options && typeof it.options === 'object')
      ? Object.keys(it.options).sort().map((k) => `${k}:${it.options[k]}`).join('|')
      : '';
    return `${name}__${opt}`;
  }

  function itemLabel(it) {
    const name = it?.name || it?.id || 'Artikel';
    const opt = (it?.options && typeof it.options === 'object')
      ? Object.values(it.options).filter(Boolean).join(', ')
      : '';
    return opt ? `${name} (${opt})` : name;
  }

  function getOpenTables() {
    const map = new Map();
    for (const order of state.orders) {
      const tableId = Number(order.tableId || 0);
      if (!tableId) continue;
      const items = Array.isArray(order.items) ? order.items : [];
      let amountCount = 0;
      for (const it of items) {
        const qty = Math.max(0, Math.trunc(Number(it?.qty) || 0));
        amountCount += qty;
      }
      if (!amountCount) continue;
      map.set(tableId, (map.get(tableId) || 0) + amountCount);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([tableId, count]) => ({ tableId, count }));
  }

  function aggregateTable(tableId) {
    const byItem = new Map();
    const orders = state.orders.filter((o) => Number(o.tableId) === Number(tableId));
    for (const order of orders) {
      const orderKey = order.key || order.id;
      const items = Array.isArray(order.items) ? order.items : [];
      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx] || {};
        const k = itemKeyOf(it);
        const qty = Math.max(0, Math.trunc(Number(it.qty) || 0));
        const done = Math.max(0, Math.trunc(Number(it.done) || 0));
        const unitPrice = Number(it.unitPrice ?? it.price ?? 0) || 0;
        if (!byItem.has(k)) {
          byItem.set(k, {
            key: k,
            label: itemLabel(it),
            unitPrice,
            totalQty: 0,
            doneQty: 0,
            orderParts: []
          });
        }
        const row = byItem.get(k);
        row.totalQty += qty;
        row.doneQty += done;
        row.orderParts.push({ orderKey, itemIndex: idx, qty, done, open: Math.max(0, qty - done), unitPrice, item: it });
      }
    }
    return [...byItem.values()].sort((a, b) => a.label.localeCompare(b.label, 'de'));
  }

  function computeTableTotals(tableId) {
    const rows = aggregateTable(tableId);
    let openTotal = 0;
    let selectedTotal = 0;
    let tableTotal = 0;
    const selForTable = state.selection[tableId] || {};
    for (const r of rows) {
      const openQty = Math.max(0, r.totalQty - r.doneQty);
      tableTotal += r.totalQty * r.unitPrice;
      openTotal += r.totalQty * r.unitPrice;
      const sel = Math.max(0, Math.min(openQty, Math.trunc(Number(selForTable[r.key]) || 0)));
      selectedTotal += sel * r.unitPrice;
    }
    return { openTotal, selectedTotal, tableTotal };
  }

  function ensureSelectionTable(tableId) {
    if (!state.selection[tableId]) state.selection[tableId] = {};
    return state.selection[tableId];
  }

  function setAllSelected(tableId) {
    const target = ensureSelectionTable(tableId);
    for (const r of aggregateTable(tableId)) {
      const openQty = Math.max(0, r.totalQty - r.doneQty);
      target[r.key] = openQty;
    }
  }

  function adjustSelected(tableId, itemKey, delta, max) {
    const target = ensureSelectionTable(tableId);
    const cur = Math.max(0, Math.trunc(Number(target[itemKey]) || 0));
    target[itemKey] = Math.max(0, Math.min(max, cur + delta));
  }

  function setSelected(tableId, itemKey, value, max) {
    const target = ensureSelectionTable(tableId);
    target[itemKey] = Math.max(0, Math.min(max, Math.trunc(Number(value) || 0)));
  }

  function buildSelectionPayload(tableId) {
    const rows = aggregateTable(tableId);
    const picked = [];
    const selForTable = ensureSelectionTable(tableId);
    for (const r of rows) {
      let need = Math.max(0, Math.min(r.totalQty - r.doneQty, Math.trunc(Number(selForTable[r.key]) || 0)));
      if (!need) continue;
      for (const part of r.orderParts) {
        if (!need) break;
        const take = Math.min(need, part.open);
        if (take > 0) {
          picked.push({ orderKey: part.orderKey, itemIndex: part.itemIndex, qty: take, label: r.label });
          need -= take;
        }
      }
    }
    return picked;
  }

  async function actOrder(payload) {
    return fetchJson(API_ACT_ORDER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, true);
  }

  async function actRequest(payload) {
    return fetchJson(API_ACT_REQ, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, true);
  }

  async function createManualOrder(tableId, item, qty, unitPrice) {
    const payload = {
      tableId,
      items: [{
        id: item.id,
        name: item.name,
        qty,
        unitPrice,
        options: { manual: 'Theke' }
      }],
      note: 'Manuell hinzugefügt (Theke)',
      total: Math.round(qty * unitPrice * 100) / 100
    };
    return fetchJson(API_ORDER_CREATE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, false);
  }

  function injectStyles() {
    if (document.getElementById('cloud9-staff-enhanced-style')) return;
    const style = document.createElement('style');
    style.id = 'cloud9-staff-enhanced-style';
    style.textContent = `
      .c9-flex{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
      .c9-left{flex:1 1 780px;min-width:560px}
      .c9-right{flex:0 1 420px;min-width:340px}
      .c9-card{border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:14px;background:rgba(255,255,255,.02);margin-top:10px}
      .c9-title{font-weight:900;font-size:18px;margin-bottom:10px}
      .c9-sub{font-size:13px;opacity:.85;margin-bottom:10px}
      .c9-tablechips{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
      .c9-chip{border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:9px 14px;background:transparent;color:inherit;cursor:pointer}
      .c9-chip.active{background:#1778ff;border-color:#1778ff}
      .c9-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
      .c9-btn{border-radius:14px;padding:10px 16px;border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;cursor:pointer}
      .c9-btn.primary{background:#1778ff;border-color:#1778ff}
      .c9-btn.danger{background:#6b1326;border-color:#b43a58}
      .c9-inlineform{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
      .c9-inlineform label{font-size:12px;opacity:.85;display:block;margin-bottom:4px}
      .c9-inlineform input,.c9-inlineform select{width:100%;border-radius:10px;padding:10px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.15);color:inherit}
      .c9-inlineform .full{grid-column:1/-1}
      .c9-items{display:flex;flex-direction:column;gap:10px;margin-top:12px}
      .c9-item{border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:12px;display:grid;grid-template-columns:minmax(0,1.8fr) 100px 110px 130px;gap:12px;align-items:center}
      .c9-item.c9-partial{background:rgba(255,255,255,.04)}
      .c9-item.c9-done{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.16);color:rgba(255,255,255,.72)}
      .c9-item.c9-done .c9-name,.c9-item.c9-done .c9-value{color:rgba(255,255,255,.82)}
      .c9-name{font-weight:900;font-size:16px;line-height:1.25}
      .c9-meta{font-size:13px;opacity:.86;margin-top:4px;line-height:1.25}
      .c9-col{display:flex;flex-direction:column;gap:4px;align-items:flex-end;justify-content:center}
      .c9-label{font-size:12px;opacity:.75;line-height:1}
      .c9-value{font-size:16px;font-weight:900;line-height:1.2;white-space:nowrap}
      .c9-qty{display:flex;justify-content:flex-end;align-items:center;gap:8px}
      .c9-qty button{width:34px;height:34px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.04);color:inherit;cursor:pointer}
      .c9-qty input{width:50px;text-align:center;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.12);color:inherit;padding:8px 6px}
      .c9-totals{margin-top:8px;line-height:1.5;font-size:15px}
      .c9-totals b{font-size:18px}
      .c9-live-row-actions{display:flex;gap:8px;flex-wrap:wrap}
      @media (max-width: 1100px){.c9-left,.c9-right{min-width:100%;flex-basis:100%}.c9-item{grid-template-columns:1fr 92px 100px 120px}}
      @media (max-width: 760px){.c9-item{grid-template-columns:1fr;gap:8px}.c9-col{align-items:flex-start}.c9-qty{justify-content:flex-start}.c9-inlineform{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function findLinksCard() {
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,strong,span')];
    const linkHead = headings.find((x) => /^\s*Links\s*$/i.test((x.textContent || '').trim()));
    if (linkHead) {
      const card = linkHead.closest('.card, .panel, .box, section');
      if (card) return card;
    }
    const linksBtn = [...document.querySelectorAll('a,button')].find((x) => /kunden-frontend/i.test((x.textContent || '').trim()));
    if (linksBtn) {
      const card = linksBtn.closest('.card, .panel, .box, section');
      if (card) return card;
    }
    return null;
  }

  function buildLayout() {
    injectStyles();

    const old = document.getElementById('c9-table-card');
    if (old && !old.closest('.grid > .card2:nth-child(2), .grid > *:nth-child(2)')) {
      try { old.remove(); } catch {}
    }
    if (document.getElementById('c9-table-root')) return;

    const rightCard =
      document.querySelector('.grid > .card2:nth-child(2)') ||
      document.querySelector('.grid > *:nth-child(2)') ||
      findLinksCard();

    if (rightCard) {
      let host = document.getElementById('c9-table-card');
      if (!host) {
        host = document.createElement('div');
        host.className = 'c9-card';
        host.id = 'c9-table-card';
        host.style.marginTop = '14px';
        rightCard.appendChild(host);
      }
      if (!document.getElementById('c9-table-root')) {
        host.innerHTML = '<div id="c9-table-root"></div>';
      }
      return;
    }

    const rowsContainer = rowsEl?.closest('table')?.parentElement || rowsEl?.parentElement || null;
    if (!rowsContainer) return;
    const liveSection = rowsContainer.closest('.card, .panel, .box, section, div') || rowsContainer.parentElement;
    if (!liveSection) return;

    const wrap = document.createElement('div');
    wrap.id = 'c9-enhanced-wrap';
    wrap.className = 'c9-flex';

    const left = document.createElement('div');
    left.className = 'c9-left';
    const right = document.createElement('div');
    right.className = 'c9-right';

    liveSection.parentNode.insertBefore(wrap, liveSection);
    wrap.appendChild(left);
    wrap.appendChild(right);
    left.appendChild(liveSection);

    const tableCard = document.createElement('div');
    tableCard.className = 'c9-card';
    tableCard.id = 'c9-table-card';
    tableCard.innerHTML = '<div id="c9-table-root"></div>';
    right.appendChild(tableCard);
  }

  function renderLiveList(list) {
    if (!rowsEl) return;
    const filter = (statusFilter?.value || 'NEW').toUpperCase();
    const shown = list.filter((x) => filter === 'ALL' ? true : String(x.status || 'NEW').toUpperCase() === filter);

    rowsEl.innerHTML = shown.map((x) => {
      const isReq = x.kind === 'request';
      const tableId = x.tableId ?? x.table ?? x.table_id ?? '';
      const id = x.id || x.key || '';
      const itemsHtml = isReq
        ? safe(String(x.type || '').toUpperCase() === 'PAY' ? 'Bezahlen' : 'Bedienung rufen')
        : summarizeItems(x.items);
      const sumHtml = isReq ? '—' : money(x.total ?? 0);
      const doneLabel = isReq ? 'Erledigt' : 'Erledigt';
      const extraBtns = isReq ? '' : `
        <button class="btn2" type="button" data-open-table="${safe(tableId)}">Tisch öffnen</button>
        <button class="btn2 danger" type="button" data-clear-table="${safe(tableId)}">Tisch leeren</button>`;
      return `
<tr>
  <td class="mono"><b>${safe(tableId)}</b></td>
  <td>
    <div style="font-weight:800">${itemsHtml}</div>
    <div class="small2 muted mono">${safe(id)}</div>
  </td>
  <td class="mono">${sumHtml}</td>
  <td>${statusPill(x.kind, x)}</td>
  <td>
    <div class="c9-live-row-actions">
      <button class="btn2 primary" type="button" data-kind="${isReq ? 'request' : 'order'}" data-done="${safe(id)}">${doneLabel}</button>
      <button class="btn2 danger" type="button" data-kind="${isReq ? 'request' : 'order'}" data-del="${safe(id)}">Löschen</button>
      ${extraBtns}
    </div>
  </td>
</tr>`;
    }).join('');

    if (emptyEl) emptyEl.style.display = shown.length ? 'none' : 'block';
  }

  function renderTablePanel() {
    buildLayout();
    const root = document.getElementById('c9-table-root');
    if (!root) return;

    const openTables = getOpenTables();
    if (!state.selectedTableId && openTables.length) state.selectedTableId = openTables[0].tableId;
    if (state.selectedTableId && !openTables.some((t) => Number(t.tableId) === Number(state.selectedTableId))) {
      state.selectedTableId = openTables.length ? openTables[0].tableId : null;
    }

    const tableId = state.selectedTableId;
    const rows = tableId ? aggregateTable(tableId) : [];
    const totals = tableId ? computeTableTotals(tableId) : { openTotal: 0, selectedTotal: 0, tableTotal: 0 };
    const selectedMap = tableId ? ensureSelectionTable(tableId) : {};

    const chipsHtml = openTables.length
      ? openTables.map((t) => `<button class="c9-chip ${Number(tableId) === Number(t.tableId) ? 'active' : ''}" data-table-chip="${t.tableId}">Tisch ${t.tableId} · ${t.count}</button>`).join('')
      : '<div class="c9-sub">Keine offenen Tische.</div>';

    const itemsHtml = tableId && rows.length ? rows.map((r) => {
      const openQty = Math.max(0, r.totalQty - r.doneQty);
      const selected = Math.max(0, Math.min(openQty, Math.trunc(Number(selectedMap[r.key]) || 0)));
      const selectedSum = selected * r.unitPrice;
      const rowCls = openQty === 0 && r.doneQty > 0 ? 'c9-item c9-done' : (r.doneQty > 0 ? 'c9-item c9-partial' : 'c9-item');
      const disabledAttr = openQty === 0 ? 'disabled' : '';
      return `
        <div class="${rowCls}">
          <div>
            <div class="c9-name">${safe(r.label)}</div>
            <div class="c9-meta">Offen: ${openQty} · Erledigt: ${r.doneQty} · Gesamt: ${r.totalQty}</div>
          </div>
          <div class="c9-col">
            <div class="c9-label">Einzelpreis</div>
            <div class="c9-value">${money(r.unitPrice)}</div>
          </div>
          <div class="c9-col">
            <div class="c9-label">Auswahl</div>
            <div class="c9-value">${money(selectedSum)}</div>
          </div>
          <div class="c9-qty">
            <button type="button" data-sel-minus="${safe(r.key)}" ${disabledAttr}>−</button>
            <input type="text" inputmode="numeric" value="${selected}" data-sel-input="${safe(r.key)}" ${disabledAttr}/>
            <button type="button" data-sel-plus="${safe(r.key)}" ${disabledAttr}>+</button>
          </div>
        </div>`;
    }).join('') : '<div class="c9-sub">Kein Tisch gewählt.</div>';

    const formHtml = tableId ? `
      <div class="c9-card" style="padding:12px;margin-top:12px">
        <div class="c9-title" style="font-size:16px;margin-bottom:6px">Manuell hinzufügen</div>
        <div class="c9-inlineform">
          <div>
            <label>Oberkategorie</label>
            <select id="c9-manual-cat"></select>
          </div>
          <div>
            <label>Produkt</label>
            <select id="c9-manual-item"></select>
          </div>
          <div>
            <label>Menge</label>
            <input id="c9-manual-qty" type="number" min="1" step="1" value="1" />
          </div>
          <div>
            <label>Einzelpreis</label>
            <input id="c9-manual-price" type="number" min="0" step="0.01" value="0" />
          </div>
          <div class="full c9-actions" style="margin-top:0">
            <button class="c9-btn primary" type="button" id="c9-manual-add-btn">Hinzubuchen</button>
          </div>
        </div>
      </div>` : '';

    root.innerHTML = `
      <div class="c9-title">Tische mit offenen Beträgen</div>
      <div class="c9-tablechips">${chipsHtml}</div>
      ${tableId ? `<div class="c9-title" style="font-size:28px;margin-bottom:0">Tisch ${tableId}</div>
        <div class="c9-sub">Hier werden offene und erledigte Positionen des Tisches für die Bezahlung zusammen angezeigt.</div>
        <div class="c9-totals">
          Offener Betrag: <b>${money(totals.openTotal)}</b><br>
          Ausgewählt: <b>${money(totals.selectedTotal)}</b><br>
          <span style="opacity:.85">Tisch komplett: ${money(totals.tableTotal)}</span>
        </div>
        <div class="c9-actions">
          <button class="c9-btn" type="button" id="c9-select-all">Alles auswählen</button>
          <button class="c9-btn primary" type="button" id="c9-mark-selected">Löschen</button>
          <button class="c9-btn danger" type="button" id="c9-clear-table">Tisch leeren</button>
        </div>
        <div class="c9-items">${itemsHtml}</div>
        ${formHtml}` : ''}
    `;

    root.querySelectorAll('[data-table-chip]').forEach((btn) => btn.addEventListener('click', () => {
      state.selectedTableId = Number(btn.getAttribute('data-table-chip'));
      renderTablePanel();
    }));

    if (!tableId) return;

    root.querySelectorAll('[data-sel-minus]').forEach((btn) => btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-sel-minus');
      const row = rows.find((x) => x.key === key);
      adjustSelected(tableId, key, -1, Math.max(0, row.totalQty - row.doneQty));
      renderTablePanel();
    }));
    root.querySelectorAll('[data-sel-plus]').forEach((btn) => btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-sel-plus');
      const row = rows.find((x) => x.key === key);
      adjustSelected(tableId, key, 1, Math.max(0, row.totalQty - row.doneQty));
      renderTablePanel();
    }));
    root.querySelectorAll('[data-sel-input]').forEach((inp) => inp.addEventListener('input', () => {
      const key = inp.getAttribute('data-sel-input');
      const row = rows.find((x) => x.key === key);
      setSelected(tableId, key, inp.value, Math.max(0, row.totalQty - row.doneQty));
      renderTablePanel();
    }));

    const selectAllBtn = document.getElementById('c9-select-all');
    if (selectAllBtn) selectAllBtn.addEventListener('click', () => {
      setAllSelected(tableId);
      renderTablePanel();
    });

    const markBtn = document.getElementById('c9-mark-selected');
    if (markBtn) markBtn.addEventListener('click', async () => {
      try {
        if (!state.pin && !localStorage.getItem(LS_PIN)) {
          errorEl.textContent = 'PIN fehlt. Bitte oben speichern.';
          return;
        }
        const picked = buildSelectionPayload(tableId);
        if (!picked.length) {
          toast('Nichts ausgewählt');
          return;
        }
        await actOrder({ action: 'partial_done', tableId, selections: picked });
        toast('Als erledigt markiert');
        state.selection[tableId] = {};
        await refreshOnce(true);
      } catch (e) {
        errorEl.textContent = String(e?.message || e);
      }
    });

    const clearBtn = document.getElementById('c9-clear-table');
    if (clearBtn) clearBtn.addEventListener('click', async () => {
      try {
        if (!state.pin && !localStorage.getItem(LS_PIN)) {
          errorEl.textContent = 'PIN fehlt. Bitte oben speichern.';
          return;
        }
        if (!confirm(`Tisch ${tableId} wirklich komplett leeren?`)) return;
        await actOrder({ action: 'table_clear', tableId });
        toast('Tisch geleert');
        state.selection[tableId] = {};
        await refreshOnce(true);
      } catch (e) {
        errorEl.textContent = String(e?.message || e);
      }
    });

    bindManualAdd(tableId);
  }

  function bindManualAdd(tableId) {
    const catSel = document.getElementById('c9-manual-cat');
    const itemSel = document.getElementById('c9-manual-item');
    const qtyInp = document.getElementById('c9-manual-qty');
    const priceInp = document.getElementById('c9-manual-price');
    const addBtn = document.getElementById('c9-manual-add-btn');
    if (!catSel || !itemSel || !qtyInp || !priceInp || !addBtn) return;

    const cats = Array.isArray(state.menu?.categories) ? state.menu.categories : [];
    catSel.innerHTML = cats.map((c) => `<option value="${safe(c.id)}">${safe(c.title || c.id)}</option>`).join('');

    const fillItems = () => {
      const cat = cats.find((c) => String(c.id) === String(catSel.value));
      const items = Array.isArray(cat?.items) ? cat.items : [];
      itemSel.innerHTML = items.map((it) => `<option value="${safe(it.id)}">${safe(it.name || it.id)}</option>`).join('');
      const first = items[0];
      if (first) priceInp.value = String(Number(first.price || 0).toFixed(2));
    };

    const syncPrice = () => {
      const cat = cats.find((c) => String(c.id) === String(catSel.value));
      const it = (Array.isArray(cat?.items) ? cat.items : []).find((x) => String(x.id) === String(itemSel.value));
      if (it) priceInp.value = String(Number(it.price || 0).toFixed(2));
    };

    catSel.addEventListener('change', fillItems);
    itemSel.addEventListener('change', syncPrice);
    fillItems();

    addBtn.addEventListener('click', async () => {
      try {
        const cat = cats.find((c) => String(c.id) === String(catSel.value));
        const it = (Array.isArray(cat?.items) ? cat.items : []).find((x) => String(x.id) === String(itemSel.value));
        if (!it) {
          toast('Produkt fehlt');
          return;
        }
        const qty = Math.max(1, Math.trunc(Number(qtyInp.value) || 1));
        const unitPrice = Math.max(0, Number(priceInp.value) || 0);
        await createManualOrder(tableId, it, qty, unitPrice);
        toast('Hinzugebucht');
        qtyInp.value = '1';
        await refreshOnce(true);
      } catch (e) {
        errorEl.textContent = String(e?.message || e);
      }
    });
  }

  async function refreshOnce(force) {
    try {
      if (errorEl) errorEl.textContent = '';
      const t0 = performance.now();
      const [ordersData, reqData] = await Promise.all([
        fetchJson(API_ORDERS),
        fetchJson(API_REQUESTS)
      ]);
      const ms = Math.round(performance.now() - t0);
      const orders = Array.isArray(ordersData.orders) ? ordersData.orders : [];
      const requests = Array.isArray(reqData.requests) ? reqData.requests : [];
      state.orders = orders;
      state.requests = requests;

      const merged = [
        ...requests.map((r) => ({ ...r, kind: 'request' })),
        ...orders.map((o) => ({ ...o, kind: 'order' }))
      ].sort((a, b) => Number(b.updatedAt || Date.parse(b.createdAt || 0) || 0) - Number(a.updatedAt || Date.parse(a.createdAt || 0) || 0));

      const currentKeys = new Set(merged.map((x) => x.id || x.key).filter(Boolean));
      let newCount = 0;
      for (const k of currentKeys) if (!state.lastKeys.has(k)) newCount++;
      if (newCount > 0 && !force) playBeep();
      state.lastKeys = currentKeys;

      if (metaEl) metaEl.textContent = `OK • o:${orders.length} • r:${requests.length} • ${ms} ms • ${nowClock()}`;
      renderLiveList(merged);
      renderTablePanel();
    } catch (e) {
      if (metaEl) metaEl.textContent = `ERR • ${nowClock()}`;
      if (errorEl) errorEl.textContent = String(e?.message || e);
      renderLiveList([]);
      renderTablePanel();
    }
  }

  function schedule() {
    if (state.timer) clearInterval(state.timer);
    if (!autoToggle || !autoToggle.checked) return;
    const sec = parseInt(autoEverySel?.value || '5', 10);
    state.timer = setInterval(() => refreshOnce(false), Math.max(1, sec) * 1000);
  }

  if (pinInput) pinInput.value = '';
  syncSoundBtn();
  if (savePinBtn) savePinBtn.addEventListener('click', () => {
    state.pin = (pinInput?.value || '').trim();
    localStorage.setItem(LS_PIN, state.pin);
    if (pinInput) pinInput.value = '';
    toast('PIN gespeichert');
    refreshOnce(true);
  });
  if (reloadBtn) reloadBtn.addEventListener('click', () => refreshOnce(true));
  if (soundBtn) soundBtn.addEventListener('click', () => {
    state.sound = !state.sound;
    localStorage.setItem(LS_SOUND, state.sound ? '1' : '0');
    syncSoundBtn();
    if (state.sound) playBeep();
  });
  if (autoToggle) autoToggle.addEventListener('change', schedule);
  if (autoEverySel) autoEverySel.addEventListener('change', schedule);
  if (statusFilter) statusFilter.addEventListener('change', () => refreshOnce(true));

  rowsEl?.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const keyDone = btn.getAttribute('data-done');
    const keyDel = btn.getAttribute('data-del');
    const openTable = btn.getAttribute('data-open-table');
    const clearTable = btn.getAttribute('data-clear-table');
    const kind = btn.getAttribute('data-kind') || 'order';

    try {
      if (errorEl) errorEl.textContent = '';
      if (openTable) {
        state.selectedTableId = Number(openTable);
        renderTablePanel();
        return;
      }
      if (clearTable) {
        if (!state.pin && !localStorage.getItem(LS_PIN)) {
          errorEl.textContent = 'PIN fehlt. Bitte oben speichern.';
          return;
        }
        if (!confirm(`Tisch ${clearTable} wirklich komplett leeren?`)) return;
        await actOrder({ action: 'table_clear', tableId: Number(clearTable) });
        toast('Tisch geleert');
        await refreshOnce(true);
        return;
      }
      if (keyDone) {
        if (!state.pin && !localStorage.getItem(LS_PIN)) {
          errorEl.textContent = 'PIN fehlt. Bitte oben speichern.';
          return;
        }
        if (kind === 'request') {
          await actRequest({ id: keyDone, action: 'done' });
          toast('Service erledigt');
        } else {
          await actOrder({ key: keyDone, status: 'DONE' });
          toast('Auf DONE gesetzt');
        }
        await refreshOnce(true);
        return;
      }
      if (keyDel) {
        if (!state.pin && !localStorage.getItem(LS_PIN)) {
          errorEl.textContent = 'PIN fehlt. Bitte oben speichern.';
          return;
        }
        const q = kind === 'request' ? 'Service-Eintrag wirklich löschen?' : 'Bestellung wirklich löschen?';
        if (!confirm(q)) return;
        if (kind === 'request') {
          await actRequest({ id: keyDel, action: 'delete' });
          toast('Service gelöscht');
        } else {
          await actOrder({ key: keyDel, action: 'delete' });
          toast('Gelöscht');
        }
        await refreshOnce(true);
      }
    } catch (e) {
      if (errorEl) errorEl.textContent = String(e?.message || e);
    }
  });

  if (hintEl) hintEl.style.display = 'block';
  if (emptyEl) emptyEl.style.display = 'block';
  loadMenu().finally(() => {
    refreshOnce(true);
    schedule();
  });
})();
