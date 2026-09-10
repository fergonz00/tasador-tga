// Edge Function: notify-pv-fecha-no-habil
//
// Tres controles sobre la forma de pago que el vendedor carga en la PV, todos
// avisando por WhatsApp al vendedor + gerente + Monica Gerez + Fernando N. Gonzalez:
//
//   A) `fecha_no_habil`  — la fecha de pago cae sabado, domingo o feriado
//                          (los bancos no acreditan ese dia).
//   B) `vencido_impago`  — paso la fecha prometida y el pago NO figura cobrado
//                          (o quedo saldo). Avisa a los 3 DIAS HABILES del
//                          vencimiento, para no pisar la demora normal de
//                          acreditacion y de carga del recibo.
//   C) `plazo_excedido`  — la fecha prometida cae MAS ALLA de los 5 dias habiles
//                          posteriores a la operacion (regla de Fer, 10/09/2026:
//                          "si la venta es el 30/09 el pago es a mas tardar el
//                          7/10; si es el 29/09, el 6/10, y asi sucesivamente").
//                          Se mide contra `preventas.fecha` (la fecha de la
//                          OPERACION), no contra la fecha de carga del renglon.
//
//                          ** SOLO aplica a la venta de fin de mes que se patenta
//                          al mes siguiente ** (recorte de Fer, 10/09/2026). Son
//                          DOS condiciones juntas:
//                            1. la PV cae en los ultimos N dias del mes, y
//                            2. su `comentario` dice que se patenta un mes
//                               posterior ("PATENTA SEPTIEMBRE" en una PV de
//                               agosto).
//                          Es el caso donde el cobro se corre a la 2da semana del
//                          mes siguiente y descoloca el flujo. Una PV normal que
//                          se patenta en su propio mes NO se controla.
//
//                          Unica salida legitima: excepcion explicita y
//                          documentada -> {"excepcion":{...}} (ver Modos).
//
// De donde sale el dato:
//   Replica Oversoft (solo lectura) -> tabla `detcash`, filas con
//   `origen = 'VTOKM'` y `referencia = 'PV xxxxx/n'`. Cada fila es un renglon
//   de la forma de pago que el vendedor carga a la izquierda de la PV:
//     - `motivo`      = concepto (SENA, CANCOKM, FIN0KMBBVA, ...)
//     - `importe`     = monto comprometido
//     - `vencimiento` = LA FECHA DE PAGO que promete el vendedor
//     - `saldo`       = lo que TODAVIA no se cobro (0 = cobrado del todo)
//     - `fecha`       = fecha de carga
//
// Que hace cada corrida:
//   1. Lee los renglones VTOKM de los ultimos VENTANA_DIAS + los feriados.
//   2. Arma los candidatos de los dos controles.
//   3. Da de alta las alertas nuevas en `pv_fechas_alertas` (PK detcashid+tipo).
//   4. Re-chequea las abiertas y cierra las que se resolvieron.
//   5. Manda 1 mensaje por PV y por tipo (agrupa los renglones de esa PV).
//      Si no se corrige: 1 recordatorio por dia habil, sin tope (MAX_AVISOS=0).
//
// Destinatarios: `tasador_usuarios` (telefono_wa). El vendedor sale de
// `pv_vendedores_map` (vendedorid de Oversoft -> usuario). Los fijos, del env
// PVFECHA_FIJOS (default: dlopez, mgerez, fngonzalez). Los vendedores de
// PVFECHA_VENDEDORES_SIN_AVISO (default: 22 = "T.G.") no reciben copia: esa PV
// avisa solo a los fijos.
//
// Templates Meta (WABA "Tito Gonzalez | Tasador"), los dos es_AR / UTILITY con
// 4 variables ({{1}} destinatario · {{2}} nro de PV · {{3}} detalle · {{4}} vendedor):
//   `pv_fecha_no_habil` · `pv_pago_vencido`
//
// Modos (query string o body JSON):
//   ?dry=1                 -> no manda ni escribe: devuelve que haria
//   ?solo=549113...        -> manda los dos ejemplos a ese numero (prueba)
//   ?forzar=1              -> ignora el limite de 1 aviso por dia y el horario
//   ?dias=90               -> agranda la ventana de lectura
//   ?desde=2026-08-18      -> corre el corte de arranque de `fecha_no_habil`
//   ?tipo=vencido_impago   -> corre un solo control
//   ?listar=1              -> lista los templates de la WABA (diagnostico)
//   ?crear_template=1      -> da de alta los templates que falten en Meta
//   {"cerrar":[detcashid]} -> cierra alertas a mano (deja de recordar)
//   {"excepcion":{"pv":"PV 08126/1","motivo":"...","por":"Daniel Lopez"}}
//                          -> autoriza un cobro fuera de plazo, documentado
//   {"comunicado":{"template":"pv_control_plazo_cobro"}}
//                          -> manda un comunicado unitario a los vendedores.
//                             Sin `confirmar:true` solo dice a quien iria.
//
// pg_cron (jobid 9): '*/10 16-23 * * *' = cada 10 min, 13 a 20 hora AR.
//   SELECT cron.schedule(
//     'notify-pv-fecha-no-habil', '*/10 15-23 * * *',
//     $$ SELECT net.http_post(
//       url := 'https://wjfglsafgaltusmbnccl.supabase.co/functions/v1/notify-pv-fecha-no-habil',
//       headers := jsonb_build_object('Content-Type', 'application/json'),
//       body := '{}'::jsonb
//     ); $$
//   );

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const WABA_ID_DEFAULT = "1183788370595856"; // WABA "Tito Gonzalez | Tasador"

const TIPO_FECHA = "fecha_no_habil";
const TIPO_VENCIDO = "vencido_impago";
const TIPO_PLAZO = "plazo_excedido";
const TEMPLATES: Record<string, string> = {
  [TIPO_FECHA]: "pv_fecha_no_habil",
  [TIPO_VENCIDO]: "pv_pago_vencido",
  [TIPO_PLAZO]: "pv_plazo_excedido",
};

// Renglones de la PV: los carga el vendedor con origen VTOKM.
const ORIGEN_PV = "VTOKM";
const VENTANA_DIAS = Number(Deno.env.get("PVFECHA_VENTANA_DIAS") ?? "60");
// Tope de recordatorios por alerta. **0 = sin tope** (Fer, 02/09/2026: "que
// siga avisando sin limite"). El aviso se corta solo cuando el problema se
// resuelve y la alerta se cierra, no por cansancio.
const MAX_AVISOS = Number(Deno.env.get("PVFECHA_MAX_AVISOS") ?? "0");
const HORA_DESDE = Number(Deno.env.get("PVFECHA_HORA_DESDE") ?? "13"); // hora AR (Fer, 01/09/2026: antes 12; y antes 9)
const HORA_HASTA = Number(Deno.env.get("PVFECHA_HORA_HASTA") ?? "20");
const FIJOS_DEFAULT = "dlopez,mgerez,fngonzalez";

// Vendedores "de la casa" que no son una persona a la que reclamarle: el aviso
// va SOLO a los fijos, sin copiar al usuario mapeado en `pv_vendedores_map`.
// 22 = "T.G." -> patriciag (pedido de Fer, 24/08/2026).
const VENDEDORES_SIN_AVISO = new Set(
  (Deno.env.get("PVFECHA_VENDEDORES_SIN_AVISO") ?? "22")
    .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
);

// El 1er aviso de fecha recien sale cuando el renglon lleva este tiempo cargado,
// para no pegarle al vendedor mientras todavia esta tipeando la forma de pago.
const GRACIA_MIN = Number(Deno.env.get("PVFECHA_GRACIA_MIN") ?? "20");

