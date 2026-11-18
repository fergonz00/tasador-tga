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
//
// Saldo de Mercado Pago (Fer, 21-sep-2026: "cuando la cuenta tenga mas de
// 100.000 pesos para que nos acordemos de transferir la plata de mercadopago
// al santander"): con `tipo: "saldo_mp"` avisa a los de rubro `saldo_mp` con el
// template `mp_saldo_para_transferir` ({{1}} nombre, {{2}} saldo, {{3}} tope).
// Lo dispara el cron diario del portal (/api/cron/mp-saldo).
//
// La columna `desde` de los destinatarios deja a alguien en pausa hasta una
// fecha (Catalina, de vacaciones hasta el 28-sep-2026).
//
// Preguntas sin responder (Fer, 21-sep-2026: "cuando pasen 2 hs y no respondio
// le avise x whatsapp y luego a las 6 hs y luego cada 6hs hasta q responda.
// siempre en dias y horarios habiles"): con `tipo: "pregunta_recordatorio"`
// avisa a rubro `pregunta_recordatorio` (Nadia) y, con `escalar: true` (desde
// las 6 hs), también a `pregunta_escalada` (Fer). Template
// `ml_pregunta_sin_responder` ({{1}} nombre, {{2}} aviso, {{3}} hace cuánto,
// {{4}} la pregunta). El cálculo de horas hábiles vive en el portal
// (src/lib/mlPreguntas.ts); acá `horas` llega ya armado ("2 horas hábiles").
//
// Unidad del reparto que VW no facturó (Fer, 22-sep-2026: "cuando una quede
// colgada necesito que me avisen x whatsapp asi la reclamo... el aviso que me
// llegue solo 1 vez asi hago el reclamo no todo el tiempo"): con
// `tipo: "reparto_sin_factura"` avisa a rubro `reparto_sin_factura` (Fer) con el
// template `reparto_unidad_sin_factura` ({{1}} nombre, {{2}} la unidad,
// {{3}} desde cuándo y qué pasó con el resto del reparto). Lo dispara el cron
// del portal (/api/cron/reparto-sin-factura), que es el que cuenta los días
// hábiles y el que se acuerda de no repetir el aviso.

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "ml_venta_nueva";
const TEMPLATE_PREGUNTA = "ml_pregunta_nueva";
const TEMPLATE_SALDO = "mp_saldo_para_transferir";
const TEMPLATE_RECORDATORIO = "ml_pregunta_sin_responder";
/**
 * Preguntas DERIVADAS: el que la contesta no entra a Mercado Libre, le pasa la
 * respuesta a Fer y Fer la publica. Nacio el 18-11-2026, con Nadia de luna de
 * miel hasta el 9-12: Maxi Lopez (gte. de postventa) sabe la respuesta pero no
 * tiene la cuenta. Mandarle el template comun le decia "entra a Mercado Libre",
 * que es justo lo que no puede hacer.
 * Mientras Meta los tenga en PENDING caen a los de siempre: el aviso llega igual
 * (con el remate equivocado) y se corrige solo cuando aprueban.
 */
const TEMPLATE_DERIVADA = "ml_pregunta_para_fer";
const TEMPLATE_DERIVADA_RECORDATORIO = "ml_pregunta_para_fer_recordatorio";
const TEMPLATE_REPARTO = "reparto_unidad_sin_factura";
const TEMPLATE_CANCELADA = "ml_venta_cancelada";
const TEMPLATE_DEVOLUCION = "ml_devolucion_seguimiento";
/**
 * ⚠️ `ml_compra_respuesta` quedo APPROVED pero en categoria **MARKETING**, y un
 * MARKETING no se entrega aunque Meta devuelva message id: el 27-9-2026 un
 * particular contesto "no gracias" y el aviso nunca llego.
 * Ver reference_whatsapp_template_utility: Meta clasifica el TEXTO por su cuenta
 * y un template aprobado no se puede recategorizar.
 *
 * Por eso se prueba una LISTA en orden y se usa el primero que salga. Los tres
 * `tasador_*` estan redactados como un control sobre registros propios, que es
 * lo que cae en UTILITY. El ultimo de la lista es `ml_pregunta_nueva`, que ya
 * esta APPROVED/UTILITY y entrega seguro.
 * NO volver a poner `ml_compra_respuesta`: no llega.
 */
