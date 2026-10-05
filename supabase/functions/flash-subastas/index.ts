// Edge Function: flash-subastas
//
// Subastas Flash (el socio de usados de Mercado Libre) EN LA NUBE. Pedido de Fer
// (1-10-2026): que no dependa de que la PC este prendida. Es la misma logica que
// kavak-cotizador/flash_subastas.py, menos Kavak (necesita un navegador con la
// sesion de la PC: ese dato lo completa la PC cuando esta prendida).
//
// La dispara pg_cron cada minuto de 07:00 a 21:00 (hora AR). Cada corrida dura
// como mucho ~55 s y toma un lock en flash_config, asi dos corridas nunca pujan a
// la vez. En una subasta las corridas se encadenan y el bot queda practicamente
// continuo: Flash da 60 s de "tiempo de ley" y esto reacciona en 2-3 s.
//
// flash_config.nube:
//   apagada -> no hace nada
//   sombra  -> NO tasa ni toca las tasaciones: corre la logica de puja y registra
//              en flash_eventos lo que haria. Sirve para compararla con la PC.
//   activa  -> tasa los autos nuevos y puja (o simula, segun flash_config.modo).
// flash_config.modo: prueba (registra, no puja) | real (puja).
//
// Reglas que no se tocan (las mismas que en la PC):
// - Sin tope cargado NO se puja. El tope lo pone una persona en el tasador.
// - El tope es el TOTAL CON COMISION: puja maxima = tope / (1 + comision).
// - La puja nunca pasa ese maximo: se chequea justo antes de cada envio.
// - origen_datos.puja_pausada (boton de la solapa) frena un auto en el momento.
//
// Auth: --no-verify-jwt + header x-stock-secret == STOCK_NOTIF_SECRET (el cron lo
// manda). Ver la memoria reference_edge_verify_jwt_cron: sin esto el cron muere
// en silencio despues de un redeploy.

import { io } from "npm:socket.io-client@4.8.1";

const API = "https://auctions-api.queflash.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";
const HDR = { "Content-Type": "application/json", "User-Agent": UA, "Origin": "https://subastas.queflash.com" };

const CCA_CSV = "https://docs.google.com/spreadsheets/d/1MJWeHCTbxdqBJwifzgNbHssLLsxAwaSkb66Zc9yv3ko/gviz/tq?tqx=out:csv&gid=904791552&headers=1";
const VW_CSV = "https://docs.google.com/spreadsheets/d/1MJWeHCTbxdqBJwifzgNbHssLLsxAwaSkb66Zc9yv3ko/gviz/tq?tqx=out:csv&gid=1899724741";
const CERO_KM_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQH_9OtgijB7xV7qZEHoogNXq8TE5gLxz4RNb2DvxbbQ1o2A_Be2my532IJF0nxpJCUkghJrEa3TeDw/pub?gid=647749443&single=true&output=csv";
const FYF = 1300000;
// ⚠️ Factor de toma de la Formula FG. **1,00: la toma ES la FG mercado.**
// Fer, 5-10-2026, despues de medirlo: "ok 1.00".
//
// El 15% de margen que pide Fer ya esta adentro de la FG mercado, porque la FG
// **no es un precio de venta, es un precio de compra**. Medido contra la
// vidriera de Kavak (kavak-cotizador/kavak_venta.py lee su tienda por GET, 90
// publicaciones, 13 autos cruzados con los candidatos de ML): lo que Kavak
// PUBLICA esta **+15,7% arriba de la FG mercado** y +17% arriba de su propia
// oferta de permuta. Bajarle un 13% o un 17% mas duplicaba el margen.
//
// Margen implicito contra esa vidriera, por factor:
//     0,83  (26-09 a 5-10)  ->  +39,4%
//     0,87  (5-10, a mitad) ->  +33,0%   <- justo el 30% que Fer rechaza
//     1,00  (este)          ->  +15,7%   <- el que pidio
// Fer: "nunca vendo un usado con margen del 30%, maximo 15 o un toque mas".
//
// ⚠️ Donde esto NO cierra: en los autos viejos y baratos la FG ya queda
// ARRIBA de la vidriera de Kavak (Gol Trend 2014: retail/FG = 0,86), asi que
// con 1,00 se sobrepaga. Avisado el 5-10-2026. Si aparece, la salida es un
// factor por tramo de antiguedad, no volver a bajarle el factor a todos.
//
// Vive en CUATRO lugares y se mueven juntos: tasador-tga/index.html,
// tasador-tga/supabase/functions/flash-subastas/index.ts,
// tasador-argendreams/index.html, kavak-cotizador/flash_subastas.py.
const FG_TOMA = 1.00;
const CCA_TOMA = 0.86;
const ANIO_ACTUAL = 2026;
const PICKUPS = ["AMAROK", "HILUX", "RANGER", "SAVEIRO", "S-10", "S10", "MONTANA", "STRADA", "TORO", "FRONTIER", "ALASKAN"];
const MIN_ANTES = 10;          // entra a la sala 10 min antes
const DURACION_MS = 55_000;    // cada corrida; el cron la vuelve a llamar al minuto
const FOTOS_MAX = 15;

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("STOCK_NOTIF_SECRET") ?? "";