// Un pago vencido recien se reclama pasados estos DIAS HABILES desde la fecha
// prometida (Fer, 18/08/2026): la transferencia tarda en acreditar y el recibo
// en cargarse, asi que antes de eso el aviso seria un falso positivo.
const GRACIA_HABILES = Number(Deno.env.get("PVFECHA_GRACIA_HABILES") ?? "3");
// Saldo por debajo del cual el renglon se considera cobrado. Es el MAYOR entre
// un piso fijo y un % del importe: sobre una PV de $29 M un resto de $4.353 es
// un redondeo del ERP, no una deuda que justifique un aviso diario para siempre
// (caso 08753/3, 02/09/2026). El % hace que la tolerancia escale con la operacion.
const TOLERANCIA_SALDO = Number(Deno.env.get("PVFECHA_TOLERANCIA_SALDO") ?? "5000");
const TOLERANCIA_PCT = Number(Deno.env.get("PVFECHA_TOLERANCIA_PCT") ?? "0.001");
const estaCobrado = (importe: unknown, saldo: unknown) =>
  Number(saldo) <= Math.max(TOLERANCIA_SALDO, Math.abs(Number(importe)) * TOLERANCIA_PCT);

// ── Control C: plazo maximo de cobro ────────────────────────────────────────
// La operacion se cobra dentro de los N dias habiles POSTERIORES a la fecha de
// la PV. Con 5 (el default, regla de Fer): PV del 30/09 -> tope 07/10.
const PLAZO_HABILES = Number(Deno.env.get("PVPLAZO_HABILES") ?? "5");
// Colchon opcional ANTES de avisar, en dias habiles. Default 0 = la regla se
// aplica tal cual. Medido sobre 485 renglones (jun-sep 2026): 69 fuera de plazo
// (14%), de los cuales 27 se pasan por UN solo dia habil. Si ese volumen molesta,
// subir a 1 por env y los avisos bajan a ~42, sin tocar codigo ni redeployar.
const PLAZO_TOLERANCIA = Number(Deno.env.get("PVPLAZO_TOLERANCIA") ?? "0");
// Cuantos dias del final del mes cuentan como "fin de mes". Con 7: en un mes de
// 31 dias es del 25 al 31; en uno de 30, del 24 al 30; en febrero, del 22 al 28.
// Se mide contra el largo real del mes en vez de un dia fijo. Ponerlo en 31
// desactiva la condicion de fecha y deja solo la del comentario.
const PLAZO_DIAS_FIN_MES = Number(Deno.env.get("PVPLAZO_DIAS_FIN_MES") ?? "7");

// Corte de arranque del control de PLAZO: solo PVs hechas de esta fecha en
// adelante. Las anteriores quedan `historica` (registradas, sin avisar) para no
// disparar decenas de mensajes por operaciones ya cerradas el dia que se enciende.
const PLAZO_DESDE = (Deno.env.get("PVPLAZO_DESDE") ?? "2026-09-11").slice(0, 10);

// Corte de arranque del control de FECHAS: corre sobre las PREVENTAS HECHAS A
// PARTIR de esta fecha (Fer, 18/08/2026: "lo viejo ya esta"). Lo de PVs
// anteriores se registra como `historica` pero NO genera aviso — tampoco si a
// una PV vieja le agregan hoy un renglon nuevo.
// El control de VENCIDOS no usa este corte: una deuda vencida sigue viva sea de
// la PV que sea (decision de Fer al activarlo).
const DESDE = (Deno.env.get("PVFECHA_DESDE") ?? "2026-08-18").slice(0, 10);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

const DIAS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

// Los conceptos vienen con la Ñ rota (doble UTF-8) desde la replica.
const MOTIVOS: Record<string, string> = {
  "SEÑA": "Seña",
  "REFUESEÑA": "Refuerzo de seña",
  "CANCOKM": "Cancelación",
  "FIN0KM": "Financiación",
  "FIN0KMBBVA": "Financiación BBVA",
  "FIN0KMNAC": "Financiación Nación",
  "FIN0KMFG": "Financiación FG",
  "GASTADM": "Gastos administrativos",
};

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

  const env = {
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
    if (flag("crear_template")) return json(await crearTemplates(env));

    const cerrar = body["cerrar"];
    if (Array.isArray(cerrar) && cerrar.length) return json(await cerrarAMano(env, cerrar));

    // La UNICA salida legitima de un pago fuera de plazo que no se corrige.
    // Queda asentado quien la autorizo y por que: sin `motivo` y `por` no entra.
    const exc = body["excepcion"] as Record<string, unknown> | undefined;
    if (exc && typeof exc === "object") return json(await registrarExcepcion(env, exc));

    const com = body["comunicado"] as Record<string, unknown> | undefined;
    if (com && typeof com === "object") return json(await comunicado(env, com));

    const alc = par("alcance");
    if (alc) return json(await diagnosticoAlcance(env, String(alc)));

    const solo = String(par("solo") ?? "").trim();
    if (solo) return json(await pruebaDirigida(env, solo.replace(/^\+/, "").replace(/[\s-]/g, "")));

    const tipo = String(par("tipo") ?? "").trim();
    return json(await procesar(env, {
      dry: flag("dry"),
      forzar: flag("forzar"),
      dias: Number(par("dias") ?? VENTANA_DIAS) || VENTANA_DIAS,
      desde: String(par("desde") ?? DESDE).slice(0, 10),
      desdePlazo: String(par("desde_plazo") ?? PLAZO_DESDE).slice(0, 10),
      tipos: tipo ? [tipo] : [TIPO_FECHA, TIPO_VENCIDO, TIPO_PLAZO],
    }));
  } catch (e) {
    console.error("notify-pv-fecha-no-habil:", e);
    return json({ error: String(e) }, 500);
  }
});

type Env = {
  SUPABASE_URL: string; SERVICE_KEY: string;
  OV_URL: string; OV_KEY: string;
  WA_PHONE_ID: string; WA_TOKEN: string; WABA_ID: string;
};

type Renglon = {
  detcashid: number; fecha: string; vencimiento: string | null;
  importe: number; saldo: number; motivo: string; referencia: string;
};

type Alerta = {
  detcashid: number; tipo: string; referencia: string; motivo: string | null;
  importe: number | null; saldo_pendiente: number | null; importe_cobrado: number | null;
  vencimiento: string;
  plazo_tope: string | null;
  dia_texto: string | null; vendedorid: number | null; vendedor_nombre: string | null;
  fecha_pv: string | null; estado: string; ultimo_aviso_dia: string | null; avisos: number;
};

type PV = { vendedorid: number; vendedor: string; fecha: string; anulada: boolean; comentario: string };

// ── Nucleo ──────────────────────────────────────────────────────────────────

