// Edge Function: notify-pv-fecha-no-habil
//
// Avisa por WhatsApp cuando un vendedor carga en una PV una fecha de pago que
// cae en dia NO bancario (sabado, domingo o feriado nacional).
//
// De donde sale el dato:
//   Replica Oversoft (solo lectura) -> tabla `detcash`, filas con
//   `origen = 'VTOKM'` y `referencia = 'PV xxxxx/n'`. Cada fila es un renglon
//   de la forma de pago que el vendedor carga a la izquierda de la PV:
//     - `motivo`      = concepto (SENA, CANCOKM, FIN0KMBBVA, ...)
//     - `importe`     = monto
//     - `vencimiento` = LA FECHA DE PAGO que promete el vendedor  <-- lo que se controla
//     - `fecha`       = fecha de carga
//
// Que hace cada corrida:
//   1. Lee los renglones VTOKM cargados en los ultimos VENTANA_DIAS.
//   2. Marca los que vencen sabado / domingo / feriado (tabla `feriados_ar`).
//   3. Da de alta las alertas nuevas en `pv_fechas_alertas`.
//   4. Re-chequea las alertas abiertas: si la fecha se corrigio, si la PV se
//      anulo o si el renglon se reemplazo -> las cierra (deja de avisar).
//   5. Manda el WhatsApp: 1 mensaje por PV (agrupa todos sus renglones malos) a
//      vendedor + gerente de ventas + Monica Gerez + Fernando N. Gonzalez.
//      Alta nueva: avisa en la corrida siguiente. Sigue sin corregirse: 1
//      recordatorio por dia habil, hasta MAX_AVISOS.
//
// Destinatarios: `tasador_usuarios` (telefono_wa). El vendedor sale de
// `pv_vendedores_map` (vendedorid de Oversoft -> usuario). Los fijos, del env
// PVFECHA_FIJOS (default: dlopez, mgerez, fngonzalez).
//
// Template Meta: `pv_fecha_no_habil` (es_AR, UTILITY, 4 variables)
//   {{1}} nombre del destinatario · {{2}} nro de PV · {{3}} detalle de los
//   renglones · {{4}} vendedor.
//
// Modos (query string o body JSON):
//   ?dry=1                 -> no manda ni escribe: devuelve que haria
//   ?solo=549113...        -> manda solo a ese numero (prueba del template)
//   ?forzar=1              -> ignora el limite de 1 aviso por dia y el horario
//   ?dias=90               -> agranda la ventana de lectura
//   ?listar=1              -> lista los templates de la WABA (diagnostico)
//   ?crear_template=1      -> da de alta el template en Meta (una sola vez)
//   {"cerrar":[detcashid]} -> cierra alertas a mano (deja de recordar)
//
// pg_cron (una sola vez, para agendarlo cada 10 min de 9 a 20 hora AR):
//   CREATE EXTENSION IF NOT EXISTS pg_cron;
//   CREATE EXTENSION IF NOT EXISTS pg_net;
//   SELECT cron.schedule(
//     'notify-pv-fecha-no-habil', '*/10 12-23 * * *',
//     $$ SELECT net.http_post(
//       url := 'https://wjfglsafgaltusmbnccl.supabase.co/functions/v1/notify-pv-fecha-no-habil',
//       headers := jsonb_build_object('Content-Type', 'application/json'),
//       body := '{}'::jsonb
//     ); $$
//   );

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "pv_fecha_no_habil";
const WABA_ID_DEFAULT = "1183788370595856"; // WABA "Tito Gonzalez | Tasador"

// Renglones de la PV: los carga el vendedor con origen VTOKM.
const ORIGEN_PV = "VTOKM";
const VENTANA_DIAS = Number(Deno.env.get("PVFECHA_VENTANA_DIAS") ?? "30");
const MAX_AVISOS = Number(Deno.env.get("PVFECHA_MAX_AVISOS") ?? "10");
const HORA_DESDE = Number(Deno.env.get("PVFECHA_HORA_DESDE") ?? "9"); // hora AR
const HORA_HASTA = Number(Deno.env.get("PVFECHA_HORA_HASTA") ?? "20");
const FIJOS_DEFAULT = "dlopez,mgerez,fngonzalez";