// ⚠️ El primero es el que se usa; los demas son red por si Meta todavia no
// aprobo el nuevo o lo dio de baja. `usados_interesado_crm` manda al CRM, solapa
// Usados: los viejos dicen "entra al tasador, solapa Compra ML", que para Ines
// no significa nada — ella trabaja estos casos desde el CRM (Fer, 2-10-2026).
const TEMPLATES_COMPRA = [
  "usados_interesado_crm",
  "tasador_respuesta_sin_atender",
  "tasador_usado_con_respuesta",
  "tasador_consulta_contestada",
  "ml_pregunta_nueva",
];
const TEMPLATE_COMPRA = TEMPLATES_COMPRA[0];
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
  const esSaldo = body?.tipo === "saldo_mp";
  const esRecordatorio = body?.tipo === "pregunta_recordatorio";
  const esReparto = body?.tipo === "reparto_sin_factura";
  const esCompra = body?.tipo === "compra_respuesta";
  const esCancelada = body?.tipo === "cancelacion";
  const esDevolucion = body?.tipo === "devolucion";
  const templateBase = esDevolucion ? TEMPLATE_DEVOLUCION
    : esCancelada ? TEMPLATE_CANCELADA
    : esCompra ? TEMPLATE_COMPRA : esReparto ? TEMPLATE_REPARTO
    : esRecordatorio ? TEMPLATE_RECORDATORIO : esSaldo ? TEMPLATE_SALDO
    : esPregunta ? TEMPLATE_PREGUNTA : TEMPLATE_NAME;
  // {"derivada":true} apunta las operaciones de template (crear/editar/listar) a
  // las plantillas de pregunta derivada, que no mandan a Mercado Libre.
  const esDerivada = body?.derivada === true && (esPregunta || esRecordatorio);
  const template = esDerivada
    ? (esRecordatorio ? TEMPLATE_DERIVADA_RECORDATORIO : TEMPLATE_DERIVADA)
    : templateBase;
  if (body?.crear_template === true) {
    const components = esDerivada
      ? (esRecordatorio ? TEMPLATE_DERIVADA_RECORDATORIO_COMPONENTS : TEMPLATE_DERIVADA_COMPONENTS)
      : esDevolucion ? TEMPLATE_DEVOLUCION_COMPONENTS
      : esCancelada ? TEMPLATE_CANCELADA_COMPONENTS
      : esCompra ? TEMPLATE_COMPRA_COMPONENTS
      : esReparto ? TEMPLATE_REPARTO_COMPONENTS
      : esRecordatorio ? TEMPLATE_RECORDATORIO_COMPONENTS : esSaldo ? TEMPLATE_SALDO_COMPONENTS
      : esPregunta ? TEMPLATE_PREGUNTA_COMPONENTS : TEMPLATE_COMPONENTS;
    return json(await postJson(`${META_API_URL}/${WABA_ID}/message_templates`, WA_TOKEN,
      { name: template, language: META_LANGUAGE, category: "UTILITY", components }));
  }
  // `editar_template: true` reescribe el cuerpo de un template que todavia esta
  // PENDING o REJECTED (Meta no deja crear dos veces el mismo idioma, y un APPROVED
  // tampoco se puede recategorizar). Nacio el 3-10-2026: `ml_venta_cancelada` se pidio
  // con un texto fijo que decia "si ya se pidio a VW, frenarlo" en TODAS, y Fer marco
  // que en una pieza de deposito eso es alarmista al pedo. El token de esta cuenta de
  // WhatsApp vive solo aca, asi que la edicion tiene que salir de la Edge.
  if (body?.editar_template === true) {
    const components = esDerivada
      ? (esRecordatorio ? TEMPLATE_DERIVADA_RECORDATORIO_COMPONENTS : TEMPLATE_DERIVADA_COMPONENTS)
      : esCancelada ? TEMPLATE_CANCELADA_COMPONENTS
      : esCompra ? TEMPLATE_COMPRA_COMPONENTS
      : esReparto ? TEMPLATE_REPARTO_COMPONENTS
      : esRecordatorio ? TEMPLATE_RECORDATORIO_COMPONENTS : esSaldo ? TEMPLATE_SALDO_COMPONENTS
      : esPregunta ? TEMPLATE_PREGUNTA_COMPONENTS : TEMPLATE_COMPONENTS;
    const busca = await fetch(
      `${META_API_URL}/${WABA_ID}/message_templates?fields=id,name,status&name=${template}`,
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } },
    );
    const lista = await busca.json();
    const id = lista?.data?.find((t: any) => t?.name === template)?.id;
    if (!id) return json({ error: `no encontre el template ${template}`, lista }, 404);
    return json(await postJson(`${META_API_URL}/${id}`, WA_TOKEN, { components }));
  }
  if (body?.listar === true) {
    const res = await fetch(
      `${META_API_URL}/${WABA_ID}/message_templates?fields=name,status,category&name=${template}`,
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } },
    );
    return json(await res.json());
  }

  const producto = limpiar(body?.producto);
  const detalle = limpiar(body?.detalle);
  if (!producto || !detalle) return json({ error: "faltan producto y detalle" }, 400);
  const horas = limpiar(body?.horas);
  const accion = limpiar(body?.accion);
  if (esRecordatorio && !horas) return json({ error: "falta horas" }, 400);
  const rubro = esDevolucion
    ? (body?.escalar === true ? "devolucion,devolucion_escalada" : "devolucion")
    : esCancelada ? "cancelacion"
    : esCompra ? "compra_ml"
    : esReparto ? "reparto_sin_factura"
    : esRecordatorio
    ? (body?.escalar === true ? "pregunta_recordatorio,pregunta_escalada" : "pregunta_recordatorio")
    : esSaldo ? "saldo_mp" : esPregunta ? "pregunta"
    : ["repuesto", "accesorio"].includes(body?.rubro) ? body.rubro : null;

  // `dry`: resuelve destinatarios y template y devuelve a quien le llegaria,
  // SIN llamar a Meta. Es la unica forma de verificar el ruteo sin mandarle un
  // WhatsApp de prueba a una persona real.
  const dry = body?.dry === true;
  // Prueba: manda solo a un teléfono.
  const solo = String(body?.solo || "").replace(/\D/g, "");
  let destinatarios: { nombre: string; telefono: string }[] = [];
  if (solo) {
    destinatarios = [{ nombre: "equipo", telefono: solo }];
  } else {
    // Venta sin rubro: a los dos grupos de ventas (no a los de preguntas).
    // `desde`: en pausa hasta esa fecha (hoy en hora argentina).
    const hoy = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const filtro = (rubro ? `&rubro=in.(${rubro})` : "&rubro=in.(repuesto,accesorio)") +
      `&or=(desde.is.null,desde.lte.${hoy})`;
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
    if (dry) { enviados.push({ destinatario: d.nombre, telefono: tel, template: templateBase, dry: true }); continue; }
    const r = esDevolucion
      ? await enviarDevolucion(WA_PHONE_ID, WA_TOKEN, tel, nombre, producto, detalle, accion)
      : esCancelada
      ? await enviarCancelada(WA_PHONE_ID, WA_TOKEN, tel, nombre, producto, detalle)
      : esCompra
      ? await enviarCompra(WA_PHONE_ID, WA_TOKEN, tel, nombre, producto, detalle)
      : esReparto
      ? await enviarReparto(WA_PHONE_ID, WA_TOKEN, tel, nombre, producto, detalle)
      : esRecordatorio
      ? await enviarRecordatorio(WA_PHONE_ID, WA_TOKEN, tel, nombre, producto, horas, detalle)
      : esSaldo
      ? await enviarSaldo(WA_PHONE_ID, WA_TOKEN, tel, nombre, producto, detalle)
      : esPregunta
      ? await enviarPregunta(WA_PHONE_ID, WA_TOKEN, tel, nombre, producto, detalle)
      : await enviar(WA_PHONE_ID, WA_TOKEN, tel, nombre, producto, detalle);
    if (r.ok) enviados.push({ destinatario: d.nombre, template: r.template, meta_id: r.meta_id });
    else errores.push({ destinatario: d.nombre, error: r.error });
  }
  // Segunda pasada: los que contestan pero NO entran a Mercado Libre (rubros
  // `pregunta_derivada*`). Mismo aviso, otro remate: "pasale la respuesta a Fer".
  // `vistos` se comparte, asi que a nadie le llegan los dos mensajes.
  if (!solo && (esPregunta || esRecordatorio)) {
    const rubroDer = esRecordatorio ? "pregunta_derivada_recordatorio" : "pregunta_derivada";
    const hoy2 = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    let derivados: { nombre: string; telefono: string }[] = [];
    try {
      derivados = await sb(
        SUPABASE_URL, SERVICE_KEY,
        `ml_ventas_destinatarios?activo=eq.true&rubro=eq.${rubroDer}` +
          `&or=(desde.is.null,desde.lte.${hoy2})&select=nombre,telefono`,
      );
    } catch (e) {
      errores.push({ destinatario: rubroDer, error: String(e) });
    }
    for (const d of derivados) {
      const tel = String(d.telefono || "").replace(/\D/g, "");
      if (!tel || vistos.has(tel)) continue;
      vistos.add(tel);
      const nombre = (String(d.nombre || "").split(/\s+/)[0] || "equipo").trim();
      const tplDer = esRecordatorio ? TEMPLATE_DERIVADA_RECORDATORIO : TEMPLATE_DERIVADA;
      if (dry) { enviados.push({ destinatario: d.nombre, telefono: tel, template: tplDer, derivada: true, dry: true }); continue; }
      const r = esRecordatorio
        ? await enviarDerivadaRecordatorio(WA_PHONE_ID, WA_TOKEN, tel, nombre, producto, horas, detalle)
        : await enviarDerivada(WA_PHONE_ID, WA_TOKEN, tel, nombre, producto, detalle);
      if (r.ok) enviados.push({ destinatario: d.nombre, template: r.template, meta_id: r.meta_id });
      else errores.push({ destinatario: d.nombre, error: r.error });
    }
  }

  return json({ enviados: enviados.length, errores, detalle_enviados: enviados });
});

