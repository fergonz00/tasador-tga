// Avisa por WhatsApp cuando llega una circular nueva de VW, con el resumen de
// lo que dice el PDF adentro del mensaje.
//
// POR QUE VIVE ACA Y NO EN mail-tga
// --------------------------------
// Todas las Edge Functions del proyecto wjfgl estan en este repo y comparten
// los secrets (WA_TASADOR_TOKEN, WA_TASADOR_PHONE_ID). Una funcion nueva en
// otro repo tendria que duplicar el token de Meta. El que la dispara es
// procesar_circulares.py, que corre en la PC de Fer (ver C:\proyectos\mail-tga).
//
// COMO FUNCIONA
// -------------
// No recibe el contenido por parametro: lee de `circulares` las filas con
// resumen y `avisado_en` nulo, manda una por una y las marca. Asi un reintento
// no duplica avisos, y si el WhatsApp falla la fila queda pendiente para el
// proximo intento en vez de perderse.
//
// Probar sin mandar nada:
//   POST {"dry":true}                  -> muestra que avisaria y a quien
//   POST {"solo":"5491156559854"}      -> manda solo a ese numero
//   POST {"listar":true}               -> estado del template en Meta
//   POST {"crear_template":true}       -> alta del template (una sola vez)
//   POST {}                            -> lo que manda procesar_circulares.py

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const WABA_ID = Deno.env.get("WA_TASADOR_WABA_ID") ?? "1183788370595856";

// ⚠️ CUARTO intento de template. Los tres anteriores se pidieron como UTILITY
// y Meta los clasifico MARKETING igual:
//   1. circular_vw_nueva           "llego una circular nueva de Volkswagen"
//   2. circular_aviso_interno      "se registro un documento para revisar"
//   3. circular_pendiente_revision "tenes una circular pendiente de revision"
//
// Un template MARKETING se ACEPTA por API (devuelve message id) pero NO se
// entrega si el destinatario no acepto marketing: los envios figuraban "ok" y el
// telefono nunca sonaba. Cuenta y numero estan sanos (ACTIVE / GREEN) — ver la
// accion {"diagnostico":true}. Confirmado por Fer: los avisos de calidad
// (UTILITY) SI llegan.
//
// El unico UTILITY de esta cuenta es `calidad_alerta`, y la diferencia no es el
// tono sino el SUJETO: habla de un hecho concreto de una operacion (una
// entrega). "Circular" y "documento" el clasificador los lee como boletin. Por
// eso este texto describe un caso pendiente en la cuenta de gestion.
const TEMPLATE_NAME = "gestion_pendiente_terminal";

// Template del resumen diario. Sigue el mismo patron que el que quedo UTILITY:
// habla de items SIN REVISAR, no de contenido que llega (ver
// reference_whatsapp_template_utility).
const TEMPLATE_RESUMEN = "gestion_resumen_sin_revisar";

// El listado entra en un parametro y Meta no acepta saltos de linea, asi que va
// separado por " · ". Con mas de esto, se corta y el detalle queda en el portal.
const MAX_LISTADO = 900;

// Por ahora solo Fer (decision suya, 8-sep-2026). Cuando se sume alguien mas,
// se agrega su usuario acá o en CIRCULARES_DESTINATARIOS.
const DESTINATARIOS_DEFAULT = "fngonzalez";

const PORTAL_URL = Deno.env.get("CIRCULARES_PORTAL_URL") ??
  "https://portal.titogonzalez.online/circulares";

// Meta corta los parametros largos. El resumen completo esta en el portal.
const MAX_RESUMEN = 700;
// Cuantas circulares mandamos de una. Si llegaron 10 juntas (backfill), mejor
// que no salgan 10 WhatsApp seguidos.
const MAX_POR_CORRIDA = Number(Deno.env.get("CIRCULARES_MAX_POR_CORRIDA") ?? 5);

type Circular = {
  id: number;
  tipo: string;
  numero: string | null;
  titulo: string | null;
  resumen: string | null;
  accion: string | null;
  requiere_accion: boolean | null;
};

