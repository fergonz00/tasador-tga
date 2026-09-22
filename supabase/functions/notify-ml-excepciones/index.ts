// Edge Function: notify-ml-excepciones
// La dispara el cron del portal-precios (/api/cron/ml-tienda) cuando, DESPUES de
// corregir solo los precios que podia, quedan cosas que necesitan que una persona
// meta mano: publicaciones sin mapear, modelos con stock sin publicar, publicadas
// sin oferta y errores de la API de ML.
//
// Decision de Fer (10-sep-2026): los precios que corrige bien NO se informan.
// Este aviso es solo para lo que NO pudo arreglar.
//
// - Autenticación: header x-stock-secret == STOCK_NOTIF_SECRET (el mismo que ya
//   usan notify-exposicion-vendida / notify-precios-actualizados).
// - Destinatarios: usuarios de `tasador_usuarios` cuyo `usuario` esté en
//   ML_EXCEPCIONES_DESTINATARIOS (env, default fngonzalez — Fer pidió que este
//   aviso sea sólo a él), activos, con telefono_wa. Dedup por teléfono.
// - Template Meta: `ml_revision_pendiente` (es_AR): {{1}} primer nombre,
//   {{2}} cuántas cosas quedaron ("10"), {{3}} detalle (una sola línea — Meta
//   rechaza los saltos de línea dentro de un parámetro). Mientras no esté
//   aprobado, cae a `precios_actualizados` metiendo el aviso entero en {{1}}.
//   El cuerpo va SIN TILDES, igual que `ml_tienda_precios`.
//
// - tipo "stock_fabrica" (control diario de accesorios a pedido, 22-sep-2026):
//   template propio `ml_stock_fabrica` que separa lo que el control YA hizo solo
//   (reactivar/pausar) de lo que necesita que alguien lo mire. Con el general
//   llegaba "quedaron 39 cosas que necesitan que alguien las mire" cuando eran
//   39 reactivaciones ya aplicadas. Params: {{1}} nombre · {{2}} resumen ·
//   {{3}} detalle · {{4}} que hay que hacer. Sin aprobar, cae al general.

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "ml_revision_pendiente";
const TEMPLATE_FALLBACK = "precios_actualizados";
const WABA_ID = Deno.env.get("WA_TASADOR_WABA_ID") ?? "1183788370595856";

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

  // Diagnóstico: ver el template (nombre/estado/cuerpo) sin mandar nada.
  if (body?.listar === true) {
    const res = await fetch(
      `${META_API_URL}/${WABA_ID}/message_templates?fields=name,language,status,category,components&limit=200`,
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } },
    );
    const j = await res.json();
    const items = (j?.data ?? []).filter((t: any) =>
      !body?.nombre || String(t.name) === String(body.nombre)
    );
    return json({ templates: items, error: j?.error });
  }

  // Alta del template en Meta (una sola vez; después queda esperando aprobación).
  if (body?.crear_template === true) {
    return json(await crearTemplate(WA_TOKEN));
  }
  if (body?.crear_template === "stock_fabrica") {
    return json(await crearTemplate(WA_TOKEN, STOCK_FABRICA));
  }
  // Editar el cuerpo de un template ya creado (pasar template_id). Meta sólo
  // deja editar los APPROVED/REJECTED: para uno PENDING hay que borrar y crear.
  if (body?.editar_template) {
    return json(await editarTemplate(WA_TOKEN, String(body.editar_template)));
  }
  if (body?.borrar_template === true) {
    return json(await borrarTemplate(WA_TOKEN));
  }

  if (body?.tipo === "stock_fabrica") {
    const p = [body?.resumen, body?.detalle, body?.accion]
      .map((x) => String(x ?? "").replace(/\s+/g, " ").trim());
    if (p.some((x) => !x)) return json({ error: "faltan resumen, detalle o accion" }, 400);
    const env = { SUPABASE_URL, SERVICE_KEY, WA_PHONE_ID, WA_TOKEN };
    const solo = String(body?.solo || "").trim() || null;
    return json(await procesar(env, "", "", solo, (tel, nombre) =>
      enviarStockFabrica(WA_PHONE_ID, WA_TOKEN, tel, nombre, p, String(body?.cantidad ?? "0"))));
  }

  const cantidad = String(body?.cantidad ?? "").trim();
  if (!cantidad) return json({ error: "falta cantidad" }, 400);
  const detalle = String(body?.detalle ?? "").replace(/\s+/g, " ").trim();
  if (!detalle) return json({ error: "falta detalle" }, 400);
  const solo = String(body?.solo || "").trim() || null;

  const env = { SUPABASE_URL, SERVICE_KEY, WA_PHONE_ID, WA_TOKEN };
  return json(await procesar(env, cantidad, detalle, solo));
});

