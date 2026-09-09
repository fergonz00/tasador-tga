// Edge Function: notify-sircreb-pendiente
// La dispara el cron diario del portal-precios (/api/cron/sircreb) cuando el
// SIRCREB del mes en curso todavia no se cargo en `costos_financieros_mes`.
//
// Ese numero lo pasa Valeria Reyna a principio de mes y es lo que define cuanto
// cuesta que un cliente pague por transferencia (0,6% entrada + 0,6% salida +
// SIRCREB). Sin el cargado, la consulta de precio sigue calculando con el mes
// anterior y muestra el cartel de desactualizado; este aviso es para que ese
// estado no dure todo el mes.
//
// - Autenticacion: header x-stock-secret == STOCK_NOTIF_SECRET (el mismo que ya
//   usan notify-ml-desactualizado / notify-precios-actualizados).
// - Destinatarios: SIRCREB_DESTINATARIOS (env, default fngonzalez), activos y
//   con telefono_wa. Dedup por telefono.
// - Template Meta: `precios_actualizados` (es_AR), que ya esta aprobado y tiene
//   una sola variable {{1}}: ahi va el aviso entero. Es el mismo recurso que usa
//   notify-ml-desactualizado como respaldo, asi no hay que esperar aprobacion de
//   un template nuevo para que esto funcione.

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "precios_actualizados";

const DESTINATARIOS_DEFAULT = "fngonzalez";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info, x-stock-secret",
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
  if (req.headers.get("x-stock-secret") !== STOCK_SECRET) {
    return json({ error: "secret inválido" }, 401);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* body opcional */ }

  const texto = String(body?.texto ?? "").replace(/\s+/g, " ").trim();
  if (!texto) return json({ error: "falta texto" }, 400);

  // Prueba a un numero puntual sin tocar la lista de destinatarios.
  const solo = String(body?.solo || "").trim() || null;
  if (solo) {
    const tel = solo.replace(/^\+/, "").replace(/\s|-/g, "");
    const r = await postMeta(WA_PHONE_ID, WA_TOKEN, tel, [recortar(texto, 900)]);
    return json({ prueba: true, destino: tel, enviados: r.ok ? 1 : 0, ...r });
  }

  const permitidos = (Deno.env.get("SIRCREB_DESTINATARIOS") ?? DESTINATARIOS_DEFAULT)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  let users: any[] = [];
  try {
    users = await sb(
      SUPABASE_URL,
      SERVICE_KEY,
      "tasador_usuarios?activo=eq.true&telefono_wa=not.is.null&select=nombre,usuario,telefono_wa",
    );
  } catch (e) {
    return json({ error: "Error leyendo Supabase", detalle: String(e) }, 500);
  }

  const destinatarios: Array<{ nombre: string; tel: string }> = [];
  const vistos = new Set<string>();
  for (const u of users || []) {
    if (!permitidos.includes(String(u.usuario || "").toLowerCase())) continue;
    const tel = String(u.telefono_wa || "").replace(/^\+/, "").replace(/\s|-/g, "");
    if (!tel || vistos.has(tel)) continue;
    vistos.add(tel);
    destinatarios.push({ nombre: u.nombre || u.usuario || "", tel });
  }
  if (destinatarios.length === 0) {
    return json({ enviados: 0, errores: [], detalle: "sin destinatarios" });
  }

  const enviados: any[] = [];
  const errores: any[] = [];
  for (const d of destinatarios) {
    const r = await postMeta(WA_PHONE_ID, WA_TOKEN, d.tel, [recortar(texto, 900)]);
    if (r.ok) enviados.push({ destinatario: d.nombre, meta_id: r.meta_id });
    else errores.push({ destinatario: d.nombre, error: r.error });
  }
  return json({ enviados: enviados.length, errores, detalle_enviados: enviados });
});

async function postMeta(phoneId: string, token: string, tel: string, params: string[]) {
  const payload = {
    messaging_product: "whatsapp",
    to: tel,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: META_LANGUAGE },
      components: [{
        type: "body",
        parameters: params.map((text) => ({ type: "text", text })),
      }],
    },
  };
  try {
    const res = await fetch(`${META_API_URL}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (res.ok && j.messages && j.messages[0]) return { ok: true, meta_id: j.messages[0].id };
    return { ok: false, error: j.error || j };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function recortar(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

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
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : [];
}
