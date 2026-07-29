// Edge Function: notify-exposicion-vendida
// Recibe aviso desde Apps Script de la planilla de stock cuando un auto en exposición
// (salón ENTRE RIOS o INDEPENDENCIA) pasa de #N/A a "vendido" en columna G.
// Envía template Meta `auto_exposicion_vendido` (es_AR) a 3 destinatarios:
// fngonzalez, dlopez (vía tasador_usuarios) + Juan Marquevich (hardcoded).

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "auto_exposicion_vendido";

const JUAN_MARQUEVICH = {
  nombre: "Juan Marquevich",
  telefono_wa: "5491133819961",
};

const USERNAMES_DESTINATARIOS = ["fngonzalez", "dlopez"];

// Ventana temporal: mientras Fer esta de viaje (29/07/2026 -> 08/08/2026 inclusive)
// los avisos le llegan tambien al padre. Vence solo: pasada esa fecha vuelve a la
// lista de arriba sin necesidad de redeployar. 2026-08-09T03:00Z = 09/08 00:00 ART.
const VENTANA_EXTRA_HASTA = Date.parse("2026-08-09T03:00:00Z");
const VENTANA_EXTRA_USUARIOS = ["fgonzalez"];
function destinatariosVigentes(): string[] {
  return Date.now() < VENTANA_EXTRA_HASTA
    ? [...USERNAMES_DESTINATARIOS, ...VENTANA_EXTRA_USUARIOS]
    : USERNAMES_DESTINATARIOS;
}

const SALONES_VALIDOS = new Set(["ENTRE RIOS", "INDEPENDENCIA"]);

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

  const serie = String(body?.serie || "").trim();
  const unidad = String(body?.unidad || "").trim();
  const color = String(body?.color || "").trim();
  const salon = String(body?.salon || "").trim().toUpperCase();

  if (!serie) return json({ error: "serie requerida" }, 400);
  if (!unidad) return json({ error: "unidad requerida" }, 400);
  if (!SALONES_VALIDOS.has(salon)) return json({ error: "salón inválido (debe ser ENTRE RIOS o INDEPENDENCIA)" }, 400);

  // Resolver destinatarios desde tasador_usuarios
  const usernamesCsv = destinatariosVigentes().map((u) => `"${u}"`).join(",");
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

  const destinatarios: Array<{ nombre: string; telefono_wa: string; usuario?: string }> = [];
  for (const u of users || []) {
    if (u.activo === false) continue;
    if (u.notificaciones_wa === false) continue;
    if (!u.telefono_wa || String(u.telefono_wa).trim().length === 0) continue;
    destinatarios.push({ nombre: u.nombre || u.usuario, telefono_wa: u.telefono_wa, usuario: u.usuario });
  }
  destinatarios.push(JUAN_MARQUEVICH);

  // Variables del template: {{1}} unidad, {{2}} color, {{3}} salón
  const colorFinal = color || "—";
  const vars = [unidad, colorFinal, salon];

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
        headers: {
          "Authorization": `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
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

  return json({ serie, unidad, salon, enviados: enviados.length, errores, detalle_enviados: enviados });
});

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sb(url: string, key: string, path: string, options: RequestInit = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${res.status}: ${t}`);
  }
  return res.json();
}
