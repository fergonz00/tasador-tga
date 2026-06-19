// Edge Function: notify-exposicion-reemplazo
// Avisa cuando se repone un auto de exposición vendido por otro.
// Envía template Meta `exposicion_reemplazo` (es_AR, 4 variables) a:
// fngonzalez, dlopez (vía tasador_usuarios) + Juan Marquevich (hardcoded).
// Variables: {{1}} salón, {{2}} unidad vendida, {{3}} unidad nueva, {{4}} serie nueva.

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "exposicion_reemplazo";

const JUAN_MARQUEVICH = {
  nombre: "Juan Marquevich",
  telefono_wa: "5491133819961",
};

const USERNAMES_DESTINATARIOS = ["fngonzalez", "dlopez"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-stock-secret",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const WA_PHONE_ID = Deno.env.get("WA_TASADOR_PHONE_ID");
  const WA_TOKEN = Deno.env.get("WA_TASADOR_TOKEN");
  const STOCK_SECRET = Deno.env.get("STOCK_NOTIF_SECRET");

  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "SUPABASE env vars missing" }, 500);
  if (!WA_PHONE_ID || !WA_TOKEN) return json({ error: "WA_TASADOR env vars missing" }, 500);
  if (!STOCK_SECRET) return json({ error: "STOCK_NOTIF_SECRET missing" }, 500);

  const reqSecret = req.headers.get("x-stock-secret");
  if (reqSecret !== STOCK_SECRET) return json({ error: "secret inválido" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  const salon = String(body?.salon || "").trim();
  const unidadVendida = String(body?.unidadVendida || "").trim();
  const unidadNueva = String(body?.unidadNueva || "").trim();
  const serieNueva = String(body?.serieNueva || "").trim();

  if (!salon || !unidadVendida || !unidadNueva || !serieNueva) {
    return json({ error: "faltan campos (salon, unidadVendida, unidadNueva, serieNueva)" }, 400);
  }

  // Destinatarios desde tasador_usuarios
  const usernamesCsv = USERNAMES_DESTINATARIOS.map((u) => `"${u}"`).join(",");
  let users: any[] = [];
  try {
    users = await sb(
      SUPABASE_URL,
      SERVICE_KEY,
      `tasador_usuarios?usuario=in.(${usernamesCsv})&select=id,nombre,usuario,telefono_wa,notificaciones_wa,activo`,
    );
  } catch (e) {
    return json({ error: "Error leyendo Supabase", detalle: String(e) }, 500);
  }

  const destinatarios: Array<{ nombre: string; telefono_wa: string }> = [];
  for (const u of users || []) {
    if (u.activo === false) continue;
    if (u.notificaciones_wa === false) continue;
    if (!u.telefono_wa || String(u.telefono_wa).trim().length === 0) continue;
    destinatarios.push({ nombre: u.nombre || u.usuario, telefono_wa: u.telefono_wa });
  }
  destinatarios.push(JUAN_MARQUEVICH);

  const vars = [salon, unidadVendida, unidadNueva, serieNueva];
  const enviados: any[] = [];
  const errores: any[] = [];

  for (const dest of destinatarios) {
    const telE164 = String(dest.telefono_wa).replace(/^\+/, "").replace(/\s|-/g, "");
    const payload = {
      messaging_product: "whatsapp",
      to: telE164,
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        language: { code: META_LANGUAGE },
        components: [{
          type: "body",
          parameters: vars.map((v) => ({ type: "text", text: String(v) })),
        }],
      },
    };
    try {
      const metaRes = await fetch(`${META_API_URL}/${WA_PHONE_ID}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const metaJson = await metaRes.json();
      if (metaRes.ok && metaJson.messages && metaJson.messages[0]) {
        enviados.push({ destinatario: dest.nombre, meta_id: metaJson.messages[0].id });
      } else {
        errores.push({ destinatario: dest.nombre, error: metaJson.error || metaJson });
      }
    } catch (e) {
      errores.push({ destinatario: dest.nombre, error: String(e) });
    }
  }

  return json({ salon, serieNueva, enviados: enviados.length, errores, detalle_enviados: enviados });
});

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sb(url: string, key: string, path: string) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}
