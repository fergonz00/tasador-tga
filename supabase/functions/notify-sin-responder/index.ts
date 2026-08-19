// Edge Function: notify-sin-responder
// Recordatorios por WhatsApp de consultas que quedaron SIN RESPONDER.
//
// Cubre los tres circuitos que comparten este proyecto Supabase:
//   - tasador        (tabla `tasaciones`,       tasador.titogonzalez.online)
//   - consulta_0km   (tabla `consultas_0km`,    consulta0km.titogonzalez.online)
//   - consulta_usado (tabla `consultas_usados`, misma app, solapa Usados)
//
// Lógica (idéntica para ambos, parametrizada en la tabla `recordatorios_config`):
//   1. Busca las que están sin responder y ya cumplieron `intervalo_min`
//      desde que entraron.
//   2. Descarta las que ya recibieron `max_recordatorios` y las que recibieron
//      uno hace menos de `intervalo_min`.
//   3. Manda el recordatorio llamando a la Edge Function de notificaciones del
//      módulo (que resuelve destinatarios y loguea el envío, como siempre).
//   4. Sella `recordatorios_enviados` + `ultimo_recordatorio_at`.
//
// El corte es automático: en cuanto se contesta (precio virtual cargado, NO APTO,
// rebotada, o la consulta 0km pasa a aceptada/rechazada/contraoferta) la fila
// deja de matchear el filtro y no llega nada más. No hace falta marcar nada.
//
// `recordatorios_config.desde` evita que al activar la feature se dispare el
// backlog histórico: sólo entran las creadas después de esa marca.
//
// pg_cron (correr una sola vez para schedulearlo cada 10 min):
//   CREATE EXTENSION IF NOT EXISTS pg_cron;
//   CREATE EXTENSION IF NOT EXISTS pg_net;
//   SELECT cron.schedule(
//     'notify-sin-responder', '*/10 * * * *',
//     $$ SELECT net.http_post(
//       url := 'https://wjfglsafgaltusmbnccl.supabase.co/functions/v1/notify-sin-responder',
//       headers := jsonb_build_object('Content-Type', 'application/json'),
//       body := '{}'::jsonb
//     ); $$
//   );
//
// Para probar sin esperar al cron, pegarle por HTTP con ?dry=1 (no manda nada,
// sólo devuelve qué mandaría).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

// Tope de filas por corrida y por fuente. Red de contención: si algo se
// descontrola, el daño máximo por corrida está acotado.
const LIMITE_POR_CORRIDA = 40;

// Dos consultas 0km creadas con menos de esta diferencia se consideran del mismo
// submit (el vendedor pidió varios modelos de una) y comparten UN recordatorio.
const VENTANA_GRUPO_MS = 30_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Para invocar otras Edge Functions va la ANON_KEY (JWT clásico): la
  // SERVICE_ROLE_KEY de este proyecto es formato nuevo `sb_secret_*` y el
  // verificador de JWT la rechaza. Mismo criterio que notify-pending-sweep.
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "SUPABASE env vars missing" }, 500);
  if (!ANON_KEY) return json({ error: "SUPABASE_ANON_KEY missing" }, 500);

  const dry = new URL(req.url).searchParams.get("dry") === "1";

  try {
    const cfgs = await sb(SUPABASE_URL, SERVICE_KEY, "recordatorios_config?select=*");
    const porFuente: Record<string, any> = {};
    for (const c of (cfgs || [])) porFuente[c.fuente] = c;

    const [tasador, consulta0km, consultaUsado] = await Promise.all([
      barrerTasador(SUPABASE_URL, SERVICE_KEY, ANON_KEY, porFuente["tasador"], dry),
      barrerConsultas0km(SUPABASE_URL, SERVICE_KEY, ANON_KEY, porFuente["consulta_0km"], dry),
      barrerConsultasUsados(SUPABASE_URL, SERVICE_KEY, ANON_KEY, porFuente["consulta_usado"], dry),
    ]);

    return json({ dry, tasador, consulta_0km: consulta0km, consulta_usado: consultaUsado });
  } catch (e) {
    return json({ error: "sweep failed", detalle: String(e) }, 500);
  }
});

// ---------- Tasador ----------