type Env = {
  SUPABASE_URL: string;
  SERVICE_KEY: string;
  WA_PHONE_ID: string;
  WA_TOKEN: string;
};

type Envio = (tel: string, primerNombre: string) =>
  Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }>;

async function procesar(
  env: Env,
  cantidad: string,
  detalle: string,
  solo: string | null,
  envio?: Envio,
) {
  const { SUPABASE_URL, SERVICE_KEY, WA_PHONE_ID, WA_TOKEN } = env;
  const mandar: Envio = envio ??
    ((tel, nombre) => enviar(WA_PHONE_ID, WA_TOKEN, tel, nombre, cantidad, detalle));

  if (solo) {
    const tel = solo.replace(/^\+/, "").replace(/\s|-/g, "");
    const r = await mandar(tel, "equipo");
    return { prueba: true, destino: tel, ...r };
  }

  const usuarios = (Deno.env.get("ML_EXCEPCIONES_DESTINATARIOS") ?? DESTINATARIOS_DEFAULT)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  let users: any[] = [];
  try {
    users = await sb(
      SUPABASE_URL,
      SERVICE_KEY,
      `tasador_usuarios?activo=eq.true&telefono_wa=not.is.null&select=nombre,usuario,telefono_wa`,
    );
  } catch (e) {
    return { error: "Error leyendo Supabase", detalle: String(e) };
  }

  const destinatarios: Array<{ nombre: string; tel: string; usuario: string }> = [];
  const vistos = new Set<string>();
  for (const u of users || []) {
    const usuario = String(u.usuario || "").toLowerCase();
    if (!usuarios.includes(usuario)) continue;
    const tel = String(u.telefono_wa || "").replace(/^\+/, "").replace(/\s|-/g, "");
    if (!tel || vistos.has(tel)) continue;
    vistos.add(tel);
    destinatarios.push({ nombre: u.nombre || u.usuario || "", tel, usuario });
  }

  if (destinatarios.length === 0) return { enviados: 0, errores: [], detalle: "sin destinatarios" };

  const enviados: any[] = [];
  const errores: any[] = [];
  for (const d of destinatarios) {
    const primerNombre = (d.nombre.split(/\s+/)[0] || d.nombre || "").trim() || "equipo";
    const r = await mandar(d.tel, primerNombre);
    if (r.ok) enviados.push({ destinatario: d.nombre, template: r.template, meta_id: r.meta_id });
    else errores.push({ destinatario: d.nombre, error: r.error });
  }
  return { enviados: enviados.length, errores, detalle_enviados: enviados };
}

/**
 * Manda el template propio; si Meta dice que no existe / no está aprobado
 * (132001 y familia), reintenta con `precios_actualizados`, que sólo tiene
 * {{1}} — ahí va el aviso completo para que igual se entienda.
 */
async function enviar(
  phoneId: string,
  token: string,
  tel: string,
  primerNombre: string,
  cantidad: string,
  detalle: string,
): Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }> {
  const propio = await postMeta(phoneId, token, tel, TEMPLATE_NAME, [
    primerNombre,
    cantidad,
    recortar(detalle, 900),
  ]);
  if (propio.ok) return { ...propio, template: TEMPLATE_NAME };

  const code = propio.error?.code;
  const noExiste = code === 132001 || code === 132000 || code === 132015 || code === 132012;
  if (!noExiste) return { ...propio, template: TEMPLATE_NAME };

  const texto = recortar(
    `🛒 Mercado Libre: corregi los precios, pero quedaron ${cantidad} cosas para revisar — ${detalle} — detalle en precios.titogonzalez.online/ml-tienda`,
    900,
  );
  const fb = await postMeta(phoneId, token, tel, TEMPLATE_FALLBACK, [texto]);
  return { ...fb, template: TEMPLATE_FALLBACK };
}