async function procesar(
  env: Env,
  opts: { dry: boolean; forzar: boolean; dias: number; desde: string; desdePlazo: string; tipos: string[] },
) {
  const ahora = new Date();
  const hoyAR = fechaAR(ahora);
  const horaAR = ahora.getUTCHours() - 3 < 0 ? ahora.getUTCHours() + 21 : ahora.getUTCHours() - 3;

  const feriados = await feriadosMap(env);
  const desdeLectura = isoMasDias(hoyAR, -Math.abs(opts.dias));
  const renglones: Renglon[] = await ov(
    env,
    `detcash?origen=eq.${ORIGEN_PV}&fecha=gte.${desdeLectura}` +
    `&select=detcashid,fecha,vencimiento,importe,saldo,motivo,referencia`,
  );
  // Los importes negativos son contra-asientos de anulacion, no promesas de pago.
  const aCobrar = renglones.filter((r) => r.vencimiento && Number(r.importe) > 0);

  // Las PVs se leen ANTES de armar los candidatos porque el control de plazo
  // necesita la fecha de la operacion. `preventasDe` hace una lectura unica y
  // filtra en memoria, asi que pasarle todas las referencias no cuesta una query
  // mas que pasarle solo las de los candidatos.
  const pvs = await preventasDe(env, [...new Set(aCobrar.map((r) => r.referencia))], opts.dias);

  // ── Candidatos de cada control ────────────────────────────────────────────
  const candidatos: { tipo: string; r: Renglon; texto: string; tope?: string }[] = [];
  if (opts.tipos.includes(TIPO_FECHA)) {
    for (const r of aCobrar) {
      const { noHabil, texto } = esNoHabil(r.vencimiento!, feriados);
      if (noHabil) candidatos.push({ tipo: TIPO_FECHA, r, texto });
    }
  }
  if (opts.tipos.includes(TIPO_VENCIDO)) {
    for (const r of aCobrar) {
      if (estaCobrado(r.importe, r.saldo)) continue; // ya cobrado
      // Recien se reclama pasados GRACIA_HABILES dias habiles del vencimiento.
      if (sumarHabiles(r.vencimiento!.slice(0, 10), GRACIA_HABILES, feriados) > hoyAR) continue;
      candidatos.push({ tipo: TIPO_VENCIDO, r, texto: esNoHabil(r.vencimiento!, feriados).texto });
    }
  }
  if (opts.tipos.includes(TIPO_PLAZO)) {
    for (const r of aCobrar) {
      // Si la plata YA entro, la fecha prometida es letra muerta: no hay nada
      // que corregir y el aviso seria ruido puro.
      if (estaCobrado(r.importe, r.saldo)) continue;
      const pv = pvs.get(r.referencia);
      // Sin la PV no se puede saber si es una venta de fin de mes que se patenta
      // despues, y ese es justamente el unico caso que se controla: se saltea.
      if (!pv) continue;
      if (!esVentaFinDeMesQuePatentaDespues(pv.fecha.slice(0, 10), pv.comentario).aplica) continue;
      // La regla se mide desde la fecha de la OPERACION, no desde la de carga.
      const base = pv.fecha.slice(0, 10);
      const tope = sumarHabiles(base, PLAZO_HABILES, feriados);
      const limite = PLAZO_TOLERANCIA > 0 ? sumarHabiles(tope, PLAZO_TOLERANCIA, feriados) : tope;
      if (r.vencimiento!.slice(0, 10) <= limite) continue;
      candidatos.push({ tipo: TIPO_PLAZO, r, texto: esNoHabil(r.vencimiento!, feriados).texto, tope });
    }
  }

  const previas: Alerta[] = await sb(env, `pv_fechas_alertas?select=*`);
  const clave = (id: number | string, tipo: string) => `${id}|${tipo}`;
  const previasPorClave = new Map(previas.map((a) => [clave(a.detcashid, a.tipo), a]));

  // ── Altas ─────────────────────────────────────────────────────────────────
  const nuevas: Record<string, unknown>[] = [];
  for (const c of candidatos) {
    if (previasPorClave.has(clave(c.r.detcashid, c.tipo))) continue;
    const pv = pvs.get(c.r.referencia);
    if (pv?.anulada) continue; // PV anulada: no molestamos a nadie
    // Cada control tiene su propio corte de arranque; el de vencidos no usa
    // ninguno (una deuda vencida sigue viva sea de la PV que sea).
    const fechaCorte = (pv?.fecha ?? c.r.fecha).slice(0, 10);
    const historica = (c.tipo === TIPO_FECHA && fechaCorte < opts.desde) ||
      (c.tipo === TIPO_PLAZO && fechaCorte < opts.desdePlazo);
    nuevas.push({
      detcashid: c.r.detcashid,
      tipo: c.tipo,
      referencia: c.r.referencia,
      motivo: c.r.motivo,
      importe: c.r.importe,
      saldo_pendiente: c.r.saldo,
      importe_cobrado: Number(c.r.importe) - Number(c.r.saldo),
      vencimiento: c.r.vencimiento!.slice(0, 10),
      plazo_tope: c.tope ?? null,
      dia_texto: c.texto,
      vendedorid: pv?.vendedorid ?? null,
      vendedor_nombre: pv?.vendedor ?? null,
      fecha_pv: fechaCorte,
      estado: historica ? "historica" : "abierta",
      detectado_at: new Date().toISOString(),
    });
  }
  if (nuevas.length && !opts.dry) {
    await sb(env, "pv_fechas_alertas?on_conflict=detcashid,tipo", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(nuevas),
    });
  }

  // ── Cierres ───────────────────────────────────────────────────────────────
  const abiertas = [
    ...previas.filter((a) => a.estado === "abierta" && opts.tipos.includes(a.tipo)),
    ...(nuevas as unknown as Alerta[]).filter((a) => a.estado === "abierta"),
  ];
  const { cerradas, refrescadas } = await revisarAbiertas(env, abiertas, renglones, pvs, feriados, hoyAR, opts.dry);
  const cerradasClaves = new Set(cerradas.map((c) => clave(c.detcashid, c.tipo)));

  // ── A quien le toca aviso ─────────────────────────────────────────────────
  const pendientes = abiertas.filter((a) => !cerradasClaves.has(clave(a.detcashid, a.tipo)));
  const aAvisar = pendientes.filter((a) => {
    if (MAX_AVISOS > 0 && (a.avisos ?? 0) >= MAX_AVISOS) return false;
    if (opts.forzar) return true;
    return a.ultimo_aviso_dia !== hoyAR; // 1 aviso por dia
  });

  const enHorario = opts.forzar ||
    (horaAR >= HORA_DESDE && horaAR < HORA_HASTA && !esNoHabilParaAvisar(hoyAR, feriados));
  const resumen = {
    ok: true, hoy: hoyAR, hora_ar: horaAR, dry: opts.dry, desde: opts.desde, desde_plazo: opts.desdePlazo, tipos: opts.tipos,
    renglones_leidos: renglones.length,
    candidatos: {
      fecha_no_habil: candidatos.filter((c) => c.tipo === TIPO_FECHA).length,
      vencido_impago: candidatos.filter((c) => c.tipo === TIPO_VENCIDO).length,
      plazo_excedido: candidatos.filter((c) => c.tipo === TIPO_PLAZO).length,
    },
    alertas_nuevas: nuevas.length,
    historicas: nuevas.filter((n) => n.estado === "historica").length,
    cerradas: cerradas.length, detalle_cerradas: cerradas,
    refrescadas: refrescadas.length, detalle_refrescadas: refrescadas,
    pendientes: pendientes.length,
  };
  if (!enHorario) {
    return { ...resumen, enviados: 0, detalle: "fuera de horario de aviso (o dia no habil)" };
  }

  // ── Envio: 1 mensaje por PV y por tipo ────────────────────────────────────
  const grupos = new Map<string, Alerta[]>();
  for (const a of aAvisar) {
    if ((a.tipo === TIPO_FECHA || a.tipo === TIPO_PLAZO) && !opts.forzar && (a.avisos ?? 0) === 0) {
      // Gracia corta: no avisar mientras el vendedor todavia esta cargando la PV.
      const r = renglones.find((x) => x.detcashid === Number(a.detcashid));
      if (r && esDeHoy(r.fecha, hoyAR) && minutosDesde(r.fecha) < GRACIA_MIN) continue;
    }
    const k = clave(a.referencia, a.tipo);
    const lista = grupos.get(k) ?? [];
    lista.push(a);
    grupos.set(k, lista);
  }

  const padron = await padronUsuarios(env);
  const enviados: unknown[] = [];
  const errores: unknown[] = [];

  for (const [k, lista] of grupos) {
    const tipo = k.split("|")[1];
    const ref = lista[0].referencia;
    const vendedorid = lista.find((a) => a.vendedorid)?.vendedorid ?? null;
    const vendedorNombre = lista.find((a) => a.vendedor_nombre)?.vendedor_nombre ?? "sin identificar";
    const detalle = recortar(
      lista.sort((a, b) => a.vencimiento.localeCompare(b.vencimiento))
        .map((a) => tipo === TIPO_FECHA ? lineaFecha(a) : tipo === TIPO_PLAZO ? lineaPlazo(a, feriados) : lineaVencido(a, hoyAR))
        .join(" · "),
      700,
    );

    const destinos = destinatarios(padron, vendedorid);
    if (opts.dry) {
      enviados.push({ tipo, pv: ref, vendedor: vendedorNombre, detalle, destinos: destinos.map((d) => d.nombre), renglones: lista.length });
      continue;
    }

    const okDestinos: string[] = [];
    for (const d of destinos) {
      const r = await enviarTemplate(env, TEMPLATES[tipo], d.telefono_wa, [primerNombre(d.nombre), ref, detalle, vendedorNombre]);
      if (r.ok) okDestinos.push(d.nombre);
      else errores.push({ tipo, pv: ref, destinatario: d.nombre, error: r.error });
    }
    if (okDestinos.length) {
      enviados.push({ tipo, pv: ref, destinos: okDestinos, renglones: lista.length });
      for (const a of lista) {
        await sb(env, `pv_fechas_alertas?detcashid=eq.${a.detcashid}&tipo=eq.${a.tipo}`, {
          method: "PATCH",
          body: JSON.stringify({
            avisos: (a.avisos ?? 0) + 1,
            ultimo_aviso_at: new Date().toISOString(),
            ultimo_aviso_dia: hoyAR,
            ultimo_envio: { destinos: okDestinos, detalle },
          }),
        });
      }
    }
  }

  return { ...resumen, grupos_avisados: grupos.size, enviados, errores };
}