async function barrerTasador(url: string, key: string, anon: string, cfg: any, dry: boolean) {
  if (!cfg) return { saltado: "sin config" };
  if (cfg.activo === false) return { saltado: "desactivado" };

  const corte = new Date(Date.now() - cfg.intervalo_min * 60000).toISOString();

  // Sin responder = no hay precio virtual ni final cargado, y no está cerrada por
  // otra vía (NO APTO / rebotada al vendedor / el cliente no avanza).
  // Las presenciales quedan afuera: dependen de un turno agendado, no de que el
  // admin cargue un precio. Mismo criterio que notify-pending-sweep.
  const path = "tasaciones?select=id,created_at,recordatorios_enviados,ultimo_recordatorio_at" +
    "&estado=eq.pendiente" +
    "&es_presencial=not.is.true" +
    "&precio_toma_virtual=is.null" +
    "&precio_toma_final=is.null" +
    "&virtual_no_apto=not.is.true" +
    "&rebotada=not.is.true" +
    "&no_avanza_motivo=is.null" +
    "&created_at=lt." + encodeURIComponent(corte) +
    "&created_at=gte." + encodeURIComponent(new Date(cfg.desde).toISOString()) +
    "&recordatorios_enviados=lt." + cfg.max_recordatorios +
    "&order=created_at.asc&limit=" + LIMITE_POR_CORRIDA;

  const filas = await sb(url, key, path);
  const pendientes = (filas || []).filter((t: any) => tocaRecordar(t, cfg));
  if (pendientes.length === 0) {
    return { revisadas: (filas || []).length, recordadas: 0, detalle: [] };
  }

  const detalle: any[] = [];
  for (const t of pendientes) {
    if (dry) {
      detalle.push({ id: t.id, aviso: (t.recordatorios_enviados || 0) + 1, dry: true });
      continue;
    }
    const r = await invocarNotify(url, anon, "notify-whatsapp", {
      tasacion_id: t.id,
      evento: "tasacion_sin_responder",
    });
    if (r.ok) {
      await patch(url, key, `tasaciones?id=eq.${t.id}`, {
        recordatorios_enviados: (t.recordatorios_enviados || 0) + 1,
        ultimo_recordatorio_at: new Date().toISOString(),
      });
    }
    detalle.push({ id: t.id, aviso: (t.recordatorios_enviados || 0) + 1, ...r });
  }

  return {
    revisadas: (filas || []).length,
    recordadas: detalle.filter((d) => d.dry || d.ok).length,
    detalle,
  };
}

// ---------- Consulta 0km ----------

async function barrerConsultas0km(url: string, key: string, anon: string, cfg: any, dry: boolean) {
  if (!cfg) return { saltado: "sin config" };
  if (cfg.activo === false) return { saltado: "desactivado" };

  const corte = new Date(Date.now() - cfg.intervalo_min * 60000).toISOString();

  // Sin responder = sigue en 'pendiente'. Cuando el admin acepta/rechaza/
  // contraoferta pasa a otro estado y sale sola del barrido.
  const path = "consultas_0km?select=id,created_at,vendedor_id,recordatorios_enviados,ultimo_recordatorio_at" +
    "&estado=eq.pendiente" +
    "&created_at=lt." + encodeURIComponent(corte) +
    "&created_at=gte." + encodeURIComponent(new Date(cfg.desde).toISOString()) +
    "&recordatorios_enviados=lt." + cfg.max_recordatorios +
    "&order=vendedor_id.asc,created_at.asc&limit=" + LIMITE_POR_CORRIDA;

  const filas = await sb(url, key, path);
  const pendientes = (filas || []).filter((c: any) => tocaRecordar(c, cfg));
  if (pendientes.length === 0) {
    return { revisadas: (filas || []).length, grupos: 0, recordadas: 0, detalle: [] };
  }

  const grupos = agruparPorSubmit(pendientes);
  const detalle: any[] = [];

  for (const g of grupos) {
    const rep = g[0];
    const ids = g.map((c: any) => c.id);
    const aviso = (rep.recordatorios_enviados || 0) + 1;

    if (dry) {
      detalle.push({ ids, aviso, dry: true });
      continue;
    }
    const r = await invocarNotify(url, anon, "notify-whatsapp-consulta", {
      consulta_id: rep.id,
      evento: "consulta_0km_sin_responder",
      grupo_ids: ids,
    });
    if (r.ok) {
      // Todas las del grupo quedan selladas juntas, aunque el WhatsApp haya
      // salido nombrando a la representante.
      await patch(url, key, `consultas_0km?id=in.(${ids.join(",")})`, {
        recordatorios_enviados: aviso,
        ultimo_recordatorio_at: new Date().toISOString(),
      });
    }
    detalle.push({ ids, aviso, ...r });
  }

  return {
    revisadas: (filas || []).length,
    grupos: grupos.length,
    recordadas: detalle.filter((d) => d.dry || d.ok).length,
    detalle,
  };
}

// ---------- Consulta de usados ----------

