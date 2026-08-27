// Edge Function: notify-feed
//
// Los DOS unicos avisos automaticos del plan del feed de Instagram (ver
// project_plan_semanal_feed_dominique). Los dos van a Fer y a nadie mas:
//
//   tipo="estado"    lun/mie/vie 18:00 AR (21:00 UTC) -> "se subio algo" o
//                    "no se subio nada". Nada mas: ni que pieza, ni chequeos.
//   tipo="comercial" viernes 9:00 AR (12:00 UTC) -> recordatorio de armar la
//                    pieza comercial que se publica el lunes.
//
// Como sabe si se subio: scrapea el perfil con Apify (`resultsType: "details"`,
// ~8 s y menos de un centavo por corrida) y mira si hay algun posteo con fecha
// de HOY en Argentina.
//
// GOTCHAS medidos el 27-ago-2026, no volver a tropezar:
//  - Apify NO devuelve los posteos en orden cronologico. `latestPosts` arranca
//    con los FIJADOS (@titogonzalezvw tiene 3 fijados de enero-2026), asi que
//    hay que ordenar por timestamp a mano. Pedir `resultsLimit: 1` devuelve el
//    posteo mas VIEJO, no el mas nuevo.
//  - `resultsType: "posts"` tarda el doble y cuesta mas. Para esto alcanza
//    "details", que ademas trae followersCount y postsCount gratis.
//
// Idempotencia: una fila por (fecha, tipo) en `feed_avisos`. Si ya se mando, no
// se repite aunque el cron corra dos veces.
//
// Probar sin mandar nada:
//   POST {"tipo":"estado","dry":true}

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const WABA_ID = Deno.env.get("WA_TASADOR_WABA_ID") ?? "1183788370595856";

const TPL_ESTADO = "feed_estado_diario";
const TPL_COMERCIAL = "feed_armar_comercial";
// ⚠️ NO hay template de respaldo, y es a proposito. El unico de 1 parametro que
// estaba aprobado (`precios_actualizados`) cierra con "Se actualizaron los
// valores en el portal de Tito Gonzalez. Por favor revisalo.", asi que usarlo de
// fallback hacia que el aviso del feed avisara de un cambio de precios que nunca
// paso. Es preferible que el aviso NO salga a que salga diciendo otra cosa: si el
// template propio no esta aprobado, queda el error registrado en feed_avisos.

const APIFY_ACTOR = "apify~instagram-scraper";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const WA_PHONE_ID = Deno.env.get("WA_TASADOR_PHONE_ID");
  const WA_TOKEN = Deno.env.get("WA_TASADOR_TOKEN");
  const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN");

  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "SUPABASE env vars missing" }, 500);
  if (!WA_PHONE_ID || !WA_TOKEN) return json({ error: "WA_TASADOR env vars missing" }, 500);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* body opcional */ }

  const url = new URL(req.url);
  const dry = body?.dry === true || url.searchParams.get("dry") === "1";

  // --- utilidades de template (una sola vez, a mano) ---
  if (body?.listar === true) return json(await listarTemplates(WA_TOKEN));
  if (body?.crear_templates === true) return json(await crearTemplates(WA_TOKEN));
  if (body?.borrar_template) return json(await borrarTemplate(WA_TOKEN, String(body.borrar_template)));

  const tipo = String(body?.tipo ?? url.searchParams.get("tipo") ?? "estado");
  if (tipo !== "estado" && tipo !== "comercial") {
    return json({ error: "tipo invalido, va 'estado' o 'comercial'" }, 400);
  }

  const env: Env = { SUPABASE_URL, SERVICE_KEY, WA_PHONE_ID, WA_TOKEN, APIFY_TOKEN: APIFY_TOKEN ?? "" };

  try {
    return json(await procesar(env, tipo, dry));
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

type Env = {
  SUPABASE_URL: string;
  SERVICE_KEY: string;
  WA_PHONE_ID: string;
  WA_TOKEN: string;
  APIFY_TOKEN: string;
};

type Config = {
  activo: boolean;
  ig_usuario: string;
  destinatario: string;
  dias_obligatorios: number[];
  desde: string;
};

// --- fecha/hora de Argentina sin librerias -----------------------------------
// Devuelve {fecha:'YYYY-MM-DD', diaISO:1..7} en horario de Buenos Aires.
function hoyAR(d = new Date()): { fecha: string; diaISO: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const fecha = fmt.format(d); // en-CA da YYYY-MM-DD
  const nombre = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires", weekday: "short",
  }).format(d);
  const mapa: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { fecha, diaISO: mapa[nombre] ?? 0 };
}

