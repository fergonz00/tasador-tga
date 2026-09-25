// Edge Function: notify-argendreams-salud
//
// Vigia del puente con ArgenDreams. Nace de un riesgo conocido y sin mitigar:
// `sync-argendreams` puede romperse EN SILENCIO (el cron muere, Meta rechaza el
// template, rotan la key de ArgenDreams, el proyecto Free se pausa) y del lado
// de Fer eso se ve igual que "esta semana no entro ningun VW". Con una ventana
// de 2,9 h de mediana para cotizar, enterarse tarde es perder la operacion.
//
// Corre por pg_cron cada 15 minutos y chequea SEIS cosas:
//
//   1) cron       el job `sync-argendreams` sigue disparando (y sin fallos).
//   2) puente     sync-argendreams responde de punta a punta (se la llama con
//                 ?dry=1, que corre las cuatro pasadas SIN escribir nada). Si
//                 ArgenDreams no contesta o la key no sirve, revienta aca.
//   3) sin_espejar  hay VW que Agustin ya mando a reventas y no aparecieron de
//                 este lado despues de la tolerancia.
//   4) sin_aviso  estan espejadas pero nunca salio el WhatsApp de entrada.
//   5) sin_push   Fer cargo el precio y nunca llego a ArgenDreams (= cotizamos
//                 y no competimos; es el unico chequeo que cuesta plata).
//   6) web        las dos apps contestan: tasador.titogonzalez.online (TGA) y
//                 tasador.argendreams.online (ArgenDreams).
//
// Avisa por WhatsApp reusando `notify-ml-excepciones` con tipo "resultado"
// (template `control_automatico_resultado`, ya aprobado): un solo mensaje por
// corrida con todo lo que esta mal junto, no uno por chequeo.
//
// Silencio cuando anda todo: solo habla si hay algo roto, y una sola vez mas
// cada REAVISO_HORAS mientras siga roto. Cuando se arregla manda un unico
// "volvio a andar" para que Fer no quede esperando.
//
// Estado en la tabla `argd_salud` (una fila por chequeo).
//
// Deployar SIEMPRE con --no-verify-jwt: el pg_cron la llama sin header de auth.
//   supabase functions deploy notify-argendreams-salud --no-verify-jwt
//
// A mano:  ?dry=1          corre todo y devuelve que avisaria, sin mandar ni escribir
//          ?forzar=1       manda el aviso aunque no toque (para probar el WhatsApp)
//          ?simular=clave  da por roto ese chequeo (puente, cron, sin_push...) para
//                          poder probar el camino de alerta de verdad. Sin esto el
//                          vigia nunca se prueba: mientras todo anda, callar es lo
//                          mismo que estar muerto.

const ARGD_URL = "https://xcijbomhvwwlzgmazvep.supabase.co";
// Misma publishable key que usa sync-argendreams y que viaja en el index.html
// publico de ArgenDreams. RLS esta OFF en ese proyecto.
const ARGD_KEY = "sb_publishable_NPO73kz-5gDAYeiZnmZmcA_gNe6Y31M";

const ESTADOS_ABIERTOS = ["en_reventa", "precios_recibidos"];

// Cuanto le damos al puente antes de gritar. El cron corre cada 2 minutos, asi
// que 20 minutos son 10 corridas perdidas: no es un pico, esta roto.
const TOLERANCIA_MIN = 20;
// El cron de este vigia es cada 15 min; si el de sync no corrio en 10, murio.
const CRON_TOLERANCIA_MIN = 10;
// Cada cuanto repite el aviso mientras siga roto.
const REAVISO_HORAS = 6;

const CONTROL = "Puente ArgenDreams (tasar los VW)";

