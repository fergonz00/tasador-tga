// Edge Function: usados-arreglos
//
// Seguimiento de los arreglos REALES que se le hacen a un usado que entra al
// concesionario. Los carga Jorge Fazzini desde el tasador (solapa "Arreglos").
//
// Por que existe (pedido de Fer, 16/09/2026): lo que Jorge pone como "gastos" en
// la tasacion es SIEMPRE un estimado — el mismo Jorge cuenta que con el Gol le
// erro por 150 lucas y despues se vendio sin reparar. Cargando lo que realmente
// se arreglo y cuanto salio, el estimado se confirma (o se corrige) contra la
// realidad, unidad por unidad.
//
// Por que una Edge y no db-proxy: la lista de unidades sale de OVERSOFT (replica
// solo lectura), cuya key no puede viajar al navegador, y ademas la escritura
// tiene que estar acotada a dos usuarios — por db-proxy cualquier vendedor
// logueado podria cargar arreglos.
//
// Universo de unidades = el mismo que la solapa /usados del portal (Oversoft
// `usados` con estado=Activado y fechadealta dentro de los ultimos 18 meses, sin
// las ocultas), MAS las vendidas en los ultimos 90 dias: la factura del taller
// suele llegar despues de que el auto se vendio, y ese es justo el caso en el
// que interesa saber cuanto costo de verdad.
//
// El estimado NO se calcula aca: se devuelve `analisis_fisico` crudo y el front
// arma el desglose con sus propias etiquetas (INSP_GRUPOS / TIPOS_DANIO). Si se
// duplicaran aca, quedarian viejas la primera vez que se tocan alla.
//
// Secrets: OVERSOFT_URL, OVERSOFT_KEY. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// los inyecta el runtime.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

// Quien puede ver/cargar/editar/borrar arreglos. Jorge es el que los hace hacer;
// Fer, el unico que ademas los mira contra el margen. Decision de Fer 17/09/2026.
const EDITORES = new Set(["jfazzini", "fngonzalez"]);

// El costo se GUARDA siempre neto en `costo`: es el que suma al costo de toma de
// Oversoft, que en un usado tomado a un particular no tiene IVA. Jorge elige en
// la pantalla si lo que tipea es neto o el total de la factura; lo tipeado queda
// tal cual en `costo_ingresado` para que al editar vea su propio numero y no uno
// dividido. La conversion la hace la Edge, no el navegador.
const IVA = 1.21;
const netear = (monto: number, ivaIncluido: boolean) =>
  Math.round((ivaIncluido ? monto / IVA : monto) * 100) / 100;