// El 1er aviso recien sale cuando el renglon lleva este tiempo cargado, para no
// pegarle al vendedor mientras todavia esta tipeando la forma de pago.
const GRACIA_MIN = Number(Deno.env.get("PVFECHA_GRACIA_MIN") ?? "20");

// Corte de arranque: los renglones cargados ANTES de esta fecha se registran
// como `historica` (quedan para consulta) pero NO generan aviso. Evita el
// aluvion de avisos por errores viejos el dia que se enciende el control.
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
    if (flag("crear_template")) return json(await crearTemplate(env));
    if (flag("borrar_template")) return json(await borrarTemplate(env));

    const cerrar = body["cerrar"];
    if (Array.isArray(cerrar) && cerrar.length) return json(await cerrarAMano(env, cerrar));

    const solo = String(par("solo") ?? "").trim();
    if (solo) return json(await pruebaDirigida(env, solo.replace(/^\+/, "").replace(/[\s-]/g, "")));

    return json(await procesar(env, {
      dry: flag("dry"),
      forzar: flag("forzar"),
      dias: Number(par("dias") ?? VENTANA_DIAS) || VENTANA_DIAS,
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
  importe: number; motivo: string; referencia: string;
};

type Alerta = {
  detcashid: number; referencia: string; motivo: string | null; importe: number | null;
  vencimiento: string; dia_texto: string | null; vendedorid: number | null;
  vendedor_nombre: string | null; fecha_pv: string | null; estado: string;
  ultimo_aviso_dia: string | null; avisos: number;
};

// ── Nucleo ──────────────────────────────────────────────────────────────────

async function procesar(env: Env, opts: { dry: boolean; forzar: boolean; dias: number }) {
  const ahora = new Date();
  const hoyAR = fechaAR(ahora);
  const horaAR = ahora.getUTCHours() - 3 < 0 ? ahora.getUTCHours() + 21 : ahora.getUTCHours() - 3;

  // 1. Feriados + renglones de PV de la ventana
  const feriados = await feriadosMap(env);
  const desde = isoMasDias(hoyAR, -Math.abs(opts.dias));
  const renglones: Renglon[] = await ov(
    env,
    `detcash?origen=eq.${ORIGEN_PV}&fecha=gte.${desde}` +
    `&select=detcashid,fecha,vencimiento,importe,motivo,referencia&limit=5000`,
  );

  // 2. Cuales caen en dia no bancario (solo importes positivos: los negativos
  //    son contra-asientos de anulacion, no una promesa de pago).
  const malos = renglones.filter((r) => r.vencimiento && Number(r.importe) > 0 && esNoHabil(r.vencimiento, feriados).noHabil);

  // 3. Datos de la PV (vendedor / anulada) para las PVs involucradas
  const refs = [...new Set(malos.map((r) => r.referencia))];
  const pvs = await preventasDe(env, refs, opts.dias);

  // 4. Estado actual de las alertas
  const previas: Alerta[] = await sb(env, `pv_fechas_alertas?select=*&limit=5000`);
  const previasPorId = new Map(previas.map((a) => [Number(a.detcashid), a]));

  // 5. Altas nuevas
  const nuevas: Record<string, unknown>[] = [];
  for (const r of malos) {
    if (previasPorId.has(r.detcashid)) continue;
    const pv = pvs.get(r.referencia);
    if (pv?.anulada) continue; // PV anulada: no molestamos a nadie
    const { texto } = esNoHabil(r.vencimiento!, feriados);
    nuevas.push({
      detcashid: r.detcashid,
      referencia: r.referencia,
      motivo: r.motivo,
      importe: r.importe,
      vencimiento: r.vencimiento!.slice(0, 10),
      dia_texto: texto,
      vendedorid: pv?.vendedorid ?? null,
      vendedor_nombre: pv?.vendedor ?? null,
      fecha_pv: (pv?.fecha ?? r.fecha)?.slice(0, 10) ?? null,
      // Anterior al arranque del control: se guarda de registro, no se avisa.
      estado: r.fecha.slice(0, 10) < DESDE ? "historica" : "abierta",
      detectado_at: new Date().toISOString(),
    });
  }
  if (nuevas.length && !opts.dry) {
    await sb(env, "pv_fechas_alertas?on_conflict=detcashid", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(nuevas),
    });
  }

  // 6. Cierre de las que ya se corrigieron
  const abiertas = [
    ...previas.filter((a) => a.estado === "abierta"),
    ...(nuevas as unknown as Alerta[]).filter((a) => a.estado === "abierta"),
  ];
  const cerradas = await detectarCorregidas(env, abiertas, renglones, pvs, feriados, opts.dry);
  const cerradasIds = new Set(cerradas.map((c) => c.detcashid));

  // 7. A quien le toca aviso en esta corrida
  const pendientes = abiertas.filter((a) => !cerradasIds.has(Number(a.detcashid)));
  const aAvisar = pendientes.filter((a) => {
    if ((a.avisos ?? 0) >= MAX_AVISOS) return false;
    if (opts.forzar) return true;
    if (a.ultimo_aviso_dia === hoyAR) return false; // ya se aviso hoy
    return true;
  });

  // Ventana horaria + dia habil (el domingo/feriado no se molesta a nadie).
  const enHorario = opts.forzar ||
    (horaAR >= HORA_DESDE && horaAR < HORA_HASTA && !esNoHabilParaAvisar(hoyAR, feriados));
  if (!enHorario) {
    return {
      ok: true, hoy: hoyAR, hora_ar: horaAR, dry: opts.dry,
      renglones_leidos: renglones.length, no_habiles: malos.length,
      alertas_nuevas: nuevas.length, cerradas: cerradas.length,
      pendientes: pendientes.length, enviados: 0,
      detalle: "fuera de horario de aviso (o dia no habil)",
    };
  }

  // 8. Un mensaje por PV, agrupando sus renglones
  const porPv = new Map<string, Alerta[]>();
  for (const a of aAvisar) {
    // Gracia: si el renglon se cargo hace muy poco, esperamos a la proxima corrida.
    const r = renglones.find((x) => x.detcashid === Number(a.detcashid));
    if (!opts.forzar && (a.avisos ?? 0) === 0 && r && minutosDesde(r.fecha) < GRACIA_MIN && esDeHoy(r.fecha, hoyAR)) continue;
    const lista = porPv.get(a.referencia) ?? [];
    lista.push(a);
    porPv.set(a.referencia, lista);
  }

  const padron = await padronUsuarios(env);
  const enviados: unknown[] = [];
  const errores: unknown[] = [];
  const avisadas: number[] = [];

  for (const [ref, lista] of porPv) {
    const vendedorid = lista.find((a) => a.vendedorid)?.vendedorid ?? null;
    const vendedorNombre = lista.find((a) => a.vendedor_nombre)?.vendedor_nombre ?? "sin identificar";
    const detalle = lista
      .sort((a, b) => a.vencimiento.localeCompare(b.vencimiento))
      .map((a) => `${nombreMotivo(a.motivo)} ${pesos(a.importe)} con fecha ${a.dia_texto} ${ddmm(a.vencimiento)}`)
      .join(" · ");

    const destinos = destinatarios(padron, vendedorid);
    if (opts.dry) {
      enviados.push({ pv: ref, vendedor: vendedorNombre, detalle, destinos: destinos.map((d) => d.nombre), renglones: lista.length });
      avisadas.push(...lista.map((a) => Number(a.detcashid)));
      continue;
    }

    const okDestinos: string[] = [];
    for (const d of destinos) {
      const r = await enviarTemplate(env, d.telefono_wa, [primerNombre(d.nombre), ref, detalle, vendedorNombre]);
      if (r.ok) okDestinos.push(d.nombre);
      else errores.push({ pv: ref, destinatario: d.nombre, error: r.error });
    }
    if (okDestinos.length) {
      enviados.push({ pv: ref, destinos: okDestinos, renglones: lista.length });
      avisadas.push(...lista.map((a) => Number(a.detcashid)));
      for (const a of lista) {
        await sb(env, `pv_fechas_alertas?detcashid=eq.${a.detcashid}`, {
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

  return {
    ok: true, hoy: hoyAR, hora_ar: horaAR, dry: opts.dry,
    renglones_leidos: renglones.length, no_habiles: malos.length,
    alertas_nuevas: nuevas.length, cerradas: cerradas.length, detalle_cerradas: cerradas,
    pendientes: pendientes.length, pvs_avisadas: porPv.size,
    enviados, errores,
  };
}

// Una alerta abierta se cierra si: la fecha se corrigio, la PV se anulo, el
// renglon tiene un contra-asiento por el mismo importe en negativo, o quedo
// reemplazado por otro renglon del mismo concepto con fecha habil.
async function detectarCorregidas(
  env: Env, abiertas: Alerta[], renglones: Renglon[],
  pvs: Map<string, { vendedorid: number; vendedor: string; fecha: string; anulada: boolean }>,
  feriados: Map<string, string>, dry: boolean,
) {
  if (!abiertas.length) return [];

  // Los renglones viejos pueden haber quedado fuera de la ventana: los pedimos
  // de a uno por id para poder comparar la fecha actual.
  const enVentana = new Map(renglones.map((r) => [r.detcashid, r]));
  const faltantes = abiertas.map((a) => Number(a.detcashid)).filter((id) => !enVentana.has(id));
  if (faltantes.length) {
    const extra: Renglon[] = await ov(
      env,
      `detcash?detcashid=in.(${faltantes.join(",")})&select=detcashid,fecha,vencimiento,importe,motivo,referencia&limit=5000`,
    );
    for (const r of extra) enVentana.set(r.detcashid, r);
  }
  const todos = [...enVentana.values()];

  const cerradas: { detcashid: number; motivo: string; vencimiento_corregido: string | null }[] = [];
  for (const a of abiertas) {
    const id = Number(a.detcashid);
    const r = enVentana.get(id);
    const pv = pvs.get(a.referencia);
    let motivoCierre: string | null = null;
    let nuevaFecha: string | null = null;

    if (pv?.anulada) motivoCierre = "PV anulada";
    else if (!r) motivoCierre = "renglon ya no existe";
    else if (r.vencimiento && !esNoHabil(r.vencimiento, feriados).noHabil) {
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

    if (!motivoCierre) continue;
    cerradas.push({ detcashid: id, motivo: motivoCierre, vencimiento_corregido: nuevaFecha });
    if (!dry) {
      await sb(env, `pv_fechas_alertas?detcashid=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          estado: motivoCierre === "PV anulada" ? "anulada" : "corregida",
          corregido_at: new Date().toISOString(),
          vencimiento_corregido: nuevaFecha,
        }),
      });
    }
  }
  return cerradas;
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
  if (vendedorid != null) {
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
  const dow = new Date(`${dia}T12:00:00Z`).getUTCDay();
  if (dow === 6) return { noHabil: true, texto: "sábado" };
  if (dow === 0) return { noHabil: true, texto: "domingo" };
  return { noHabil: false, texto: DIAS[dow] };
}

// Para decidir si hoy se puede molestar: el sabado el salon trabaja, el domingo
// y los feriados no.
function esNoHabilParaAvisar(hoyISO: string, feriados: Map<string, string>) {
  if (feriados.has(hoyISO)) return true;
  return new Date(`${hoyISO}T12:00:00Z`).getUTCDay() === 0;
}

const fechaAR = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const isoMasDias = (iso: string, dias: number) =>
  new Date(new Date(`${iso}T12:00:00Z`).getTime() + dias * 86400_000).toISOString().slice(0, 10);
const minutosDesde = (iso: string) => (Date.now() - new Date(`${iso.slice(0, 19)}Z`).getTime()) / 60000;
const esDeHoy = (iso: string, hoyAR: string) => iso.slice(0, 10) === hoyAR;
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
// Los nombres oficiales de feriado son larguisimos ("Paso a la Inmortalidad
// del Gral. Jose de San Martin"): en el WhatsApp alcanza con el arranque.
const corto = (s: string) => (s.length <= 34 ? s : s.slice(0, 32).trimEnd() + "…");
const primerNombre = (n: string) => (n || "").trim().split(/\s+/)[0] || "equipo";
const pesos = (n: number | null) =>
  "$" + Math.round(Number(n ?? 0)).toLocaleString("es-AR").replace(/ /g, " ");
const nombreMotivo = (m: string | null) => {
  const k = String(m ?? "").replace(/Ã‘/g, "Ñ").trim().toUpperCase();
  return MOTIVOS[k] ?? (k || "Pago");
};

// ── Datos ───────────────────────────────────────────────────────────────────

async function preventasDe(env: Env, refs: string[], dias: number) {
  const out = new Map<string, { vendedorid: number; vendedor: string; fecha: string; anulada: boolean }>();
  if (!refs.length) return out;
  const desde = isoMasDias(fechaAR(new Date()), -Math.abs(dias) - 120);
  const pvs = await ov(env, `preventas?fecha=gte.${desde}&select=numero,fecha,vendedorid,anulada&limit=5000`);
  const vends = await ov(env, `vendedores?select=vendedorid,nombre&limit=1000`);
  const nombreVend = new Map<number, string>(vends.map((v: { vendedorid: number; nombre: string }) => [Number(v.vendedorid), String(v.nombre || "").trim()]));
  for (const p of pvs) {
    if (!refs.includes(p.numero)) continue;
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
  await sb(env, `pv_fechas_alertas?detcashid=in.(${limpios.join(",")})`, {
    method: "PATCH",
    body: JSON.stringify({ estado: "cerrada_manual", corregido_at: new Date().toISOString() }),
  });
  return { cerradas: limpios.length, detcashids: limpios };
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
    "PV 09999/1",
    "Seña $1.000.000 con fecha sábado 22/08 · Cancelación $15.629.600 con fecha domingo 23/08",
    "PRUEBA (no es una PV real)",
  ]);
  return { prueba: true, destino: tel, ...r };
}

async function listarTemplates(env: Env) {
  const res = await fetch(
    `${META_API_URL}/${env.WABA_ID}/message_templates?fields=name,language,status,category&limit=200`,
    { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } },
  );
  const j = await res.json();
  return { templates: (j?.data ?? []).map((t: Record<string, string>) => ({ name: t.name, language: t.language, status: t.status, category: t.category })), error: j?.error };
}

async function crearTemplate(env: Env) {
  const payload = {
    name: TEMPLATE_NAME,
    language: META_LANGUAGE,
    category: "UTILITY",
    components: [
      { type: "HEADER", format: "TEXT", text: "Fecha de pago en día no bancario" },
      {
        type: "BODY",
        text: "Hola {{1}}, en la {{2}} hay pagos cargados con fecha en un día no bancario: {{3}}. Vendedor: {{4}}. Los bancos no acreditan sábados, domingos ni feriados: por favor entrá a la PV y corregí la fecha de pago a un día hábil.",
        example: {
          body_text: [[
            "Jorge",
            "PV 08114/1",
            "Seña $1.000.000 con fecha sábado 22/08 · Cancelación $15.629.600 con fecha domingo 23/08",
            "Fazzini Jorge",
          ]],
        },
      },
      { type: "FOOTER", text: "Aviso automático · Tito Gonzalez" },
    ],
  };
  const res = await fetch(`${META_API_URL}/${env.WABA_ID}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, respuesta: await res.json() };
}

async function borrarTemplate(env: Env) {
  const res = await fetch(
    `${META_API_URL}/${env.WABA_ID}/message_templates?name=${TEMPLATE_NAME}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${env.WA_TOKEN}` } },
  );
  return { status: res.status, respuesta: await res.json() };
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
