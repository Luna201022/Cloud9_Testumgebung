/* Cloud9 Staff (Orders + Service Requests)
 * Lists:
 *  - GET /api/orders        -> { ok:true, orders:[...] }
 *  - GET /api/requests      -> { ok:true, requests:[...] }
 * Actions (Admin PIN via Bearer):
 *  - POST /api/staff/order  -> { key, status:"DONE" } or { key, action:"delete" }
 *  - POST /api/staff/request-> { id, action:"done"|"delete" }
 */

(function () {
  "use strict";

  const API_ORDERS = "/api/orders";
  const API_REQUESTS = "/api/requests";
  const API_ACT_ORDER = "/api/staff/order";
  const API_ACT_REQ = "/api/staff/request";

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
    lastCounts: { orders: 0, requests: 0 }
  };

  // -------- utils
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

  function summarizeItems(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    return items.map((it) => {
      const qty = Number.isFinite(+it?.qty) ? Math.trunc(+it.qty) : (Number.isFinite(+it?.quantity) ? Math.trunc(+it.quantity) : 1);
      const name = it?.name || it?.id || "Artikel";
      const opt = (it?.options && typeof it.options === "object")
        ? Object.values(it.options).filter(Boolean).join(", ")
        : "";
      const line = `${qty}\u00d7 ${name}${opt ? " (" + opt + ")" : ""}`;
      return safe(line);
    }).join("<br>");
  }

  function money(n) {
    try { return (Number(n) || 0).toFixed(2).replace(".", ",") + " \u20ac"; }
    catch { return "0,00 \u20ac"; }
  }

  function statusPill(kind, obj) {
    // kind: order/request
    let label = (obj?.status || "NEW").toUpperCase();
    if (kind === "request") label = String(obj?.type || label).toUpperCase(); // CALL / PAY
    const cls = (obj?.status || "NEW").toUpperCase() === "DONE" ? "pill done" : "pill new";
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

  // -------- UI init
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
      // refresh immediately
      refreshOnce(true);
    });
  }

  if (reloadBtn) reloadBtn.addEventListener("click", () => refreshOnce(true));

  if (soundBtn) {
    soundBtn.addEventListener("click", () => {
      state.sound = !state.sound;
      localStorage.setItem(LS_SOUND, state.sound ? "1" : "0");
      syncSoundBtn();
      if (state.sound) playBeep(); // unlock hint
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

  // -------- actions
  async function actOrder(payload) {
    return fetchJson(API_ACT_ORDER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, true);
  }
  async function actRequest(payload) {
    return fetchJson(API_ACT_REQ, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, true);
  }

  rowsEl?.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;

    const keyDone = btn.getAttribute("data-done");
    const keyDel = btn.getAttribute("data-del");
    const kind = btn.getAttribute("data-kind") || "order";

    try {
      errorEl.textContent = "";

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

  // -------- render
  function render(list) {
    if (!rowsEl) return;

    const filter = (statusFilter?.value || "NEW").toUpperCase();
    const shown = list.filter((x) => {
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

      const doneLabel = isReq ? "Erledigt" : "Gesendet";

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
    <button class="btn2 primary" type="button" data-kind="${isReq ? "request" : "order"}" data-done="${safe(id)}">${doneLabel}</button>
    <button class="btn2 danger" type="button" data-kind="${isReq ? "request" : "order"}" data-del="${safe(id)}">Löschen</button>
  </td>
</tr>`;
    }).join("");

    if (emptyEl) emptyEl.style.display = shown.length ? "none" : "block";
  }

  // -------- refresh
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

      const merged = [
        ...requests.map((r) => ({ ...r, kind: "request" })),
        ...orders.map((o) => ({ ...o, kind: "order" }))
      ].sort((a, b) => {
        const ta = Number(a.updatedAt ?? Date.parse(a.createdAt || 0) ?? 0);
        const tb = Number(b.updatedAt ?? Date.parse(b.createdAt || 0) ?? 0);
        return tb - ta;
      });

      // sound on new keys
      const currentKeys = new Set(merged.map((x) => x.id || x.key).filter(Boolean));
      let newCount = 0;
      for (const k of currentKeys) if (!state.lastKeys.has(k)) newCount++;
      if (newCount > 0 && !force) playBeep();
      state.lastKeys = currentKeys;

      state.lastOk = true;
      state.lastMs = ms;
      state.lastAt = new Date();
      state.lastCounts = { orders: orders.length, requests: requests.length };

      // meta line
      if (metaEl) {
        const ok = "OK";
        metaEl.textContent = `${ok} \u2022 o:${orders.length} \u2022 r:${requests.length} \u2022 ${ms} ms \u2022 ${nowClock()}`;
      }

      render(merged);
    } catch (e) {
      state.lastOk = false;
      if (metaEl) metaEl.textContent = `ERR \u2022 ${nowClock()}`;
      errorEl.textContent = String(e?.message || e);
      render([]); // don't keep stale if broken
    }
  }

  // initial
  hintEl && (hintEl.style.display = "block");
  emptyEl && (emptyEl.style.display = "block");
  refreshOnce(true);
  schedule();

})();