function fechaARde(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

function diasEntre(desdeISO: string, hastaFechaAR: string): number {
  const a = new Date(fechaARde(desdeISO) + "T12:00:00Z").getTime();
  const b = new Date(hastaFechaAR + "T12:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

function hace(dias: number): string {
  if (dias <= 0) return "hoy";
  if (dias === 1) return "ayer";
  return `hace ${dias} dias`;
}

// -----------------------------------------------------------------------------

async function procesar(env: Env, tipo: string, dry: boolean) {
  const { fecha, diaISO } = hoyAR();

  const cfgRows = await sb<Config>(env, "feed_config?id=eq.1&select=*");
  const cfg = cfgRows[0];
  if (!cfg) return { error: "falta la fila de feed_config" };
  if (!cfg.activo) return { ok: true, salteado: "feed_config.activo = false" };
  if (fecha < cfg.desde) return { ok: true, salteado: `anterior a desde (${cfg.desde})` };

  // El aviso de estado solo corre los dias obligatorios.
  if (tipo === "estado" && !(cfg.dias_obligatorios || []).includes(diaISO)) {
    return { ok: true, salteado: `dia ${diaISO} no es obligatorio` };
  }
  // El recordatorio comercial es del viernes.
  if (tipo === "comercial" && diaISO !== 5) {
    return { ok: true, salteado: `dia ${diaISO} no es viernes` };
  }

  // Idempotencia: si ya se mando hoy este tipo, no repetir.
  const yaRows = await sb<{ id: number; enviado: boolean }>(
    env, `feed_avisos?fecha=eq.${fecha}&tipo=eq.${tipo}&enviado=eq.true&select=id`);
  if (yaRows.length && !dry) return { ok: true, salteado: "ya se envio hoy" };

  let resultado: string;
  let mensaje: string;
  let detalle = "";

  if (tipo === "comercial") {
    resultado = "recordatorio";
    mensaje = "Recordatorio: hoy hay que armar la pieza comercial de Instagram que se publica el lunes.";
  } else {
    const feed = await mirarFeed(env, cfg.ig_usuario);
    if (feed.error) return { ok: false, error: "no se pudo leer el feed", detalle: feed.error };

    await guardarFeed(env, fecha, feed);

    const ultima = feed.posts[0]; // ya viene ordenado, mas nuevo primero
    const subioHoy = !!ultima && fechaARde(ultima.timestamp) === fecha;

    if (subioHoy) {
      resultado = "subido";
      mensaje = "Se subio la publicacion de hoy en Instagram.";
      detalle = ultima.url ?? "";
    } else {
      resultado = "sin_subir";
      const d = ultima ? diasEntre(ultima.timestamp, fecha) : null;
      const cola = d === null
        ? "No pude ver ninguna publicacion previa."
        : `La ultima publicacion fue ${hace(d)}.`;
      mensaje = `Hoy no se subio nada en Instagram. ${cola}`;
      detalle = ultima ? `ultima=${ultima.url} (${fechaARde(ultima.timestamp)})` : "";
    }
  }

  if (dry) return { ok: true, dry: true, fecha, tipo, resultado, mensaje, detalle };

  const dest = await destinatario(env, cfg.destinatario);
  if (!dest) {
    await registrar(env, fecha, tipo, resultado, detalle, false, null, "sin destinatario con telefono_wa");
    return { ok: false, error: `no encontre a ${cfg.destinatario} con telefono_wa` };
  }

  const envio = await enviar(env, tipo, dest.tel, dest.primerNombre, mensaje);
  await registrar(env, fecha, tipo, resultado, detalle, envio.ok, envio.meta_id ?? null,
    envio.ok ? null : JSON.stringify(envio.error));

  return {
    ok: envio.ok, fecha, tipo, resultado, mensaje,
    destinatario: dest.primerNombre, template: envio.template,
    meta_id: envio.meta_id, error: envio.ok ? undefined : envio.error,
  };
}

// --- Apify -------------------------------------------------------------------

type Post = {
  shortCode: string; timestamp: string; type?: string; productType?: string;
  caption?: string; likesCount?: number; commentsCount?: number; url?: string;
};

async function mirarFeed(env: Env, usuario: string): Promise<{
  posts: Post[]; seguidores: number | null; total: number | null; error?: string;
}> {
  if (!env.APIFY_TOKEN) return { posts: [], seguidores: null, total: null, error: "falta APIFY_TOKEN" };
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${env.APIFY_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directUrls: [`https://www.instagram.com/${usuario}/`],
          resultsType: "details",
          resultsLimit: 1,
          addParentData: false,
        }),
      },
    );
    if (!res.ok) return { posts: [], seguidores: null, total: null, error: `apify ${res.status}: ${await res.text()}` };
    const data = await res.json();
    const perfil = Array.isArray(data) ? data[0] : null;
    if (!perfil) return { posts: [], seguidores: null, total: null, error: "apify no devolvio perfil" };

    // ⚠️ latestPosts arranca por los FIJADOS: hay que ordenar por fecha.
    const posts: Post[] = (perfil.latestPosts ?? [])
      .filter((p: Post) => p && p.timestamp)
      .sort((a: Post, b: Post) => b.timestamp.localeCompare(a.timestamp));

    return { posts, seguidores: perfil.followersCount ?? null, total: perfil.postsCount ?? null };
  } catch (e) {
    return { posts: [], seguidores: null, total: null, error: String(e) };
  }
}

