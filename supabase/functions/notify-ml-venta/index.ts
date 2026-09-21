// Edge Function: notify-ml-venta
// Avisa por WhatsApp cuando se vende algo en Mercado Libre, para que alguien lo
// prepare y lo despache a tiempo (si no, ML baja la reputación).
//
// Pedido de Fer (18-sep-2026):
//   - repuesto  → Fer, Catalina, celular de Repuestos (el de Germán Orozco).
//     21-sep-2026: Juan Carlos Caputo NO recibe ninguna notificación automática
//     en su celular privado. Accesorios y preguntas también van al celular de Repuestos.
//   - accesorio → Fer, Catalina, Giselle (encargada de accesorios)
//   - y en las dos, Nadia Vera (19-sep-2026: "cuando se venda algo tmb siempre
//     que se le avise a ella"), que es la que maneja la cuenta de ML
// Los destinatarios salen de la tabla `ml_ventas_destinatarios` (se editan ahí,
// sin tocar código). Si el aviso no tiene rubro, se avisa a los dos grupos.
//
// La dispara el cron del portal-precios (/api/cron/ml-ventas), que detecta la
// venta porque sube el `sold_quantity` del aviso (la app de ML no tiene permiso
// de órdenes, así que no hay comprador ni envío: eso se ve en ML).
//
// - Autenticación: header x-stock-secret == STOCK_NOTIF_SECRET.
// - Template Meta `ml_venta_nueva` (UTILITY, es_AR): {{1}} primer nombre,
//   {{2}} qué se vendió, {{3}} detalle (una línea). Mientras Meta no lo apruebe,
//   cae a `precios_actualizados` con el aviso entero en {{1}}.
//
// Preguntas (Fer, 19-sep-2026: "que las preguntas le lleguen al celular de
// Nadia, que es la que tiene acceso a Mercado Libre, para que entre y
// responda"): con `tipo: "pregunta"` avisa a los destinatarios de rubro
// `pregunta` con el template `ml_pregunta_nueva` ({{1}} nombre, {{2}} aviso,
// {{3}} la pregunta), y el mismo fallback.

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "ml_venta_nueva";
const TEMPLATE_PREGUNTA = "ml_pregunta_nueva";
const TEMPLATE_FALLBACK = "precios_actualizados";
const WABA_ID = Deno.env.get("WA_TASADOR_WABA_ID") ?? "1183788370595856";

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

  const esPregunta = body?.tipo === "pregunta";
  if (body?.crear_template === true) {
    return json(await postJson(`${META_API_URL}/${WABA_ID}/message_templates`, WA_TOKEN, esPregunta
      ? { name: TEMPLATE_PREGUNTA, language: META_LANGUAGE, category: "UTILITY", components: TEMPLATE_PREGUNTA_COMPONENTS }
      : { name: TEMPLATE_NAME, language: META_LANGUAGE, category: "UTILITY", components: TEMPLATE_COMPONENTS }));
  }
  if (body?.listar === true) {
    const res = await fetch(
      `${META_API_URL}/${WABA_ID}/message_templates?fields=name,status,category&name=${esPregunta ? TEMPLATE_PREGUNTA : TEMPLATE_NAME}`,
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } },
    );
    return json(await res.json());
  }

  const producto = limpiar(body?.producto);
  const detalle = limpiar(body?.detalle);
  if (!producto || !detalle) return json({ error: "faltan producto y detalle" }, 400);
  const rubro = esPregunta ? "pregunta" : ["repuesto", "accesorio"].includes(body?.rubro) ? body.rubro : null;

  // Prueba: manda solo a un teléfono.
  const solo = String(body?.solo || "").replace(/\D/g, "");
  let destinatarios: { nombre: string; telefono: string }[] = [];
  if (solo) {
    destinatarios = [{ nombre: "equipo", telefono: solo }];
  } else {
    // Venta sin rubro: a los dos grupos de ventas (no a los de preguntas).
    const filtro = rubro ? `&rubro=eq.${rubro}` : "&rubro=in.(repuesto,accesorio)";
    try {
      destinatarios = await sb(
        SUPABASE_URL, SERVICE_KEY,
        `ml_ventas_destinatarios?activo=eq.true${filtro}&select=nombre,telefono`,
      );
    } catch (e) {
      return json({ error: "Error leyendo destinatarios", detalle: String(e) }, 500);
    }
  }

  const vistos = new Set<string>();
  const enviados: any[] = [];
  const errores: any[] = [];
  for (const d of destinatarios) {
    const tel = String(d.telefono || "").replace(/\D/g, "");
    if (!tel || vistos.has(tel)) continue; // Fer y Catalina están en los dos grupos
    vistos.add(tel);
    const nombre = (String(d.nombre || "").split(/\s+/)[0] || "equipo").trim();
    const r = esPregunta
      ? await enviarPregunta(WA_PHONE_ID, WA_TOKEN, tel, nombre, producto, detalle)
      : await enviar(WA_PHONE_ID, WA_TOKEN, tel, nombre, producto, detalle);
    if (r.ok) enviados.push({ destinatario: d.nombre, template: r.template, meta_id: r.meta_id });
    else errores.push({ destinatario: d.nombre, error: r.error });
  }
  return json({ enviados: enviados.length, errores, detalle_enviados: enviados });
});