// ------------------------------------------------------------------ util

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plata = (n: number | null | undefined) => "$" + Math.round(n || 0).toLocaleString("es-AR");
const horaAR = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
}

async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status} ${path.slice(0, 60)}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

async function evento(origen: string, tipo: string, detalle: Record<string, unknown>, subasta_id?: number, lote_id?: number) {
  try {
    await sb("flash_eventos", { method: "POST", body: JSON.stringify([{ origen, tipo, detalle, subasta_id, lote_id }]) });
  } catch (_) { /* el registro no puede frenar una puja */ }
}

async function avisar(hecho: string[], detalle: string[], mirar: string[]) {
  const accion = mirar.length
    ? `Hay que mirar ${mirar.length} ${mirar.length === 1 ? "cosa" : "cosas"}: ${mirar.join("; ")}.`
    : "No hace falta que hagas nada: ya quedo arreglado.";
  try {
    await fetch(`${SB_URL}/functions/v1/notify-ml-excepciones`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-stock-secret": SECRET },
      body: JSON.stringify({
        tipo: "resultado", cantidad: String(mirar.length), control: "Subastas Flash",
        resumen: hecho.length ? hecho.join(" y ") : "no cambie nada",
        detalle: detalle.length ? detalle.join(". ") : "-", accion,
      }),
    });
  } catch (_) { /* sin aviso no se frena nada */ }
}

// ------------------------------------------------------------------ Flash

class Flash {
  tok = "";
  agencia = 249;
  constructor(private user: string, private pw: string) {}

  async login() {
    const r = await fetch(`${API}/auth/login`, { method: "POST", headers: HDR, body: JSON.stringify({ email: this.user, password: this.pw }) });
    if (!r.ok) throw new Error(`Flash login ${r.status}`);
    const j = await r.json();
    this.tok = j.access_token;
    this.agencia = j.agency?.agencyId ?? 249;
    // El cron corre cada minuto: loguearse 840 veces por dia puede disparar un
    // bloqueo. El token se guarda y se reusa hasta que Flash lo rechace (401).
    await sb("flash_config?id=eq.1", { method: "PATCH", body: JSON.stringify({ token: this.tok }) }).catch(() => {});
  }

  async sesion() {
    const t = (await sb("flash_config?id=eq.1&select=token"))?.[0]?.token;
    if (t) this.tok = t; else await this.login();
  }

