// Edge Function: notify-pv-fecha-no-habil
//
// Dos controles sobre la forma de pago que el vendedor carga en la PV, ambos
// avisando por WhatsApp al vendedor + gerente + Monica Gerez + Fernando N. Gonzalez:
//
//   A) `fecha_no_habil`  — la fecha de pago cae sabado, domingo o feriado
//                          (los bancos no acreditan ese dia).
//   B) `vencido_impago`  — paso la fecha prometida y el pago NO figura cobrado
//                          (o quedo saldo). Avisa a los 3 DIAS HABILES del
//                          vencimiento, para no pisar la demora normal de
//                          acreditacion y de carga del recibo.
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
//      Si no se corrige: 1 recordatorio por dia habil, hasta MAX_AVISOS.
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
//
// pg_cron (jobid 9): '*/10 15-23 * * *' = cada 10 min, 12 a 20 hora AR.
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
const TEMPLATES: Record<string, string> = {
  [TIPO_FECHA]: "pv_fecha_no_habil",
  [TIPO_VENCIDO]: "pv_pago_vencido",
};

// Renglones de la PV: los carga el vendedor con origen VTOKM.
const ORIGEN_PV = "VTOKM";
const VENTANA_DIAS = Number(Deno.env.get("PVFECHA_VENTANA_DIAS") ?? "60");
const MAX_AVISOS = Number(Deno.env.get("PVFECHA_MAX_AVISOS") ?? "10");
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
// Saldo por debajo del cual se considera cobrado (redondeos de centavos).
const TOLERANCIA_SALDO = Number(Deno.env.get("PVFECHA_TOLERANCIA_SALDO") ?? "1");

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

    const solo = String(par("solo") ?? "").trim();
    if (solo) return json(await pruebaDirigida(env, solo.replace(/^\+/, "").replace(/[\s-]/g, "")));

    const tipo = String(par("tipo") ?? "").trim();
    return json(await procesar(env, {
      dry: flag("dry"),
      forzar: flag("forzar"),
      dias: Number(par("dias") ?? VENTANA_DIAS) || VENTANA_DIAS,
      desde: String(par("desde") ?? DESDE).slice(0, 10),
      tipos: tipo ? [tipo] : [TIPO_FECHA, TIPO_VENCIDO],
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
  importe: number | null; saldo_pendiente: number | null; vencimiento: string;
  dia_texto: string | null; vendedorid: number | null; vendedor_nombre: string | null;
  fecha_pv: string | null; estado: string; ultimo_aviso_dia: string | null; avisos: number;
};

type PV = { vendedorid: number; vendedor: string; fecha: string; anulada: boolean };

// ── Nucleo ──────────────────────────────────────────────────────────────────

async function procesar(
  env: Env,
  opts: { dry: boolean; forzar: boolean; dias: number; desde: string; tipos: string[] },
) {
  const ahora = new Date();
  const hoyAR = fechaAR(ahora);
  const horaAR = ahora.getUTCHours() - 3 < 0 ? ahora.getUTCHours() + 21 : ahora.getUTCHours() - 3;

  const feriados = await feriadosMap(env);
  const desdeLectura = isoMasDias(hoyAR, -Math.abs(opts.dias));
  const renglones: Renglon[] = await ov(
    env,
    `detcash?origen=eq.${ORIGEN_PV}&fecha=gte.${desdeLectura}` +
    `&select=detcashid,fecha,vencimiento,importe,saldo,motivo,referencia&limit=5000`,
  );
  // Los importes negativos son contra-asientos de anulacion, no promesas de pago.
  const aCobrar = renglones.filter((r) => r.vencimiento && Number(r.importe) > 0);

  // ── Candidatos de cada control ────────────────────────────────────────────
  const candidatos: { tipo: string; r: Renglon; texto: string }[] = [];
  if (opts.tipos.includes(TIPO_FECHA)) {
    for (const r of aCobrar) {
      const { noHabil, texto } = esNoHabil(r.vencimiento!, feriados);
      if (noHabil) candidatos.push({ tipo: TIPO_FECHA, r, texto });
    }
  }
  if (opts.tipos.includes(TIPO_VENCIDO)) {
    for (const r of aCobrar) {
      if (Number(r.saldo) <= TOLERANCIA_SALDO) continue; // ya cobrado
      // Recien se reclama pasados GRACIA_HABILES dias habiles del vencimiento.
      if (sumarHabiles(r.vencimiento!.slice(0, 10), GRACIA_HABILES, feriados) > hoyAR) continue;
      candidatos.push({ tipo: TIPO_VENCIDO, r, texto: esNoHabil(r.vencimiento!, feriados).texto });
    }
  }

  const refs = [...new Set(candidatos.map((c) => c.r.referencia))];
  const pvs = await preventasDe(env, refs, opts.dias);

  const previas: Alerta[] = await sb(env, `pv_fechas_alertas?select=*&limit=20000`);
  const clave = (id: number | string, tipo: string) => `${id}|${tipo}`;
  const previasPorClave = new Map(previas.map((a) => [clave(a.detcashid, a.tipo), a]));

  // ── Altas ─────────────────────────────────────────────────────────────────
  const nuevas: Record<string, unknown>[] = [];
  for (const c of candidatos) {
    if (previasPorClave.has(clave(c.r.detcashid, c.tipo))) continue;
    const pv = pvs.get(c.r.referencia);
    if (pv?.anulada) continue; // PV anulada: no molestamos a nadie
    // El corte de arranque solo aplica al control de fechas.
    const fechaCorte = (pv?.fecha ?? c.r.fecha).slice(0, 10);
    const historica = c.tipo === TIPO_FECHA && fechaCorte < opts.desde;
    nuevas.push({
      detcashid: c.r.detcashid,
      tipo: c.tipo,
      referencia: c.r.referencia,
      motivo: c.r.motivo,
      importe: c.r.importe,
      saldo_pendiente: c.r.saldo,
      importe_cobrado: Number(c.r.importe) - Number(c.r.saldo),
      vencimiento: c.r.vencimiento!.slice(0, 10),
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
  const cerradas = await detectarCerradas(env, abiertas, renglones, pvs, feriados, hoyAR, opts.dry);
  const cerradasClaves = new Set(cerradas.map((c) => clave(c.detcashid, c.tipo)));

  // ── A quien le toca aviso ─────────────────────────────────────────────────
  const pendientes = abiertas.filter((a) => !cerradasClaves.has(clave(a.detcashid, a.tipo)));
  const aAvisar = pendientes.filter((a) => {
    if ((a.avisos ?? 0) >= MAX_AVISOS) return false;
    if (opts.forzar) return true;
    return a.ultimo_aviso_dia !== hoyAR; // 1 aviso por dia
  });

  const enHorario = opts.forzar ||
    (horaAR >= HORA_DESDE && horaAR < HORA_HASTA && !esNoHabilParaAvisar(hoyAR, feriados));
  const resumen = {
    ok: true, hoy: hoyAR, hora_ar: horaAR, dry: opts.dry, desde: opts.desde, tipos: opts.tipos,
    renglones_leidos: renglones.length,
    candidatos: { fecha_no_habil: candidatos.filter((c) => c.tipo === TIPO_FECHA).length, vencido_impago: candidatos.filter((c) => c.tipo === TIPO_VENCIDO).length },
    alertas_nuevas: nuevas.length,
    historicas: nuevas.filter((n) => n.estado === "historica").length,
    cerradas: cerradas.length, detalle_cerradas: cerradas,
    pendientes: pendientes.length,
  };
  if (!enHorario) {
    return { ...resumen, enviados: 0, detalle: "fuera de horario de aviso (o dia no habil)" };
  }

  // ── Envio: 1 mensaje por PV y por tipo ────────────────────────────────────
  const grupos = new Map<string, Alerta[]>();
  for (const a of aAvisar) {
    if (a.tipo === TIPO_FECHA && !opts.forzar && (a.avisos ?? 0) === 0) {
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
        .map((a) => (tipo === TIPO_FECHA ? lineaFecha(a) : lineaVencido(a, hoyAR)))
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

// Cierra la alerta cuando el problema se resolvio. Segun el tipo:
//   fecha_no_habil  -> la fecha se corrigio / el renglon se anulo o reemplazo
//   vencido_impago  -> entro la plata / se reprogramo la fecha a futuro
// En los dos: PV anulada o renglon inexistente.
async function detectarCerradas(
  env: Env, abiertas: Alerta[], renglones: Renglon[], pvs: Map<string, PV>,
  feriados: Map<string, string>, hoyAR: string, dry: boolean,
) {
  if (!abiertas.length) return [];

  const porId = new Map(renglones.map((r) => [r.detcashid, r]));
  const faltantes = [...new Set(abiertas.map((a) => Number(a.detcashid)).filter((id) => !porId.has(id)))];
  if (faltantes.length) {
    const extra: Renglon[] = await ov(
      env,
      `detcash?detcashid=in.(${faltantes.join(",")})&select=detcashid,fecha,vencimiento,importe,saldo,motivo,referencia&limit=5000`,
    );
    for (const r of extra) porId.set(r.detcashid, r);
  }
  const todos = [...porId.values()];

  const cerradas: { detcashid: number; tipo: string; motivo: string; vencimiento_corregido: string | null }[] = [];
  for (const a of abiertas) {
    const id = Number(a.detcashid);
    const r = porId.get(id);
    const pv = pvs.get(a.referencia);
    let motivoCierre: string | null = null;
    let nuevaFecha: string | null = null;
    let saldo: number | null = r ? Number(r.saldo) : null;

    if (pv?.anulada) motivoCierre = "PV anulada";
    else if (!r) motivoCierre = "renglon ya no existe";
    else if (a.tipo === TIPO_VENCIDO) {
      if (Number(r.saldo) <= TOLERANCIA_SALDO) motivoCierre = "pago cobrado";
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

    if (!motivoCierre) continue;
    cerradas.push({ detcashid: id, tipo: a.tipo, motivo: motivoCierre, vencimiento_corregido: nuevaFecha });
    if (!dry) {
      await sb(env, `pv_fechas_alertas?detcashid=eq.${id}&tipo=eq.${a.tipo}`, {
        method: "PATCH",
        body: JSON.stringify({
          estado: motivoCierre === "PV anulada" ? "anulada" : "corregida",
          corregido_at: new Date().toISOString(),
          vencimiento_corregido: nuevaFecha,
          saldo_pendiente: saldo,
        }),
      });
    }
  }
  return cerradas;
}

// ── Textos del mensaje ──────────────────────────────────────────────────────

const lineaFecha = (a: Alerta) =>
  `${nombreMotivo(a.motivo)} ${pesos(a.importe)} con fecha ${a.dia_texto} ${ddmm(a.vencimiento)}`;

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
  const filas = await sb(env, `feriados_ar?select=fecha,nombre&limit=2000`);
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
  const pvs = await ov(env, `preventas?fecha=gte.${desde}&select=numero,fecha,vendedorid,anulada&limit=5000`);
  const vends = await ov(env, `vendedores?select=vendedorid,nombre&limit=1000`);
  const nombreVend = new Map<number, string>(vends.map((v: { vendedorid: number; nombre: string }) => [Number(v.vendedorid), String(v.nombre || "").trim()]));
  const buscados = new Set(refs);
  for (const p of pvs) {
    if (!buscados.has(p.numero)) continue;
    out.set(p.numero, {
      vendedorid: Number(p.vendedorid),
      vendedor: nombreVend.get(Number(p.vendedorid)) || `vendedor ${p.vendedorid}`,
      fecha: p.fecha,
      anulada: p.anulada === true,
    });
  }
  return out;
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
  return { prueba: true, destino: tel, fecha_no_habil: a, vencido_impago: b };
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