const WEBS = [
  { nombre: "tasador TGA", url: "https://tasador.titogonzalez.online/" },
  { nombre: "tasador ArgenDreams", url: "https://tasador.argendreams.online/" },
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

type Chequeo = { clave: string; ok: boolean; detalle: string; accion: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const TGA_URL = Deno.env.get("SUPABASE_URL");
  const TGA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!TGA_URL || !TGA_KEY) return json({ error: "SUPABASE env vars missing" }, 500);

  const params = new URL(req.url).searchParams;
  const dry = params.get("dry") === "1";
  const forzar = params.get("forzar") === "1";
  const simular = (params.get("simular") || "").trim();

  const desde = new Date(Date.now() - TOLERANCIA_MIN * 60 * 1000).toISOString();
  const chequeos: Chequeo[] = [];

  chequeos.push(await chequearCron(TGA_URL, TGA_KEY));
  chequeos.push(await chequearPuente(TGA_URL, TGA_KEY));
  chequeos.push(await chequearSinEspejar(TGA_URL, TGA_KEY, desde));
  chequeos.push(await chequearSinAviso(TGA_URL, TGA_KEY, desde));
  chequeos.push(await chequearSinPush(TGA_URL, TGA_KEY, desde));
  for (const w of WEBS) chequeos.push(await chequearWeb(w.nombre, w.url));

  if (simular) {
    const i = chequeos.findIndex((c) => c.clave === simular);
    const falso = malo(simular, "PRUEBA: se forzo este chequeo como roto para probar el aviso.",
      "Es una prueba, no hay nada roto de verdad.");
    if (i >= 0) chequeos[i] = falso; else chequeos.push(falso);
  }

  const aviso = await decidirYAvisar(TGA_URL, TGA_KEY, chequeos, dry, forzar, !!simular);
  return json({ dry, simular: simular || null, chequeos, aviso });
});

// ------------------------------------------------------------------ chequeos

// El cron sigue vivo. Sin esto, si pg_cron se cae no se rompe nada visible:
// simplemente deja de entrar trabajo y parece que ArgenDreams no manda VW.
async function chequearCron(url: string, key: string): Promise<Chequeo> {
  try {
    const r = await rpc(url, key, "argd_cron_estado");
    const fila = Array.isArray(r) ? r[0] : r;
    if (!fila || !fila.ultima) {
      return malo("cron", "El job sync-argendreams no tiene ninguna corrida registrada.",
        "Mirar en Supabase si el job sigue existiendo (select * from cron.job).");
    }
    const min = Math.round((Date.now() - new Date(fila.ultima).getTime()) / 60000);
    if (min > CRON_TOLERANCIA_MIN) {
      return malo("cron", "El job sync-argendreams no corre desde hace " + min + " min (deberia ser cada 2).",
        "Revisar pg_cron: puede estar desactivado o el proyecto pausado.");
    }
    if ((fila.fallidas || 0) > 0) {
      return malo("cron", fila.fallidas + " corridas del job fallaron en la ultima hora.",
        "Mirar cron.job_run_details y el log de la Edge Function.");
    }
    return { clave: "cron", ok: true, detalle: "ultima corrida hace " + min + " min", accion: "" };
  } catch (e) {
    return malo("cron", "No se pudo leer el estado del cron: " + corto(e),
      "Verificar que exista la funcion argd_cron_estado().");
  }
}

// El unico chequeo que prueba la cadena entera: TGA -> Edge -> ArgenDreams.
// ?dry=1 corre las cuatro pasadas sin escribir ni mandar nada.
async function chequearPuente(url: string, key: string): Promise<Chequeo> {
  try {
    const res = await fetch(url + "/functions/v1/sync-argendreams?dry=1", {
      headers: { Authorization: "Bearer " + key, apikey: key },
      signal: AbortSignal.timeout(25000),
    });
    const txt = await res.text();
    let body: any = null;
    try { body = JSON.parse(txt); } catch { /* respuesta no-JSON */ }
    if (!res.ok || !body || body.error) {
      return malo("puente", "sync-argendreams contesta " + res.status + ": " + corto(body?.error ?? txt),
        "Ver el log de la Edge Function. Si habla de la key o de 401, rotaron la de ArgenDreams.");
    }
    return { clave: "puente", ok: true, detalle: "responde OK", accion: "" };
  } catch (e) {
    return malo("puente", "sync-argendreams no responde: " + corto(e),
      "Redeployar con --no-verify-jwt y mirar el log.");
  }
}