// Mismo corte de antiguedad que /usados y usados-disponibles.
const ANTIGUEDAD_MAX_MESES = 18;
// Ventana en la que una unidad ya vendida se sigue mostrando (facturas que llegan tarde).
const VENDIDA_DIAS = 90;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
async function rest(base: string, key: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

const normPat = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Sesion firmada de `login_tasador`: HMAC-SHA256 de "<usuario>.<exp>" con
 * `app_config.tga_session_secret`, en hex.
 *
 * La firma va atada al usuario al que se le emitio, que es `session_usuario` —
 * NO `usuario`, que cambia cuando un superadmin impersona. Hay que autorizar
 * siempre contra el dueño de la firma.
 */
async function firmanteValido(
  W: string,
  KEY: string,
  usuario: string,
  exp: unknown,
  sig: string,
): Promise<boolean> {
  const e = Number(exp) || 0;
  if (!usuario || !e || !sig) return false;
  if (e * 1000 < Date.now()) return false; // vencida (dura 7 dias)
  const rows = await rest(W, KEY, "/app_config?clave=eq.tga_session_secret&select=valor&limit=1");
  const secret = rows?.[0]?.valor;
  if (!secret) return false;
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", k, enc.encode(`${usuario}.${e}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== sig.length) return false;
  let d = 0;
  for (let i = 0; i < hex.length; i++) d |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return d === 0;
}

// Oversoft ya mete la version (y a veces el año) adentro de `modelo`, asi que el
// año se agrega solo si no viene ya en el texto. Mismo criterio que tituloUsado()
// en portal-precios; si no, el nombre sale con el año duplicado.
// deno-lint-ignore no-explicit-any
function tituloUsado(u: any): string {
  const marca = String(u.marca ?? "").trim();
  const modelo = String(u.modelo ?? "").trim();
  const base = [marca, modelo].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const anio = Number(u.anio) || 0;
  if (anio && !/\b(19|20)\d{2}\b/.test(base)) return `${base} ${anio}`.trim();
  return base || "Usado sin nombre";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Metodo no permitido" }, 405);

  const SUPA_URL = Deno.env.get("SUPABASE_URL");
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const OV_URL_RAW = Deno.env.get("OVERSOFT_URL");
  const OV_KEY = Deno.env.get("OVERSOFT_KEY");
  if (!SUPA_URL || !SUPA_KEY) return json({ ok: false, error: "SUPABASE env vars missing" }, 500);
  if (!OV_URL_RAW || !OV_KEY) return json({ ok: false, error: "OVERSOFT env vars missing" }, 500);
  const W = SUPA_URL + "/rest/v1";
  const OV_BASE = OV_URL_RAW.replace(/\/+$/, "");
  const OV = OV_BASE.endsWith("/rest/v1") ? OV_BASE : OV_BASE + "/rest/v1";

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON invalido" }, 400);
  }

  const sess = body?.session || {};
  // El dueño de la firma manda para autorizar (ver firmanteValido).
  const firmante = String(sess.session_usuario || sess.usuario || "").trim().toLowerCase();
  let ok = false;
  try {
    ok = await firmanteValido(W, SUPA_KEY, firmante, sess.session_exp, String(sess.session_sig || ""));
  } catch (e) {
    console.error("usados-arreglos firma:", e);
  }
  if (!ok) return json({ ok: false, error: "No autorizado" }, 401);
  if (!EDITORES.has(firmante)) return json({ ok: false, error: "Sin permiso para ver arreglos" }, 403);

  // Nombre que queda registrado: si hay impersonacion, el que esta navegando.
  const autor = String(sess.nombre || sess.usuario || firmante).trim();
  const accion = String(body?.accion || "listar").toLowerCase();

  try {
    if (accion === "agregar") {
      const usadoid = Number(body?.usadoid) || 0;
      const descripcion = String(body?.descripcion || "").trim();
      const costo = Number(body?.costo);
      const fecha = String(body?.fecha || "").slice(0, 10);
      if (!usadoid) return json({ ok: false, error: "Falta la unidad" }, 400);
      if (!descripcion) return json({ ok: false, error: "Falta decir que se arreglo" }, 400);
      if (!Number.isFinite(costo) || costo < 0) return json({ ok: false, error: "Costo invalido" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return json({ ok: false, error: "Fecha invalida" }, 400);
      const ivaIncluido = body?.iva_incluido === true;
      const row = await rest(W, SUPA_KEY, "/usados_arreglos", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          usadoid,
          patente: String(body?.patente || "").trim().toUpperCase() || null,
          descripcion,
          costo: netear(costo, ivaIncluido),
          costo_ingresado: Math.round(costo * 100) / 100,
          iva_incluido: ivaIncluido,
          fecha,
          cargado_por: autor,
        }),
      });
      return json({ ok: true, arreglo: Array.isArray(row) ? row[0] : row });
    }

    if (accion === "editar") {
      const id = String(body?.id || "").trim();
      if (!id) return json({ ok: false, error: "Falta el id" }, 400);
      // deno-lint-ignore no-explicit-any
      const patch: any = { actualizado_por: autor, actualizado_at: new Date().toISOString() };
      if (body?.descripcion !== undefined) {
        const d = String(body.descripcion || "").trim();
        if (!d) return json({ ok: false, error: "Falta decir que se arreglo" }, 400);
        patch.descripcion = d;
      }
      if (body?.costo !== undefined) {
        const c = Number(body.costo);
        if (!Number.isFinite(c) || c < 0) return json({ ok: false, error: "Costo invalido" }, 400);
        // Si el que edita no manda el flag, vale el que ya tenia la fila: cambiarlo
        // a `false` por omision convertiria un bruto en neto sin que nadie lo pida.
        let ivaIncluido: boolean;
        if (typeof body.iva_incluido === "boolean") {
          ivaIncluido = body.iva_incluido;
        } else {
          const prev = await rest(
            W, SUPA_KEY,
            `/usados_arreglos?id=eq.${encodeURIComponent(id)}&select=iva_incluido&limit=1`,
          );
          ivaIncluido = prev?.[0]?.iva_incluido === true;
        }
        patch.costo = netear(c, ivaIncluido);
        patch.costo_ingresado = Math.round(c * 100) / 100;
        patch.iva_incluido = ivaIncluido;
      }
      if (body?.fecha !== undefined) {
        const f = String(body.fecha || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return json({ ok: false, error: "Fecha invalida" }, 400);
        patch.fecha = f;
      }
      const row = await rest(W, SUPA_KEY, `/usados_arreglos?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(patch),
      });
      return json({ ok: true, arreglo: Array.isArray(row) ? row[0] : row });
    }

    if (accion === "borrar") {
      const id = String(body?.id || "").trim();
      if (!id) return json({ ok: false, error: "Falta el id" }, 400);
      await rest(W, SUPA_KEY, `/usados_arreglos?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      return json({ ok: true });
    }

    // ---- listar ----
    const corte = new Date();
    corte.setMonth(corte.getMonth() - ANTIGUEDAD_MAX_MESES);
    const corteAlta = corte.toISOString().slice(0, 10);
    const corteVenta = new Date(Date.now() - VENDIDA_DIAS * 86400000).toISOString().slice(0, 10);

    // 1) Universo en Oversoft: vivas + vendidas recientes.
    const raw = await rest(
      OV,
      OV_KEY,
      "/usados?select=usadoid,marca,modelo,anio,km,color,patente,fechadealta,fechadeingreso," +
        "fechadeventa,recibida,enreparacion,preventaorigen" +
        `&estado=eq.Activado&fechadealta=gte.${corteAlta}` +
        `&or=(fechadeventa.is.null,fechadeventa.gte.${corteVenta})` +
        "&order=fechadealta.desc&limit=500",
    ) as Record<string, unknown>[];

    if (!raw.length) return json({ ok: true, usuario: firmante, puedeEditar: true, unidades: [] });

    const ids = raw.map((u) => Number(u.usadoid)).filter(Boolean);

    // 2) Ocultas del portal (unidades trabadas que no se ofrecen) -> fuera.
    const portal = await rest(
      W,
      SUPA_KEY,
      `/portal_usados?usadoid=in.(${ids.join(",")})&select=usadoid,oculto,vendido`,
    ) as Record<string, unknown>[];
    const portalMap = new Map<number, Record<string, unknown>>(
      portal.map((p) => [Number(p.usadoid), p]),
    );

    // 3) Tasacion por patente (la mas reciente gana): km/color reales y el estimado.
    const patentes = raw.map((u) => String(u.patente ?? "").trim()).filter(Boolean);
    const tasMap = new Map<string, Record<string, unknown>>();
    if (patentes.length) {
      const lista = patentes.map((p) => `"${p}"`).join(",");
      const tas = await rest(
        W,
        SUPA_KEY,
        `/tasaciones?patente=in.(${encodeURIComponent(lista)})&select=id,patente,version,color,kilometros,` +
          `analisis_fisico,tasado_fisico_por,tasado_fisico_at,created_at&order=created_at.desc&limit=500`,
      ) as Record<string, unknown>[];
      for (const t of tas) {
        const k = normPat(t.patente);
        if (k && !tasMap.has(k)) tasMap.set(k, t);
      }
    }

    // 4) Arreglos ya cargados.
    const arr = await rest(
      W,
      SUPA_KEY,
      `/usados_arreglos?usadoid=in.(${ids.join(",")})&select=*&order=fecha.asc,created_at.asc`,
    ) as Record<string, unknown>[];
    const arrMap = new Map<number, Record<string, unknown>[]>();
    for (const a of arr) {
      const k = Number(a.usadoid);
      if (!arrMap.has(k)) arrMap.set(k, []);
      arrMap.get(k)!.push(a);
    }

    const unidades = [];
    for (const u of raw) {
      const p = portalMap.get(Number(u.usadoid));
      if (p && p.oculto === true) continue;

      const t = tasMap.get(normPat(u.patente));
      const arreglos = arrMap.get(Number(u.usadoid)) || [];
      const totalReal = arreglos.reduce((s, a) => s + (Number(a.costo) || 0), 0);
      const km = t?.kilometros != null && Number(t.kilometros) > 0
        ? Number(t.kilometros)
        : (Number(u.km) || 0);
      const fechaVenta = String(u.fechadeventa ?? "").slice(0, 10) || null;

      unidades.push({
        usadoid: Number(u.usadoid),
        patente: String(u.patente ?? "").trim() || null,
        unidad: tituloUsado(u),
        marca: String(u.marca ?? "").trim(),
        modelo: String(u.modelo ?? "").trim(),
        version: (t?.version as string) || null,
        anio: Number(u.anio) || null,
        km,
        color: String((t?.color as string) ?? u.color ?? "").trim() || null,
        estado: u.recibida === true ? "fisico" : "a_recibir",
        enreparacion: u.enreparacion === true,
        fecha_alta: String(u.fechadealta ?? "").slice(0, 10) || null,
        fecha_ingreso: String(u.fechadeingreso ?? "").slice(0, 10) || null,
        fecha_venta: fechaVenta,
        // Vendida en Oversoft, o marcada a mano en el portal mientras Oversoft
        // no le cargo la fecha (mismo puente que usa la solapa /usados).
        vendido: !!fechaVenta || (p?.vendido === true),
        tasacion_id: (t?.id as string) || null,
        tasado_fisico_por: (t?.tasado_fisico_por as string) || null,
        // Crudo a proposito: el desglose lo arma el front con sus etiquetas.
        analisis_fisico: (t?.analisis_fisico as unknown) ?? null,
        arreglos,
        total_real: Math.round(totalReal),
      });
    }

    // Primero lo que sigue en stock (ahi es donde hay que anotar), vendidas al final.
    unidades.sort((a, b) => {
      if (a.vendido !== b.vendido) return a.vendido ? 1 : -1;
      return String(b.fecha_alta ?? "").localeCompare(String(a.fecha_alta ?? ""));
    });

    return json({ ok: true, usuario: firmante, puedeEditar: true, total: unidades.length, unidades });
  } catch (e) {
    console.error("usados-arreglos:", e);
    return json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
