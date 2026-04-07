// Cloud9 Staff - list orders (D1)
// Endpoint: GET /api/staff/orders
// Header: Authorization: Bearer <PIN>

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.DB) {
    return json({ ok: false, error: "DB missing" }, 500);
  }

  const pinOk = isAuthorized(request, env.ADMIN_PIN);
  if (!pinOk) return json({ ok: false, error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const tableId = url.searchParams.get("tableId");
  const status = url.searchParams.get("status");

  const where = [];
  const binds = [];

  if (tableId && /^\d+$/.test(tableId)) {
    where.push("tableId = ?"); binds.push(Number(tableId));
  }
  if (status && ["NEW", "DONE"].includes(status.toUpperCase())) {
    where.push("status = ?"); binds.push(status.toUpperCase());
  }

  const whereSql = where.length ? ("WHERE " + where.join(" AND ")) : "";
  const sql = `SELECT id, tableId, items, note, total, status, createdAt, updatedAt
               FROM orders
               ${whereSql}
               ORDER BY createdAt DESC
               LIMIT 200`;

  try {
    const stmt = env.DB.prepare(sql);
    const res = binds.length ? await stmt.bind(...binds).all() : await stmt.all();
    const rows = Array.isArray(res.results) ? res.results : [];

    const orders = rows.map((r) => ({
      key: `order:${Date.parse(r.createdAt || new Date().toISOString()) || Date.now()}:${r.id}`,
      id: r.id,
      tableId: r.tableId,
      items: safeJsonParse(r.items, []),
      note: r.note || "",
      total: typeof r.total === "number" ? r.total : Number(r.total || 0),
      status: r.status || "NEW",
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    return json({ ok: true, count: orders.length, orders });
  } catch (e) {
    return json({ ok: false, error: "db_error", message: String(e?.message || e) }, 500);
  }
}

function isAuthorized(request, pin) {
  if (!pin) return false;
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!m && m[1] === String(pin);
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
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
