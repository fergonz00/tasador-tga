// Edge Function: sync-argendreams
// Puente entre el tasador de ArgenDreams (proyecto xcijbomhvwwlzgmazvep) y el
// tasador de TGA (wjfglsafgaltusmbnccl). TGA cotiza los usados VW de ArgenDreams
// como una reventa mas, pero desde su propia app.
//
// Corre por pg_cron cada 2 minutos y hace TRES pasadas en cada corrida:
//
//   1) PULL     ArgenDreams -> TGA
//      Trae las tasaciones de marca VOLKSWAGEN que Agustin ya mando a reventas
//      (estado en_reventa / precios_recibidos) y las inserta en `tasaciones` de
//      TGA con origen='argendreams' y estado='argendreams'. Ese estado propio es
//      lo que las mantiene fuera de TODOS los circuitos existentes de TGA
//      (notify-pending-sweep y notify-sin-responder filtran estado=eq.pendiente).
//      Si la tasacion ya existe, refresca los datos que ArgenDreams pudo cambiar
//      (ronda, km, estado) sin pisar el precio que cargo Fer.
//
//   2) PUSH     TGA -> ArgenDreams
//      Las que ya tienen precio cargado y todavia no se empujaron (o se editaron
//      despues del ultimo push) se escriben en `reventas_precios` de ArgenDreams
//      a nombre del usuario reventa 'tga'. Ahi entran al ranking de Agustin
//      compitiendo con las otras reventas.
//
//   3) AVISO DE ENTRADA -> WhatsApp de Fer
//      Apenas entra un VW nuevo para tasar le llega el WhatsApp con los datos
//      del auto. Es imprescindible: la ventana para cotizar en ArgenDreams es
//      de 2,9 h de mediana (y 13 de 186 cerraron en menos de UNA hora), asi que
//      sin aviso la mitad se pasa de largo. Va en una pasada aparte del PULL y
//      se sella en `externa_aviso_entrada_at`: si CallMeBot falla, la proxima
//      corrida reintenta en vez de perderse el aviso.
//
//   4) FEEDBACK ArgenDreams -> WhatsApp de Fer
//      Cuando ArgenDreams cierra la ronda (estado precio_al_vendedor o cerrada),
//      compara el precio de TGA contra el mejor de la ronda y le avisa a Fer si
//      gano o cuanto le falto. Es su termometro para saber si esta tasando bien.
//      Va por CallMeBot al numero fijo del proyecto (que es el de Fer), asi que
//      no necesita template nuevo aprobado por Meta.
//
// Deployar SIEMPRE con --no-verify-jwt: el pg_cron la llama sin header de auth.
//   supabase functions deploy sync-argendreams --no-verify-jwt
//
// Se puede invocar a mano con ?dry=1 para ver que haria SIN escribir nada.

const ARGD_URL = "https://xcijbomhvwwlzgmazvep.supabase.co";
// Publishable key de ArgenDreams. RLS esta OFF en ese proyecto (igual que en TGA),
// asi que alcanza para leer tasaciones y escribir en reventas_precios. Es la misma
// key que viaja hardcodeada en el index.html publico de tasador.argendreams.
const ARGD_KEY = "sb_publishable_NPO73kz-5gDAYeiZnmZmcA_gNe6Y31M";

// Usuario reventa con el que TGA cotiza dentro de ArgenDreams.
const ARGD_REVENTA_USUARIO = "tga";

// Marca que hoy tasa TGA. Cuando se abra a mas marcas, agregar aca.
const MARCAS = ["VOLKSWAGEN"];

// Estados de ArgenDreams en los que una tasacion esta abierta a cotizacion.
const ESTADOS_ABIERTOS = ["en_reventa", "precios_recibidos"];
// Estados en los que ArgenDreams ya definio con quien se queda.
const ESTADOS_CERRADOS = ["precio_al_vendedor", "cerrada"];

// WhatsApp por la Cloud API de Meta, igual que el resto del proyecto (mismos
// secrets WA_TASADOR_*). Dos templates propios, hay que darlos de alta una sola
// vez con ?crear_templates=1 y esperar que Meta los apruebe.
const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const WABA_ID_DEFAULT = "1183788370595856"; // WABA "Tito Gonzalez | Tasador"
const TPL_ENTRADA = "argendreams_nuevo_vw";
const TPL_RESULTADO = "argendreams_resultado";

