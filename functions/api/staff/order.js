// Cloud9 Staff - update/delete order (D1)
// Endpoint: POST /api/staff/order
// Header: Authorization: Bearer <PIN>
// Body:
//   { "key":"order:...:id", "status":"DONE" }   -> set DONE
//   { "key":"order:...:id", "status":"NEW" }    -> set NEW
//   { "key":"order:...:id", "action":"delete" } -> delete row

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

  const key = (body.key ?? "").toString();
  const id = extractIdFromKey(key);
  if (!id) return json({ ok: false, error: "bad_key" }, 400);

  const action = (body.action ?? "").toString().toLowerCase();
  const status = (body.status ?? "").toString().toUpperCase();
  const nowMs = Date.now();

  try {
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