// Repasa las alertas abiertas contra lo que dice HOY la replica. Dos cosas:
//
//   a) Las CIERRA cuando el problema se resolvio. Segun el tipo:
//        fecha_no_habil  -> la fecha se corrigio / el renglon se anulo o reemplazo
//        vencido_impago  -> entro la plata / se reprogramo la fecha a futuro
//      En los dos: PV anulada o renglon inexistente.
//
//   b) Las que siguen abiertas, las REFRESCA (importe / saldo / vencimiento).
//      Sin esto los numeros quedaban congelados en el dia de la deteccion y el
//      recordatorio repetia montos viejos: el 02/09/2026 dos alertas reclamaban
//      $52,2 M cuando la deuda real era $6,6 M (cobros posteriores no contados
//      y una PV editada de 31,4 a 30,29 M). El objeto `a` se muta a proposito
//      para que el mensaje de ESTA corrida ya salga con los numeros de hoy.
async function revisarAbiertas(
  env: Env, abiertas: Alerta[], renglones: Renglon[], pvs: Map<string, PV>,
  feriados: Map<string, string>, hoyAR: string, dry: boolean,
) {
  // Devuelve la MISMA forma que el camino largo: con `return []` el destructuring
  // de `{ cerradas, refrescadas }` daba undefined y la corrida se caia en
  // `cerradas.map` justo cuando no quedaba ninguna alerta abierta.
  if (!abiertas.length) return { cerradas: [], refrescadas: [] };

  const porId = new Map(renglones.map((r) => [r.detcashid, r]));
  const faltantes = [...new Set(abiertas.map((a) => Number(a.detcashid)).filter((id) => !porId.has(id)))];
  if (faltantes.length) {
    const extra: Renglon[] = await ov(
      env,
      `detcash?detcashid=in.(${faltantes.join(",")})&select=detcashid,fecha,vencimiento,importe,saldo,motivo,referencia`,
    );
    for (const r of extra) porId.set(r.detcashid, r);
  }
  const todos = [...porId.values()];

  const cerradas: { detcashid: number; tipo: string; motivo: string; vencimiento_corregido: string | null }[] = [];
  const refrescadas: Record<string, unknown>[] = [];
  for (const a of abiertas) {
    const id = Number(a.detcashid);
    const r = porId.get(id);
    const pv = pvs.get(a.referencia);
    let motivoCierre: string | null = null;
    let nuevaFecha: string | null = null;
    let saldo: number | null = r ? Number(r.saldo) : null;

    if (pv?.anulada) motivoCierre = "PV anulada";
    else if (!r) motivoCierre = "renglon ya no existe";
    else if (a.tipo === TIPO_PLAZO) {
      // Se recalcula el tope en vez de confiar en el guardado: si corrigieron la
      // FECHA DE LA PV, el tope se mueve con ella.
      const base = (pv?.fecha ?? r.fecha).slice(0, 10);
      const tope = sumarHabiles(base, PLAZO_HABILES, feriados);
      const limite = PLAZO_TOLERANCIA > 0 ? sumarHabiles(tope, PLAZO_TOLERANCIA, feriados) : tope;
      // Si corrigieron el comentario y ya no es una venta que se patenta al mes
      // siguiente, la PV deja de estar alcanzada por la regla.
      const alcance = pv ? esVentaFinDeMesQuePatentaDespues(base, pv.comentario) : { aplica: true, motivo: "" };
      if (!alcance.aplica) motivoCierre = `fuera de la regla: ${alcance.motivo}`;
      else if (estaCobrado(r.importe, r.saldo)) motivoCierre = "pago cobrado";
      else if (r.vencimiento && r.vencimiento.slice(0, 10) <= limite) {
        motivoCierre = "fecha corregida dentro del plazo";
        nuevaFecha = r.vencimiento.slice(0, 10);
      }
    } else if (a.tipo === TIPO_VENCIDO) {
      if (estaCobrado(r.importe, r.saldo)) motivoCierre = "pago cobrado";
      else if (r.vencimiento && sumarHabiles(r.vencimiento.slice(0, 10), GRACIA_HABILES, feriados) > hoyAR) {
        motivoCierre = "fecha reprogramada a futuro";
        nuevaFecha = r.vencimiento.slice(0, 10);
      }
    } else {
      if (r.vencimiento && !esNoHabil(r.vencimiento, feriados).noHabil) {
        motivoCierre = "fecha corregida";
        nuevaFecha = r.vencimiento.slice(0, 10);
      } else if (todos.some((x) => x.referencia === a.referencia && x.motivo === r.motivo && Math.abs(x.importe + r.importe) < 1 && x.importe < 0)) {
        motivoCierre = "renglon anulado (contra-asiento)";
      } else {
        const reemplazo = todos.find((x) =>
          x.referencia === a.referencia && x.motivo === r.motivo && x.detcashid > id &&
          Math.abs(x.importe - r.importe) < 1 && x.vencimiento && !esNoHabil(x.vencimiento, feriados).noHabil
        );
        if (reemplazo) {
          motivoCierre = "reemplazado por otro renglon con fecha habil";
          nuevaFecha = reemplazo.vencimiento!.slice(0, 10);
        }
      }
    }

    if (!motivoCierre) {
      if (r) await refrescar(env, a, r, feriados, refrescadas, dry);
      continue;
    }
    cerradas.push({ detcashid: id, tipo: a.tipo, motivo: motivoCierre, vencimiento_corregido: nuevaFecha });
    if (!dry) {
      await sb(env, `pv_fechas_alertas?detcashid=eq.${id}&tipo=eq.${a.tipo}`, {
        method: "PATCH",
        body: JSON.stringify({
          estado: motivoCierre === "PV anulada" ? "anulada" : "corregida",
          corregido_at: new Date().toISOString(),
          vencimiento_corregido: nuevaFecha,
          saldo_pendiente: saldo,
          // Al cerrar tambien queda el importe de hoy: la PV se pudo editar
          // despues de detectada (08762/3: de 31,4 M a 30,29 M).
          ...(r ? { importe: Number(r.importe), importe_cobrado: Number(r.importe) - Number(r.saldo) } : {}),
        }),
      });
    }
  }
  return { cerradas, refrescadas };
}