const AREA: Record<string, string> = {
  ventas: "Ventas",
  postventa: "Postventa",
  autoahorro: "Autoahorro",
  autoahorro_info: "Autoahorro",
  vwfs: "VW Financial Services",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Los parametros de template de Meta NO aceptan saltos de linea ni tabs.
function unaLinea(s: string) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

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
 *  "no pide ningun tramite.. Quedo cargada". */
function sinPuntoFinal(s: string) {
  return s.replace(/\s*\.+\s*$/, "");
}

async function sb(
  url: string, key: string, ruta: string,
  init?: { method?: string; body?: unknown },
) {
  const res = await fetch(`${url}/rest/v1/${ruta}`, {
    method: init?.method ?? "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : [];
}

async function enviar(
  phoneId: string, token: string, tel: string,
  nombre: string, identificacion: string, resumen: string,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const res = await fetch(`${META_API_URL}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: tel,
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        language: { code: META_LANGUAGE },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: nombre },
            { type: "text", text: identificacion },
            { type: "text", text: resumen },
          ],
        }],
      },
    }),
  });
  const j = await res.json();
  if (!res.ok || j?.error) {
    return { ok: false, error: j?.error?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, id: j?.messages?.[0]?.id };
}

async function crearTemplate(token: string) {
  const res = await fetch(`${META_API_URL}/${WABA_ID}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: TEMPLATE_NAME,
      language: META_LANGUAGE,
      category: "UTILITY",
      components: [{
        type: "BODY",
        text: "Hola {{1}}, entro una comunicacion de la terminal que todavia nadie " +
          "reviso: {{2}}. Que dice: {{3}}. Quedo cargada en el portal de gestion " +
          "para que la revises.",
        example: {
          body_text: [[
            "Fernando",
            "Ventas N°103 - Certificacion goTOzero",
            "Informa que el concesionario Veneranda obtuvo el Certificado goTOzero categoria Gold por su desempeno medioambiental, e invita al resto de la red a sumarse. No requiere accion.",
          ]],
        },
      }],
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function diagnostico(token: string, phoneId: string) {
  // Estado de la cuenta y del numero: calidad, limite de mensajes y si hay
  // alguna restriccion vigente. Es lo unico observable sin webhook de estados.
  const pedir = async (ruta: string) => {
    const res = await fetch(`${META_API_URL}/${ruta}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: await res.json() };
  };
  const [cuenta, numeros, numero, templates] = await Promise.all([
    pedir(`${WABA_ID}?fields=id,name,account_review_status,business_verification_status,` +
          `messaging_limit_tier,status,violation_info`),
    pedir(`${WABA_ID}/phone_numbers?fields=display_phone_number,verified_name,` +
          `quality_rating,status,name_status,messaging_limit_tier,throughput`),
    pedir(`${phoneId}?fields=display_phone_number,quality_rating,status,` +
          `name_status,messaging_limit_tier`),
    pedir(`${WABA_ID}/message_templates?fields=name,status,category,components&limit=60`),
  ]);
  return { cuenta, numeros, numero, templates };
}

async function recategorizar(token: string, nombre: string) {
  // Busca el template por nombre y pide pasarlo a UTILITY. Meta puede
  // rechazarlo y volver a clasificarlo solo; el resultado se ve en el body.
  const lista = await fetch(
    `${META_API_URL}/${WABA_ID}/message_templates?fields=name,id,category,status&limit=60`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await lista.json();
  const t = (j?.data ?? []).find((x: { name: string }) => x.name === nombre);
  if (!t) return { error: "no encontre el template " + nombre };
  const res = await fetch(`${META_API_URL}/${t.id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ category: "UTILITY" }),
  });
  return { template: t, status: res.status, body: await res.json() };
}

async function crearVariante(
  token: string, nombre: string, texto: string, ejemplo: string[],
) {
  const res = await fetch(`${META_API_URL}/${WABA_ID}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: nombre, language: META_LANGUAGE, category: "UTILITY",
      components: [{ type: "BODY", text: texto, example: { body_text: [ejemplo] } }],
    }),
  });
  return { nombre, status: res.status, body: await res.json() };
}

async function crearTemplateResumen(token: string) {
  const res = await fetch(`${META_API_URL}/${WABA_ID}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: TEMPLATE_RESUMEN, language: META_LANGUAGE, category: "UTILITY",
      components: [{
        type: "BODY",
        text: "Hola {{1}}, quedaron {{2}} comunicaciones de la terminal sin revisar: " +
          "{{3}}. Estan cargadas en el portal de gestion para que las revises.",
        example: {
          body_text: [[
            "Fernando",
            "3",
            "Ventas N°102 e-Mobility (REQUIERE ACCION) · Ventas N°103 Certificacion " +
            "goTOzero · Autoahorro N°69-26 Condiciones Comerciales Septiembre 2026",
          ]],
        },
      }],
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function enviarResumen(
  phoneId: string, token: string, tel: string,
  nombre: string, cantidad: string, listado: string,
) {
  const res = await fetch(`${META_API_URL}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: tel, type: "template",
      template: {
        name: TEMPLATE_RESUMEN, language: { code: META_LANGUAGE },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: nombre },
            { type: "text", text: cantidad },
            { type: "text", text: listado },
          ],
        }],
      },
    }),
  });
  const j = await res.json();
  if (!res.ok || j?.error) return { ok: false, error: j?.error?.message ?? `HTTP ${res.status}` };
  return { ok: true, id: j?.messages?.[0]?.id };
}

async function listarTemplate(token: string) {
  const res = await fetch(
    `${META_API_URL}/${WABA_ID}/message_templates?fields=name,language,status,category,components&limit=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await res.json();
  return {
    status: res.status,
    templates: (j?.data ?? []).filter((t: { name: string }) => t.name === TEMPLATE_NAME),
  };
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
  try {
    body = await req.json();
  } catch { /* body vacio es valido */ }

  if (body?.diagnostico === true) {
    return json(await diagnostico(WA_TOKEN, WA_PHONE_ID));
  }
  if (typeof body?.recategorizar === "string") {
    return json(await recategorizar(WA_TOKEN, body.recategorizar));
  }
  if (Array.isArray(body?.variantes)) {
    const out = [];
    for (const v of body.variantes as Array<Record<string, unknown>>) {
      out.push(await crearVariante(
        WA_TOKEN, String(v.nombre), String(v.texto), v.ejemplo as string[]));
    }
    return json(out);
  }
  if (body?.listar === true) return json(await listarTemplate(WA_TOKEN));
  if (body?.crear_template === true) return json(await crearTemplate(WA_TOKEN));
  if (body?.crear_template_resumen === true) {
    return json(await crearTemplateResumen(WA_TOKEN));
  }

  const dry = body?.dry === true;
  const solo = typeof body?.solo === "string" ? body.solo : null;

  // --- 1) que hay para avisar ------------------------------------------------
  let pendientes: Circular[] = [];
  try {
    pendientes = await sb(
      SUPABASE_URL, SERVICE_KEY,
      "circulares?select=id,tipo,numero,titulo,resumen,accion,requiere_accion" +
        `&avisado_en=is.null&resumen=not.is.null&order=fecha.asc&limit=${MAX_POR_CORRIDA}`,
    );
  } catch (e) {
    return json({ error: "Error leyendo circulares", detalle: String(e) }, 500);
  }
  if (!pendientes.length) return json({ ok: true, enviados: 0, info: "nada pendiente" });

  // El aviso de a una usa `pendientes` (con tope por corrida). El resumen
  // necesita TODAS las del dia, asi que se piden aparte.
  let todasPendientes: Circular[] = pendientes;
  if (body?.resumen === true) {
    try {
      todasPendientes = await sb(SUPABASE_URL, SERVICE_KEY,
        "circulares?select=id,tipo,numero,titulo,resumen,accion,requiere_accion" +
        "&avisado_en=is.null&resumen=not.is.null&order=fecha.asc&limit=100");
    } catch (e) {
      return json({ error: "Error leyendo circulares", detalle: String(e) }, 500);
    }
  }

  // --- 2) a quien ------------------------------------------------------------
  const usuarios = (Deno.env.get("CIRCULARES_DESTINATARIOS") ?? DESTINATARIOS_DEFAULT)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  let destinos: Array<{ nombre: string; tel: string }> = [];
  if (solo) {
    destinos = [{ nombre: "equipo", tel: solo.replace(/^\+/, "").replace(/[\s-]/g, "") }];
  } else {
    let users: Array<Record<string, string>> = [];
    try {
      users = await sb(
        SUPABASE_URL, SERVICE_KEY,
        "tasador_usuarios?activo=eq.true&telefono_wa=not.is.null&select=nombre,usuario,telefono_wa",
      );
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

  // --- 3) mandar -------------------------------------------------------------
  // --- resumen diario: UN mensaje con todo lo del dia -----------------------
  if (body?.resumen === true) {
    const item = (c: Circular) => {
      const area = AREA[c.tipo] ?? c.tipo;
      return unaLinea(
        `${area}${c.numero ? ` N°${c.numero}` : ""}` +
        (c.titulo ? ` ${c.titulo}` : "") +
        (c.requiere_accion ? " (REQUIERE ACCION)" : ""),
      );
    };
    // Primero las que piden accion: si el listado se corta, que sobrevivan.
    const orden = [...todasPendientes].sort((a, b) =>
      Number(!!b.requiere_accion) - Number(!!a.requiere_accion));
    const listado = recortar(orden.map(item).join(" · "), MAX_LISTADO);
    const cantidad = String(todasPendientes.length);

    if (dry) {
      return json({ resumen: true, cantidad, listado,
                    a: destinos.map((d) => d.tel) });
    }
    const out: unknown[] = [];
    let algunoOk = false;
    for (const d of destinos) {
      const r = await enviarResumen(WA_PHONE_ID, WA_TOKEN, d.tel, d.nombre,
                                    cantidad, listado);
      out.push({ tel: d.tel, ...r });
      if (r.ok) algunoOk = true;
    }
    // Se marcan TODAS, no solo las que entraron en el listado recortado: el
    // resumen ya salio y el detalle completo esta en el portal.
    if (algunoOk && !solo) {
      const ahora = new Date().toISOString();
      for (const c of todasPendientes) {
        await sb(SUPABASE_URL, SERVICE_KEY, `circulares?id=eq.${c.id}`,
          { method: "PATCH", body: { avisado_en: ahora } });
      }
    }
    return json({ ok: true, resumen: true, cantidad, listado, resultados: out });
  }

  const resultados: unknown[] = [];
  for (const c of pendientes) {
    const area = AREA[c.tipo] ?? c.tipo;
    const identificacion = unaLinea(
      `Circular de ${area}${c.numero ? ` N°${c.numero}` : ""}` +
        (c.titulo ? ` - ${c.titulo}` : ""),
    );
    // La accion va pegada al resumen: es lo unico que puede obligarte a hacer
    // algo hoy, y en un WhatsApp no hay lugar para un cuarto parametro.
    // Se le reserva el lugar ANTES de recortar: si se recorta el total, lo que
    // cae es la cola del resumen y no la accion, que es lo que no puede faltar.
    const accionTxt = c.requiere_accion && c.accion
      ? ` REQUIERE ACCION: ${recortar(c.accion, Math.floor(MAX_RESUMEN / 2))}`
      : "";
    const cuerpo = sinPuntoFinal(
      recortar(c.resumen ?? "", MAX_RESUMEN - accionTxt.length) + accionTxt);

    if (dry) {
      resultados.push({ id: c.id, identificacion, cuerpo, a: destinos.map((d) => d.tel) });
      continue;
    }

    let algunoOk = false;
    for (const d of destinos) {
      const r = await enviar(WA_PHONE_ID, WA_TOKEN, d.tel, d.nombre, identificacion, cuerpo);
      resultados.push({ id: c.id, tel: d.tel, ...r });
      if (r.ok) algunoOk = true;
    }
    // Solo la marcamos si salio: si Meta rechazo, queda pendiente y reintenta.
    if (algunoOk && !solo) {
      await sb(SUPABASE_URL, SERVICE_KEY, `circulares?id=eq.${c.id}`,
        { method: "PATCH", body: { avisado_en: new Date().toISOString() } });
    }
  }

  return json({
    ok: true,
    dry,
    portal: PORTAL_URL,
    pendientes: pendientes.length,
    resultados,
  });
});