async function enviar(
  phoneId: string, token: string, tel: string, nombre: string, producto: string, detalle: string,
): Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }> {
  const propio = await postMeta(phoneId, token, tel, TEMPLATE_NAME, [nombre, recortar(producto, 200), recortar(detalle, 700)]);
  if (propio.ok) return { ...propio, template: TEMPLATE_NAME };
  const code = propio.error?.code;
  const noExiste = code === 132001 || code === 132000 || code === 132015 || code === 132012;
  if (!noExiste) return { ...propio, template: TEMPLATE_NAME };
  const texto = recortar(`🛒 VENTA EN MERCADO LIBRE: ${producto} — ${detalle} — hay que prepararlo y despacharlo.`, 900);
  const fb = await postMeta(phoneId, token, tel, TEMPLATE_FALLBACK, [texto]);
  return { ...fb, template: TEMPLATE_FALLBACK };
}

// producto = el aviso (titulo · MLA), detalle = la pregunta tal cual.
async function enviarPregunta(
  phoneId: string, token: string, tel: string, nombre: string, aviso: string, pregunta: string,
): Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }> {
  const propio = await postMeta(phoneId, token, tel, TEMPLATE_PREGUNTA, [nombre, recortar(aviso, 200), recortar(pregunta, 700)]);
  if (propio.ok) return { ...propio, template: TEMPLATE_PREGUNTA };
  const code = propio.error?.code;
  const noExiste = code === 132001 || code === 132000 || code === 132015 || code === 132012;
  if (!noExiste) return { ...propio, template: TEMPLATE_PREGUNTA };
  const texto = recortar(`❓ PREGUNTA EN MERCADO LIBRE sobre ${aviso}: "${pregunta}" — entrá a Mercado Libre, Preguntas, y respondela.`, 900);
  const fb = await postMeta(phoneId, token, tel, TEMPLATE_FALLBACK, [texto]);
  return { ...fb, template: TEMPLATE_FALLBACK };
}

async function postMeta(phoneId: string, token: string, tel: string, template: string, params: string[]) {
  const payload = {
    messaging_product: "whatsapp",
    to: tel,
    type: "template",
    template: {
      name: template,
      language: { code: META_LANGUAGE },
      components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
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

// {{1}} primer nombre · {{2}} qué se vendió · {{3}} detalle, una línea.
const TEMPLATE_COMPONENTS = [
  {
    type: "BODY",
    text:
      "Hola {{1}}! Se vendio por Mercado Libre: {{2}}.\n\n{{3}}\n\nHay que prepararlo y despacharlo a tiempo. El comprador y el envio estan en la cuenta de Mercado Libre, en Ventas.",
    example: {
      body_text: [[
        "Juan Carlos",
        "2 x Filtro De Aceite Original Volkswagen 04E115561T",
        "Codigo 04E115561T · $57.353 c/u · quedan 215 publicadas · MLA3968577738",
      ]],
    },
  },
];

// {{1}} primer nombre · {{2}} el aviso · {{3}} la pregunta.
const TEMPLATE_PREGUNTA_COMPONENTS = [
  {
    type: "BODY",
    text:
      "Hola {{1}}! Entro una pregunta en Mercado Libre sobre: {{2}}.\n\nPregunta: {{3}}\n\nEntra a la cuenta de Mercado Libre, en Preguntas, y respondela lo antes posible.",
    example: {
      body_text: [[
        "Nadia",
        "Filtro De Aceite Original Vw 04E115561T · MLA3968577738",
        "Hola, le sirve a un Polo 2019 1.6 MSI?",
      ]],
    },
  },
];

async function postJson(url: string, token: string, payload: unknown) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  } catch (e) {
    return { error: String(e) };
  }
}

// Meta rechaza saltos de línea dentro de un parámetro.
function limpiar(s: unknown) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
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

async function sb(url: string, key: string, path: string) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return await res.json();
}