// Pone al dia los numeros de una alerta que sigue abierta. Solo escribe si algo
// cambio: son 3 filas por corrida, pero no tiene sentido un PATCH al pedo.
async function refrescar(
  env: Env, a: Alerta, r: Renglon, feriados: Map<string, string>,
  refrescadas: Record<string, unknown>[], dry: boolean,
) {
  const fresco = {
    importe: Number(r.importe),
    saldo_pendiente: Number(r.saldo),
    importe_cobrado: Number(r.importe) - Number(r.saldo),
    vencimiento: (r.vencimiento ?? a.vencimiento).slice(0, 10),
    dia_texto: r.vencimiento ? esNoHabil(r.vencimiento, feriados).texto : a.dia_texto,
  };
  const cambio = Number(a.importe) !== fresco.importe ||
    Number(a.saldo_pendiente) !== fresco.saldo_pendiente ||
    String(a.vencimiento ?? "").slice(0, 10) !== fresco.vencimiento;
  if (!cambio) return;

  refrescadas.push({
    detcashid: Number(a.detcashid), tipo: a.tipo, referencia: a.referencia,
    antes: { importe: a.importe, saldo_pendiente: a.saldo_pendiente, vencimiento: a.vencimiento },
    ahora: { importe: fresco.importe, saldo_pendiente: fresco.saldo_pendiente, vencimiento: fresco.vencimiento },
  });
  Object.assign(a, fresco); // el aviso de esta corrida ya sale con los numeros de hoy
  if (!dry) {
    await sb(env, `pv_fechas_alertas?detcashid=eq.${Number(a.detcashid)}&tipo=eq.${a.tipo}`, {
      method: "PATCH",
      body: JSON.stringify(fresco),
    });
  }
}

// ── Textos del mensaje ──────────────────────────────────────────────────────

const lineaFecha = (a: Alerta) =>
  `${nombreMotivo(a.motivo)} ${pesos(a.importe)} con fecha ${a.dia_texto} ${ddmm(a.vencimiento)}`;

// Muestra la fecha cargada contra el tope, y de cuanto es el desvio: sin el
// tope a la vista el vendedor no sabe que fecha poner.
function lineaPlazo(a: Alerta, feriados: Map<string, string>) {
  const tope = String(a.plazo_tope ?? "").slice(0, 10);
  if (!tope) return `${nombreMotivo(a.motivo)} ${pesos(a.importe)} con fecha ${ddmm(a.vencimiento)}`;
  const exceso = habilesEntre(tope, a.vencimiento.slice(0, 10), feriados);
  return `${nombreMotivo(a.motivo)} ${pesos(a.importe)} con fecha ${ddmm(a.vencimiento)}, ` +
    `${exceso} ${exceso === 1 ? "día hábil" : "días hábiles"} más tarde del tope (${ddmm(tope)})`;
}

function lineaVencido(a: Alerta, hoyAR: string) {
  const dias = diasEntre(a.vencimiento, hoyAR);
  const cuando = `venció el ${ddmm(a.vencimiento)} (hace ${dias} ${dias === 1 ? "día" : "días"})`;
  const saldo = Number(a.saldo_pendiente ?? a.importe ?? 0);
  const total = Number(a.importe ?? 0);
  return saldo < total - 1
    ? `${nombreMotivo(a.motivo)}: faltan ${pesos(saldo)} de ${pesos(total)}, ${cuando}`
    : `${nombreMotivo(a.motivo)} ${pesos(total)}, ${cuando}`;
}

// ── Destinatarios ───────────────────────────────────────────────────────────

type Usuario = { usuario: string; nombre: string; telefono_wa: string };

async function padronUsuarios(env: Env) {
  const users = await sb(
    env,
    `tasador_usuarios?activo=eq.true&telefono_wa=not.is.null&select=usuario,nombre,telefono_wa,notificaciones_wa`,
  );
  const porUsuario = new Map<string, Usuario>();
  for (const u of users) {
    if (u.notificaciones_wa === false) continue;
    const tel = String(u.telefono_wa || "").replace(/^\+/, "").replace(/[\s-]/g, "");
    if (!tel) continue;
    porUsuario.set(String(u.usuario), { usuario: u.usuario, nombre: u.nombre || u.usuario, telefono_wa: tel });
  }
  const mapa = await sb(env, `pv_vendedores_map?activo=eq.true&select=vendedorid,usuario`);
  const porVendedor = new Map<number, string>(mapa.map((m: { vendedorid: number; usuario: string }) => [Number(m.vendedorid), m.usuario]));
  const fijos = (Deno.env.get("PVFECHA_FIJOS") ?? FIJOS_DEFAULT).split(",").map((s) => s.trim()).filter(Boolean);
  return { porUsuario, porVendedor, fijos };
}

function destinatarios(
  padron: { porUsuario: Map<string, Usuario>; porVendedor: Map<number, string>; fijos: string[] },
  vendedorid: number | null,
) {
  const out: Usuario[] = [];
  const vistos = new Set<string>();
  const push = (u?: Usuario) => {
    if (!u || vistos.has(u.telefono_wa)) return;
    vistos.add(u.telefono_wa);
    out.push(u);
  };
  if (vendedorid != null && !VENDEDORES_SIN_AVISO.has(Number(vendedorid))) {
    const usuario = padron.porVendedor.get(Number(vendedorid));
    if (usuario) push(padron.porUsuario.get(usuario));
  }
  for (const f of padron.fijos) push(padron.porUsuario.get(f));
  return out;
}

// ── Calendario ──────────────────────────────────────────────────────────────

async function feriadosMap(env: Env) {
  const filas = await sb(env, `feriados_ar?select=fecha,nombre`);
  return new Map<string, string>(filas.map((f: { fecha: string; nombre: string }) => [String(f.fecha).slice(0, 10), f.nombre]));
}

function esNoHabil(fechaISO: string, feriados: Map<string, string>) {
  const dia = fechaISO.slice(0, 10);
  const fer = feriados.get(dia);
  if (fer) return { noHabil: true, texto: `feriado (${corto(fer)})` };
  const dow = diaSemana(dia);
  if (dow === 6) return { noHabil: true, texto: "sábado" };
  if (dow === 0) return { noHabil: true, texto: "domingo" };
  return { noHabil: false, texto: DIAS[dow] };
}

// Para decidir si hoy se puede molestar: el sabado el salon trabaja, el domingo
// y los feriados no.
function esNoHabilParaAvisar(hoyISO: string, feriados: Map<string, string>) {
  if (feriados.has(hoyISO)) return true;
  return diaSemana(hoyISO) === 0;
}