  async get(path: string, reintento = true): Promise<any> {
    const r = await fetch(API + path, { headers: { ...HDR, Authorization: `Bearer ${this.tok}` } });
    if (r.status === 401 && reintento) { await this.login(); return this.get(path, false); }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Flash ${r.status} ${path}`);
    const t = await r.text();
    try { return t ? JSON.parse(t) : null; } catch { return null; }
  }

  async subastas(): Promise<any[]> { return (await this.get("/auctions"))?.data ?? []; }
  ganadora(lot: number) { return this.get(`/bids/winning-bid/${lot}`); }
}

// ------------------------------------------------------------------ matcheo (igual que catalogo.py)

function norm(s: string) {
  let x = (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase();
  x = x.replace(/,/g, ".").replace(/-/g, "");
  x = x.replace(/D\/C/g, "DC").replace(/C\/C/g, "CC").replace(/S\/C/g, "SC");
  return x.replace(/[^A-Z0-9. ]/g, " ").replace(/\s+/g, " ").trim();
}

const CAJA_AUTO = new Set(["EAT6", "E6AT", "AT6", "6AT", "AT", "TIPT6", "TIPTRONIC", "AUT", "AUTOMATICO", "4AT", "5AT", "7AT", "8AT", "DSG", "CVT", "ECVT"]);

function toks(s: string, anioLinea = true): Set<string> {
  let x = s || "";
  if (anioLinea) x = x.replace(/\bL\s*\/\s*(\d\d)\b/g, (_m, a) => ` 20${a} `);   // "L/17" de Flash = linea 2017
  return new Set(norm(x).split(" ").filter(Boolean).map((t) => (CAJA_AUTO.has(t) ? "AUT" : t)));
}
const inter = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => b.has(x)));

function ratio(a: string, b: string) {
  // aproximacion de difflib.SequenceMatcher: bigramas en comun
  const bg = (s: string) => { const o: string[] = []; for (let i = 0; i < s.length - 1; i++) o.push(s.slice(i, i + 2)); return o; };
  const A = bg(a), B = bg(b);
  if (!A.length || !B.length) return 0;
  const m = new Map<string, number>(); B.forEach((x) => m.set(x, (m.get(x) || 0) + 1));
  let c = 0; A.forEach((x) => { const n = m.get(x) || 0; if (n) { c++; m.set(x, n - 1); } });
  return (2 * c) / (A.length + B.length);
}

function csvFilas(t: string): string[][] {
  return t.split("\n").map((l) => [...l.matchAll(/"([^"]*)"/g)].map((m) => m[1]));
}

type CCA = { marca: string; modelo: string; version: string; moneda: string; precios: Record<number, number> };

async function bajar(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  return await r.text();
}

async function cargarCCA(): Promise<CCA[]> {
  const f = csvFilas(await bajar(CCA_CSV));
  const cab = f[0];
  const out: CCA[] = [];
  for (const c of f.slice(1)) {
    if (c.length < 6) continue;
    const precios: Record<number, number> = {};
    cab.forEach((h, i) => {
      if (/^20\d\d$/.test(h) && c[i] && c[i].trim()) {
        const v = parseFloat(c[i].replace(",", "."));
        if (!isNaN(v)) precios[+h] = v;
      }
    });
    out.push({ marca: c[0].trim(), modelo: c[1].trim(), version: c[2].trim(), moneda: (c[3] || "").trim().toUpperCase() === "USD" ? "USD" : "ARS", precios });
  }
  return out;
}

async function cargarVW() {
  return csvFilas(await bajar(VW_CSV)).slice(1)
    .filter((c) => c.length >= 3 && c[0].trim())
    .map((c) => ({ modelo: c[0].trim().toUpperCase(), precio_0km: Math.max(0, (+c[2].replace(/[^\d]/g, "") || 0) - FYF) }))
    .filter((v) => v.precio_0km > 0);
}

async function cargar0km() {
  const out: any[] = [];
  for (const l of (await bajar(CERO_KM_CSV)).split("\n")) {
    const v = [...l.trim().matchAll(/("[^"]*"|[^,]*)(,|$)/g)].map((m) => m[1].replace(/"/g, "").trim());
    if (v.length >= 5 && v[0] && v[1] && v[2]) {
      const p = parseFloat(v[3]);
      if (!isNaN(p) && p) out.push({ marca: v[0], modelo: v[1], version: v[2], precio: p, moneda: (v[4] || "ARS").toUpperCase() });
    }
  }
  return out;
}

function filaCCA(marca: string, modelo: string, version: string, anio: number, cca: CCA[]) {
  const nm = norm(marca), nmod = norm(modelo), tv = toks(version);
  let mejor: CCA | null = null, pts = -99;
  for (const r of cca) {
    if (norm(r.marca) !== nm || !r.precios[anio]) continue;
    const rm = norm(r.modelo);
    if (rm !== nmod && !inter(new Set(rm.split(" ")), new Set(nmod.split(" "))).size) continue;
    const rv = toks(r.version);
    let p = (rm === nmod ? 4 : 0) + 2 * inter(tv, rv).size - 0.6 * [...rv].filter((x) => !tv.has(x)).length;
    p += ratio(norm(version), norm(r.version));
    if (p > pts) { mejor = r; pts = p; }
  }
  return mejor;
}

const GENERICO = /^(\d?P|\d\.\d|\d{3}|AUT|MT|\dMT|MY\d\d|G\d|20\d\d|VW|TSI|MSI|TDI|NUEVO|NUEVA)$/;

function puntaje0km(usado: string, nuevo: string) {
  const a = toks(usado, false), b = toks(nuevo, false);
  const comun = inter(a, b);
  const propios = new Set([...comun].filter((x) => !GENERICO.test(x)));
  let p = 2 * propios.size + 0.5 * (comun.size - propios.size);
  const ca = a.has("AUT") || a.has("AT"), cb = b.has("AUT") || b.has("AT");
  if (a.has("AUT") || a.has("MT") || [...a].some((x) => x.endsWith("MT"))) p += ca === cb ? 0.5 : -2;
  return { p, propios };
}

function equiv0km(marca: string, modelo: string, version: string, vw: any[], cerokm: any[]) {
  const esVW = norm(marca) === "VOLKSWAGEN", nmod = norm(modelo);
  let mejor: any = null, pts = 0;
  for (const r of esVW ? vw : cerokm) {
    let texto: string;
    if (esVW) {
      if (!inter(new Set(nmod.split(" ")), toks(r.modelo, false)).size) continue;
      texto = r.modelo;
    } else {
      if (norm(r.marca) !== norm(marca) || norm(r.modelo) !== nmod) continue;
      texto = r.version;
    }
    const { p, propios } = puntaje0km(esVW ? `${modelo} ${version}` : version, texto);
    if (propios.size >= 1 && p > pts) { mejor = r; pts = p; }
  }
  if (!mejor) return null;
  return esVW ? { marca: "VOLKSWAGEN", modelo: mejor.modelo, version: null, precio: mejor.precio_0km, moneda: "ARS" } : mejor;
}

function ajusteKm(km: number, anio: number, modelo: string) {
  const antig = Math.max(1, ANIO_ACTUAL - anio);
  const esperados = antig * (PICKUPS.some((k) => (modelo || "").toUpperCase().includes(k)) ? 20000 : 15000);
  const r = (km || 0) / esperados;
  const tabla: [number, number][] = [[0.15, 19], [0.33, 16], [0.5, 13], [0.66, 10], [0.8, 8], [0.9, 6], [1, 3], [1.1, 0], [1.33, -6], [1.66, -9], [2, -12], [3, -16]];
  for (const [t, a] of tabla) if (r <= t) return a;
  return -20;
}

// ------------------------------------------------------------------ tasar

async function copiarFotos(fl: Flash, carId: number) {
  const urls: string[] = (await fl.get(`/core-proxy/cars/${carId}/pictures/all`))?.urls ?? [];
  const out: string[] = [];
  for (let i = 0; i < Math.min(urls.length, FOTOS_MAX); i++) {
    try {
      const r = await fetch(urls[i]);
      if (!r.ok) continue;
      const png = urls[i].split("?")[0].toLowerCase().endsWith(".png");
      const ruta = `flash/${carId}/foto_${String(i).padStart(2, "0")}.${png ? "png" : "jpg"}`;
      const up = await fetch(`${SB_URL}/storage/v1/object/tasaciones-fotos/${ruta}`, {
        method: "POST",
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": png ? "image/png" : "image/jpeg", "x-upsert": "true" },
        body: await r.arrayBuffer(),
      });
      if (up.ok) out.push(`${SB_URL}/storage/v1/object/public/tasaciones-fotos/${ruta}`);
    } catch (_) { /* una foto que falla no frena la tasacion */ }
  }
  return out;
}

function inspeccion(i: any) {
  if (!i) return null;
  const items = i.items || [];
  return {
    calificacion: i.calification, veredicto: i.finalVerdict, comentarios: i.comments, positivos: i.positiveAspects,
    fecha: i.finishedAt, items_total: items.length,
    items_con_observacion: items.filter((it: any) => it.calification && String(it.calification).toUpperCase() !== "OK")
      .map((it: any) => ({ item: it.name, area: it.area, cal: it.calification, obs: String(it.comments || "").slice(0, 200) })),
  };
}

/** Arma la fila de `tasaciones` igual que si la cargara un vendedor (sin Kavak). */
async function armarFila(fl: Flash, s: any, lot: any, tablas: { cca: CCA[]; vw: any[]; cerokm: any[] }, conFotos: boolean) {
  const car = (await fl.get(`/core-proxy/cars/${lot.car_id}`))?.data;
  if (!car) return null;
  const marca = car.brand || "", modelo = car.model || "", version = car.version || "";
  const anio = +car.year || 0, km = +car.kms || 0;
  const r = filaCCA(marca, modelo, version, anio, tablas.cca);
  const aj = ajusteKm(km, anio, modelo);
  const mC = r ? r.marca : marca.toUpperCase(), modC = r ? r.modelo : modelo.toUpperCase(), verC = r ? r.version : version.toUpperCase();
  const precioCca = r ? r.precios[anio] * 1000 : null;     // la planilla viene en miles
  const monedaCca = r ? r.moneda : "ARS";
  const eq = equiv0km(mC, modC, verC, tablas.vw, tablas.cerokm);
  const fg = eq ? eq.precio / 1.05 / Math.pow(1.09, Math.max(0, ANIO_ACTUAL - anio)) : null;
  const fgArs = eq && eq.moneda === "ARS";
  const fotos = conFotos ? await copiarFotos(fl, lot.car_id) : [];
  const comision = parseFloat(s.commission || "5") || 5;
  return {
    marca: mC, modelo: modC, version: verC, anio, kilometros: km,
    patente: (car.domain || "").toUpperCase() || null,
    estado: "compra_flash", origen: "flash", vendedor_nombre: "Flash (subasta ML)",
    numero_interno: `FLASH-${lot.id}`,
    precio_cca: precioCca, precio_cca_moneda: monedaCca,
    precio_cca_toma: precioCca && monedaCca === "ARS" ? precioCca * (1 + aj / 100) * CCA_TOMA : null,
    precio_formula_vw: fgArs ? fg : null,
    precio_formula_vw_toma: fgArs && fg ? fg * (1 + aj / 100) * FG_TOMA : null,
    equiv_0km_marca: eq?.marca ?? null, equiv_0km_modelo: eq?.modelo ?? null, equiv_0km_version: eq?.version ?? null,
    equiv_0km_precio: eq?.precio ?? null, equiv_0km_moneda: eq?.moneda ?? null,
    modelo_vw_0km: eq?.marca === "VOLKSWAGEN" ? eq.modelo : null,
    precio_vw_0km: eq?.marca === "VOLKSWAGEN" ? eq.precio : null,
    ajuste_km_porcentaje: aj,
    // Kavak lo completa la PC (necesita navegador con la sesion). Sin esto queda "pendiente".
    precio_kavak_auto: null, kavak_auto_estado: null,
    fotos,
    notas_vendedor: lot.ai_summary ?? null,
    origen_datos: {
      flash_lot_id: lot.id, flash_car_id: lot.car_id, subasta_id: s.id, subasta: s.name,
      inicio: s.startDate, fin: s.endDate, base: lot.base_price, comision_pct: comision,
      flash_version: `${marca} ${modelo} ${version}`, vin: car.vin, gnc: car.gnc,
      cca_version: r ? `${modC} ${verC}` : null,
      inspeccion: inspeccion(await fl.get(`/core-proxy/cars/${lot.car_id}/inspections/latest`)),
      resumen_ia_flash: lot.ai_summary ?? null,
      link: `https://subastas.queflash.com/subastas/${s.id}/lotes/${lot.id}`,
      tasado_en: "nube",
    },
  };
}

