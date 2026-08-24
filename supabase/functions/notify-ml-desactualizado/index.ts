// Edge Function: notify-ml-desactualizado
// La dispara el cron del portal-precios (/api/cron/ml-tienda) cuando la vidriera
// de Mercado Libre (tienda "TITO GONZALEZ AUTOMOTORES") lleva N horas publicando
// un precio distinto a la oferta vigente del portal.
//
// - Autenticación: header x-stock-secret == STOCK_NOTIF_SECRET (el mismo que ya
//   usan notify-exposicion-vendida / notify-precios-actualizados).
// - Destinatarios: usuarios de `tasador_usuarios` cuyo `usuario` esté en
//   ML_TIENDA_DESTINATARIOS (env, default nvera,mlubrano,fngonzalez), activos,
//   con telefono_wa. Dedup por teléfono (Nadia tiene 2 cuentas, mismo número).
// - Template Meta: `ml_tienda_desactualizada` (es_AR): {{1}} primer nombre,
//   {{2}} horas de desvío, {{3}} detalle (una sola línea — Meta rechaza saltos
//   de línea dentro de un parámetro). Si ese template todavía no está aprobado,
//   cae a `precios_actualizados` metiendo el aviso en {{1}}.

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "ml_tienda_desactualizada";
const TEMPLATE_FALLBACK = "precios_actualizados";
const WABA_ID = Deno.env.get("WA_TASADOR_WABA_ID") ?? "1183788370595856";

const DESTINATARIOS_DEFAULT = "nvera,mlubrano,fngonzalez";

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
  // Editar el cuerpo de un template ya creado (pasar template_id). Meta sólo
  // deja editar los APPROVED/REJECTED: para uno PENDING hay que borrar y crear.
  if (body?.editar_template) {
    return json(await editarTemplate(WA_TOKEN, String(body.editar_template)));
  }
  if (body?.borrar_template === true) {
    return json(await borrarTemplate(WA_TOKEN));
  }

  const horas = String(body?.horas ?? "6 horas");
  const detalle = String(body?.detalle ?? "").replace(/\s+/g, " ").trim();
  if (!detalle) return json({ error: "falta detalle" }, 400);
  const solo = String(body?.solo || "").trim() || null;

  const env = { SUPABASE_URL, SERVICE_KEY, WA_PHONE_ID, WA_TOKEN };
  return json(await procesar(env, horas, detalle, solo));
});

type Env = {
  SUPABASE_URL: string;
  SERVICE_KEY: string;
  WA_PHONE_ID: string;
  WA_TOKEN: string;
};

async function procesar(env: Env, horas: string, detalle: string, solo: string | null) {
  const { SUPABASE_URL, SERVICE_KEY, WA_PHONE_ID, WA_TOKEN } = env;

  if (solo) {
    const tel = solo.replace(/^\+/, "").replace(/\s|-/g, "");
    const r = await enviar(WA_PHONE_ID, WA_TOKEN, tel, "equipo", horas, detalle);
    return { prueba: true, destino: tel, ...r };
  }

  const usuarios = (Deno.env.get("ML_TIENDA_DESTINATARIOS") ?? DESTINATARIOS_DEFAULT)
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
    const r = await enviar(WA_PHONE_ID, WA_TOKEN, d.tel, primerNombre, horas, detalle);
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
  horas: string,
  detalle: string,
): Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }> {
  const propio = await postMeta(phoneId, token, tel, TEMPLATE_NAME, [
    primerNombre,
    horas,
    recortar(detalle, 900),
  ]);
  if (propio.ok) return { ...propio, template: TEMPLATE_NAME };

  const code = propio.error?.code;
  const noExiste = code === 132001 || code === 132000 || code === 132015 || code === 132012;
  if (!noExiste) return { ...propio, template: TEMPLATE_NAME };

  const texto = recortar(
    `🛒 Mercado Libre desactualizado hace ${horas} — ${detalle} — detalle en precios.titogonzalez.online/ml-tienda`,
    900,
  );
  const fb = await postMeta(phoneId, token, tel, TEMPLATE_FALLBACK, [texto]);
  return { ...fb, template: TEMPLATE_FALLBACK };
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

// {{1}} primer nombre · {{2}} cuánto hace ("7 horas", "3 dias") · {{3}} detalle.
const TEMPLATE_COMPONENTS = [
  {
    type: "BODY",
    text:
      "Hola {{1}}! La tienda de Mercado Libre quedo desactualizada: hace {{2}} que hay precios distintos a la oferta vigente del portal.\n\n{{3}}\n\nPor favor actualizalos en Mercado Libre. El detalle completo esta en precios.titogonzalez.online/ml-tienda",
    example: {
      body_text: [[
        "Nadia",
        "7 horas",
        "Polo Track: esta en $27.040.374 y la oferta es $27.499.999",
      ]],
    },
  },
];

async function crearTemplate(token: string) {
  return await postJson(`${META_API_URL}/${WABA_ID}/message_templates`, token, {
    name: TEMPLATE_NAME,
    language: META_LANGUAGE,
    category: "UTILITY",
    components: TEMPLATE_COMPONENTS,
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