// ── El caso que controla la regla del plazo ────────────────────────────────
//
// El vendedor deja escrito en el comentario de la PV en que mes se patenta:
// "PATENTA SEPTIEMBRE", "SE PATENTA EN MAYO", "OFERTA PATENTANDO MES DE JULIO",
// "patenta mes de  septiembre caso contrario abona aumento del 10%". Se busca el
// primer nombre de mes que aparece DESPUES de "patent", dentro de los 60
// caracteres siguientes (mas lejos ya es otra cosa del comentario).
//
// Ojo con la ortografia real de la casa: conviven "septiembre" y "setiembre", y
// los comentarios vienen en mayusculas, en minusculas y con acentos rotos, asi
// que se normaliza (sin tildes, minusculas) antes de buscar.
const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const NOMBRES_MES =
  "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";
// Los limites de palabra son obligatorios: sin ellos "mayo" matchea adentro de
// "mayoristas" y de "mayores", que aparecen en los comentarios.
const RE_MES = new RegExp(`\\b(${NOMBRES_MES})\\b`);

const sinTildes = (s: string) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Los comentarios se tipean a las apuradas y el mes queda pegado a lo de al lado.
// Los tres typos reales que aparecen en la base (7 PVs desde 2025), y que sin
// reparar se pierden porque el limite de palabra no encuentra donde cortar:
//   "patenta mes d emayo"        -> la "e" de "de" se despego  ("d e" + mes)
//   "patenta mes deoctubre"      -> "de" pegado al mes
//   "patentando mes de septiembrecaso" / "patentar abril2025" -> pegado atras
// Se reparan ANTES de buscar, asi el resto de la funcion trabaja con limites de
// palabra limpios en vez de aflojar el regex (aflojarlo traia de vuelta el falso
// positivo de "mayorista").
function repararPegotes(t: string): string {
  let out = t.replace(/\bd\s+e(?=[a-z])/g, "de ");
  out = out.replace(new RegExp(`\\bde(${NOMBRES_MES})\\b`, "g"), "de $1");
  // "mayo" queda afuera de este ultimo paso a proposito: separarlo romperia
  // "mayorista" en "mayo rista" y volveria a dar el falso positivo.
  out = out.replace(
    new RegExp(`\\b(${NOMBRES_MES.replace("mayo|", "")})(?=[a-z0-9])`, "g"),
    "$1 ",
  );
  return out;
}

function mesQuePatenta(comentario: string): number | null {
  const t = repararPegotes(sinTildes(comentario));
  const re = /patent\w*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const mm = t.slice(m.index, m.index + 60).match(RE_MES);
    if (mm) return MESES[mm[1]];
  }
  return null;
}

// ¿La PV es de fin de mes Y dice que se patenta un mes posterior?
// Las dos condiciones juntas: es el unico caso que la regla controla.
function esVentaFinDeMesQuePatentaDespues(fechaPV: string, comentario: string) {
  const anio = Number(fechaPV.slice(0, 4));
  const mes = Number(fechaPV.slice(5, 7));
  const dia = Number(fechaPV.slice(8, 10));

  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  if (dia <= ultimoDia - PLAZO_DIAS_FIN_MES) return { aplica: false, motivo: "no es fin de mes" };

  const mesPat = mesQuePatenta(comentario);
  if (mesPat === null) return { aplica: false, motivo: "el comentario no dice en que mes se patenta" };

  // Distancia en meses, dando la vuelta en diciembre (PV de dic -> "enero" = 1).
  const distancia = (mesPat - mes + 12) % 12;
  // 0 = se patenta en su propio mes (el caso normal, no se controla).
  // 1-3 = se patenta despues; mas que eso es una referencia vieja del comentario.
  if (distancia < 1 || distancia > 3) {
    return { aplica: false, motivo: distancia === 0 ? "se patenta en el mismo mes" : "mes del comentario fuera de rango" };
  }
  return { aplica: true, motivo: `se patenta ${distancia} mes(es) despues` };
}

// Suma dias habiles BANCARIOS (lun-vie, sin feriados) a una fecha.
function sumarHabiles(iso: string, n: number, feriados: Map<string, string>) {
  let f = iso;
  let restan = n;
  let guarda = 0;
  while (restan > 0 && guarda++ < 400) {
    f = isoMasDias(f, 1);
    const dow = diaSemana(f);
    if (dow !== 0 && dow !== 6 && !feriados.has(f)) restan--;
  }
  return f;
}

// Dias habiles bancarios ENTRE dos fechas (excluye la de arranque, incluye la
// de llegada). Es la inversa de sumarHabiles: mide de cuanto fue el desvio.
function habilesEntre(desde: string, hasta: string, feriados: Map<string, string>) {
  let f = desde.slice(0, 10);
  const fin = hasta.slice(0, 10);
  let n = 0, guarda = 0;
  while (f < fin && guarda++ < 400) {
    f = isoMasDias(f, 1);
    const dow = diaSemana(f);
    if (dow !== 0 && dow !== 6 && !feriados.has(f)) n++;
  }
  return n;
}

const diaSemana = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay();
const fechaAR = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const isoMasDias = (iso: string, dias: number) =>
  new Date(new Date(`${iso.slice(0, 10)}T12:00:00Z`).getTime() + dias * 86400_000).toISOString().slice(0, 10);
const diasEntre = (desde: string, hasta: string) =>
  Math.round((new Date(`${hasta.slice(0, 10)}T12:00:00Z`).getTime() - new Date(`${desde.slice(0, 10)}T12:00:00Z`).getTime()) / 86400_000);
const minutosDesde = (iso: string) => (Date.now() - new Date(`${iso.slice(0, 19)}Z`).getTime()) / 60000;
const esDeHoy = (iso: string, hoyAR: string) => iso.slice(0, 10) === hoyAR;
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
// Los nombres oficiales de feriado son larguisimos ("Paso a la Inmortalidad
// del Gral. Jose de San Martin"): en el WhatsApp alcanza con el arranque.
const corto = (s: string) => (s.length <= 34 ? s : s.slice(0, 32).trimEnd() + "…");
const recortar = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…");
const primerNombre = (n: string) => (n || "").trim().split(/\s+/)[0] || "equipo";
const pesos = (n: number | null) => "$" + Math.round(Number(n ?? 0)).toLocaleString("es-AR");
const nombreMotivo = (m: string | null) => {
  const k = String(m ?? "").replace(/Ã‘/g, "Ñ").trim().toUpperCase();
  return MOTIVOS[k] ?? (k || "Pago");
};

// ── Datos ───────────────────────────────────────────────────────────────────

async function preventasDe(env: Env, refs: string[], dias: number) {
  const out = new Map<string, PV>();
  if (!refs.length) return out;
  const desde = isoMasDias(fechaAR(new Date()), -Math.abs(dias) - 120);
  const pvs = await ov(env, `preventas?fecha=gte.${desde}&select=numero,fecha,vendedorid,anulada,comentario,comentarioaux`);
  const vends = await ov(env, `vendedores?select=vendedorid,nombre`);
  const nombreVend = new Map<number, string>(vends.map((v: { vendedorid: number; nombre: string }) => [Number(v.vendedorid), String(v.nombre || "").trim()]));
  const buscados = new Set(refs);
  for (const p of pvs) {
    if (!buscados.has(p.numero)) continue;
    out.set(p.numero, {
      vendedorid: Number(p.vendedorid),
      vendedor: nombreVend.get(Number(p.vendedorid)) || `vendedor ${p.vendedorid}`,
      fecha: p.fecha,
      anulada: p.anulada === true,
      comentario: `${p.comentario ?? ""} ${p.comentarioaux ?? ""}`,
    });
  }
  return out;
}

