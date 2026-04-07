// POST /api/request_done
// Body: { id: "uuid" }

export async function onRequest({ request, env }) {
  if (request.method !== "POST")
    return json({ ok: false }, 405);

  if (!env.DB)
    return json({ ok: false, error: "DB missing" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const id = String(body.id || "");
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  try {
    await env.DB.prepare(
      `UPDATE service_requests
       SET status='DONE', updatedAt=?2
       WHERE id=?1`
    ).bind(id, Date.now()).run();

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}