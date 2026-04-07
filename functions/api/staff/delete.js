function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function unauthorized() {
  return json({ ok: false, error: "Unauthorized" }, 401);
}

function checkAuth(request, env) {
  const pin = env.ADMIN_PIN || "";
  const auth = request.headers.get("Authorization") || "";
  if (!pin) return false;
  return auth === `Bearer ${pin}`;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ORDERS_KV) return json({ ok: false, error: "ORDERS_KV missing" }, 500);
  if (!checkAuth(request, env)) return unauthorized();

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok:false, error:"Invalid JSON" }, 400); }

  const key = String(body.key || "");
  if (!key.startsWith("order:")) return json({ ok:false, error:"Bad key" }, 400);

  await env.ORDERS_KV.delete(key);
  return json({ ok:true });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    },
  });
}