// Quién recibe. Es info de Fer y de nadie más: sirve para saber si está tasando
// bien o corto. Se respeta el opt-out `notificaciones_wa` de la tabla.
const DESTINATARIOS = (Deno.env.get("ARGD_DESTINATARIOS") ?? "fngonzalez")
  .split(",").map((s) => s.trim()).filter(Boolean);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const TGA_URL = Deno.env.get("SUPABASE_URL");
  const TGA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!TGA_URL || !TGA_KEY) return json({ error: "SUPABASE env vars missing" }, 500);

  const params = new URL(req.url).searchParams;
  const dry = params.get("dry") === "1";

  try {
    if (params.get("listar") === "1") return json(await listarTemplates());
    if (params.get("crear_templates") === "1") return json(await crearTemplates());
    const reventaId = await getReventaId();
    if (!reventaId) {
      return json({
        error: "No existe el usuario reventa '" + ARGD_REVENTA_USUARIO + "' en ArgenDreams. " +
               "Hay que darlo de alta antes de que el puente funcione.",
      }, 412);
    }

    const pull = await pasoPull(TGA_URL, TGA_KEY, dry);
    const push = await pasoPush(TGA_URL, TGA_KEY, reventaId, dry);
    const aviso = await pasoAvisoEntrada(TGA_URL, TGA_KEY, dry);
    const feedback = await pasoFeedback(TGA_URL, TGA_KEY, reventaId, dry);

    return json({ dry, reventa_id: reventaId, pull, push, aviso, feedback });
  } catch (e) {
    return json({ error: String(e && (e as Error).message || e) }, 500);
  }
});

// ---------------------------------------------------------------- paso 1: PULL

async function pasoPull(tgaUrl: string, tgaKey: string, dry: boolean) {
  const marcaFiltro = MARCAS.map((m) => '"' + m + '"').join(",");
  const path = "tasaciones?select=*" +
    "&usado_marca=in.(" + encodeURIComponent(marcaFiltro) + ")" +
    "&estado=in.(" + ESTADOS_ABIERTOS.join(",") + ")" +
    "&order=created_at.desc&limit=100";
  const abiertas = await argd(path);
  if (!Array.isArray(abiertas) || abiertas.length === 0) {
    return { revisadas: 0, nuevas: 0, actualizadas: 0 };
  }

  // Que tenemos ya espejado de ese lote
  const ids = abiertas.map((t: any) => '"' + t.id + '"').join(",");
  const yaEspejadas = await tga(tgaUrl, tgaKey,
    "tasaciones?origen=eq.argendreams&origen_ref_id=in.(" + encodeURIComponent(ids) + ")" +
    "&select=id,origen_ref_id,externa_ronda,externa_estado_origen,kilometros");
  const porRef = new Map<string, any>((yaEspejadas || []).map((t: any) => [t.origen_ref_id, t]));

  let nuevas = 0, actualizadas = 0;
  const detalle: any[] = [];

  for (const t of abiertas) {
    const espejo = porRef.get(t.id);

    if (!espejo) {
      if (!dry) await tga(tgaUrl, tgaKey, "tasaciones", "POST", [filaEspejo(t)]);
      nuevas++;
      detalle.push({ ref: t.id, accion: "nueva", modelo: t.usado_modelo, anio: t.usado_anio });
      continue;
    }

    // Ya existe: refrescamos solo lo que ArgenDreams puede haber cambiado.
    // Nunca tocamos externa_precio: ese dato es de Fer, no de ellos.
    const cambios: any = {};
    if (espejo.externa_ronda !== t.ronda_actual) cambios.externa_ronda = t.ronda_actual;
    if (espejo.externa_estado_origen !== t.estado) cambios.externa_estado_origen = t.estado;
    if (Number(espejo.kilometros) !== Number(t.usado_km)) cambios.kilometros = t.usado_km;
    if (Object.keys(cambios).length > 0) {
      cambios.origen_datos = datosOrigen(t);
      if (!dry) await tga(tgaUrl, tgaKey, "tasaciones?id=eq." + espejo.id, "PATCH", cambios);
      actualizadas++;
      detalle.push({ ref: t.id, accion: "actualizada", cambios: Object.keys(cambios) });
    }
  }

  return { revisadas: abiertas.length, nuevas, actualizadas, detalle };
}