// Por que una PV entra o no en la regla del plazo. Responde la pregunta que van a
// hacer Daniel y Monica: "¿por que no avisó de esta?".
//   ?alcance=2026-08-01   -> todas las PVs desde esa fecha
//   ?alcance=PV 08126/1   -> una sola
async function diagnosticoAlcance(env: Env, arg: string) {
  const esFecha = /^\d{4}-\d{2}-\d{2}$/.test(arg);
  const desde = esFecha ? arg : isoMasDias(fechaAR(new Date()), -120);
  const pvs = await ov(
    env,
    `preventas?fecha=gte.${desde}&select=numero,fecha,anulada,comentario,comentarioaux&order=fecha.asc`,
  );
  const filas = pvs
    .filter((p: { numero: string }) => esFecha || p.numero === arg)
    .map((p: { numero: string; fecha: string; anulada: boolean; comentario: string; comentarioaux: string }) => {
      const fecha = String(p.fecha).slice(0, 10);
      const comentario = `${p.comentario ?? ""} ${p.comentarioaux ?? ""}`;
      const r = esVentaFinDeMesQuePatentaDespues(fecha, comentario);
      return {
        pv: p.numero,
        fecha,
        dia: Number(fecha.slice(8, 10)),
        ultimo_dia_del_mes: new Date(Date.UTC(Number(fecha.slice(0, 4)), Number(fecha.slice(5, 7)), 0)).getUTCDate(),
        mes_pv: Number(fecha.slice(5, 7)),
        mes_que_patenta: mesQuePatenta(comentario),
        anulada: p.anulada === true,
        alcanzada: r.aplica,
        motivo: r.motivo,
      };
    });
  return {
    dias_fin_de_mes: PLAZO_DIAS_FIN_MES,
    total: filas.length,
    alcanzadas: filas.filter((f) => f.alcanzada).length,
    filas,
  };
}

// Comunicado unitario a los vendedores (la regla del plazo, y cualquier otro que
// haga falta despues). No es parte del cron: se dispara a mano una sola vez.
//
//   {"comunicado":{"template":"pv_control_plazo_cobro"}}              -> a quien iria
//   {"comunicado":{"template":"...","solo":"5491122334455"}}       -> prueba a 1 numero
//   {"comunicado":{"template":"...","confirmar":true}}                -> lo manda
//
// Manda a los vendedores de `pv_vendedores_map` (TODOS, incluida la cuenta de la
// casa: la regla es para la persona, no para la PV) mas los fijos, que se enteran
// de que salio. `pv_comunicados` tiene PK (template, usuario), asi que reenviar
// por error no duplica: los ya avisados se saltean salvo `reenviar:true`.
async function comunicado(env: Env, com: Record<string, unknown>) {
  const template = String(com.template ?? "").trim();
  if (!template) return { error: "falta `template`" };

  const aprobado = ((await listarTemplates(env)).templates ?? [])
    .find((t: { name: string }) => t.name === template);
  if (!aprobado) return { error: `el template ${template} no existe en la WABA` };
  // Un template MARKETING se acepta y NO se entrega al que no acepto marketing,
  // y el envio igual devuelve message id: mejor frenar aca que creer que salio.
  if (aprobado.status !== "APPROVED") return { error: `el template ${template} esta en ${aprobado.status}, todavia no se puede mandar` };
  if (aprobado.category !== "UTILITY") {
    return { error: `el template ${template} quedo en ${aprobado.category}: no se entrega. Usar una variante que Meta clasifique UTILITY` };
  }

  const padron = await padronUsuarios(env);
  const solo = String(com.solo ?? "").replace(/^\+/, "").replace(/[\s-]/g, "");
  if (solo) {
    const r = await enviarTemplate(env, template, solo, ["Fer"]);
    return { prueba: true, template, destino: solo, resultado: r };
  }

  const usuarios = [...new Set([...padron.porVendedor.values(), ...padron.fijos])];
  const yaAvisados = new Set(
    (await sb(env, `pv_comunicados?template=eq.${encodeURIComponent(template)}&select=usuario`))
      .map((c: { usuario: string }) => c.usuario),
  );
  const reenviar = com.reenviar === true;
  const destinos = usuarios
    .map((u) => padron.porUsuario.get(u))
    .filter((u): u is Usuario => !!u && (reenviar || !yaAvisados.has(u.usuario)));

  if (com.confirmar !== true) {
    return {
      dry: true, template, categoria: aprobado.category,
      iria_a: destinos.map((d) => d.nombre),
      ya_avisados: [...yaAvisados],
      detalle: "sin `confirmar:true` no se manda nada",
    };
  }

  const enviados: unknown[] = [];
  const errores: unknown[] = [];
  for (const d of destinos) {
    const r = await enviarTemplate(env, template, d.telefono_wa, [primerNombre(d.nombre)]);
    if (!r.ok) { errores.push({ destinatario: d.nombre, error: r.error }); continue; }
    enviados.push(d.nombre);
    await sb(env, "pv_comunicados?on_conflict=template,usuario", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{
        template, usuario: d.usuario, nombre: d.nombre,
        telefono: d.telefono_wa, meta_id: r.meta_id ?? null,
      }]),
    });
  }
  return { template, enviados, errores };
}

// Excepcion explicita y documentada al plazo de cobro (Fer, 10/09/2026: "salvo
// excepcion dada de forma explicita y documentada"). Deja de avisar y la fila
// guarda el motivo y quien la autorizo, para que despues se pueda auditar quien
// habilito cada cobro corrido.
//   {"excepcion":{"detcashids":[123,124],"motivo":"...","por":"Daniel Lopez"}}
// o, mas comodo, por PV entera:
//   {"excepcion":{"pv":"PV 08126/1","motivo":"...","por":"Daniel Lopez"}}
async function registrarExcepcion(env: Env, exc: Record<string, unknown>) {
  const motivo = String(exc.motivo ?? "").trim();
  const por = String(exc.por ?? "").trim();
  if (!motivo || !por) {
    return { error: "la excepcion necesita `motivo` (por que se autoriza) y `por` (quien la autoriza)" };
  }
  const ids = Array.isArray(exc.detcashids) ? exc.detcashids.map(Number).filter(Number.isFinite) : [];
  const pv = String(exc.pv ?? "").trim();
  if (!ids.length && !pv) return { error: "indicar `detcashids` o `pv`" };

  const filtro = ids.length
    ? `detcashid=in.(${ids.join(",")})`
    : `referencia=eq.${encodeURIComponent(pv)}`;
  const afectadas = await sb(
    env,
    `pv_fechas_alertas?${filtro}&tipo=eq.${TIPO_PLAZO}&estado=eq.abierta&select=detcashid,referencia,motivo,importe,vencimiento,plazo_tope`,
  );
  if (!afectadas.length) return { excepciones: 0, detalle: "no hay alertas de plazo abiertas para eso" };

  await sb(env, `pv_fechas_alertas?${filtro}&tipo=eq.${TIPO_PLAZO}&estado=eq.abierta`, {
    method: "PATCH",
    body: JSON.stringify({
      estado: "excepcion",
      excepcion_motivo: motivo,
      excepcion_por: por,
      excepcion_at: new Date().toISOString(),
      corregido_at: new Date().toISOString(),
    }),
  });
  return { excepciones: afectadas.length, autorizada_por: por, motivo, renglones: afectadas };
}