// Pregunta para alguien que NO entra a Mercado Libre: contesta y Fer publica.
// Mientras Meta no apruebe el template propio cae al comun (`ml_pregunta_nueva`),
// que llega seguro aunque el remate diga "entra a Mercado Libre". Preferimos que
// la pregunta le llegue con el remate viejo a que no le llegue.
async function enviarDerivada(
  phoneId: string, token: string, tel: string, nombre: string, aviso: string, pregunta: string,
): Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }> {
  const args = [nombre, recortar(aviso, 200), recortar(pregunta, 700)];
  const propio = await postMeta(phoneId, token, tel, TEMPLATE_DERIVADA, args);
  if (propio.ok) return { ...propio, template: TEMPLATE_DERIVADA };
  const fb = await postMeta(phoneId, token, tel, TEMPLATE_PREGUNTA, args);
  return { ...fb, template: TEMPLATE_PREGUNTA };
}

async function enviarDerivadaRecordatorio(
  phoneId: string, token: string, tel: string, nombre: string, aviso: string,
  horas: string, pregunta: string,
): Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }> {
  const args = [nombre, recortar(aviso, 200), horas, recortar(pregunta, 600)];
  const propio = await postMeta(phoneId, token, tel, TEMPLATE_DERIVADA_RECORDATORIO, args);
  if (propio.ok) return { ...propio, template: TEMPLATE_DERIVADA_RECORDATORIO };
  const fb = await postMeta(phoneId, token, tel, TEMPLATE_RECORDATORIO, args);
  return { ...fb, template: TEMPLATE_RECORDATORIO };
}

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
// producto = el auto + lo que le ofrecimos, detalle = lo que contesto el dueno.
// Prueba los templates en orden y se queda con el primero que Meta acepte: los
// que todavia estan PENDING fallan con 132001 y se saltean solos, asi que cuando
// alguno se apruebe empieza a usarse sin redeployar.
async function enviarCompra(
  phoneId: string, token: string, tel: string, nombre: string, auto: string, respuesta: string,
): Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }> {
  let ultimo: any = null;
  for (const tpl of TEMPLATES_COMPRA) {
    const r = await postMeta(phoneId, token, tel, tpl,
      [nombre, recortar(auto, 200), recortar(respuesta, 700)]);
    if (r.ok) return { ...r, template: tpl };
    ultimo = r;
    const code = r.error?.code;
    const noExiste = code === 132001 || code === 132000 || code === 132015 || code === 132012;
    if (!noExiste) return { ...r, template: tpl };  // error real: no seguir probando
  }
  const texto = recortar(`\u{1F4AC} CONTESTARON POR EL USADO ${auto}: "${respuesta}" \u2014 entra al tasador, solapa Compra ML.`, 900);
  const fb = await postMeta(phoneId, token, tel, TEMPLATE_FALLBACK, [texto]);
  return fb.ok ? { ...fb, template: TEMPLATE_FALLBACK } : { ...(ultimo || fb), template: "ninguno" };
}