async function guardarFeed(
  env: Env, fecha: string,
  feed: { posts: Post[]; seguidores: number | null; total: number | null },
) {
  try {
    if (feed.posts.length) {
      const filas = feed.posts.map((p) => ({
        shortcode: p.shortCode,
        publicado_at: p.timestamp,
        producto: p.productType ?? null,
        media: p.type ?? null,
        caption: (p.caption ?? "").slice(0, 2000),
        likes: p.likesCount ?? null,
        comentarios: p.commentsCount ?? null,
        url: p.url ?? null,
        visto_at: new Date().toISOString(),
      }));
      await sbWrite(env, "feed_posts?on_conflict=shortcode", filas, "resolution=merge-duplicates");
    }
    if (feed.seguidores !== null) {
      await sbWrite(env, "feed_snapshot?on_conflict=fecha", [{
        fecha, seguidores: feed.seguidores, posteos_totales: feed.total,
      }], "resolution=merge-duplicates");
    }
  } catch (e) {
    console.error("guardarFeed:", String(e)); // no romper el aviso por esto
  }
}

// --- destinatario y envio ----------------------------------------------------

async function destinatario(env: Env, usuario: string) {
  const rows = await sb<{ nombre: string; telefono_wa: string }>(
    env,
    `tasador_usuarios?activo=eq.true&telefono_wa=not.is.null&usuario=eq.${encodeURIComponent(usuario)}&select=nombre,telefono_wa&limit=1`,
  );
  const u = rows[0];
  if (!u) return null;
  const tel = String(u.telefono_wa || "").replace(/^\+/, "").replace(/[\s-]/g, "");
  if (!tel) return null;
  return { tel, primerNombre: (String(u.nombre || "").split(/\s+/)[0] || "equipo").trim() };
}