async function cerrarAMano(env: Env, ids: unknown[]) {
  const limpios = ids.map((i) => Number(i)).filter((n) => Number.isFinite(n));
  if (!limpios.length) return { cerradas: 0 };
  await sb(env, `pv_fechas_alertas?detcashid=in.(${limpios.join(",")})&estado=eq.abierta`, {
    method: "PATCH",
    body: JSON.stringify({ estado: "cerrada_manual", corregido_at: new Date().toISOString() }),
  });
  return { cerradas: limpios.length, detcashids: limpios };
}

// ── WhatsApp ────────────────────────────────────────────────────────────────

async function enviarTemplate(env: Env, template: string, telE164: string, vars: string[]) {
  const payload = {
    messaging_product: "whatsapp",
    to: telE164,
    type: "template",
    template: {
      name: template,
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
  const a = await enviarTemplate(env, TEMPLATES[TIPO_FECHA], tel, [
    "Fer", "PV 09999/1",
    "Seña $1.000.000 con fecha sábado 22/08 · Cancelación $15.629.600 con fecha domingo 23/08",
    "PRUEBA (no es una PV real)",
  ]);
  const b = await enviarTemplate(env, TEMPLATES[TIPO_VENCIDO], tel, [
    "Fer", "PV 09999/1",
    "Financiación BBVA $17.000.000, venció el 13/08 (hace 5 días) · Cancelación: faltan $3.757.095 de $20.809.600, venció el 13/08 (hace 5 días)",
    "PRUEBA (no es una PV real)",
  ]);
  const c = await enviarTemplate(env, TEMPLATES[TIPO_PLAZO], tel, [
    "Fer", "PV 09999/1",
    "Cancelación $55.707.000 con fecha 10/09, 5 días hábiles más tarde del tope (03/09)",
    "PRUEBA (no es una PV real)",
  ]);
  return { prueba: true, destino: tel, fecha_no_habil: a, vencido_impago: b, plazo_excedido: c };
}

async function listarTemplates(env: Env) {
  const res = await fetch(
    `${META_API_URL}/${env.WABA_ID}/message_templates?fields=name,language,status,category&limit=200`,
    { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } },
  );
  const j = await res.json();
  return { templates: (j?.data ?? []).map((t: Record<string, string>) => ({ name: t.name, language: t.language, status: t.status, category: t.category })), error: j?.error };
}

const CUERPOS: Record<string, { header: string; body: string; ejemplo: string[] }> = {
  [TIPO_FECHA]: {
    header: "Fecha de pago en día no bancario",
    body: "Hola {{1}}, en la {{2}} hay pagos cargados con fecha en un día no bancario: {{3}}. Vendedor: {{4}}. Los bancos no acreditan sábados, domingos ni feriados: por favor entrá a la PV y corregí la fecha de pago a un día hábil.",
    ejemplo: ["Jorge", "PV 08114/1", "Seña $1.000.000 con fecha sábado 22/08 · Cancelación $15.629.600 con fecha domingo 23/08", "Fazzini Jorge"],
  },
  [TIPO_VENCIDO]: {
    header: "Pago vencido sin cobrar",
    body: "Hola {{1}}, en la {{2}} hay pagos que ya pasaron su fecha y todavía no figuran cobrados: {{3}}. Vendedor: {{4}}. Por favor verificá con el cliente y actualizá la fecha de pago en la PV si se reprogramó.",
    ejemplo: ["Jorge", "PV 08114/1", "Financiación BBVA $17.000.000, venció el 13/08 (hace 5 días)", "Fazzini Jorge"],
  },
  [TIPO_PLAZO]: {
    header: "Fecha de cobro fuera de plazo",
    body: "Hola {{1}}, en la {{2}} hay pagos con fecha posterior al plazo máximo de 5 días hábiles desde la operación: {{3}}. Vendedor: {{4}}. Salvo excepción autorizada y documentada, corregí la fecha de cobro en la PV para que caiga dentro del tope.",
    ejemplo: ["Gisela", "PV 08126/1", "Cancelación $55.707.000 con fecha 10/09, 5 días hábiles más tarde del tope (03/09)", "Buena Gisela"],
  },
};

async function crearTemplates(env: Env) {
  const existentes = new Set(((await listarTemplates(env)).templates ?? []).map((t: { name: string }) => t.name));
  const out: unknown[] = [];
  for (const [tipo, nombre] of Object.entries(TEMPLATES)) {
    if (existentes.has(nombre)) { out.push({ template: nombre, ya_existia: true }); continue; }
    const c = CUERPOS[tipo];
    const res = await fetch(`${META_API_URL}/${env.WABA_ID}/message_templates`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: nombre,
        language: META_LANGUAGE,
        category: "UTILITY",
        components: [
          { type: "HEADER", format: "TEXT", text: c.header },
          { type: "BODY", text: c.body, example: { body_text: [c.ejemplo] } },
          { type: "FOOTER", text: "Aviso automático · Tito Gonzalez" },
        ],
      }),
    });
    out.push({ template: nombre, status: res.status, respuesta: await res.json() });
  }
  return { creados: out };
}

// ── Helpers HTTP ────────────────────────────────────────────────────────────

// Las LECTURAS se paginan por el mismo motivo que en `ov()`: PostgREST corta en
// 1.000 filas sin avisar. `pv_fechas_alertas` va por ~80 filas al mes, asi que en
// un anio la lectura empezaria a perder alertas viejas en silencio y a re-crear
// las que ya estaban. Las escrituras (POST/PATCH/DELETE) van derecho.
// deno-lint-ignore no-explicit-any
async function sb(env: Env, path: string, options: RequestInit & { headers?: Record<string, string> } = {}): Promise<any[]> {
  const headers = {
    apikey: env.SERVICE_KEY,
    Authorization: `Bearer ${env.SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };
  const pedir = async (url: string) => {
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const txt = await res.text();
    return txt ? JSON.parse(txt) : [];
  };

  const base = `${env.SUPABASE_URL}/rest/v1/${path}`;
  const metodo = (options.method ?? "GET").toUpperCase();
  if (metodo !== "GET" || /[?&]limit=/.test(path)) return await pedir(base);

  const PAGINA = 1000;
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let offset = 0; ; offset += PAGINA) {
    const pagina = await pedir(`${base}${sep}limit=${PAGINA}&offset=${offset}`);
    out.push(...pagina);
    if (pagina.length < PAGINA) return out;
    if (offset > 200_000) return out; // red de seguridad
  }
}

// ⚠️ PostgREST corta en 1.000 filas SIN AVISAR: `limit=5000` devuelve 1.000 y la
// respuesta parece completa (verificado 10/09/2026 contra la replica: pedir 5000
// renglones VTOKM devolvio 1.000 cuando el total real era 4.939). Con la ventana
// default de 60 dias no se llega, pero con `?dias=200` si, y la corrida se comia
// renglones en silencio. Por eso se pagina siempre en vez de confiar en el limit.
// deno-lint-ignore no-explicit-any
async function ov(env: Env, path: string): Promise<any[]> {
  const PAGINA = 1000;
  const out: any[] = [];
  for (let offset = 0; ; offset += PAGINA) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${env.OV_URL}/${path}${sep}limit=${PAGINA}&offset=${offset}`, {
      headers: { apikey: env.OV_KEY, Authorization: `Bearer ${env.OV_KEY}` },
    });
    if (!res.ok) throw new Error(`Oversoft ${res.status}: ${await res.text()}`);
    const pagina = await res.json();
    out.push(...pagina);
    if (pagina.length < PAGINA) return out;
    if (offset > 200_000) return out; // red de seguridad
  }
}

// deno-lint-ignore no-explicit-any
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
