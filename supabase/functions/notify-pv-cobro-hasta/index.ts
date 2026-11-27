// Edge Function: notify-pv-cobro-hasta
//
// Control de la FECHA DE PAGO DEL CONTADO en las preventas 0km (Fer, 27-11-2026):
//   "quiero que todas las preventas a partir de hoy se chequee la fecha de pago que
//    ponen y solo acepte una fecha diferente si se autorizo por el portal antes
//    (salvo los creditos, porque eso depende de la adm cuando se liquida). Cuando
//    carguen una fecha que no corresponda, me avise a mi y a Daniel Lopez."
//
// La regla:
//   - Las ofertas de cada semana valen cobrando hasta la fecha tope de esa semana:
//     `cobro_hasta(fecha de la PV)` en wjfgl (la misma que ven los vendedores arriba
//     de las ofertas, incluido el cambio manual de Fer en cobro_limite_semana).
//   - Solo el CONTADO: SENA, REFUERZO, CANCOKM, GASTADM... Todo motivo FIN* (VW
//     Credit, bancos, Financia FG) queda afuera: lo liquida administracion.
//   - Margen de e-cheq (Gisela, 27-11-2026: "la mayoria de mis pagos son con e-cheq
//     y demora como tres dias en aplicarse, por eso le pongo unos dias mas"): no se
//     avisa hasta pasados COBRO_TOLERANCIA_HABILES (default 3) dias habiles del tope.
//   - Autorizada = hay una consulta 0km del portal con esa PV cargada, aceptada o
//     contraofertada, con `fecha_pago_pedida` >= la fecha cargada (con el mismo margen).
//   - Un renglon ya cobrado no se reclama: no hay nada que corregir.
//
// Que hace cada corrida:
//   1. Lee de Oversoft (solo lectura) las PVs 0km no anuladas desde COBRO_DESDE y sus
//      renglones VTOKM (la forma de pago que carga el vendedor).
//   2. Calcula, por PV, si algun pago de contado cae despues del limite.
//   3. Lleva el estado en `pv_cobro_hasta_alertas` (una fila por PV): abierta,
//      avisada, autorizada, corregida, cobrada.
//   4. Avisa UNA vez por PV (y otra si despues corren la fecha mas lejos), pasados
//      COBRO_GRACIA_MIN minutos desde que se vio (el vendedor puede estar tipeando).
//      Un solo WhatsApp por corrida con todas las PVs juntas, via
//      `notify-ml-excepciones` tipo "resultado" (template control_automatico_resultado,
//      aprobado) a los usuarios de COBRO_DESTINATARIOS.
//
// Envs: COBRO_DESDE (2026-11-27) · COBRO_DESTINATARIOS (fngonzalez; sumar dlopez
// despues de la primera semana) · COBRO_TOLERANCIA_HABILES (3) · COBRO_GRACIA_MIN (20)
// · COBRO_TOPE_PV (10 PVs nombradas por mensaje) · COBRO_ACTIVO (1).
//
// Modos: ?dry=1 (no escribe ni manda; devuelve que haria) · ?forzar=1 (ignora horario
// y gracia) · ?solo=549... (manda el mensaje solo a ese numero, sin sellar).
//
// pg_cron: cada 15 min de 9 a 20 hora AR, lun-sab ('*/15 12-23 * * 1-6').
// Deployar con --no-verify-jwt (el cron no manda Authorization).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const DESDE = (Deno.env.get("COBRO_DESDE") ?? "2026-11-27").slice(0, 10);
const DESTINATARIOS = Deno.env.get("COBRO_DESTINATARIOS") ?? "fngonzalez";
const TOL_HABILES = Number(Deno.env.get("COBRO_TOLERANCIA_HABILES") ?? "3");
const GRACIA_MIN = Number(Deno.env.get("COBRO_GRACIA_MIN") ?? "20");
const TOPE_PV = Number(Deno.env.get("COBRO_TOPE_PV") ?? "10");
const ACTIVO = (Deno.env.get("COBRO_ACTIVO") ?? "1") !== "0";
const HORA_DESDE = 9, HORA_HASTA = 20;
// Saldo por debajo del cual el renglon se da por cobrado (mismo criterio que
// notify-pv-fecha-no-habil: el mayor entre $5.000 y el 0,1% del importe).
const cobrado = (importe: number, saldo: number) => saldo <= Math.max(5000, Math.abs(importe) * 0.001);

