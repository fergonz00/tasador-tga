// Edge Function: notify-unidad-demorada
//
// Unidades que figuran A RECIBIR en Oversoft y no llegan. Cuando una unidad
// lleva mas de 7 dias habiles cargada en el sistema sin entrar fisicamente, le
// avisa por WhatsApp a Fer y a Daniel Lopez para que le consulten a VW que
// paso. Pedido por Fer el 21/08/2026: se vendio una Amarok Hero que estaba "a
// recibir" y recien al reclamarla nos enteramos de que los papeles estaban
// demorados y no llegaba en el corto plazo. El vendedor le habia prometido una
// fecha al cliente que nadie podia sostener.
//
// El circuito completo:
//   1. Esta funcion detecta la demora y avisa (Fer + Daniel Lopez).
//   2. Ellos le consultan a VW.
//   3. Fer carga el problema y la fecha estimada de llegada en el panel
//      /precios del portal (tabla `unidades_demora`, columnas `problema` y
//      `fecha_estimada`).
//   4. El vendedor ve esa nota en /ofertas, /presupuesto y consulta-0km, asi
//      sabe que plazo prometerle al cliente antes de vender la unidad.
//
// Cadencia (definida por Fer el 21/08/2026):
//   - Primer aviso a los DIAS_ALERTA (7) dias habiles desde que la unidad esta
//     en Oversoft (`fechadepedido`, que es la fecha de alta).
//   - Sin nota cargada: reincide cada DIAS_REPASO (5) dias habiles.
//   - Con nota cargada: se apaga y vuelve a los 5 dias habiles de la nota, para
//     ir actualizando el estado. EXCEPCION: si la nota trae una fecha estimada
//     de llegada que todavia no vencio, se calla hasta esa fecha — ya sabemos
//     cuando llega, no hay nada que consultar. Si la fecha pasa y la unidad
//     sigue sin llegar, vuelve a avisar.
//   - La unidad se cierra sola cuando Oversoft la marca recibida o entregada.
//   - SILENCIADA: Fer puede marcar desde el panel "ya la chequee, no me avises
//     mas" (`silenciada_at`). Deja de avisar y el vendedor la ve como una a
//     recibir normal, pero sigue en el panel por si hay que retomarla. Si
//     despues se le carga una nota, la nota manda y el vendedor la vuelve a ver.
//
// De donde sale el dato (replica Oversoft, SOLO LECTURA):
//   `unidades` con recibida=false y entregada=false = pedida y todavia no
//   fisica. `fechadepedido` es la fecha de alta (coincide con `statusfec`).
//   `preventa` != '' quiere decir que ya esta vendida — ese caso es el urgente,
//   porque hay un cliente esperando.
//   El nombre del modelo: `modelos.descripcionoperativa` por codigo de compra;
//   si el model-year es tan nuevo que Oversoft no lo describio todavia (el caso
//   de las AGDD8A MY26), cae a la descripcion real de ESE chasis segun la
//   factura de VW (`compras_vw.modelo_valeria`) o el reparto
//   (`reparto_vw.descripcion`). Mismo fallback que portal-precios/src/lib/unidades.ts.
//
// A quien le llega: `fngonzalez` y `dlopez`, via tasador_usuarios (respeta
// activo / notificaciones_wa). Se cambia sin tocar codigo con el env
// UNIDAD_DEMORA_DESTINATARIOS (usuarios separados por coma).
//
// Template Meta: `unidad_a_recibir_demorada` (es_AR, UTILITY, 4 variables)
//   {{1}} destinatario - {{2}} unidad (modelo, color, chasis)
//   {{3}} desde cuando esta y si esta vendida - {{4}} que sabemos hasta ahora.
//
// Modos (query string o body JSON):
//   ?dry=1                 -> no manda ni escribe: devuelve que haria
//   ?sync=1                -> actualiza la lista de unidades a recibir SIN avisar
//                             (es lo que alimenta el panel /precios y consulta-0km)
//   ?solo=549113...        -> manda un ejemplo a ese numero (prueba)
//   ?forzar=1              -> ignora la cadencia y lo ya avisado hoy
//   ?desde=2026-06-01      -> corte de arranque por fechadepedido
//   ?dias=7                -> cambia el umbral de dias habiles (pruebas)
//   ?listar=1              -> lista los templates de la WABA
//   ?crear_template=1      -> da de alta el template en Meta (una sola vez)
//
// pg_cron (job notify-unidad-demorada): "0 13 * * 1-6" = 10:00 hora AR, de
// lunes a sabado. Domingo no manda: el salon esta cerrado y no hay a quien
// consultarle.

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "unidad_a_recibir_demorada";
const WABA_ID_DEFAULT = "1183788370595856"; // WABA "Tito Gonzalez | Tasador"