// Igual que las de 0km pero SIN agrupar: el wizard de usados guarda UNA fila por
// consulta (un usado es una unidad única, no se piden varios de una), así que
// cada una tiene que insistir por su cuenta. Si se agruparan, dos pedidos por
// dos autos distintos se sellarían con un solo aviso que nombra uno solo.
async function barrerConsultasUsados(url: string, key: string, anon: string, cfg: any, dry: boolean) {
  if (!cfg) return { saltado: "sin config" };
  if (cfg.activo === false) return { saltado: "desactivado" };

  const corte = new Date(Date.now() - cfg.intervalo_min * 60000).toISOString();

  // Sin responder = sigue en 'pendiente'. Aceptar / rechazar / contraofertar la
  // saca sola del barrido, igual que en el 0km.
  const path = "consultas_usados?select=id,created_at,vendedor_id,unidad,recordatorios_enviados,ultimo_recordatorio_at" +
    "&estado=eq.pendiente" +
    "&created_at=lt." + encodeURIComponent(corte) +
    "&created_at=gte." + encodeURIComponent(new Date(cfg.desde).toISOString()) +
    "&recordatorios_enviados=lt." + cfg.max_recordatorios +
    "&order=created_at.asc&limit=" + LIMITE_POR_CORRIDA;

  const filas = await sb(url, key, path);
  const pendientes = (filas || []).filter((c: any) => tocaRecordar(c, cfg));
  if (pendientes.length === 0) {
    return { revisadas: (filas || []).length, recordadas: 0, detalle: [] };
  }

  const detalle: any[] = [];
  for (const c of pendientes) {
    const aviso = (c.recordatorios_enviados || 0) + 1;
    if (dry) {
      detalle.push({ id: c.id, unidad: c.unidad, aviso, dry: true });
      continue;
    }
    const r = await invocarNotify(url, anon, "notify-whatsapp-consulta", {
      consulta_id: c.id,
      evento: "consulta_usado_sin_responder",
    });
    if (r.ok) {
      await patch(url, key, `consultas_usados?id=eq.${c.id}`, {
        recordatorios_enviados: aviso,
        ultimo_recordatorio_at: new Date().toISOString(),
      });
    }
    detalle.push({ id: c.id, unidad: c.unidad, aviso, ...r });
  }

  return {
    revisadas: (filas || []).length,
    recordadas: detalle.filter((d) => d.dry || d.ok).length,
    detalle,
  };
}

// Agrupa consultas del mismo vendedor creadas casi al mismo tiempo: son las N
// unidades de un mismo pedido, que el wizard guarda como N consultas separadas.
function agruparPorSubmit(filas: any[]): any[][] {
  const orden = [...filas].sort((a, b) => {
    const va = String(a.vendedor_id || "");
    const vb = String(b.vendedor_id || "");
    if (va !== vb) return va < vb ? -1 : 1;
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });

  const grupos: any[][] = [];
  for (const f of orden) {
    const ultimo = grupos[grupos.length - 1];
    const ref = ultimo && ultimo[ultimo.length - 1];
    const mismoVendedor = ref && String(ref.vendedor_id || "") === String(f.vendedor_id || "");
    const cerca = ref && Math.abs(Date.parse(f.created_at) - Date.parse(ref.created_at)) <= VENTANA_GRUPO_MS;
    if (mismoVendedor && cerca) ultimo.push(f);
    else grupos.push([f]);
  }
  return grupos;
}

// ---------- Helpers ----------

// ¿Le toca recordatorio? Nunca recordó, o el último fue hace >= intervalo.
function tocaRecordar(fila: any, cfg: any): boolean {
  if ((fila.recordatorios_enviados || 0) >= cfg.max_recordatorios) return false;
  if (!fila.ultimo_recordatorio_at) return true;
  const desde = Date.parse(fila.ultimo_recordatorio_at);
  if (!isFinite(desde)) return true;
  return (Date.now() - desde) >= cfg.intervalo_min * 60000;
}

async function invocarNotify(url: string, anon: string, fn: string, body: any) {
  // `notify-whatsapp-consulta` tiene el verificador de JWT ENCENDIDO (a
  // diferencia de las del tasador). Si la ANON_KEY que inyecta Supabase no fuera
  // un JWT clásico, reintentamos con la SERVICE_ROLE_KEY antes de darlo por
  // perdido — así el recordatorio no depende del formato de keys del proyecto.
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  let ultimo: any = { ok: false, status: 0, error: "sin intento" };

  for (const key of [anon, SERVICE_KEY]) {
    if (!key) continue;
    try {
      const res = await fetch(url + "/functions/v1/" + fn, {
        method: "POST",
        headers: {
          "apikey": key,
          "Authorization": "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      ultimo = {
        ok: res.ok,
        status: res.status,
        enviados: data.enviados || 0,
        errores: (data.errores || []).length,
        info: data.info || null,
        error: data.error || null,
      };
      // Sólo reintentamos si el rechazo fue de autenticación.
      if (res.ok || (res.status !== 401 && res.status !== 403)) return ultimo;
    } catch (e) {
      ultimo = { ok: false, status: 0, error: String(e) };
    }
  }
  return ultimo;
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sb(url: string, key: string, path: string) {
  const res = await fetch(url + "/rest/v1/" + path, {
    headers: {
      "apikey": key,
      "Authorization": "Bearer " + key,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("Supabase " + res.status + ": " + t);
  }
  return res.json();
}

async function patch(url: string, key: string, path: string, body: any) {
  try {
    const res = await fetch(url + "/rest/v1/" + path, {
      method: "PATCH",
      headers: {
        "apikey": key,
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error("patch err:", res.status, await res.text());
  } catch (e) {
    console.error("patch err:", e);
  }
}
