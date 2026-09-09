// Avisa por WhatsApp cuando una encuesta de calidad prende una alerta.
//
// QUE DISPARA UNA ALERTA (pedido de Fer, 8-sep-2026)
// -------------------------------------------------
// 1. El cliente reporto un problema (clase problema o mixto, leido del texto).
// 2. Cualquier pregunta contestada con 3 o menos.
// 3. La planilla lo marco como "relevante" (esos son casi siempre problemas).
//
// El calculo NO vive aca: `calidad_encuestas.alerta` ya viene resuelta desde
// procesar_calidad.py y clasificar_comentarios.py, asi que el portal y el
// WhatsApp muestran exactamente lo mismo.
//
// COMO FUNCIONA
// -------------
// Lee las filas con alerta y `alerta_avisada_en` nulo, manda una por una y las
// marca. Un reintento no duplica; si Meta falla, la fila queda pendiente.
//
//   POST {"dry":true}              -> muestra que avisaria
//   POST {"solo":"549115..."}      -> manda solo a ese numero
//   POST {"listar":true}           -> estado del template
//   POST {"crear_template":true}   -> alta del template (una sola vez)
//   POST {}                        -> lo que manda procesar_calidad.py

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const WABA_ID = Deno.env.get("WA_TASADOR_WABA_ID") ?? "1183788370595856";

const TEMPLATE_NAME = "calidad_alerta";
const DESTINATARIOS_DEFAULT = "fngonzalez";
const PORTAL_URL = Deno.env.get("CALIDAD_PORTAL_URL") ?? "https://calidad.titogonzalez.online";

// Meta corta los parametros largos; el detalle completo esta en el portal.
const MAX_DETALLE = 700;
// Si se acumularon muchas (por ejemplo tras una recarga historica), no salen
// todas de golpe.
const MAX_POR_CORRIDA = Number(Deno.env.get("CALIDAD_MAX_POR_CORRIDA") ?? 4);

type Alerta = {
  id: number;
  cliente: string | null;
  modelo: string | null;
  color: string | null;
  patente: string | null;
  chasis: string | null;
  pv: string | null;
  tipo_operacion: string | null;
  fecha_entrega: string | null;
  vendedor: string | null;
  administrativo: string | null;
  asesor_entrega: string | null;
  operadora: string | null;
  promedio: number | null;
  clase: string | null;
  severidad: string | null;
  area_problema: string | null;
  responsable: string | null;
  resumen_ia: string | null;
  comentario_texto: string | null;
  alerta_motivo: string | null;
  preguntas_bajas: { pregunta: string; valor: string }[];
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { "Content-Type": "application/json" },
  });
}

// Los parametros de template de Meta NO aceptan saltos de linea ni tabs.
const unaLinea = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();

function recortar(s: string, max: number) {
  const t = unaLinea(s);
  if (t.length <= max) return t;
  const corte = t.slice(0, max);
  // 1) Preferimos cortar en la ultima oracion entera que entre.
  const punto = corte.lastIndexOf(". ");
  if (punto > max * 0.5) return corte.slice(0, punto + 1);
  // 2) Si no hay, al menos en la ultima palabra entera.
  const espacio = corte.lastIndexOf(" ");
  return (espacio > 0 ? corte.slice(0, espacio) : corte.trimEnd()) + "...";
}

/** El template ya cierra la frase con un punto: si el texto trae el suyo queda
 *  un doble punto. */
function sinPuntoFinal(s: string) {
  return s.replace(/\s*\.+\s*$/, "");
}

const fecha = (s: string | null) =>
  !s ? "" : s.split("-").reverse().join("/");

