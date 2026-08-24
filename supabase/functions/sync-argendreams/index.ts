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
//   3) FEEDBACK ArgenDreams -> WhatsApp de Fer
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

const CALLMEBOT_PHONE = "5491156559854";
const CALLMEBOT_KEY = "6552632";

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

  const dry = new URL(req.url).searchParams.get("dry") === "1";

  try {
    const reventaId = await getReventaId();
    if (!reventaId) {
      return json({
        error: "No existe el usuario reventa '" + ARGD_REVENTA_USUARIO + "' en ArgenDreams. " +
               "Hay que darlo de alta antes de que el puente funcione.",
      }, 412);
    }

    const pull = await pasoPull(TGA_URL, TGA_KEY, dry);
    const push = await pasoPush(TGA_URL, TGA_KEY, reventaId, dry);
    const feedback = await pasoFeedback(TGA_URL, TGA_KEY, reventaId, dry);

    return json({ dry, reventa_id: reventaId, pull, push, feedback });
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

// ------------------------------------------------------------ paso 3: FEEDBACK

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

    const patch: any = {
      externa_resultado: resultado,
      externa_mejor_precio: mejor || null,
      externa_cerrada_at: new Date().toISOString(),
      externa_estado_origen: orig.estado,
      externa_avisado_at: new Date().toISOString(),
    };

    const msg = mensajeFeedback(t, mio, mejor, ganamos, validos.length, orig);
    if (!dry) {
      await avisarFer(msg);
      await tga(tgaUrl, tgaKey, "tasaciones?id=eq." + t.id, "PATCH", patch);
    }
    avisadas++;
    detalle.push({ ref: t.origen_ref_id, resultado, mio, mejor, mensaje: msg });
  }

  return { revisadas: cotizadas.length, avisadas, detalle };
}

function mensajeFeedback(t: any, mio: number, mejor: number, ganamos: boolean, cuantas: number, orig: any) {
  const auto = [t.modelo, t.anio, t.kilometros ? fmt(t.kilometros) + " km" : null]
    .filter(Boolean).join(" ");
  const cab = ganamos ? "GANAMOS la tasacion de ArgenDreams" : "No ganamos la tasacion de ArgenDreams";
  const lineas = [
    (ganamos ? "✅ " : "❌ ") + cab,
    "",
    auto,
    "Nuestro precio: $" + fmt(mio),
  ];
  if (mejor > 0 && !ganamos) {
    const dif = mejor - mio;
    const pct = mio > 0 ? (dif / mio) * 100 : 0;
    lineas.push("Mejor precio: $" + fmt(mejor));
    lineas.push("Nos faltaron $" + fmt(dif) + " (" + pct.toFixed(1) + "%)");
  }
  lineas.push("");
  lineas.push("Cotizaron " + cuantas + " reventas contando la nuestra.");
  if (orig && orig.precio_final_admin) {
    lineas.push("ArgenDreams le ofrecio al cliente $" + fmt(Number(orig.precio_final_admin)) + ".");
  }
  return lineas.join("\n");
}

async function avisarFer(mensaje: string) {
  const url = "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(CALLMEBOT_PHONE) +
    "&text=" + encodeURIComponent(mensaje) + "&apikey=" + encodeURIComponent(CALLMEBOT_KEY);
  try {
    await fetch(url);
  } catch (_e) {
    // Fire and forget: si CallMeBot falla no bloqueamos el sync. El resultado
    // igual queda guardado en la tasacion y se ve en el panel.
  }
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
