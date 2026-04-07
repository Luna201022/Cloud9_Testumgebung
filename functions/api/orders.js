// Cloud9 Orders API (D1)
// Endpoint: GET /api/orders
// Returns: { ok:true, orders:[...] }

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  if (!env.DB) {
    return json({ ok: false, error: "DB missing" }, 500);
  }

  // Optional filters: ?status=NEW or ?tableId=3
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") || "").toUpperCase();
  const tableId = url.searchParams.get("tableId");

  try {
    let stmt = `
      SELECT id, tableId, items, note, total, status, createdAt, updatedAt
      FROM orders
    `;
    const binds = [];

    const where = [];
    if (status) {
      where.push("status = ?1");
      binds.push(status);
    }
    if (tableId && Number.isFinite(Number(tableId))) {
      where.push(`tableId = ?${binds.length + 1}`);
      binds.push(Math.trunc(Number(tableId)));
    }
    if (where.length) stmt += " WHERE " + where.join(" AND ");

    stmt += " ORDER BY updatedAt DESC LIMIT 200";

    const res = await env.DB.prepare(stmt).bind(...binds).all();

    const orders = (res.results || []).map((r) => ({
      ...r,
      items: safeJson(r.items),
    }));

    return json({ ok: true, orders });
  } catch (e) {
    return json({ ok: false, error: "db_error", message: String(e?.message || e) }, 500);
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
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