function filaEspejo(t: any) {
  return {
    id: crypto.randomUUID(),
    origen: "argendreams",
    origen_ref_id: t.id,
    origen_datos: datosOrigen(t),
    estado: "argendreams",
    vendedor_nombre: "ArgenDreams",
    cliente_nombre: t.cliente_nombre,
    marca: t.usado_marca,
    modelo: t.usado_modelo,
    version: t.usado_version,
    anio: t.usado_anio,
    kilometros: t.usado_km,
    color: t.usado_color,
    provincia_radicacion: t.usado_provincia,
    fotos: t.fotos || [],
    externa_ronda: t.ronda_actual,
    externa_estado_origen: t.estado,
    // Blindaje extra: aunque el estado propio ya las saca de los sweepers, esto
    // las deja fuera del barrido de recordatorios pase lo que pase.
    recordatorios_enviados: 5,
    created_at: t.enviada_a_reventas_at || t.created_at,
  };
}

function datosOrigen(t: any) {
  return {
    byd_modelo: t.byd_modelo,
    byd_version: t.byd_version,
    estado: t.estado,
    ronda_actual: t.ronda_actual,
    usado_version_manual: t.usado_version_manual,
    enviada_a_reventas_at: t.enviada_a_reventas_at,
    comentarios_reventa: t.comentarios_reventa,
    analisis_fisico: t.analisis_fisico,
    peritaje_cargado_at: t.peritaje_cargado_at,
    peritaje_fotos: t.peritaje_fotos,
    sync_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- paso 2: PUSH

async function pasoPush(tgaUrl: string, tgaKey: string, reventaId: string, dry: boolean) {
  // Con precio cargado y sin empujar todavia, o editado despues del ultimo push.
  const pendientes = await tga(tgaUrl, tgaKey,
    "tasaciones?origen=eq.argendreams&externa_precio=not.is.null" +
    "&select=id,origen_ref_id,externa_precio,externa_ronda,externa_push_at,externa_precio_at,modelo,anio" +
    "&order=externa_precio_at.asc&limit=50");

  const aEmpujar = (pendientes || []).filter((t: any) =>
    !t.externa_push_at || new Date(t.externa_precio_at) > new Date(t.externa_push_at));

  let empujadas = 0;
  const detalle: any[] = [];

  for (const t of aEmpujar) {
    const fila = {
      tasacion_id: t.origen_ref_id,
      reventa_id: reventaId,
      ronda: t.externa_ronda || 1,
      precio: t.externa_precio,
      comentario: "Precio de Tito Gonzalez Automotores",
      no_interesado: false,
    };
    try {
      if (!dry) {
        // UNIQUE (tasacion_id, reventa_id, ronda) -> upsert por merge-duplicates,
        // asi editar el precio en TGA pisa el anterior en vez de duplicar la fila.
        await argd("reventas_precios?on_conflict=tasacion_id,reventa_id,ronda", "POST", [fila], {
          Prefer: "resolution=merge-duplicates,return=minimal",
        });
        await tga(tgaUrl, tgaKey, "tasaciones?id=eq." + t.id, "PATCH",
          { externa_push_at: new Date().toISOString() });
      }
      empujadas++;
      detalle.push({ ref: t.origen_ref_id, precio: t.externa_precio, modelo: t.modelo, anio: t.anio });
    } catch (e) {
      detalle.push({ ref: t.origen_ref_id, error: String(e && (e as Error).message || e) });
    }
  }

  return { candidatas: (pendientes || []).length, empujadas, detalle };
}

// ------------------------------------------------- paso 3: AVISO DE ENTRADA

// Tope por corrida: si algun dia ArgenDreams reabre un lote grande, que no se
// convierta en 20 WhatsApps seguidos.
const AVISOS_MAX_POR_CORRIDA = 5;
// Solo avisamos de lo reciente: una tasacion vieja que reaparece no es noticia.
const AVISO_VENTANA_HORAS = 24;

async function pasoAvisoEntrada(tgaUrl: string, tgaKey: string, dry: boolean) {
  const desde = new Date(Date.now() - AVISO_VENTANA_HORAS * 3600 * 1000).toISOString();
  const nuevas = await tga(tgaUrl, tgaKey,
    "tasaciones?origen=eq.argendreams&externa_aviso_entrada_at=is.null" +
    "&externa_precio=is.null" +
    "&externa_estado_origen=in.(" + ESTADOS_ABIERTOS.join(",") + ")" +
    "&created_at=gte." + encodeURIComponent(desde) +
    "&select=id,marca,modelo,version,anio,kilometros,color,provincia_radicacion,cliente_nombre,origen_datos,externa_ronda" +
    "&order=created_at.asc&limit=" + AVISOS_MAX_POR_CORRIDA);

  let avisadas = 0;
  const detalle: any[] = [];

  for (const t of (nuevas || [])) {
    const envios = await avisarFer(tgaUrl, tgaKey, TPL_ENTRADA, (nombre) => varsEntrada(t, nombre), dry);
    // Sellar SOLO si el WhatsApp salio de verdad. Si Meta lo rechaza (template
    // sin aprobar, ventana, lo que sea) queda sin sellar y la proxima corrida
    // reintenta, que es justamente el punto de tener la columna.
    const salio = envios.some((e: any) => e.estado === "enviado");
    if (!dry && salio) {
      await tga(tgaUrl, tgaKey, "tasaciones?id=eq." + t.id, "PATCH",
        { externa_aviso_entrada_at: new Date().toISOString() });
    }
    if (salio || dry) avisadas++;
    detalle.push({ id: t.id, modelo: t.modelo, anio: t.anio, envios });
  }

  return { pendientes: (nuevas || []).length, avisadas, detalle };
}

// Variables del template `argendreams_nuevo_vw`:
//   {{1}} nombre · {{2}} el auto · {{3}} ficha + cliente + avisos
function varsEntrada(t: any, nombre: string) {
  const d = t.origen_datos || {};
  const auto = [t.marca, t.modelo, t.anio].filter(Boolean).join(" ");

  const ficha = [
    t.version || null,
    t.kilometros != null ? fmt(t.kilometros) + " km" : null,
    t.color || null,
    t.provincia_radicacion || null,
  ].filter(Boolean).join(" · ");

  const extras: string[] = [];
  if (t.cliente_nombre) {
    extras.push("El cliente es " + t.cliente_nombre +
      (d.byd_modelo ? " y consulta un BYD " + d.byd_modelo : ""));
  }
  if (t.externa_ronda > 1) extras.push("OJO: es la ronda " + t.externa_ronda + ", piden mejorar el precio");
  if (d.peritaje_cargado_at) extras.push("tiene peritaje cargado");

  const detalle = [ficha, ...extras].filter(Boolean).join(". ");
  return [nombre, auto, detalle || "sin más datos cargados"];
}

// ------------------------------------------------------------ paso 4: FEEDBACK

async function pasoFeedback(tgaUrl: string, tgaKey: string, reventaId: string, dry: boolean) {
  // Cotizamos, todavia no nos avisamos el resultado.
  const cotizadas = await tga(tgaUrl, tgaKey,
    "tasaciones?origen=eq.argendreams&externa_precio=not.is.null&externa_avisado_at=is.null" +
    "&select=id,origen_ref_id,externa_precio,externa_ronda,modelo,version,anio,kilometros" +
    "&limit=50");
  if (!cotizadas || cotizadas.length === 0) return { revisadas: 0, avisadas: 0 };

  const ids = cotizadas.map((t: any) => '"' + t.origen_ref_id + '"').join(",");
  const enOrigen = await argd(
    "tasaciones?id=in.(" + encodeURIComponent(ids) + ")" +
    "&select=id,estado,ronda_actual,reventa_ganadora_id,reventa_final_id,precio_final_admin,resultado");
  const porId = new Map<string, any>((enOrigen || []).map((t: any) => [t.id, t]));

  let avisadas = 0;
  const detalle: any[] = [];

  for (const t of cotizadas) {
    const orig = porId.get(t.origen_ref_id);
    if (!orig || !ESTADOS_CERRADOS.includes(orig.estado)) continue;

    // Precios de la ronda que cotizamos, para saber contra que competimos.
    const precios = await argd(
      "reventas_precios?tasacion_id=eq." + t.origen_ref_id +
      "&ronda=eq." + (t.externa_ronda || orig.ronda_actual || 1) +
      "&no_interesado=is.false&precio=not.is.null&select=reventa_id,precio");
    const validos = (precios || []).filter((p: any) => Number(p.precio) > 1000000);
    const mejor = validos.reduce((max: number, p: any) => Math.max(max, Number(p.precio)), 0);
    const ganamos = orig.reventa_ganadora_id === reventaId || orig.reventa_final_id === reventaId;

    const mio = Number(t.externa_precio);
    const resultado = ganamos ? "ganada" : (mejor > 0 && mio >= mejor ? "empatada" : "perdida");

    // El resultado se guarda siempre (lo muestra el panel aunque el WhatsApp
    // falle); `externa_avisado_at` se agrega abajo solo si el aviso salio.
    const patch: any = {
      externa_resultado: resultado,
      externa_mejor_precio: mejor || null,
      externa_cerrada_at: new Date().toISOString(),
      externa_estado_origen: orig.estado,
    };

    const envios = await avisarFer(tgaUrl, tgaKey, TPL_RESULTADO,
      (nombre) => varsResultado(t, nombre, mio, mejor, ganamos, validos.length, orig), dry);
    const salio = envios.some((e: any) => e.estado === "enviado");
    if (salio) patch.externa_avisado_at = new Date().toISOString();
    if (!dry) await tga(tgaUrl, tgaKey, "tasaciones?id=eq." + t.id, "PATCH", patch);
    if (salio || dry) avisadas++;
    detalle.push({ ref: t.origen_ref_id, resultado, mio, mejor, envios });
  }

  return { revisadas: cotizadas.length, avisadas, detalle };
}

// Variables del template `argendreams_resultado`:
//   {{1}} nombre · {{2}} ganamos/no · {{3}} el auto · {{4}} nuestro precio · {{5}} el cierre
function varsResultado(t: any, nombre: string, mio: number, mejor: number,
                       ganamos: boolean, cuantas: number, orig: any) {
  const auto = [t.modelo, t.anio, t.kilometros ? fmt(t.kilometros) + " km" : null]
    .filter(Boolean).join(" ");

  const cierre: string[] = [];
  if (mejor > 0 && !ganamos) {
    const dif = mejor - mio;
    const pct = mio > 0 ? (dif / mio) * 100 : 0;
    cierre.push("el mejor de la ronda fue $" + fmt(mejor) +
      ", nos faltaron $" + fmt(dif) + " (" + pct.toFixed(1) + "%)");
  } else if (ganamos) {
    cierre.push("fue el precio más alto de la ronda");
  }
  cierre.push("cotizaron " + cuantas + " reventas contando la nuestra");
  if (orig && orig.precio_final_admin) {
    cierre.push("ArgenDreams le ofreció al cliente $" + fmt(Number(orig.precio_final_admin)));
  }

  return [
    nombre,
    ganamos ? "ganamos la tasación" : "no ganamos la tasación",
    auto,
    "$" + fmt(mio),
    cierre.join("; "),
  ];
}

/** Manda un template de Meta a los destinatarios (hoy, solo Fer). */
async function avisarFer(tgaUrl: string, tgaKey: string, template: string,
                         armarVars: (nombre: string) => string[], dry: boolean) {
  const WA_PHONE_ID = Deno.env.get("WA_TASADOR_PHONE_ID");
  const WA_TOKEN = Deno.env.get("WA_TASADOR_TOKEN");
  if (!WA_PHONE_ID || !WA_TOKEN) return [{ error: "WA_TASADOR env vars missing" }];

  const lista = DESTINATARIOS.map((u) => '"' + u + '"').join(",");
  const users = await tga(tgaUrl, tgaKey,
    "tasador_usuarios?usuario=in.(" + encodeURIComponent(lista) + ")" +
    "&select=usuario,nombre,telefono_wa,activo,notificaciones_wa");

  const validos = (users || []).filter((u: any) =>
    u.activo !== false && u.notificaciones_wa !== false &&
    u.telefono_wa && String(u.telefono_wa).trim().length > 0);

  const out: any[] = [];
  for (const u of validos) {
    const nombre = String(u.nombre || u.usuario).split(" ")[0];
    const vars = armarVars(nombre);
    if (dry) { out.push({ usuario: u.usuario, dry: true, vars }); continue; }

    const payload = {
      messaging_product: "whatsapp",
      to: String(u.telefono_wa).replace(/^\+/, "").replace(/[\s-]/g, ""),
      type: "template",
      template: {
        name: template,
        language: { code: META_LANGUAGE },
        components: [{ type: "body", parameters: vars.map((v) => ({ type: "text", text: String(v || "") })) }],
      },
    };
    try {
      const res = await fetch(META_API_URL + "/" + WA_PHONE_ID + "/messages", {
        method: "POST",
        headers: { Authorization: "Bearer " + WA_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      out.push(res.ok && j.messages
        ? { usuario: u.usuario, estado: "enviado", id: j.messages[0].id }
        : { usuario: u.usuario, estado: "error", detalle: j.error?.message || JSON.stringify(j) });
    } catch (e) {
      out.push({ usuario: u.usuario, estado: "error", detalle: String(e) });
    }
  }
  if (validos.length === 0) out.push({ error: "sin destinatarios con telefono_wa" });
  return out;
}

// ------------------------------------------------------- templates de Meta

async function listarTemplates() {
  const WABA_ID = Deno.env.get("WA_TASADOR_WABA_ID") ?? WABA_ID_DEFAULT;
  const WA_TOKEN = Deno.env.get("WA_TASADOR_TOKEN");
  const res = await fetch(
    META_API_URL + "/" + WABA_ID + "/message_templates?limit=100&fields=name,status,category,language",
    { headers: { Authorization: "Bearer " + WA_TOKEN } });
  const j = await res.json();
  const propios = (j.data || []).filter((t: any) => String(t.name).startsWith("argendreams_"));
  return { status: res.status, propios, total: (j.data || []).length, error: j.error };
}

async function crearTemplates() {
  const WABA_ID = Deno.env.get("WA_TASADOR_WABA_ID") ?? WABA_ID_DEFAULT;
  const WA_TOKEN = Deno.env.get("WA_TASADOR_TOKEN");

  const defs = [
    {
      name: TPL_ENTRADA,
      language: META_LANGUAGE,
      category: "UTILITY",
      components: [
        { type: "HEADER", format: "TEXT", text: "VW nuevo para tasar en ArgenDreams" },
        {
          type: "BODY",
          text: "Hola {{1}}, entró un {{2}} para tasar en ArgenDreams. {{3}}. Cargá tu precio en el tasador, solapa ArgenDreams: allá las tasaciones se cierran en unas 3 horas.",
          example: {
            body_text: [[
              "Fer",
              "VOLKSWAGEN TAOS 2022",
              "5P 1,4 TSI 250 COMFORTLINE TIPT · 67.000 km · Blanco · CABA. El cliente es Maximiliano Santos y consulta un BYD SONG PRO",
            ]],
          },
        },
        { type: "FOOTER", text: "Aviso automático · Tito Gonzalez" },
      ],
    },
    {
      name: TPL_RESULTADO,
      language: META_LANGUAGE,
      category: "UTILITY",
      components: [
        { type: "HEADER", format: "TEXT", text: "Resultado de la tasación en ArgenDreams" },
        {
          type: "BODY",
          text: "Hola {{1}}, {{2}} del {{3}}. Nuestro precio fue {{4}} y {{5}}. El detalle lo tenés en el tasador, solapa ArgenDreams.",
          example: {
            body_text: [[
              "Fer",
              "no ganamos la tasación",
              "TAOS 2022 67.000 km",
              "$31.000.000",
              "el mejor de la ronda fue $33.000.000, nos faltaron $2.000.000 (6,5%); cotizaron 5 reventas contando la nuestra",
            ]],
          },
        },
        { type: "FOOTER", text: "Aviso automático · Tito Gonzalez" },
      ],
    },
  ];

  const out: any[] = [];
  for (const def of defs) {
    const res = await fetch(META_API_URL + "/" + WABA_ID + "/message_templates", {
      method: "POST",
      headers: { Authorization: "Bearer " + WA_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(def),
    });
    out.push({ template: def.name, status: res.status, respuesta: await res.json() });
  }
  return out;
}

// ------------------------------------------------------------------- helpers

async function getReventaId(): Promise<string | null> {
  const r = await argd("usuarios?usuario=eq." + ARGD_REVENTA_USUARIO + "&rol=eq.reventa&select=id,activo");
  if (!Array.isArray(r) || r.length === 0) return null;
  return r[0].activo ? r[0].id : null;
}

async function argd(path: string, method = "GET", body?: any, extraHeaders?: Record<string, string>) {
  const res = await fetch(ARGD_URL + "/rest/v1/" + path, {
    method,
    headers: {
      apikey: ARGD_KEY,
      Authorization: "Bearer " + ARGD_KEY,
      "Content-Type": "application/json",
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("ArgD " + method + " " + path.split("?")[0] + " -> " + res.status + " " + (await res.text()));
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

async function tga(url: string, key: string, path: string, method = "GET", body?: any) {
  const res = await fetch(url + "/rest/v1/" + path, {
    method,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("TGA " + method + " " + path.split("?")[0] + " -> " + res.status + " " + (await res.text()));
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

function fmt(n: number) {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(Number(n) || 0);
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
