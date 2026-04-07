// Cloud9 Orders API (D1)
// Endpoint: POST /api/order
// Expects JSON: { tableId:number, items:[{id,name?,qty,options?}], note?:string, total?:number }
// Persists order into D1 table "orders"

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  if (!env.DB) {
    return json({ ok: false, error: "DB missing" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const tableId = toInt(body.tableId, 0);
  const items = Array.isArray(body.items) ? body.items : [];
  const note = (body.note ?? "").toString().slice(0, 1000);
  const total = typeof body.total === "number" ? body.total : 0;

  if (!tableId || items.length === 0) {
    return json({ ok: false, error: "missing_fields" }, 400);
  }

  const id = crypto.randomUUID();
  const nowMs = Date.now();
  const key = `order:${nowMs}:${id}`;
  const createdAt = new Date(nowMs).toISOString();
  const updatedAt = nowMs;
  const status = "NEW";

  const safeItems = items.map((it) => ({
    id: (it?.id ?? "").toString().slice(0, 80),
    name: (it?.name ?? "").toString().slice(0, 120),
    qty: toInt(it?.qty, 1),
    options: it?.options && typeof it.options === "object" ? it.options : {},
    unitPrice: typeof it?.unitPrice === "number" ? it.unitPrice : 0,
  }));

  try {
    await env.DB.prepare(
      `INSERT INTO orders (id, tableId, items, note, total, status, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
      .bind(
        id,
        tableId,
        JSON.stringify(safeItems),
        note,
        total,
        status,
        createdAt,
        updatedAt
      )
      .run();

    return json({ ok: true, key, id });
  } catch (e) {
    return json({ ok: false, error: "db_error", message: String(e?.message || e) }, 500);
  }
}

function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
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