// producto = "6 x <titulo>", detalle = cuando se habia vendido, por cuanto y el MLA.
// Mientras Meta no apruebe `ml_venta_cancelada` cae al texto libre, que SI sale hoy:
// un aviso de este tipo no puede esperar los dias que tarda una revision.
// producto = "1 x <titulo> - MLA...", detalle = como viene en ML, accion = que tiene que hacer.
async function enviarDevolucion(
  phoneId: string, token: string, tel: string, nombre: string,
  producto: string, detalle: string, accion: string,
): Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }> {
  const quehacer = accion ||
    "Entra a Mercado Libre, en Ventas, y reclama la devolucion del paquete.";
  const propio = await postMeta(phoneId, token, tel, TEMPLATE_DEVOLUCION,
    [nombre, recortar(producto, 200), recortar(detalle, 500), recortar(quehacer, 400)]);
  if (propio.ok) return { ...propio, template: TEMPLATE_DEVOLUCION };
  const code = propio.error?.code;
  const noExiste = code === 132001 || code === 132000 || code === 132015 || code === 132012;
  if (!noExiste) return { ...propio, template: TEMPLATE_DEVOLUCION };
  const texto = recortar(
    `SEGUIMIENTO de una pieza despachada con la venta cancelada: ${producto} - ${detalle} - ${quehacer}`, 900);
  const fb = await postMeta(phoneId, token, tel, TEMPLATE_FALLBACK, [texto]);
  return { ...fb, template: TEMPLATE_FALLBACK };
}