async function analizarFotos(id: string, fotos: string[], veh: Record<string, unknown>) {
  try {
    await sb(`tasaciones?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ analisis_ia_estado: "pendiente" }) });
    const r = await fetch(`${SB_URL}/functions/v1/analyze-photos`, {
      method: "POST", headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fotos, ...veh }), signal: AbortSignal.timeout(100_000),
    });
    const a = (await r.json())?.analisis;
    if (!a) throw new Error("sin analisis");
    await sb(`tasaciones?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ analisis_ia_resumen: a.resumen_vendedor ?? null, analisis_ia_detalle: a, analisis_ia_descuento: +a.descuento_total_ars || 0, analisis_ia_estado: "ok" }),
    });
  } catch (_) {
    await sb(`tasaciones?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ analisis_ia_estado: "error" }) }).catch(() => {});
  }
}

async function existentes(): Promise<Map<string, any>> {
  const f = await sb("tasaciones?origen=eq.flash&select=id,numero_interno,precio_toma_virtual,origen_datos");
  return new Map((f || []).map((x: any) => [x.numero_interno, x]));
}

function pendientesDe(subs: any[], ya: Map<string, any>) {
  const out: [any, any][] = [];
  for (const s of subs) {
    if (!["scheduled", "active", "in_progress", "started"].includes(s.status)) continue;
    for (const lot of s.lots || []) {
      if (["finished", "expired"].includes(lot.status)) continue;
      if (!ya.has(`FLASH-${lot.id}`)) out.push([s, lot]);
    }
  }
  return out;
}

/** Tasa como mucho UN auto por corrida (fotos + IA pueden tardar ~1 min). */
async function tasarUno(fl: Flash, subs: any[]) {
  const pend = pendientesDe(subs, await existentes());
  if (!pend.length) return null;
  const [s, lot] = pend[0];
  const tablas = { cca: await cargarCCA(), vw: await cargarVW(), cerokm: await cargar0km() };
  const fila = await armarFila(fl, s, lot, tablas, true);
  if (!fila) return null;
  const g = (await sb("tasaciones", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([fila]) }))[0];
  await evento("nube", "tasado", { numero: fila.numero_interno, modelo: fila.modelo, version: fila.version, cca: fila.precio_cca }, s.id, lot.id);
  if (fila.fotos.length) await analizarFotos(g.id, fila.fotos, { marca: fila.marca, modelo: fila.modelo, version: fila.version, anio: fila.anio, kilometros: fila.kilometros });
  const baseTotal = lot.base_price * (1 + (parseFloat(s.commission || "5") || 5) / 100);
  await avisar([`entro un auto nuevo de Flash al tasador`],
    [`${fila.modelo} ${fila.anio}, ${fila.kilometros.toLocaleString("es-AR")} km, base+comision ${plata(baseTotal)}, subasta ${horaAR(s.startDate)}. Kavak lo completa la PC`],
    ["si te interesa, pone el tope (total con comision) en tasador.titogonzalez.online, solapa Flash ML"]);
  return fila.numero_interno;
}

// ------------------------------------------------------------------ pujar

function incremento(precio: number, cfg: any) {
  const tramos = (cfg?.biddingIncrements?.increments || []).slice().sort((a: any, b: any) => (a.fromPrice || 0) - (b.fromPrice || 0));
  let inc = 25000;
  for (const t of tramos) if (precio >= (t.fromPrice || 0) && t.values?.length) inc = Math.min(...t.values);
  return inc;
}

async function guardarPuja(tas: any, estado: Record<string, unknown>) {
  const d = { ...(tas.origen_datos || {}) };
  d.puja = { ...(d.puja || {}), ...estado };
  tas.origen_datos = d;
  await sb(`tasaciones?id=eq.${tas.id}`, { method: "PATCH", body: JSON.stringify({ origen_datos: d }) }).catch(() => {});
}

function porArrancar(subs: any[], ya: Map<string, any>) {
  const ahora = Date.now();
  const out: [any, [any, any][]][] = [];
  for (const s of subs) {
    if (["finished", "cancelled", "canceled"].includes(s.status)) continue;
    const ini = Date.parse(s.startDate), fin = Date.parse(s.endDate);
    if (!ini || ahora < ini - MIN_ANTES * 60_000) continue;
    if (fin && ahora > fin + 60 * 60_000 && s.status !== "active") continue;
    const lotes: [any, any][] = [];
    for (const lot of s.lots || []) {
      const t = ya.get(`FLASH-${lot.id}`);
      // "No ofertar" del panel: se saltea aunque tenga tope
      if (t && +t.precio_toma_virtual > 0 && !t.origen_datos?.no_ofertar && !["finished", "expired"].includes(lot.status)) lotes.push([lot, t]);
    }
    if (lotes.length) out.push([s, lotes]);
  }
  return out;
}

/** Corre la sala hasta `hasta` (ms). Devuelve true si quedan lotes abiertos. */
async function pujarSubasta(fl: Flash, s: any, lotes: [any, any][], cfgFlash: any, nube: string, hasta: number) {
  const sombra = nube !== "activa";
  const comision = parseFloat(s.commission || "5") || 5;
  const cfgG = (await fl.get("/global-config")) || {};
  await fl.get("/auctions/" + s.id);      // si el token guardado vencio, esto relogea antes de abrir el socket
  const sock = io(API, { auth: { token: fl.tok }, transports: ["websocket"], reconnection: true });
  await new Promise<void>((res) => { const t = setTimeout(res, 8000); sock.on("connect", () => { clearTimeout(t); res(); }); });
  if (sock.connected) await sock.timeout(8000).emitWithAck("auction:connect", { auctionId: s.id }).catch(() => {});

  const est = new Map<number, any>();
  for (const [lot, t] of lotes) {
    est.set(lot.id, { tas: t, abierto: true, max: Math.floor(+t.precio_toma_virtual / (1 + comision / 100)), marca: null, ultimoTiro: null });
  }
  let releer = 0;
  try {
    while (Date.now() < hasta && [...est.values()].some((e) => e.abierto)) {
      // cada 15 s: tope / pausa nuevos y el modo
      if (Date.now() - releer > 15_000) {
        releer = Date.now();
        const ids = [...est.values()].map((e) => e.tas.id).join(",");
        for (const nt of await sb(`tasaciones?id=in.(${ids})&select=id,numero_interno,precio_toma_virtual,origen_datos`)) {
          for (const e of est.values()) if (e.tas.id === nt.id) {
            e.tas.precio_toma_virtual = nt.precio_toma_virtual;
            if (!sombra) e.tas.origen_datos = nt.origen_datos;
            else e.tas.origen_datos = { ...(e.tas.origen_datos || {}), puja_pausada: nt.origen_datos?.puja_pausada };
            e.max = Math.floor((+nt.precio_toma_virtual || 0) / (1 + comision / 100));
          }
        }
        const c = (await sb("flash_config?id=eq.1&select=modo,nube"))?.[0];
        if (c) { cfgFlash.modo = c.modo; if (c.nube === "apagada") break; }
      }
      const modo = sombra ? "prueba" : cfgFlash.modo;

      for (const [lid, e] of est) {
        if (!e.abierto) continue;
        const lot = (await fl.get(`/lots/${lid}`)) || {};
        const gan = (await fl.ganadora(lid)) || {};
        const monto = gan.amount ?? null;
        const mia = gan.agency?.id === fl.agencia;
        if (["finished", "expired", "closed", "sold"].includes(lot.status)) {
          e.abierto = false;
          const res = mia && lot.status !== "expired" ? "ganado" : (lot.status === "expired" && !monto ? "desierto" : "perdido");
          await evento(sombra ? "nube-sombra" : "nube", "cierre", { res, monto, max: e.max }, s.id, lid);
          if (!sombra) {
            await guardarPuja(e.tas, { estado: res, cierre: monto, cerro_at: new Date().toISOString(), modo, por: "nube" });
            if (res === "ganado") {
              await avisar([`GANAMOS ${e.tas.numero_interno}`], [`puja ${plata(monto)}, total con comision ${plata(monto * (1 + comision / 100))}`],
                ["pagar en 48 h y subir el comprobante en Flash (Mis compras)"]);
            } else {
              await avisar([`${e.tas.numero_interno}: ${res}`], [`cerro en ${plata(monto)}; nuestro tope era ${plata(e.max)} de puja`], []);
            }
          }
          continue;
        }
        if (Date.now() < Date.parse(s.startDate)) continue;
        if (e.tas.origen_datos?.puja_pausada || mia) continue;
        const actual = monto || lot.base_price || 0;
        let prox = Math.round(actual + incremento(actual, cfgG));
        // ultimo tiro: justo el maximo si el incremento minimo lo pasa pero hay margen
        if (prox > e.max && e.max > actual && e.ultimoTiro !== actual) { e.ultimoTiro = actual; prox = e.max; }
        if (prox > e.max) {
          if (e.marca !== `sup-${actual}`) {
            e.marca = `sup-${actual}`;
            await evento(sombra ? "nube-sombra" : "nube", "superado", { actual, prox, max: e.max }, s.id, lid);
            if (!sombra) await guardarPuja(e.tas, { estado: "superado", precio_actual: actual, por: "nube" });
          }
          continue;
        }
        if (modo !== "real") {
          if (e.marca !== `pru-${actual}`) {
            e.marca = `pru-${actual}`;
            await evento(sombra ? "nube-sombra" : "nube", "pujaria", { actual, prox, max: e.max }, s.id, lid);
            if (!sombra) await guardarPuja(e.tas, { estado: "prueba", precio_actual: actual, pujaria: prox, por: "nube" });
          }
          continue;
        }
        // ⚠️ ultimo control antes de mandar plata
        if (sombra || prox > e.max || prox <= 0) continue;
        if (!sock.connected) continue;
        let res = "sin_respuesta";
        try {
          res = (await sock.timeout(8000).emitWithAck("bid:push", { amount: prox, auction_id: s.id, lot_id: lid }))?.result ?? "?";
        } catch (_) { /* sin ack: se reintenta en la vuelta siguiente */ }
        await evento("nube", "puja", { prox, res, actual, max: e.max }, s.id, lid);
        if (res === "accepted") await guardarPuja(e.tas, { estado: "ganando", ultima_puja: prox, ultima_puja_at: new Date().toISOString(), por: "nube" });
      }
      await sleep(1500);
    }
  } finally {
    try { sock.emit("auction:leave", { auctionId: s.id }); sock.disconnect(); } catch (_) { /* */ }
  }
  return [...est.values()].some((e) => e.abierto);
}

// ------------------------------------------------------------------ main

async function tomarLock(ms: number, quien: string) {
  const ahora = new Date().toISOString();
  const r = await sb(`flash_config?id=eq.1&or=(lock_hasta.is.null,lock_hasta.lt.${encodeURIComponent(ahora)})`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ lock_hasta: new Date(Date.now() + ms).toISOString(), lock_por: quien }),
  });
  return Array.isArray(r) && r.length === 1;
}

async function soltarLock(quien: string, error: string | null) {
  await sb(`flash_config?id=eq.1&lock_por=eq.${encodeURIComponent(quien)}`, {
    method: "PATCH", body: JSON.stringify({ lock_hasta: null, ultima_corrida: new Date().toISOString(), ultimo_error: error }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.headers.get("x-stock-secret") !== SECRET || !SECRET) return json({ error: "no autorizado" }, 401);
  const url = new URL(req.url);
  const accion = url.searchParams.get("accion") || "ciclo";
  const fl = new Flash(Deno.env.get("FLASH_USER")!, Deno.env.get("FLASH_PASS")!);
  await fl.sesion();

  // Diagnostico sin escribir nada: que ve y que tasaria
  if (accion === "estado" || accion === "tasar_dry") {
    const subs = await fl.subastas();
    const ya = await existentes();
    const out: any = {
      config: (await sb("flash_config?id=eq.1&select=nube,modo,lock_hasta,ultima_corrida,ultimo_error"))?.[0],
      por_arrancar: porArrancar(subs, ya).map(([s, l]) => ({ subasta: s.id, lotes: l.map(([x]) => x.id) })),
      pendientes: pendientesDe(subs, ya).map(([s, l]) => ({ subasta: s.id, lote: l.id })),
    };
    if (accion === "tasar_dry") {
      const tablas = { cca: await cargarCCA(), vw: await cargarVW(), cerokm: await cargar0km() };
      const lotes = url.searchParams.get("lotes")?.split(",").map(Number) || [];
      out.filas = [];
      for (const s of subs) for (const lot of s.lots || []) {
        if (lotes.includes(lot.id)) {
          const f: any = await armarFila(fl, s, lot, tablas, false);
          if (f) out.filas.push({ numero: f.numero_interno, marca: f.marca, modelo: f.modelo, version: f.version, anio: f.anio, km: f.kilometros, precio_cca: f.precio_cca, cca_toma: f.precio_cca_toma, aj: f.ajuste_km_porcentaje, fg: f.precio_formula_vw, equiv: f.equiv_0km_modelo, patente: f.patente, items_obs: f.origen_datos.inspeccion?.items_con_observacion?.length });
        }
      }
    }
    return json(out);
  }
  if (accion === "probar_socket") {
    const sock = io(API, { auth: { token: fl.tok }, transports: ["websocket"] });
    const ok = await new Promise<boolean>((res) => { const t = setTimeout(() => res(false), 8000); sock.on("connect", () => { clearTimeout(t); res(true); }); });
    let ack = null;
    const sid = Number(url.searchParams.get("subasta") || 0);
    if (ok && sid) ack = await sock.timeout(8000).emitWithAck("auction:connect", { auctionId: sid }).catch((e: Error) => String(e));
    if (ok && sid) sock.emit("auction:leave", { auctionId: sid });
    sock.disconnect();
    return json({ conectado: ok, ack });
  }

  // ---- ciclo (lo que llama el cron) ----
  const cfg = (await sb("flash_config?id=eq.1"))?.[0];
  if (!cfg || cfg.nube === "apagada") return json({ ok: true, nada: "apagada" });
  const quien = crypto.randomUUID();
  if (!(await tomarLock(DURACION_MS + 30_000, quien))) return json({ ok: true, nada: "otra corrida en curso" });
  let error: string | null = null;
  const hecho: string[] = [];
  try {
    const hasta = Date.now() + DURACION_MS;
    const subs = await fl.subastas();
    const ya = await existentes();
    const salas = porArrancar(subs, ya);
    for (const [s, lotes] of salas) {
      await pujarSubasta(fl, s, lotes, cfg, cfg.nube, hasta);
      hecho.push(`sala ${s.id}`);
    }
    if (!salas.length && cfg.nube === "activa") {
      // fuera de subasta: tasar lo nuevo (uno por corrida, alcanza: el cron corre cada minuto)
      await sb(`flash_config?id=eq.1&lock_por=eq.${quien}`, { method: "PATCH", body: JSON.stringify({ lock_hasta: new Date(Date.now() + 170_000).toISOString() }) });
      const n = await tasarUno(fl, subs);
      if (n) hecho.push(`tasado ${n}`);
    }
  } catch (e) {
    error = String((e as Error)?.message || e).slice(0, 300);
    await evento("nube", "error", { error });
  } finally {
    await soltarLock(quien, error);
  }
  return json({ ok: !error, hecho, error });
});