async function enviar(env: Env, tipo: string, tel: string, primerNombre: string, mensaje: string) {
  const propio = tipo === "comercial"
    ? await postMeta(env, tel, TPL_COMERCIAL, [primerNombre])
    : await postMeta(env, tel, TPL_ESTADO, [primerNombre, recortar(mensaje, 900)]);
  return { ...propio, template: tipo === "comercial" ? TPL_COMERCIAL : TPL_ESTADO };
}

async function postMeta(
  env: Env, tel: string, template: string, params: string[],
): Promise<{ ok: boolean; meta_id?: string; error?: any }> {
  try {
    const res = await fetch(`${META_API_URL}/${env.WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: tel,
        type: "template",
        template: {
          name: template,
          language: { code: META_LANGUAGE },
          components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
        },
      }),
    });
    const j = await res.json();
    if (res.ok && j.messages && j.messages[0]) return { ok: true, meta_id: j.messages[0].id };
    return { ok: false, error: j.error || j };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function registrar(
  env: Env, fecha: string, tipo: string, resultado: string, detalle: string,
  enviado: boolean, meta_id: string | null, error: string | null,
) {
  try {
    await sbWrite(env, "feed_avisos?on_conflict=fecha,tipo", [{
      fecha, tipo, resultado, detalle, enviado, meta_id, error,
    }], "resolution=merge-duplicates");
  } catch (e) {
    console.error("registrar:", String(e));
  }
}

// --- templates de Meta (alta manual, una sola vez) ---------------------------

// ⚠️ Meta rechaza las plantillas que EMPIEZAN o TERMINAN en una variable
// (error_subcode 2388299). Por eso el cierre fijo de la ultima linea.
const COMPONENTES_ESTADO = [{
  type: "BODY",
  text:
    "Hola {{1}}! Estado del Instagram de hoy. {{2}} Este aviso sale los lunes, miercoles y viernes a las 18.",
  example: {
    body_text: [["Fer", "Hoy no se subio nada en Instagram. La ultima publicacion fue hace 6 dias."]],
  },
}];

const COMPONENTES_COMERCIAL = [{
  type: "BODY",
  text: "Hola {{1}}! Recordatorio: hoy hay que armar la pieza comercial de Instagram que se publica el lunes.",
  example: { body_text: [["Fer"]] },
}];

async function crearTemplates(token: string) {
  const a = await postJson(`${META_API_URL}/${WABA_ID}/message_templates`, token, {
    name: TPL_ESTADO, language: META_LANGUAGE, category: "UTILITY", components: COMPONENTES_ESTADO,
  });
  const b = await postJson(`${META_API_URL}/${WABA_ID}/message_templates`, token, {
    name: TPL_COMERCIAL, language: META_LANGUAGE, category: "UTILITY", components: COMPONENTES_COMERCIAL,
  });
  return { [TPL_ESTADO]: a, [TPL_COMERCIAL]: b };
}

async function listarTemplates(token: string) {
  const res = await fetch(
    `${META_API_URL}/${WABA_ID}/message_templates?fields=name,language,status,category,components&limit=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await res.json();
  const mios = (j?.data ?? []).filter((t: any) =>
    [TPL_ESTADO, TPL_COMERCIAL].includes(String(t.name)));
  return { templates: mios, error: j?.error };
}

async function borrarTemplate(token: string, nombre: string) {
  try {
    const res = await fetch(
      `${META_API_URL}/${WABA_ID}/message_templates?name=${encodeURIComponent(nombre)}`,
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

// --- helpers -----------------------------------------------------------------

function recortar(s: string, max: number) {
  return s.length <= max ? s : s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sb<T>(env: Env, path: string): Promise<T[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SERVICE_KEY,
      Authorization: `Bearer ${env.SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : [];
}

async function sbWrite(env: Env, path: string, filas: unknown[], prefer: string) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: env.SERVICE_KEY,
      Authorization: `Bearer ${env.SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(filas),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}