// VW que Agustin ya mando a reventas y de este lado no existen.
async function chequearSinEspejar(url: string, key: string, desde: string): Promise<Chequeo> {
  try {
    const abiertos = ESTADOS_ABIERTOS.join(",");
    const alla = await argd("tasaciones?usado_marca=eq.VOLKSWAGEN" +
      "&estado=in.(" + abiertos + ")" +
      "&created_at=lt." + encodeURIComponent(desde) +
      "&created_at=gte." + encodeURIComponent(hace(7 * 24)) +
      "&select=id,usado_modelo,usado_anio&order=created_at.desc&limit=50");
    if (!alla || alla.length === 0) {
      return { clave: "sin_espejar", ok: true, detalle: "nada pendiente", accion: "" };
    }
    const ids = alla.map((t: any) => '"' + t.id + '"').join(",");
    const aca = await tga(url, key,
      "tasaciones?origen=eq.argendreams&origen_ref_id=in.(" + encodeURIComponent(ids) + ")&select=origen_ref_id");
    const vistos = new Set((aca || []).map((t: any) => t.origen_ref_id));
    const faltan = alla.filter((t: any) => !vistos.has(t.id));
    if (faltan.length === 0) {
      return { clave: "sin_espejar", ok: true, detalle: alla.length + " al dia", accion: "" };
    }
    return malo("sin_espejar",
      faltan.length + " VW estan en reventas hace mas de " + TOLERANCIA_MIN +
      " min y no llegaron al tasador (" + listar(faltan.map((t: any) => t.usado_modelo + " " + (t.usado_anio || ""))) + ").",
      "Es el PULL. Correr sync-argendreams a mano y mirar que devuelve.");
  } catch (e) {
    return malo("sin_espejar", "No se pudo leer ArgenDreams: " + corto(e),
      "Puede ser la key, el proyecto pausado o la tabla cambiada.");
  }
}

// Espejadas pero sin el WhatsApp de entrada. Ojo: el paso de aviso de
// sync-argendreams solo mira las ultimas 24 h, asi que una que se atasque mas
// de un dia no se avisa nunca mas. Este chequeo es el que la agarra.
async function chequearSinAviso(url: string, key: string, desde: string): Promise<Chequeo> {
  try {
    const filas = await tga(url, key,
      "tasaciones?origen=eq.argendreams&externa_aviso_entrada_at=is.null" +
      "&externa_precio=is.null" +
      "&externa_estado_origen=in.(" + ESTADOS_ABIERTOS.join(",") + ")" +
      "&created_at=lt." + encodeURIComponent(desde) +
      "&select=id,modelo,anio&order=created_at.desc&limit=20");
    if (!filas || filas.length === 0) {
      return { clave: "sin_aviso", ok: true, detalle: "sin pendientes", accion: "" };
    }
    return malo("sin_aviso",
      filas.length + " VW entraron y nunca salio el WhatsApp de aviso (" +
      listar(filas.map((t: any) => t.modelo + " " + (t.anio || ""))) + ").",
      "Suele ser Meta rechazando el template argendreams_nuevo_vw: revisar que siga aprobado.");
  } catch (e) {
    return malo("sin_aviso", "No se pudo consultar: " + corto(e), "Mirar el log.");
  }
}