/**
 * Control de stock de fabrica: template propio. Mientras Meta no lo apruebe,
 * cae al general con la cantidad de lo que hay que mirar (no de lo hecho).
 */
async function enviarStockFabrica(
  phoneId: string,
  token: string,
  tel: string,
  primerNombre: string,
  [resumen, detalle, accion]: string[],
  cantidadRevisar: string,
) {
  const propio = await postMeta(phoneId, token, tel, STOCK_FABRICA.name, [
    primerNombre,
    recortar(resumen, 300),
    recortar(detalle, 700),
    recortar(accion, 400),
  ]);
  if (propio.ok) return { ...propio, template: STOCK_FABRICA.name };
  const code = propio.error?.code;
  const noExiste = code === 132001 || code === 132000 || code === 132015 || code === 132012;
  if (!noExiste) return { ...propio, template: STOCK_FABRICA.name };
  return await enviar(phoneId, token, tel, primerNombre, cantidadRevisar,
    `Stock de fabrica: ${resumen}. ${detalle} -- ${accion}`);
}

async function postMeta(
  phoneId: string,
  token: string,
  tel: string,
  template: string,
  params: string[],
) {
  const payload = {
    messaging_product: "whatsapp",
    to: tel,
    type: "template",
    template: {
      name: template,
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

// {{1}} primer nombre · {{2}} cuántas quedaron ("10") · {{3}} detalle, una línea.
const TEMPLATE_COMPONENTS = [
  {
    type: "BODY",
    text:
      "Hola {{1}}! Revise los precios de Mercado Libre y corregi lo que hacia falta, pero quedaron {{2}} cosas que necesitan que alguien las mire.\n\n{{3}}\n\nEl detalle completo esta en precios.titogonzalez.online/ml-tienda",
    example: {
      body_text: [[
        "Fer",
        "10",
        "Taos Highline: 6 en stock y no esta publicado en ML · Amarok Comfortline V6: 5 en stock y no esta publicado en ML",
      ]],
    },
  },
];

// {{1}} nombre · {{2}} resumen de lo hecho · {{3}} detalle · {{4}} que hacer.
const STOCK_FABRICA = {
  name: "ml_stock_fabrica",
  components: [
    {
      type: "BODY",
      text:
        "Hola {{1}}! Revise en el POC de VW el stock de fabrica de los accesorios que vendemos a pedido en Mercado Libre: {{2}}.\n\nDetalle: {{3}}\n\n{{4}}\n\nEste control corre a las 8:30, 13 y 18 hs.",
      example: {
        body_text: [[
          "Fer",
          "reactive 2 avisos porque VW volvio a tener stock",
          "Junta De Motor Tiguan (MLA3979759670); Sensor De Nivel De Aceite Tiguan (MLA3979733644)",
          "No hace falta que hagas nada: ya quedo aplicado en Mercado Libre.",
        ]],
      },
    },
  ],
};

async function crearTemplate(
  token: string,
  t: { name: string; components: unknown } = { name: TEMPLATE_NAME, components: TEMPLATE_COMPONENTS },
) {
  return await postJson(`${META_API_URL}/${WABA_ID}/message_templates`, token, {
    name: t.name,
    language: META_LANGUAGE,
    category: "UTILITY",
    components: t.components,
  });
}

async function editarTemplate(token: string, templateId: string) {
  return await postJson(`${META_API_URL}/${templateId}`, token, {
    category: "UTILITY",
    components: TEMPLATE_COMPONENTS,
  });
}

async function borrarTemplate(token: string) {
  try {
    const res = await fetch(
      `${META_API_URL}/${WABA_ID}/message_templates?name=${TEMPLATE_NAME}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
    return { status: res.status, body: await res.json() };
  } catch (e) {
    return { error: String(e) };
  }
}

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