async function enviarCancelada(
  phoneId: string, token: string, tel: string, nombre: string, producto: string, detalle: string,
): Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }> {
  const propio = await postMeta(phoneId, token, tel, TEMPLATE_CANCELADA,
    [nombre, recortar(producto, 200), recortar(detalle, 700)]);
  if (propio.ok) return { ...propio, template: TEMPLATE_CANCELADA };
  const code = propio.error?.code;
  const noExiste = code === 132001 || code === 132000 || code === 132015 || code === 132012;
  if (!noExiste) return { ...propio, template: TEMPLATE_CANCELADA };
  const texto = recortar(
    `AVISO SE CANCELO UNA VENTA DE MERCADO LIBRE: ${producto} - ${detalle} - NO hay que despacharla.`,
    900);
  const fb = await postMeta(phoneId, token, tel, TEMPLATE_FALLBACK, [texto]);
  return { ...fb, template: TEMPLATE_FALLBACK };
}

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

// producto = el aviso (titulo · MLA), horas = "2 horas hábiles", detalle = la pregunta.
async function enviarRecordatorio(
  phoneId: string, token: string, tel: string, nombre: string, aviso: string, horas: string, pregunta: string,
): Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }> {
  const propio = await postMeta(phoneId, token, tel, TEMPLATE_RECORDATORIO,
    [nombre, recortar(aviso, 200), horas, recortar(pregunta, 600)]);
  if (propio.ok) return { ...propio, template: TEMPLATE_RECORDATORIO };
  const code = propio.error?.code;
  const noExiste = code === 132001 || code === 132000 || code === 132015 || code === 132012;
  if (!noExiste) return { ...propio, template: TEMPLATE_RECORDATORIO };
  const texto = recortar(`⏰ PREGUNTA SIN RESPONDER EN MERCADO LIBRE hace ${horas}, sobre ${aviso}: "${pregunta}" — entrá a Mercado Libre, Preguntas, y respondela.`, 900);
  const fb = await postMeta(phoneId, token, tel, TEMPLATE_FALLBACK, [texto]);
  return { ...fb, template: TEMPLATE_FALLBACK };
}

