function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

function readBearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export async function onRequestGet({ request, env }) {
  const pin = readBearer(request);
  if (!pin || pin !== env.ADMIN_PIN) return unauthorized();

  const data = await env.MENU_KV.get("menu.de.json");
  return new Response(data || "null", {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export async function onRequestPut({ request, env }) {
  const pin = readBearer(request);
  if (!pin || pin !== env.ADMIN_PIN) return unauthorized();

  const text = await request.text();

  try {
    JSON.parse(text);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  await env.MENU_KV.put("menu.de.json", text);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
