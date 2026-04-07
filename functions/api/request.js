// Cloud9 Service Request API (D1)
// Endpoint: POST /api/request
// Expects JSON: { tableId:number|string, type:"CALL"|"PAY", note?:string }
// Persists into D1 table "service_requests"
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return json({ ok:false, error:"method_not_allowed" }, 405);
  if (!env.DB) return json({ ok:false, error:"DB missing" }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ ok:false, error:"invalid_json" }, 400); }

  const tableId = toInt(body.tableId, 0);
  const type = String(body.type || "").toUpperCase();
  const note = (body.note ?? "").toString().slice(0, 500);

  if (!tableId || (type !== "CALL" && type !== "PAY")) {
    return json({ ok:false, error:"missing_fields" }, 400);
  }

  const id = crypto.randomUUID();
  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const updatedAt = nowMs;
  const status = "NEW";

  try {
    await env.DB.prepare(
      `INSERT INTO service_requests (id, tableId, type, note, status, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(id, tableId, type, note, status, createdAt, updatedAt).run();

    return json({ ok:true, id });
  } catch (e) {
    return json({ ok:false, error:"db_error", message:String(e?.message || e) }, 500);
  }
}

function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control":"no-store" }
  });
}