// deno-lint-ignore no-explicit-any
type Any = any;

function json(obj: Any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  let body: Any = {};
  try { if (req.method === "POST") body = await req.json(); } catch { /* sin body */ }
  const flag = (k: string) => ["1", "true"].includes(String(url.searchParams.get(k) ?? body?.[k] ?? ""));
  const dry = flag("dry"), forzar = flag("forzar");
  const solo = String(url.searchParams.get("solo") ?? body?.solo ?? "").trim() || null;
  // ?desde=YYYY-MM-DD solo para probar en dry contra PVs viejas.
  const desdeQ = String(url.searchParams.get("desde") ?? body?.desde ?? "").slice(0, 10);
  const desde = dry && /^\d{4}-\d{2}-\d{2}$/.test(desdeQ) ? desdeQ : DESDE;

  const W = Deno.env.get("SUPABASE_URL") ?? "";
  const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const OV_URL = (Deno.env.get("OVERSOFT_URL") ?? "").replace(/\/+$/, "");
  const OV_KEY = Deno.env.get("OVERSOFT_KEY") ?? "";
  if (!W || !SK || !OV_URL || !OV_KEY) return json({ error: "faltan env de Supabase/Oversoft" }, 500);
  if (!ACTIVO && !forzar) return json({ ok: true, apagado: true });

  const ahoraAR = new Date(Date.now() - 3 * 3600_000);
  const hoy = ahoraAR.toISOString().slice(0, 10);
  const hora = ahoraAR.getUTCHours();
  const enHorario = hora >= HORA_DESDE && hora < HORA_HASTA && ahoraAR.getUTCDay() !== 0;

  const wj = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${W}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: SK, Authorization: `Bearer ${SK}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!r.ok) throw new Error(`wjfgl ${path.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
  const ov = async (path: string): Promise<Any[]> => {
    const out: Any[] = [];
    for (let off = 0; off < 50_000; off += 1000) {
      const sep = path.includes("?") ? "&" : "?";
      const r = await fetch(`${OV_URL}/${path}${sep}limit=1000&offset=${off}`, { headers: { apikey: OV_KEY, Authorization: `Bearer ${OV_KEY}` } });
      if (!r.ok) throw new Error(`Oversoft ${path.split("?")[0]} ${r.status}`);
      const p = await r.json();
      out.push(...p);
      if (p.length < 1000) break;
    }
    return out;
  };

  try {
    // 1) PVs y forma de pago
    const pvs = await ov(`preventas?select=numero,fecha,vendedorid,cliente,anulada&tipopv=eq.O&fecha=gte.${desde}`);
    const vivas = pvs.filter((p) => !p.anulada);
    const numeros = vivas.map((p) => String(p.numero));
    const renglones: Any[] = [];
    for (let i = 0; i < numeros.length; i += 40) {
      const lote = numeros.slice(i, i + 40).map((n) => `"${n}"`).join(",");
      renglones.push(...await ov(`detcash?select=detcashid,referencia,motivo,importe,saldo,vencimiento&origen=eq.VTOKM&referencia=in.(${encodeURIComponent(lote)})`));
    }

    // 2) Feriados, mapa de vendedores, consultas autorizadas y alertas previas
    const [feriados, mapa, consultas, previas] = await Promise.all([
      wj(`feriados_ar?select=fecha&fecha=gte.${desde}`),
      wj(`pv_vendedores_map?select=vendedorid,usuario`),
      wj(`consultas_0km?select=id,preventa,estado,fecha_pago_pedida,vendedor_nombre&preventa=not.is.null&fecha_pago_pedida=not.is.null`),
      wj(`pv_cobro_hasta_alertas?select=*`),
    ]);
    const esFeriado = new Set((feriados ?? []).map((f: Any) => String(f.fecha).slice(0, 10)));
    const sumarHabiles = (iso: string, n: number) => {
      const d = new Date(iso + "T12:00:00Z");
      let k = 0;
      while (k < n) {
        d.setUTCDate(d.getUTCDate() + 1);
        const s = d.toISOString().slice(0, 10);
        if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !esFeriado.has(s)) k++;
      }
      return d.toISOString().slice(0, 10);
    };
    const usuarioDe = new Map<number, string>((mapa ?? []).map((m: Any) => [Number(m.vendedorid), String(m.usuario)]));
    const normPv = (x: string) => {
      const m = String(x || "").match(/(\d+)\s*\/\s*(\d+)/);
      return m ? `${Number(m[1])}/${Number(m[2])}` : "";
    };
    const autorizacion = new Map<string, Any>();
    for (const c of consultas ?? []) {
      if (!["aceptada", "contraoferta"].includes(String(c.estado))) continue;
      const k = normPv(c.preventa);
      const prev = autorizacion.get(k);
      if (k && (!prev || String(c.fecha_pago_pedida) > String(prev.fecha_pago_pedida))) autorizacion.set(k, c);
    }
    const previa = new Map<string, Any>((previas ?? []).map((a: Any) => [a.pv, a]));

    // tope por fecha de PV (cobro_hasta), una llamada por dia distinto
    const topeDe = new Map<string, string>();
    for (const f of [...new Set(vivas.map((p) => String(p.fecha).slice(0, 10)))]) {
      const t = await wj("rpc/cobro_hasta", { method: "POST", body: JSON.stringify({ p_fecha: f }) });
      topeDe.set(f, String(t).slice(0, 10));
    }

    const porPv = new Map<string, Any[]>();
    for (const r of renglones) {
      const motivo = String(r.motivo ?? "").replace(/Ã‘|�/g, "Ñ").trim().toUpperCase();
      if (motivo.startsWith("FIN")) continue; // credito: lo liquida administracion
      if (!(Number(r.importe) > 0) || !r.vencimiento) continue;
      const arr = porPv.get(r.referencia) ?? [];
      arr.push({ ...r, motivo });
      porPv.set(r.referencia, arr);
    }

    const nombreMotivo = (m: string) =>
      m.startsWith("SE") ? "Seña" : m.startsWith("REFUE") ? "Refuerzo de seña" : m === "CANCOKM" ? "Cancelación" : m === "GASTADM" ? "Gastos adm." : m;
    const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
    const millones = (n: number) => `$${(n / 1e6).toLocaleString("es-AR", { maximumFractionDigits: 1 })}M`;

    const resultado: Any[] = [];
    const filas: Any[] = [];
    const aAvisar: Any[] = [];
    for (const p of vivas) {
      const pv = String(p.numero);
      const fechaPv = String(p.fecha).slice(0, 10);
      const tope = topeDe.get(fechaPv)!;
      const limite = sumarHabiles(tope, TOL_HABILES);
      const fuera = (porPv.get(pv) ?? []).filter((r) =>
        String(r.vencimiento).slice(0, 10) > limite && !cobrado(Number(r.importe), Number(r.saldo)));
      const prev = previa.get(pv);
      if (!fuera.length) {
        if (prev && ["abierta", "avisada"].includes(prev.estado)) {
          filas.push({ pv, estado: "corregida", cerrada_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        }
        continue;
      }
      const vtoMax = fuera.map((r) => String(r.vencimiento).slice(0, 10)).sort().pop()!;
      const auth = autorizacion.get(normPv(pv));
      const autorizada = !!auth && sumarHabiles(String(auth.fecha_pago_pedida).slice(0, 10), TOL_HABILES) >= vtoMax;
      const detalle = fuera.map((r) => `${nombreMotivo(r.motivo)} ${millones(Number(r.importe))} al ${ddmm(String(r.vencimiento).slice(0, 10))}`).join(", ");
      const vendedor = usuarioDe.get(Number(p.vendedorid)) ?? `vendedor ${p.vendedorid}`;
      const fila: Any = {
        pv, vendedorid: Number(p.vendedorid) || null, fecha_pv: fechaPv, tope, vto_max: vtoMax,
        detalle: `${detalle} · vendedor ${vendedor}`, updated_at: new Date().toISOString(),
        consulta_id: auth ? auth.id : null,
      };
      if (autorizada) {
        fila.estado = "autorizada";
      } else {
        const vista = prev?.visto_at ? Date.parse(prev.visto_at) : Date.now();
        if (!prev) fila.visto_at = new Date().toISOString();
        const yaAvisada = prev?.avisado_at && String(prev.vto_max) >= vtoMax;
        fila.estado = yaAvisada ? "avisada" : "abierta";
        const maduro = forzar || (Date.now() - vista) / 60000 >= GRACIA_MIN;
        if (!yaAvisada && maduro) aAvisar.push({ ...fila, vendedor, cliente: p.cliente });
      }
      filas.push(fila);
      resultado.push({ pv, fechaPv, tope, limite, vtoMax, autorizada, detalle });
    }

    // 3) Mensaje (uno solo con todo lo nuevo)
    let envio: Any = null;
    if (aAvisar.length && (enHorario || forzar || solo)) {
      const lista = aAvisar.slice(0, TOPE_PV).map((a) =>
        `${a.pv} (${a.vendedor}, PV del ${ddmm(a.fecha_pv)}, tope ${ddmm(a.tope)}): ${a.detalle.replace(/ · vendedor .*/, "")}`);
      if (aAvisar.length > TOPE_PV) lista.push(`y ${aAvisar.length - TOPE_PV} PVs más`);
      const payload = {
        tipo: "resultado",
        control: "fechas de pago de las preventas",
        resumen: `${aAvisar.length === 1 ? "1 PV tiene" : `${aAvisar.length} PVs tienen`} pago de contado después de la fecha tope de la oferta, sin autorización en el portal`,
        detalle: lista.join(" · "),
        accion: `Revisalo con el vendedor. Se tolera hasta ${TOL_HABILES} días hábiles después del tope por los e-cheq. Si la autorizaste por el portal, que cargue la PV en la consulta y el aviso se cierra solo.`,
        cantidad: String(aAvisar.length),
        usuarios: DESTINATARIOS,
        ...(solo ? { solo } : {}),
      };
      if (dry) envio = { dry: true, payload };
      else {
        const r = await fetch(`${W}/functions/v1/notify-ml-excepciones`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-stock-secret": Deno.env.get("STOCK_NOTIF_SECRET") ?? "", apikey: SK, Authorization: `Bearer ${SK}` },
          body: JSON.stringify(payload),
        });
        envio = await r.json().catch(() => ({ status: r.status }));
        const enviados = Array.isArray(envio?.enviados) ? envio.enviados.length : Number(envio?.enviados ?? 0);
        // Se sella solo si salio y no es prueba: si Meta falla, se reintenta.
        if (enviados > 0 && !solo) {
          const sello = new Set(aAvisar.map((a) => a.pv));
          for (const f of filas) if (sello.has(f.pv)) { f.estado = "avisada"; f.avisado_at = new Date().toISOString(); }
        }
      }
    }

    // 4) Guardar estado
    // PostgREST pide las mismas columnas en todas las filas del lote: se completa
    // cada una con lo que ya estaba guardado.
    if (!dry && filas.length) {
      const COLS = ["pv", "vendedorid", "fecha_pv", "tope", "vto_max", "detalle", "estado", "visto_at", "avisado_at", "cerrada_at", "consulta_id", "updated_at"];
      const completas = filas.map((f) => {
        const base = previa.get(f.pv) ?? {};
        const o: Any = {};
        for (const c of COLS) o[c] = c in f ? f[c] : (c in base ? base[c] : null);
        if (!o.visto_at) o.visto_at = new Date().toISOString();
        if (!o.estado) o.estado = "abierta";
        return o;
      });
      await wj("pv_cobro_hasta_alertas?on_conflict=pv", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(completas),
      });
    }

    return json({
      ok: true, dry, desde, pvs: vivas.length, fueraDeTope: resultado.length,
      aAvisar: aAvisar.map((a) => a.pv), enHorario, resultado, envio,
    });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
