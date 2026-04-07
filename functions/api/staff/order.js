// Cloud9 Staff - update/delete order (D1)
// Endpoint: POST /api/staff/order
// Header: Authorization: Bearer <PIN>
// Supports:
//   { "key":"order:...:id", "status":"DONE" }    -> set whole row DONE
//   { "key":"order:...:id", "status":"NEW" }     -> set whole row NEW
//   { "key":"order:...:id", "action":"delete" }  -> delete one row
//   { "action":"table_clear", "tableId":15 }     -> delete all rows for a table
//   { "action":"partial_done", "tableId":15, "selections":[
//       { "orderKey":"order:...:id", "itemIndex":0, "qty":2 }
//     ] } -> mark selected quantities as done inside items JSON

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!env.DB) {
    return json({ ok: false, error: "DB missing" }, 500);
  }

  if (!isAuthorized(request, env.ADMIN_PIN)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const action = String(body.action || "").toLowerCase();
  const status = String(body.status || "").toUpperCase();
  const nowMs = Date.now();

  try {
    if (action === "table_clear") {
      const tableId = toInt(body.tableId, 0);
      if (!tableId) return json({ ok: false, error: "bad_table" }, 400);

      await env.DB.prepare(`DELETE FROM orders WHERE tableId = ?1`).bind(tableId).run();
      return json({ ok: true, action: "table_clear", tableId });
    }

    if (action === "partial_done") {
      const selections = Array.isArray(body.selections) ? body.selections : [];
      if (!selections.length) return json({ ok: false, error: "missing_selections" }, 400);

      const grouped = new Map();
      for (const sel of selections) {
        const id = extractIdFromKey(String(sel.orderKey || sel.key || ""));
        const itemIndex = toInt(sel.itemIndex, -1);
        const qty = Math.max(0, toInt(sel.qty, 0));
        if (!id || itemIndex < 0 || qty <= 0) continue;
        if (!grouped.has(id)) grouped.set(id, []);
        grouped.get(id).push({ itemIndex, qty });
      }
      if (!grouped.size) return json({ ok: false, error: "bad_selections" }, 400);

      for (const [id, picks] of grouped.entries()) {
        const row = await env.DB.prepare(
          `SELECT items FROM orders WHERE id = ?1`
        ).bind(id).first();

        if (!row) continue;

        let items = [];
        try { items = JSON.parse(row.items || "[]"); } catch { items = []; }
        if (!Array.isArray(items)) items = [];

        for (const pick of picks) {
          const it = items[pick.itemIndex];
          if (!it) continue;
          const qty = Math.max(0, toInt(it.qty, 0));
          const done = Math.max(0, toInt(it.done, 0));
          it.done = Math.max(0, Math.min(qty, done + pick.qty));
        }

        const allDone = items.length > 0 && items.every((it) => {
          const qty = Math.max(0, toInt(it?.qty, 0));
          const done = Math.max(0, toInt(it?.done, 0));
          return done >= qty;
        });

        await env.DB.prepare(
          `UPDATE orders
             SET items = ?1,
                 status = ?2,
                 updatedAt = ?3
           WHERE id = ?4`
        ).bind(JSON.stringify(items), allDone ? "DONE" : "NEW", nowMs, id).run();
      }

      return json({ ok: true, action: "partial_done" });
    }

    const key = (body.key ?? "").toString();
    const id = extractIdFromKey(key);
    if (!id) return json({ ok: false, error: "bad_key" }, 400);

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
      "cache-control": "no-store",
    },
  });
}