// Dias habiles que puede estar una unidad "a recibir" antes de que sea raro.
const DIAS_ALERTA = Number(Deno.env.get("UNIDAD_DEMORA_DIAS") ?? 7);
// Cada cuantos dias habiles se vuelve a insistir.
const DIAS_REPASO = Number(Deno.env.get("UNIDAD_DEMORA_REPASO") ?? 5);
// Tope de unidades por corrida, para que un problema masivo no dispare 40 mensajes.
const MAX_UNIDADES = Number(Deno.env.get("UNIDAD_DEMORA_MAX") ?? 10);

const DESTINATARIOS = (Deno.env.get("UNIDAD_DEMORA_DESTINATARIOS") ?? "fngonzalez,dlopez")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Arranque: no avisar unidades cargadas antes de esta fecha. Se mide por
// `fechadepedido`. Sin esto entrarian a la lista las unidades viejas que
// quedaron colgadas en Oversoft sin recibir nunca.
const DESDE = (Deno.env.get("UNIDAD_DEMORA_DESDE") ?? "2026-06-01").slice(0, 10);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { /* body opcional */ }
  }
  const par = (k: string) => body[k] ?? url.searchParams.get(k);
  const flag = (k: string) => {
    const v = par(k);
    return v === true || v === "1" || v === "true";
  };

  const env: Env = {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL") ?? "",
    SERVICE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    OV_URL: (Deno.env.get("OVERSOFT_URL") ?? "").replace(/\/+$/, ""),
    OV_KEY: Deno.env.get("OVERSOFT_KEY") ?? "",
    WA_PHONE_ID: Deno.env.get("WA_TASADOR_PHONE_ID") ?? "",
    WA_TOKEN: Deno.env.get("WA_TASADOR_TOKEN") ?? "",
    WABA_ID: Deno.env.get("WA_TASADOR_WABA_ID") ?? WABA_ID_DEFAULT,
  };
  if (!env.SUPABASE_URL || !env.SERVICE_KEY) return json({ error: "SUPABASE env vars missing" }, 500);
  if (!env.OV_URL || !env.OV_KEY) return json({ error: "OVERSOFT env vars missing" }, 500);
  if (!env.WA_PHONE_ID || !env.WA_TOKEN) return json({ error: "WA_TASADOR env vars missing" }, 500);

  try {
    if (flag("listar")) return json(await listarTemplates(env));
    if (flag("crear_template")) return json(await crearTemplate(env));

    const solo = String(par("solo") ?? "").trim();
    if (solo) return json(await pruebaDirigida(env, solo.replace(/^\+/, "").replace(/[\s-]/g, "")));

    return json(await procesar(env, {
      dry: flag("dry"),
      sync: flag("sync"),
      forzar: flag("forzar"),
      desde: String(par("desde") ?? DESDE).slice(0, 10),
      dias: Number(par("dias")) > 0 ? Number(par("dias")) : DIAS_ALERTA,
    }));
  } catch (e) {
    console.error("notify-unidad-demorada:", e);
    return json({ error: String(e) }, 500);
  }
});

type Env = {
  SUPABASE_URL: string; SERVICE_KEY: string;
  OV_URL: string; OV_KEY: string;
  WA_PHONE_ID: string; WA_TOKEN: string; WABA_ID: string;
};

