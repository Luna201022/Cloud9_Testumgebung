export async function onRequestGet({ env }) {
  const data = await env.MENU_KV.get("menu.de.json");
  return new Response(data || "null", {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}