// Precio cargado que no llego al ranking de ArgenDreams: cotizamos y no
// competimos. Es el unico que cuesta plata directa.
async function chequearSinPush(url: string, key: string, desde: string): Promise<Chequeo> {
  try {
    const filas = await tga(url, key,
      "tasaciones?origen=eq.argendreams&externa_precio=not.is.null" +
      "&externa_push_at=is.null" +
      "&externa_precio_at=lt." + encodeURIComponent(desde) +
      "&select=id,modelo,anio,externa_precio&order=externa_precio_at.desc&limit=20");
    if (!filas || filas.length === 0) {
      return { clave: "sin_push", ok: true, detalle: "todo empujado", accion: "" };
    }
    return malo("sin_push",
      filas.length + " precios cargados hace mas de " + TOLERANCIA_MIN +
      " min no llegaron a ArgenDreams (" + listar(filas.map((t: any) => t.modelo + " " + (t.anio || ""))) + ").",
      "Estamos cotizando sin competir. Correr sync-argendreams y mirar el paso push.");
  } catch (e) {
    return malo("sin_push", "No se pudo consultar: " + corto(e), "Mirar el log.");
  }
}

async function chequearWeb(nombre: string, url: string): Promise<Chequeo> {
  const clave = "web_" + url.replace(/https?:\/\//, "").replace(/[^a-z0-9]/gi, "_").replace(/_+$/, "");
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
    if (!res.ok) {
      return malo(clave, "La app " + nombre + " contesta " + res.status + ".",
        "Si es 404 puede ser el deploy de GitHub Pages o el CNAME.");
    }
    const txt = await res.text();
    // Una pagina de 200 vacia (o el 404 de GitHub Pages) tambien es estar caido.
    if (txt.length < 500) {
      return malo(clave, "La app " + nombre + " contesta 200 pero devuelve una pagina vacia.",
        "Revisar el deploy: puede haber quedado a medias.");
    }
    return { clave, ok: true, detalle: nombre + " OK", accion: "" };
  } catch (e) {
    return malo(clave, "La app " + nombre + " no responde: " + corto(e),
      "Probar abrirla en el navegador; si carga, fue un pico y se arregla solo.");
  }
}

// ------------------------------------------------------- estado + aviso unico

async function decidirYAvisar(url: string, key: string, chequeos: Chequeo[],
                              dry: boolean, forzar: boolean, simulado = false) {
  const previos: Record<string, any> = {};
  try {
    const filas = await tga(url, key, "argd_salud?select=*");
    for (const f of (filas || [])) previos[f.chequeo] = f;
  } catch (_e) { /* si no se puede leer el estado, igual avisamos */ }

  const ahora = new Date().toISOString();
  const rotos = chequeos.filter((c) => !c.ok);
  const nuevosOVencidos: Chequeo[] = [];
  const arreglados: string[] = [];

  for (const c of chequeos) {
    const p = previos[c.clave];
    if (!c.ok) {
      const avisadoHace = p?.avisado_at ? (Date.now() - new Date(p.avisado_at).getTime()) / 3600000 : null;
      if (avisadoHace === null || avisadoHace >= REAVISO_HORAS) nuevosOVencidos.push(c);
    } else if (p && p.estado === "mal" && p.avisado_at) {
      // Solo se avisa que volvio si se habia avisado que estaba roto.
      arreglados.push(c.clave);
    }
  }

  const hayQueAvisar = forzar || nuevosOVencidos.length > 0 || (rotos.length === 0 && arreglados.length > 0);
  let envio: any = { mandado: false, motivo: "sin novedades" };

  if (hayQueAvisar) {
    const texto = rotos.length > 0
      ? {
        resumen: rotos.length === 1
          ? "Hay 1 cosa rota en el puente con ArgenDreams."
          : "Hay " + rotos.length + " cosas rotas en el puente con ArgenDreams.",
        detalle: rotos.map((c) => "- " + c.detalle).join(" "),
        accion: rotos.map((c) => c.accion).filter(Boolean).join(" "),
      }
      : arreglados.length > 0
      ? {
        resumen: "Volvio a andar: " + arreglados.join(", ") + ".",
        detalle: "Los " + chequeos.length + " chequeos dan OK. Si mientras tanto entro algun VW, ya deberia estar en el tab de ArgenDreams.",
        accion: "No hace falta que hagas nada.",
      }
      : {
        resumen: "Prueba del vigia: el puente con ArgenDreams esta OK.",
        detalle: "Los " + chequeos.length + " chequeos dan bien. Este mensaje salio a mano para verificar que el aviso llega.",
        accion: "No hace falta que hagas nada.",
      };

    if (dry) envio = { mandado: false, motivo: "dry", texto };
    else envio = await mandarWhatsApp(url, key, texto, rotos.length);
  }

  // Una simulacion no ensucia el estado real: si guardara, el chequeo simulado
  // quedaria como "mal" y al rato mandaria un "volvio a andar" que es mentira.
  if (!dry && !simulado) {
    for (const c of chequeos) {
      const p = previos[c.clave];
      const seAviso = nuevosOVencidos.some((x) => x.clave === c.clave) && envio.mandado;
      await guardarEstado(url, key, {
        chequeo: c.clave,
        estado: c.ok ? "ok" : "mal",
        detalle: c.ok ? c.detalle : (c.detalle + " " + c.accion).trim(),
        mal_desde: c.ok ? null : (p?.mal_desde || ahora),
        avisado_at: c.ok ? null : (seAviso ? ahora : (p?.avisado_at || null)),
        ultimo_at: ahora,
      });
    }
  }

  return { rotos: rotos.length, avisados: nuevosOVencidos.map((c) => c.clave), arreglados, envio };
}

