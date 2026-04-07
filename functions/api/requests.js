// Cloud9 Service Requests API (D1)
// Endpoint: GET /api/requests
// Returns: { ok:true, requests:[...] }
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") return json({ ok:false, error:"method_not_allowed" }, 405);
  if (!env.DB) return json({ ok:false, error:"DB missing" }, 500);

  try {
    const res = await env.DB.prepare(
      `SELECT id, tableId, type, note, status, createdAt, updatedAt
       FROM service_requests
       WHERE status != 'DONE'
       ORDER BY updatedAt DESC
       LIMIT 200`
    ).all();

    return json({ ok:true, requests: res.results || [] });
  } catch (e) {
    return json({ ok:false, error:"db_error", message:String(e?.message || e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control":"no-store" }
  });
}