async function sb(url: string, key: string, ruta: string,
                  init?: { method?: string; body?: unknown }) {
  const res = await fetch(`${url}/rest/v1/${ruta}`, {
    method: init?.method ?? "GET",
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : [];
}

async function enviar(phoneId: string, token: string, tel: string,
                      nombre: string, unidad: string, quienes: string, detalle: string) {
  const res = await fetch(`${META_API_URL}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: tel, type: "template",
      template: {
        name: TEMPLATE_NAME, language: { code: META_LANGUAGE },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: nombre },
            { type: "text", text: unidad },
            { type: "text", text: quienes },
            { type: "text", text: detalle },
          ],
        }],
      },
    }),
  });
  const j = await res.json();
  if (!res.ok || j?.error) return { ok: false, error: j?.error?.message ?? `HTTP ${res.status}` };
  return { ok: true, id: j?.messages?.[0]?.id };
}

async function crearTemplate(token: string) {
  const res = await fetch(`${META_API_URL}/${WABA_ID}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: TEMPLATE_NAME, language: META_LANGUAGE, category: "UTILITY",
      components: [{
        type: "BODY",
        text: "Hola {{1}}, hay una alerta de calidad en una entrega. Unidad: {{2}}. " +
          "Atendieron: {{3}}. Que paso: {{4}}. El detalle completo esta en el portal de Tito Gonzalez.",
        example: {
          body_text: [[
            "Fernando",
            "MARIA SIMONOVICH - VW T-Cross Comfortline 200TSI AT, Gris Platino, patente AI376WH, PV 8759/3, entregada el 31/08/2026",
            "vendedor TG, administracion ANTONELLA, entrega CAMILA, llamo Alicia",
            "Problema de severidad media en entrega. Le entregaron la camioneta con el capot rayado y ya es reiterado. Puntajes bajos: 6 - Usted realizo la PM? = 2",
          ]],
        },
      }],
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function listarTemplate(token: string) {
  const res = await fetch(
    `${META_API_URL}/${WABA_ID}/message_templates?fields=name,language,status,category&limit=200`,
    { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  return { status: res.status, templates: (j?.data ?? []).filter((t: { name: string }) => t.name === TEMPLATE_NAME) };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Usar POST" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const WA_PHONE_ID = Deno.env.get("WA_TASADOR_PHONE_ID");
  const WA_TOKEN = Deno.env.get("WA_TASADOR_TOKEN");
  const SECRET = Deno.env.get("STOCK_NOTIF_SECRET");
  if (!SUPABASE_URL || !SERVICE_KEY || !WA_PHONE_ID || !WA_TOKEN) {
    return json({ error: "Faltan variables de entorno" }, 500);
  }
  if (SECRET && req.headers.get("x-stock-secret") !== SECRET) {
    return json({ error: "No autorizado" }, 401);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* body vacio es valido */ }

  if (body?.listar === true) return json(await listarTemplate(WA_TOKEN));
  if (body?.crear_template === true) return json(await crearTemplate(WA_TOKEN));

  const dry = body?.dry === true;
  const solo = typeof body?.solo === "string" ? body.solo : null;

  let pendientes: Alerta[] = [];
  try {
    pendientes = await sb(SUPABASE_URL, SERVICE_KEY,
      "calidad_encuestas?select=id,cliente,modelo,color,patente,chasis,pv,tipo_operacion," +
      "fecha_entrega,vendedor,administrativo,asesor_entrega,operadora,promedio,clase," +
      "severidad,area_problema,responsable,resumen_ia,comentario_texto,alerta_motivo," +
      "preguntas_bajas&alerta=is.true&alerta_avisada_en=is.null" +
      `&order=fecha_entrega.desc&limit=${MAX_POR_CORRIDA}`);
  } catch (e) {
    return json({ error: "Error leyendo alertas", detalle: String(e) }, 500);
  }
  if (!pendientes.length) return json({ ok: true, enviados: 0, info: "nada pendiente" });

  const usuarios = (Deno.env.get("CALIDAD_DESTINATARIOS") ?? DESTINATARIOS_DEFAULT)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  let destinos: Array<{ nombre: string; tel: string }> = [];
  if (solo) {
    destinos = [{ nombre: "equipo", tel: solo.replace(/^\+/, "").replace(/[\s-]/g, "") }];
  } else {
    let users: Array<Record<string, string>> = [];
    try {
      users = await sb(SUPABASE_URL, SERVICE_KEY,
        "tasador_usuarios?activo=eq.true&telefono_wa=not.is.null&select=nombre,usuario,telefono_wa");
    } catch (e) {
      return json({ error: "Error leyendo usuarios", detalle: String(e) }, 500);
    }
    const vistos = new Set<string>();
    for (const u of users) {
      if (!usuarios.includes((u.usuario ?? "").toLowerCase())) continue;
      const tel = (u.telefono_wa ?? "").replace(/^\+/, "").replace(/[\s-]/g, "");
      if (!tel || vistos.has(tel)) continue;
      vistos.add(tel);
      destinos.push({ nombre: (u.nombre ?? "").split(" ")[0] || "equipo", tel });
    }
  }
  if (!destinos.length) return json({ error: "Sin destinatarios con telefono_wa" }, 500);

  const resultados: unknown[] = [];
  for (const a of pendientes) {
    const unidad = unaLinea([
      a.cliente,
      [a.modelo, a.color].filter(Boolean).join(", "),
      a.patente ? `patente ${a.patente}` : "",
      a.pv ? `PV ${a.pv}` : "",
      a.tipo_operacion ? `(${a.tipo_operacion})` : "",
      a.fecha_entrega ? `entregada el ${fecha(a.fecha_entrega)}` : "",
    ].filter(Boolean).join(" - "));

    const quienes = unaLinea([
      a.vendedor ? `vendedor ${a.vendedor}` : "",
      a.administrativo ? `administracion ${a.administrativo}` : "",
      a.asesor_entrega ? `entrega ${a.asesor_entrega}` : "",
      a.operadora ? `llamo ${a.operadora}` : "",
    ].filter(Boolean).join(", ")) || "sin datos de quien atendio";

    // El detalle prioriza el resumen de lo que paso; los puntajes bajos van
    // despues, y se recortan primero si no entra todo.
    const bajas = (a.preguntas_bajas ?? [])
      .map((p) => `${unaLinea(p.pregunta).slice(0, 60)} = ${p.valor}`).join("; ");
    const cabeza = [
      a.severidad ? `Severidad ${a.severidad}` : null,
      a.area_problema ? `en ${a.area_problema}` : null,
      a.responsable && a.responsable !== "tga" && a.responsable !== "indistinto"
        ? `(responsable: ${a.responsable})` : null,
    ].filter(Boolean).join(" ");
    const cuerpo = a.resumen_ia || a.comentario_texto || "";
    const partes = sinPuntoFinal([cabeza, cuerpo].filter(Boolean).join(". "));
    const conBajas = bajas ? `${partes}${partes ? ". " : ""}Puntajes bajos: ${bajas}` : partes;
    const detalle = sinPuntoFinal(recortar(
      conBajas || `Alerta por ${a.alerta_motivo ?? "revisar"}`, MAX_DETALLE));

    if (dry) {
      resultados.push({ id: a.id, motivo: a.alerta_motivo, unidad, quienes, detalle,
                        a: destinos.map((d) => d.tel) });
      continue;
    }

    let algunoOk = false;
    for (const d of destinos) {
      const r = await enviar(WA_PHONE_ID, WA_TOKEN, d.tel, d.nombre, unidad, quienes, detalle);
      resultados.push({ id: a.id, tel: d.tel, ...r });
      if (r.ok) algunoOk = true;
    }
    if (algunoOk && !solo) {
      await sb(SUPABASE_URL, SERVICE_KEY, `calidad_encuestas?id=eq.${a.id}`,
        { method: "PATCH", body: { alerta_avisada_en: new Date().toISOString() } });
    }
  }

  return json({ ok: true, dry, portal: PORTAL_URL, pendientes: pendientes.length, resultados });
});