// Reusa notify-ml-excepciones (template control_automatico_resultado, aprobado):
// {{1}} nombre, {{2}} que control, {{3}} resumen, {{4}} detalle, {{5}} que hacer.
async function mandarWhatsApp(url: string, key: string, texto: any, cantidad: number) {
  const secret = Deno.env.get("STOCK_NOTIF_SECRET");
  if (!secret) return { mandado: false, motivo: "falta STOCK_NOTIF_SECRET" };
  try {
    const res = await fetch(url + "/functions/v1/notify-ml-excepciones", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-stock-secret": secret,
        Authorization: "Bearer " + key,
        apikey: key,
      },
      body: JSON.stringify({
        tipo: "resultado",
        control: CONTROL,
        resumen: texto.resumen,
        detalle: texto.detalle,
        accion: texto.accion || "No hace falta que hagas nada.",
        cantidad: String(cantidad),
      }),
      signal: AbortSignal.timeout(25000),
    });
    const j = await res.json().catch(() => null);
    return { mandado: res.ok && !j?.error, respuesta: j };
  } catch (e) {
    return { mandado: false, motivo: corto(e) };
  }
}

async function guardarEstado(url: string, key: string, fila: any) {
  try {
    await fetch(url + "/rest/v1/argd_salud?on_conflict=chequeo", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(fila),
    });
  } catch (_e) { /* el estado es best-effort: no vale abortar el vigia por esto */ }
}

// --------------------------------------------------------------------- helpers

function malo(clave: string, detalle: string, accion: string): Chequeo {
  return { clave, ok: false, detalle, accion };
}

function hace(horas: number) {
  return new Date(Date.now() - horas * 3600 * 1000).toISOString();
}

function listar(xs: string[]) {
  const l = xs.map((x) => String(x || "").trim()).filter(Boolean);
  return l.slice(0, 3).join(", ") + (l.length > 3 ? " y " + (l.length - 3) + " mas" : "");
}

function corto(e: any) {
  return String(e && (e as Error).message || e).replace(/\s+/g, " ").slice(0, 160);
}

async function argd(path: string) {
  const res = await fetch(ARGD_URL + "/rest/v1/" + path, {
    headers: { apikey: ARGD_KEY, Authorization: "Bearer " + ARGD_KEY },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("ArgD " + path.split("?")[0] + " -> " + res.status + " " + (await res.text()));
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

async function tga(url: string, key: string, path: string) {
  const res = await fetch(url + "/rest/v1/" + path, {
    headers: { apikey: key, Authorization: "Bearer " + key },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("TGA " + path.split("?")[0] + " -> " + res.status + " " + (await res.text()));
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

async function rpc(url: string, key: string, fn: string) {
  const res = await fetch(url + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("rpc " + fn + " -> " + res.status + " " + (await res.text()));
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
