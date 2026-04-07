// Cloud9 Staff Service Request Actions (D1)
// Endpoint: POST /api/staff/request
// Auth: Authorization: Bearer <PIN> must match env.ADMIN_PIN
// Body: { id: string, action: "done" | "delete" }

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

function readBearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
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

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const pin = readBearer(request);
  if (!pin || pin !== env.ADMIN_PIN) return unauthorized();

  if (!env.DB) return json({ ok: false, error: "DB missing" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const id = String(body.id || "").trim();
  const action = String(body.action || "").toLowerCase();

  if (!id) return json({ ok: false, error: "missing_id" }, 400);
  if (action !== "done" && action !== "delete") return json({ ok: false, error: "bad_action" }, 400);

  try {
    if (action === "delete") {
      await env.DB.prepare(`DELETE FROM service_requests WHERE id=?1`).bind(id).run();
      return json({ ok: true });
    } else {
      await env.DB.prepare(
        `UPDATE service_requests SET status='DONE', updatedAt=?2 WHERE id=?1`
      ).bind(id, Date.now()).run();
      return json({ ok: true });
    }
  } catch (e) {
    return json({ ok: false, error: "db_error", message: String(e?.message || e) }, 500);
  }
}