type OvsUnidad = {
  unidadid: number;
  serie: string | null;
  modelo: string | null;
  color: number | string | null;
  preventa: string | null;
  fechadepedido: string | null;
  recibida: boolean | null;
  entregada: boolean | null;
};

type FilaDemora = {
  serie: string;
  silenciada_at: string | null;
  problema: string | null;
  fecha_estimada: string | null;
  nota_at: string | null;
  avisos: number | null;
  ultimo_aviso_at: string | null;
  recibida_at: string | null;
  fecha_oversoft: string | null;
};

// ── Proceso ─────────────────────────────────────────────────────────────────

async function procesar(env: Env, opts: { dry: boolean; sync: boolean; forzar: boolean; desde: string; dias: number }) {
  const hoyAR = fechaAR(new Date());

  // 1) Las que hoy figuran a recibir en Oversoft (pedidas y todavia no fisicas).
  //    Las vendidas (con preventa) entran igual: son las urgentes.
  const raw = await ov(
    env,
    "unidades?select=unidadid,serie,modelo,color,preventa,fechadepedido,recibida,entregada" +
      "&recibida=eq.false&entregada=eq.false&order=fechadepedido.asc&limit=500",
  ) as OvsUnidad[];

  const aRecibir = raw.filter((u) => {
    const f = String(u.fechadepedido ?? "").slice(0, 10);
    return !!String(u.serie ?? "").trim() && !!f && f >= opts.desde;
  });

  const feriados = await feriadosMap(env);

  // 2) Espejo en wjfgl: alta de las nuevas, cierre de las que ya llegaron.
  const enOversoft = new Set(aRecibir.map((u) => serieDe(u)));
  const guardadas = await estadoGuardado(env);
  if (!opts.dry) {
    await cerrarLlegadas(env, guardadas, enOversoft);
  }

  // 3) Nombre del modelo y color.
  const [descPorCodigo, colorPorId, descPorChasis] = await Promise.all([
    descripcionesOversoft(env, aRecibir),
    coloresOversoft(env, aRecibir),
    descripcionesPorChasis(env, aRecibir).catch(() => new Map<string, string>()),
  ]);

  // 4) Quien esta en condiciones de aviso.
  const candidatos: Candidato[] = [];
  const enSeguimiento: unknown[] = [];

  for (const u of aRecibir) {
    const serie = serieDe(u);
    const alta = String(u.fechadepedido).slice(0, 10);
    const habiles = habilesEntre(alta, hoyAR, feriados);
    const prev = guardadas.get(serie);
    const unidad = descUnidad(u, descPorCodigo, descPorChasis, colorPorId);

    if (!opts.dry) {
      await upsertDemora(env, {
        serie,
        unidadid: u.unidadid,
        modelo: unidad.modelo,
        color: unidad.color,
        fecha_oversoft: alta,
        preventa: String(u.preventa ?? "").trim() || null,
        recibida_at: null,
        updated_at: new Date().toISOString(),
      });
    }

    const motivo = motivoAviso({ habiles, dias: opts.dias, prev, hoyAR, feriados, forzar: opts.forzar });
    enSeguimiento.push({
      serie, unidad: unidad.texto, alta, dias_habiles: habiles,
      preventa: String(u.preventa ?? "").trim() || null,
      problema: prev?.problema ?? null, fecha_estimada: prev?.fecha_estimada ?? null,
      avisos: prev?.avisos ?? 0,
      silenciada: prev?.silenciada_at ? true : undefined,
      motivo: motivo ?? (prev?.silenciada_at ? "silenciada (ya chequeada)" : "en plazo / ya avisado"),
    });
    if (motivo) candidatos.push({ u, serie, alta, habiles, unidad, prev, motivo });
  }

  if (!candidatos.length || opts.sync) {
    // `sync` deja la lista al dia (altas, cierres y nombres) sin mandar nada. Sirve
    // para poblar el panel sin molestar a nadie, y para tener datos aunque el aviso
    // este apagado.
    return {
      ok: true, hoy: hoyAR, solo_sync: opts.sync || undefined,
      a_recibir: aRecibir.length, avisables: candidatos.length,
      seguimiento: enSeguimiento, enviados: [],
    };
  }

  // Las mas viejas primero: si hay tope, que salgan las que mas duelen.
  candidatos.sort((a, b) => b.habiles - a.habiles);
  const aAvisar = candidatos.slice(0, MAX_UNIDADES);

  // 5) Destinatarios y control de duplicados del dia.
  const usuarios = await padronUsuarios(env);
  const yaHoy = opts.forzar ? new Set<string>() : await avisadosHoy(env, aAvisar.map((c) => c.serie), hoyAR);

  // Domingo o feriado: no se molesta (no hay a quien consultarle en VW).
  if (!opts.dry && !opts.forzar && esNoHabilParaAvisar(hoyAR, feriados)) {
    return {
      ok: true, hoy: hoyAR, a_recibir: aRecibir.length, avisables: candidatos.length,
      enviados: [], detalle: "domingo o feriado: no se avisa", seguimiento: enSeguimiento,
    };
  }

  const enviados: unknown[] = [];
  const errores: unknown[] = [];
  const omitidos: unknown[] = [];

  for (const c of aAvisar) {
    const cuando = textoAntiguedad(c.alta, c.habiles);
    const estado = textoEstado(c.u, cuando);
    const sabido = textoSabido(c.prev, c.habiles);
    let salioAlguno = false;

    for (const dest of usuarios) {
      const clave = `${c.serie}|${dest.usuario}`;
      if (yaHoy.has(clave)) {
        omitidos.push({ serie: c.serie, para: dest.usuario, motivo: "ya avisado hoy" });
        continue;
      }

      const fila: Record<string, unknown> = {
        serie: c.serie, fecha: hoyAR, destinatario: dest.usuario, destinatario_tel: dest.telefono_wa,
        modelo: c.unidad.modelo, dias_habiles: c.habiles, motivo: c.motivo,
      };

      if (opts.dry) {
        enviados.push({ ...fila, unidad: c.unidad.texto, estado, sabido, destinatario_nombre: dest.nombre });
        continue;
      }

      const r = await enviarTemplate(env, dest.telefono_wa, [
        primerNombre(dest.nombre), c.unidad.texto, estado, sabido,
      ]);
      if (r.ok) {
        salioAlguno = true;
        enviados.push({ serie: c.serie, unidad: c.unidad.texto, para: dest.nombre, dias_habiles: c.habiles, motivo: c.motivo });
        await guardarAviso(env, { ...fila, estado: "enviado", enviado_at: new Date().toISOString(), meta_id: r.meta_id, error: null });
      } else {
        errores.push({ serie: c.serie, para: dest.nombre, error: r.error });
        await guardarAviso(env, { ...fila, estado: "pendiente", error: JSON.stringify(r.error).slice(0, 500) });
      }
    }

    // El contador de la unidad avanza una vez por corrida, no una por destinatario,
    // y SOLO si el mensaje salio de verdad. Si Meta rechaza (template todavia
    // PENDING, token vencido), la unidad no se sella y se reintenta en la corrida
    // siguiente en vez de quedar muda 5 dias habiles.
    if (!opts.dry && salioAlguno) {
      await sbPatch(env, `unidades_demora?serie=eq.${encodeURIComponent(c.serie)}`, {
        avisos: (c.prev?.avisos ?? 0) + 1,
        ultimo_aviso_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  }

  return {
    ok: true, hoy: hoyAR, dry: opts.dry, desde: opts.desde, umbral_habiles: opts.dias,
    a_recibir: aRecibir.length, avisables: candidatos.length, avisadas: aAvisar.length,
    destinatarios: usuarios.map((u) => u.usuario),
    enviados, omitidos, errores, seguimiento: enSeguimiento,
  };
}

type Unidad = { texto: string; modelo: string; color: string };
type Candidato = {
  u: OvsUnidad; serie: string; alta: string; habiles: number;
  unidad: Unidad; prev: FilaDemora | undefined; motivo: string;
};

/**
 * La regla de cadencia, en un solo lugar.
 *   - Menos del umbral de dias habiles: nada.
 *   - Nunca avisada y sin nota: primer aviso.
 *   - Con fecha estimada de llegada que todavia no vencio: silencio hasta esa
 *     fecha (ya sabemos cuando llega, no hay nada que consultar).
 *   - Si no: cada DIAS_REPASO dias habiles desde lo ultimo que paso (la nota o
 *     el aviso anterior, lo que sea mas reciente).
 */
function motivoAviso(a: {
  habiles: number; dias: number; prev: FilaDemora | undefined;
  hoyAR: string; feriados: Map<string, string>; forzar: boolean;
}): string | null {
  if (a.forzar) return "forzado";
  if (a.habiles < a.dias) return null;

  const prev = a.prev;
  // Chequeada a mano y sin problema: no se avisa mas por esta unidad.
  if (prev?.silenciada_at) return null;
  const notaAt = prev?.nota_at ? String(prev.nota_at).slice(0, 10) : null;
  const avisoAt = prev?.ultimo_aviso_at ? String(prev.ultimo_aviso_at).slice(0, 10) : null;

  if (!notaAt && !avisoAt) return "primer aviso";

  // Fecha estimada de llegada cargada y todavia vigente: no se molesta.
  const est = prev?.fecha_estimada ? String(prev.fecha_estimada).slice(0, 10) : null;
  if (est && est >= a.hoyAR) return null;

  const ultimo = [notaAt, avisoAt].filter(Boolean).sort().pop()!;
  if (habilesEntre(ultimo, a.hoyAR, a.feriados) < DIAS_REPASO) return null;

  if (est && est < a.hoyAR) return "se pasó la fecha estimada";
  return notaAt && notaAt >= (avisoAt ?? "") ? "repaso de estado" : "sigue sin novedades";
}

// ── Espejo en wjfgl ─────────────────────────────────────────────────────────

async function estadoGuardado(env: Env) {
  const filas = await sb(
    env,
    "unidades_demora?select=serie,problema,fecha_estimada,nota_at,avisos,ultimo_aviso_at,recibida_at,fecha_oversoft,silenciada_at&limit=2000",
  ) as FilaDemora[];
  return new Map<string, FilaDemora>(filas.map((f) => [String(f.serie), f]));
}

const upsertDemora = (env: Env, fila: Record<string, unknown>) =>
  sb(env, "unidades_demora?on_conflict=serie", {
    method: "POST",
    // Solo los campos que vienen de Oversoft. La nota de Fer (problema /
    // fecha_estimada / nota_at) no se toca: es de el, no del sync.
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(fila),
  });

/** Las que estaban en seguimiento y ya no figuran a recibir: llegaron. */
async function cerrarLlegadas(env: Env, guardadas: Map<string, FilaDemora>, enOversoft: Set<string>) {
  const cerrar = [...guardadas.values()]
    .filter((f) => !f.recibida_at && !enOversoft.has(String(f.serie)))
    .map((f) => String(f.serie));
  if (!cerrar.length) return;
  const lista = cerrar.map((s) => `"${s}"`).join(",");
  await sbPatch(env, `unidades_demora?serie=in.(${encodeURIComponent(lista)})`, {
    recibida_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

const guardarAviso = (env: Env, fila: Record<string, unknown>) =>
  sb(env, "unidades_demora_avisos?on_conflict=serie,fecha,destinatario", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(fila),
  });

async function avisadosHoy(env: Env, series: string[], hoyAR: string) {
  if (!series.length) return new Set<string>();
  const lista = series.map((s) => `"${s}"`).join(",");
  const filas = await sb(
    env,
    `unidades_demora_avisos?fecha=eq.${hoyAR}&estado=eq.enviado&serie=in.(${encodeURIComponent(lista)})&select=serie,destinatario`,
  );
  return new Set<string>(filas.map((f: { serie: string; destinatario: string }) => `${f.serie}|${f.destinatario}`));
}

// ── Nombre de la unidad ─────────────────────────────────────────────────────

const serieDe = (u: OvsUnidad) => String(u.serie ?? "").trim().toUpperCase();

/** descripcionoperativa por codigo de compra (el nombre que usa Oversoft). */
async function descripcionesOversoft(env: Env, us: OvsUnidad[]) {
  const codigos = [...new Set(us.map((u) => String(u.modelo ?? "").trim()).filter(Boolean))];
  const m = new Map<string, string>();
  if (!codigos.length) return m;
  const lista = codigos.map((c) => `"${c}"`).join(",");
  const filas = await ov(
    env,
    `modelos?select=codigodecompra,descripcionoperativa&codigodecompra=in.(${encodeURIComponent(lista)})`,
  ).catch(() => []);
  for (const f of filas) {
    if (f.codigodecompra) m.set(String(f.codigodecompra).trim(), String(f.descripcionoperativa ?? "").trim());
  }
  return m;
}

async function coloresOversoft(env: Env, us: OvsUnidad[]) {
  const ids = [...new Set(us.map((u) => String(u.color ?? "").trim()).filter(Boolean))];
  const m = new Map<string, string>();
  if (!ids.length) return m;
  const filas = await ov(env, `colores?select=colorid,descripcion&colorid=in.(${ids.join(",")})`).catch(() => []);
  for (const f of filas) m.set(String(f.colorid), String(f.descripcion ?? "").trim());
  return m;
}

/**
 * Descripcion real por CHASIS, para los model-year que Oversoft todavia no
 * describio (AGDD8A MY26 no esta en `modelos`, y ademas el codigo base es
 * ambiguo: Extreme / Hero / Black Style comparten AGDD8A). Fuentes: la factura
 * de VW que carga Valeria y el reparto. Mismo criterio que portal-precios.
 */
async function descripcionesPorChasis(env: Env, us: OvsUnidad[]) {
  const series = us.map((u) => serieDe(u)).filter(Boolean);
  const m = new Map<string, string>();
  if (!series.length) return m;
  const lista = series.map((s) => `"${s}"`).join(",");
  const [rep, com] = await Promise.all([
    sb(env, `reparto_vw?select=vin,descripcion&limit=2000`).catch(() => []),
    sb(env, `compras_vw?select=serie,modelo_valeria&serie=in.(${encodeURIComponent(lista)})`).catch(() => []),
  ]);
  for (const r of rep) {
    const s = String(r.vin ?? "").trim().toUpperCase().slice(-8);
    if (s && r.descripcion) m.set(s, String(r.descripcion).trim());
  }
  // Compras pisa a reparto: es lo facturado, no lo prometido.
  for (const r of com) {
    const s = String(r.serie ?? "").trim().toUpperCase();
    if (s && r.modelo_valeria) m.set(s, String(r.modelo_valeria).trim());
  }
  return m;
}

function descUnidad(
  u: OvsUnidad,
  porCodigo: Map<string, string>,
  porChasis: Map<string, string>,
  colores: Map<string, string>,
): Unidad {
  const cod = String(u.modelo ?? "").trim();
  const serie = serieDe(u);
  const modelo = limpiarModelo(porCodigo.get(cod) || porChasis.get(serie) || `código ${cod}`);
  const color = colores.get(String(u.color ?? "")) || "color sin identificar";
  return { texto: `${modelo} ${color} (chasis ${serie})`, modelo, color };
}

// "VW Amarok Hero V6 AT 4X4 G2  MY25" -> "Amarok Hero V6 AT 4X4 G2 MY25"
const limpiarModelo = (s: string) =>
  String(s || "").replace(/\s+/g, " ").replace(/^VW\s+/i, "").trim();

// ── Textos del mensaje ──────────────────────────────────────────────────────

function textoAntiguedad(alta: string, habiles: number) {
  const etiqueta = `${DIAS[diaSemana(alta)]} ${alta.slice(8, 10)}/${alta.slice(5, 7)}`;
  return `está cargada desde el ${etiqueta}, hace ${habiles} días hábiles`;
}

function textoEstado(u: OvsUnidad, cuando: string) {
  const pv = String(u.preventa ?? "").trim();
  if (pv) return `${cuando} y YA ESTÁ VENDIDA en la ${pv}, o sea que hay un cliente esperándola`;
  return `${cuando} y todavía no está vendida`;
}

function textoSabido(prev: FilaDemora | undefined, habiles: number) {
  const problema = String(prev?.problema ?? "").trim();
  const est = prev?.fecha_estimada ? String(prev.fecha_estimada).slice(0, 10) : null;
  if (!problema && !est) {
    return habiles > 0 && (prev?.avisos ?? 0) > 0
      ? "Todavía no hay nada anotado sobre esta unidad"
      : "No tenemos ninguna novedad de VW sobre esta unidad";
  }
  const partes: string[] = [];
  if (problema) partes.push(`Lo último anotado: ${problema}`);
  if (est) {
    const venc = est < fechaAR(new Date()) ? "y esa fecha ya pasó" : `y se esperaba para el ${est.slice(8, 10)}/${est.slice(5, 7)}`;
    partes.push(problema ? venc : `Se esperaba para el ${est.slice(8, 10)}/${est.slice(5, 7)} y esa fecha ya pasó`);
  }
  return partes.join(" ");
}

// ── Destinatarios ───────────────────────────────────────────────────────────

type Usuario = { usuario: string; nombre: string; telefono_wa: string };

async function padronUsuarios(env: Env): Promise<Usuario[]> {
  const lista = DESTINATARIOS.map((u) => `"${u}"`).join(",");
  const filas = await sb(
    env,
    `tasador_usuarios?usuario=in.(${lista})&select=usuario,nombre,telefono_wa,notificaciones_wa,activo`,
  );
  const out: Usuario[] = [];
  for (const u of filas) {
    if (u.activo === false || u.notificaciones_wa === false) continue;
    const tel = String(u.telefono_wa || "").replace(/^\+/, "").replace(/[\s-]/g, "");
    if (!tel) continue;
    out.push({ usuario: String(u.usuario), nombre: u.nombre || u.usuario, telefono_wa: tel });
  }
  out.sort((a, b) => DESTINATARIOS.indexOf(a.usuario) - DESTINATARIOS.indexOf(b.usuario));
  return out;
}

// ── WhatsApp ────────────────────────────────────────────────────────────────

async function enviarTemplate(env: Env, telE164: string, vars: string[]) {
  const payload = {
    messaging_product: "whatsapp",
    to: telE164,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: META_LANGUAGE },
      components: [{ type: "body", parameters: vars.map((v) => ({ type: "text", text: limpiar(v) })) }],
    },
  };
  try {
    const res = await fetch(`${META_API_URL}/${env.WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (res.ok && j.messages?.[0]) return { ok: true, meta_id: j.messages[0].id };
    return { ok: false, error: j.error || j };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Los parametros de template no admiten saltos de linea, tabs ni 5 espacios seguidos.
const limpiar = (s: string) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{4,}/g, "   ").trim();

async function pruebaDirigida(env: Env, tel: string) {
  const r = await enviarTemplate(env, tel, [
    "Fer",
    "PRUEBA - Amarok Hero V6 AT 4X4 G2 MY26 Gris Volcan (chasis TA020043)",
    "está cargada desde el viernes 31/07, hace 14 días hábiles y YA ESTÁ VENDIDA en la PV 08754/3, o sea que hay un cliente esperándola",
    "No tenemos ninguna novedad de VW sobre esta unidad",
  ]);
  return { prueba: true, destino: tel, ...r };
}

async function listarTemplates(env: Env) {
  const res = await fetch(
    `${META_API_URL}/${env.WABA_ID}/message_templates?fields=name,language,status,category&limit=200`,
    { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } },
  );
  const j = await res.json();
  return {
    templates: (j?.data ?? []).map((t: Record<string, string>) => ({
      name: t.name, language: t.language, status: t.status, category: t.category,
    })),
    error: j?.error,
  };
}

async function crearTemplate(env: Env) {
  const res = await fetch(`${META_API_URL}/${env.WABA_ID}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: TEMPLATE_NAME,
      language: META_LANGUAGE,
      category: "UTILITY",
      components: [
        { type: "HEADER", format: "TEXT", text: "Unidad a recibir que no llega" },
        {
          type: "BODY",
          text: "Hola {{1}}, la unidad {{2}} figura A RECIBIR en el sistema y todavía no entró físicamente: {{3}}. {{4}}. Hay que consultarle a VW qué pasa y cargar el problema y la fecha estimada de llegada en el panel de precios, así los vendedores saben qué plazo prometerle al cliente.",
          example: {
            body_text: [[
              "Fer",
              "Amarok Hero V6 AT 4X4 G2 MY26 Gris Volcan (chasis TA020043)",
              "está cargada desde el viernes 31/07, hace 14 días hábiles y YA ESTÁ VENDIDA en la PV 08754/3, o sea que hay un cliente esperándola",
              "No tenemos ninguna novedad de VW sobre esta unidad",
            ]],
          },
        },
        { type: "FOOTER", text: "Aviso automático · Tito Gonzalez" },
      ],
    }),
  });
  return { status: res.status, respuesta: await res.json() };
}

// ── Calendario ──────────────────────────────────────────────────────────────

async function feriadosMap(env: Env) {
  const filas = await sb(env, `feriados_ar?select=fecha,nombre&limit=2000`);
  return new Map<string, string>(
    filas.map((f: { fecha: string; nombre: string }) => [String(f.fecha).slice(0, 10), f.nombre]),
  );
}

/** Dias habiles (lun-vie, sin feriados) transcurridos entre dos fechas. */
function habilesEntre(desde: string, hasta: string, feriados: Map<string, string>) {
  let f = desde.slice(0, 10);
  const fin = hasta.slice(0, 10);
  let n = 0;
  let guarda = 0;
  while (f < fin && guarda++ < 800) {
    f = isoMasDias(f, 1);
    const dow = diaSemana(f);
    if (dow !== 0 && dow !== 6 && !feriados.has(f)) n++;
  }
  return n;
}

// El sabado el salon trabaja; el domingo y los feriados no.
function esNoHabilParaAvisar(hoyISO: string, feriados: Map<string, string>) {
  if (feriados.has(hoyISO)) return true;
  return diaSemana(hoyISO) === 0;
}

const diaSemana = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay();
const fechaAR = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const isoMasDias = (iso: string, dias: number) =>
  new Date(new Date(`${iso.slice(0, 10)}T12:00:00Z`).getTime() + dias * 86400_000).toISOString().slice(0, 10);
const primerNombre = (n: string) => (n || "").trim().split(/\s+/)[0] || "equipo";

// ── Helpers HTTP ────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function sb(env: Env, path: string, options: RequestInit & { headers?: Record<string, string> } = {}): Promise<any[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: env.SERVICE_KEY,
      Authorization: `Bearer ${env.SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : [];
}

const sbPatch = (env: Env, path: string, patch: Record<string, unknown>) =>
  sb(env, path, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });

// deno-lint-ignore no-explicit-any
async function ov(env: Env, path: string): Promise<any[]> {
  const res = await fetch(`${env.OV_URL}/${path}`, {
    headers: { apikey: env.OV_KEY, Authorization: `Bearer ${env.OV_KEY}` },
  });
  if (!res.ok) throw new Error(`Oversoft ${res.status}: ${await res.text()}`);
  return await res.json();
}

// deno-lint-ignore no-explicit-any
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
