// Cloud9 Staff - update/delete order (D1)
// Endpoint: POST /api/staff/order
// Header: Authorization: Bearer <PIN>
//
// Legacy:
//   { "key":"order:...:id", "status":"DONE" }   -> set whole order DONE
//   { "key":"order:...:id", "status":"NEW" }    -> set whole order NEW
//   { "key":"order:...:id", "action":"delete" } -> delete row
//
// New:
//   { "action":"partial_done", "ops":[{ "key":"order:...:id", "itemIndex":0, "qty":1 }] }
//   { "action":"clear_table", "tableId": 12 }

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!env.DB) {
    return json({ ok: false, error: "DB missing" }, 500);
  }

  const pinOk = isAuthorized(request, env.ADMIN_PIN);
  if (!pinOk) return json({ ok: false, error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const action = (body.action ?? "").toString().toLowerCase();
  const nowMs = Date.now();

  try {
    if (action === "clear_table") {
      const tableId = toInt(body.tableId, 0);
      if (!tableId) return json({ ok: false, error: "bad_table" }, 400);

      const del = await env.DB.prepare(`DELETE FROM orders WHERE tableId = ?1`).bind(tableId).run();
      return json({ ok: true, action: "clear_table", tableId, deleted: del?.meta?.changes ?? 0 });
    }

    if (action === "partial_done") {
      const opsRaw = Array.isArray(body.ops) ? body.ops : [];
      if (!opsRaw.length) return json({ ok: false, error: "missing_ops" }, 400);

      const grouped = new Map();
      for (const raw of opsRaw) {
        const key = (raw?.key ?? "").toString();
        const id = extractIdFromKey(key);
        const itemIndex = toInt(raw?.itemIndex, -1);
        const qty = Math.max(0, toInt(raw?.qty, 0));
        if (!id || itemIndex < 0 || qty <= 0) continue;

        const arr = grouped.get(id) || [];
        arr.push({ itemIndex, qty });
        grouped.set(id, arr);
      }

      if (!grouped.size) return json({ ok: false, error: "bad_ops" }, 400);

      let touched = 0;

      for (const [id, ops] of grouped.entries()) {
        const row = await env.DB.prepare(`SELECT id, items FROM orders WHERE id = ?1`).bind(id).first();
        if (!row || !row.items) continue;

        const items = safeJsonParse(row.items, []);
        if (!Array.isArray(items)) continue;

        let changed = false;

        for (const op of ops) {
          const it = items[op.itemIndex];
          if (!it) continue;

          const qty = Math.max(0, toInt(it.qty ?? it.quantity, 1));
          const done = Math.max(0, Math.min(qty, toInt(it.done, 0)));
          const open = Math.max(0, qty - done);
          if (!open) continue;

          const take = Math.min(open, op.qty);
          if (take <= 0) continue;

          it.done = done + take;
          changed = true;
        }

        if (!changed) continue;

        const normalized = items.map((it) => normalizeItem(it));
        const status = normalized.every((it) => it.done >= it.qty) ? "DONE" : "NEW";

        await env.DB.prepare(
          `UPDATE orders
             SET items = ?1,
                 status = ?2,
                 updatedAt = ?3
           WHERE id = ?4`
        ).bind(JSON.stringify(normalized), status, nowMs, id).run();

        touched++;
      }

      return json({ ok: true, action: "partial_done", touched });
    }

    const key = (body.key ?? "").toString();
    const id = extractIdFromKey(key);
    if (!id) return json({ ok: false, error: "bad_key" }, 400);

    const status = (body.status ?? "").toString().toUpperCase();

    if (action === "delete") {
      const del = await env.DB.prepare(`DELETE FROM orders WHERE id = ?1`).bind(id).run();
      const changed = del?.meta?.changes ?? 0;
      if (!changed) return json({ ok: false, error: "not_found" }, 404);
      return json({ ok: true, action: "delete", key });
    }

    if (!["NEW", "DONE"].includes(status)) {
      return json({ ok: false, error: "bad_status" }, 400);
    }

    const upd = await env.DB.prepare(
      `UPDATE orders SET status = ?1, updatedAt = ?2 WHERE id = ?3`
    ).bind(status, nowMs, id).run();

    const changed = upd?.meta?.changes ?? 0;
    if (!changed) return json({ ok: false, error: "not_found" }, 404);

    return json({ ok: true, action: "status", key, status });
  } catch (e) {
    return json({ ok: false, error: "db_error", message: String(e?.message || e) }, 500);
  }
}

function normalizeItem(it) {
  const qty = Math.max(0, toInt(it?.qty ?? it?.quantity, 1));
  const done = Math.max(0, Math.min(qty, toInt(it?.done, 0)));
  return {
    id: (it?.id ?? "").toString().slice(0, 80),
    name: (it?.name ?? "").toString().slice(0, 120),
    qty,
    done,
    options: it?.options && typeof it.options === "object" ? it.options : {},
    unitPrice: typeof it?.unitPrice === "number" ? it.unitPrice : Number(it?.unitPrice || 0)
  };
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function extractIdFromKey(key) {
  if (!key) return "";
  const parts = key.split(":");
  return parts.length >= 3 ? parts.slice(-1)[0] : key;
}

function isAuthorized(request, pin) {
  if (!pin) return false;
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!m && m[1] === String(pin);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