// producto = la unidad (modelo · color · chasis), detalle = desde cuándo está
// colgada y cómo viene el resto del reparto. Sale UNA sola vez por unidad: quien
// lleva la cuenta es el portal (`reparto_sin_factura_avisos`), no esta función.
async function enviarReparto(
  phoneId: string, token: string, tel: string, nombre: string, unidad: string, detalle: string,
): Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }> {
  const propio = await postMeta(phoneId, token, tel, TEMPLATE_REPARTO, [nombre, recortar(unidad, 200), recortar(detalle, 700)]);
  if (propio.ok) return { ...propio, template: TEMPLATE_REPARTO };
  const code = propio.error?.code;
  const noExiste = code === 132001 || code === 132000 || code === 132015 || code === 132012;
  if (!noExiste) return { ...propio, template: TEMPLATE_REPARTO };
  const texto = recortar(`🚩 UNIDAD DEL REPARTO SIN FACTURAR: ${unidad} — ${detalle} — hay que reclamársela a VW.`, 900);
  const fb = await postMeta(phoneId, token, tel, TEMPLATE_FALLBACK, [texto]);
  return { ...fb, template: TEMPLATE_FALLBACK };
}

// producto = el saldo ($ formateado), detalle = el tope.
async function enviarSaldo(
  phoneId: string, token: string, tel: string, nombre: string, saldo: string, tope: string,
): Promise<{ ok: boolean; template?: string; meta_id?: string; error?: any }> {
  const propio = await postMeta(phoneId, token, tel, TEMPLATE_SALDO, [nombre, saldo, tope]);
  if (propio.ok) return { ...propio, template: TEMPLATE_SALDO };
  const code = propio.error?.code;
  const noExiste = code === 132001 || code === 132000 || code === 132015 || code === 132012;
  if (!noExiste) return { ...propio, template: TEMPLATE_SALDO };
  const texto = `💰 SALDO EN MERCADO PAGO: hay ${saldo} disponibles (tope ${tope}) — hay que transferirlos al Santander.`;
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
/**
 * Fer (3-10-2026): *"es importante que si se cancela alguna x el comprador avise
 * urgente para que no se pida tanto a nadia como a repuestos como a mi"*. Una venta
 * cancelada que nadie avisa termina en una pieza pedida a VW para un pago que ML ya
 * devolvio: el 28-9-2026 se cancelo una venta de SEIS unidades y nadie se entero.
 */
/**
 * Fer (3-10-2026): *"ESA HAY Q SEGUIRLA CUANDO PASE ALGO ASI ACTIVA ALGUN TIPO DE
 * SEGUIMIENTO Y PASALE A NADIA QUE VAYA CHEQUEANDO EN FUNCION DEL ESTADO Y ANDA
 * CHEQUEANDO EN ML"*. Una venta cancelada DESPUES de despachar deja la pieza adentro
 * de la red de ML y nadie la sigue: el sensor `JZZ957827` ($48.688 de costo) quedo
 * asi el 2-10-2026, sin devolucion registrada y con la salida ya facturada.
 *
 * Este aviso sale una vez por dia habil por cada pieza sin volver, y cada vez que ML
 * cambia el estado del envio. Se corta solo cuando la pieza reingresa al deposito.
 */
const TEMPLATE_DEVOLUCION_COMPONENTS = [
  {
    type: "BODY",
    text:
      "Hola {{1}}! Seguimiento de una pieza que se despacho y la venta se cancelo: {{2}}.\n\nComo viene en Mercado Libre: {{3}}\n\n{{4}}\n\nEste aviso se repite una vez por dia habil hasta que la pieza vuelva al deposito.",
    example: {
      body_text: [[
        "Nadia",
        "1 x Sensor De Velocidad Gol G2 G3 G4 Original Vw JZZ957827 - MLA2134696777",
        "el envio figura cancelado (service_unavailable) y ML todavia no registro la devolucion - van 2 dias",
        "Entra a Mercado Libre, en Ventas, y reclama la devolucion del paquete. Cuando la pieza vuelva al deposito el aviso se corta solo.",
      ]],
    },
  },
];

const TEMPLATE_CANCELADA_COMPONENTS = [
  {
    type: "BODY",
    text:
      "Hola {{1}}! SE CANCELO una venta de Mercado Libre: {{2}}.\n\n{{3}}\n\nNO hay que despacharla.",
    example: {
      body_text: [[
        "Nadia",
        "6 x Grapa Clip Manguera Intercooler Vw Golf Bora 1J0145769G",
        "Se habia vendido el 28-09 a las 08:06 por $47.622 en total - el comprador cancelo y ML devolvio el pago - estaba en el deposito, no hay nada que pedir: solo no despacharla - MLA2116303981",
      ]],
    },
  },
];

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
// Un particular contestó la oferta que le dejamos en su aviso (solapa Compra ML
// del tasador). Es lo contrario de `pregunta`: ahí alguien nos pregunta a
// nosotros; acá contestaron lo que preguntamos nosotros. Por eso template y
// destinatarios propios: el aviso va a Fer, no a Nadia, y manda al tasador.
const TEMPLATE_COMPRA_COMPONENTS = [
  {
    type: "BODY",
    text:
      "Hola {{1}}! Un dueno contesto interesado por su usado: {{2}}.\n\n{{3}}\n\nEntra al CRM, solapa Usados, para seguirlo.",
    example: {
      body_text: [[
        "Ines",
        "Volkswagen Gol Trend 2019 1.6 Trendline - le ofrecimos 14.600.000",
        'Contesto: "Lo puedo vender en ese precio"\n\nAviso: https://auto.mercadolibre.com.ar/MLA-2076336993-_JM',
      ]],
    },
  },
];

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

// {{1}} primer nombre · {{2}} el aviso · {{3}} hace cuánto · {{4}} la pregunta.
const TEMPLATE_RECORDATORIO_COMPONENTS = [
  {
    type: "BODY",
    text:
      "Hola {{1}}! La pregunta de Mercado Libre sobre {{2}} sigue sin responder hace {{3}}.\n\nPregunta: {{4}}\n\nEntra a la cuenta de Mercado Libre, en Preguntas, y respondela. El control se repite cada 6 horas habiles hasta que tenga respuesta.",
    example: {
      body_text: [[
        "Nadia",
        "Filtro De Aceite Original Vw 04E115561T · MLA3968577738",
        "2 horas habiles",
        "Hola, le sirve a un Polo 2019 1.6 MSI?",
      ]],
    },
  },
];

// {{1}} primer nombre · {{2}} el aviso · {{3}} la pregunta.
// Igual que TEMPLATE_PREGUNTA pero sin mandar a Mercado Libre: el destinatario
// no tiene la cuenta, contesta y Fer publica.
const TEMPLATE_DERIVADA_COMPONENTS = [
  {
    type: "BODY",
    text:
      "Hola {{1}}! Entro una pregunta en Mercado Libre sobre: {{2}}.\n\nPregunta: {{3}}\n\nPasale la respuesta a Fer por WhatsApp y el la publica en Mercado Libre.",
    example: {
      body_text: [[
        "Maxi",
        "Filtro De Aceite Original Vw 04E115561T \u00b7 MLA3968577738",
        "Hola, le sirve a un Polo 2019 1.6 MSI?",
      ]],
    },
  },
];

// {{1}} primer nombre · {{2}} el aviso · {{3}} hace cuánto · {{4}} la pregunta.
const TEMPLATE_DERIVADA_RECORDATORIO_COMPONENTS = [
  {
    type: "BODY",
    text:
      "Hola {{1}}! La pregunta de Mercado Libre sobre {{2}} sigue sin responder hace {{3}}.\n\nPregunta: {{4}}\n\nPasale la respuesta a Fer por WhatsApp y el la publica. El control se repite cada 6 horas habiles hasta que tenga respuesta.",
    example: {
      body_text: [[
        "Maxi",
        "Filtro De Aceite Original Vw 04E115561T \u00b7 MLA3968577738",
        "2 horas habiles",
        "Hola, le sirve a un Polo 2019 1.6 MSI?",
      ]],
    },
  },
];

// {{1}} primer nombre · {{2}} saldo disponible · {{3}} tope.
// Redacción pensada para caer en UTILITY: una anomalía concreta de un registro
// propio y qué hacer con ella. Ver reference_whatsapp_template_utility: las
// palabras "novedad", "nueva", "circular" empujan el template a MARKETING, y un
// template MARKETING se acepta por API pero no se entrega.
const TEMPLATE_REPARTO_COMPONENTS = [
  {
    type: "BODY",
    text:
      "Hola {{1}}! La unidad {{2}} figura comprada en el reparto de VW y todavia no tiene factura de VW cargada.\n\n{{3}}\n\nHay que reclamarsela a VW. Este control avisa una sola vez por unidad: si sigue sin facturarse no te va a volver a escribir.",
    example: {
      body_text: [[
        "Fer",
        "T-Cross Highline Bitono 200TSI AT G1 · Blanco Marfil / Negro Universal · chasis 9BWBH6BF9V4006259",
        "Comprada el 18-09 (hace 3 dias habiles). De las 20 unidades de ese reparto, 19 ya tienen factura y esta no.",
      ]],
    },
  },
];

const TEMPLATE_SALDO_COMPONENTS = [
  {
    type: "BODY",
    text:
      "Hola {{1}}! La cuenta de Mercado Pago de la empresa tiene {{2}} de saldo disponible, por encima del tope de {{3}}.\n\nHay que transferirlo a la cuenta del Santander desde Mercado Pago, en Transferir. El control se repite una vez por dia mientras el saldo siga arriba del tope.",
    example: { body_text: [["Fer", "$15.444.606", "$100.000"]] },
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
