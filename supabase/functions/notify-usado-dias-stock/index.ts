// Edge Function: notify-usado-dias-stock
//
// Avisa por WhatsApp a Fer cuando un usado cumple 30 dias en el salon sin
// venderse, y de nuevo a los 45, 60, 75... (cada 15 dias) mientras siga ahi.
// Pedido de Fer el 26/11/2026: "cuando un usado cumple 30 dias de stock quiero
// que me avises asi revisamos el precio o que paso" + "30 45 60 etc si".
// Caso que lo motivo: la Tera High AI321FO, 31 dias a $38,9M con 1 lead.
//
// Dias = desde `usados.fechadeingreso` de Oversoft (cuando entro al salon), no
// desde el alta como "a recibir". Mismo universo vendible que la solapa
// /usados: estado=Activado, fechadeventa null, recibida=true, alta <= 18 meses,
// sin ocultas ni vendidas de `portal_usados`.
//
// Un aviso por (usadoid, hito, destinatario): tabla `usados_avisos_dias`. Solo
// se manda el hito vigente (si arranca con un usado de 50 dias, avisa el de 45,
// no el de 30 y el de 45 juntos).
//
// Template: `control_automatico_resultado` (ya aprobado, 5 variables), asi no
// hay que esperar a Meta. Tope TOPE_CORRIDA mensajes por corrida: si se pasa no
// manda nada y lo dice en la respuesta (y el vigia control-whatsapp mira el resto).
//
// Modos: ?dry=1 · ?solo=549113... (ejemplo a ese numero) · ?forzar=1 (ignora lo
// ya avisado) · ?usadoid=1998
//
// pg_cron (job notify-usado-dias-stock): "5 13 * * 1-6" = 10:05 AR, lun a sab.
// Deployar con --no-verify-jwt.

const META_API_URL = "https://graph.facebook.com/v25.0";
const TEMPLATE = "control_automatico_resultado";
const PRIMER_HITO = 30;
const CADA = 15;
const TOPE_CORRIDA = 10;
const ANTIGUEDAD_MAX_MESES = 18;

const DESTINATARIOS = (Deno.env.get("USADO_DIAS_DESTINATARIOS") ?? "fngonzalez")
  .split(",").map((s) => s.trim()).filter(Boolean);

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { /* opcional */ }
  }
  const par = (k: string) => body[k] ?? url.searchParams.get(k);
  const flag = (k: string) => { const v = par(k); return v === true || v === "1" || v === "true"; };

  const env: Env = {
    SUPABASE_URL: Deno.env.get("SUPABASE_URL") ?? "",
    SERVICE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    OV_URL: (Deno.env.get("OVERSOFT_URL") ?? "").replace(/\/+$/, ""),
    OV_KEY: Deno.env.get("OVERSOFT_KEY") ?? "",
    WA_PHONE_ID: Deno.env.get("WA_TASADOR_PHONE_ID") ?? "",
    WA_TOKEN: Deno.env.get("WA_TASADOR_TOKEN") ?? "",
  };
  if (!env.SUPABASE_URL || !env.SERVICE_KEY || !env.OV_URL || !env.OV_KEY || !env.WA_PHONE_ID || !env.WA_TOKEN) {
    return json({ error: "faltan env vars" }, 500);
  }

  try {
    const solo = String(par("solo") ?? "").trim();
    if (solo) {
      const r = await enviar(env, solo.replace(/^\+/, "").replace(/[\s-]/g, ""), [
        "Fer", "usados en stock",
        "PRUEBA - VOLKSWAGEN TERA HIGH 170 TSI AT 2026 (AI321FO) cumplio 30 dias en el salon",
        "Precio $38.900.000 · toma $34.200.000 · margen 13,7% · entro el 26/10 · aviso a vendedores el 26/10 · 0 consultas de mejora de precio",
        "Revisemos el precio o que paso. Te vuelvo a avisar a los 45 dias si sigue sin venderse.",
      ]);
      return json({ prueba: true, ...r });
    }
    return json(await procesar(env, {
      dry: flag("dry"), forzar: flag("forzar"), usadoid: Number(par("usadoid")) || null,
    }));
  } catch (e) {
    console.error("notify-usado-dias-stock:", e);
    return json({ error: String(e) }, 500);
  }
});

type Env = { SUPABASE_URL: string; SERVICE_KEY: string; OV_URL: string; OV_KEY: string; WA_PHONE_ID: string; WA_TOKEN: string };

type OvsUsado = {
  usadoid: number; marca: string | null; modelo: string | null; anio: number | null;
  patente: string | null; preciodetoma: number | null; preciodeventa: number | null;
  fechadealta: string | null; fechadeingreso: string | null;
};

async function procesar(env: Env, opts: { dry: boolean; forzar: boolean; usadoid: number | null }) {
  const hoy = fechaAR(new Date());
  const corte = new Date();
  corte.setMonth(corte.getMonth() - ANTIGUEDAD_MAX_MESES);
  const corteAlta = corte.toISOString().slice(0, 10);

  const raw = await ov(env,
    "usados?select=usadoid,marca,modelo,anio,patente,preciodetoma,preciodeventa,fechadealta,fechadeingreso" +
    "&estado=eq.Activado&fechadeventa=is.null&recibida=is.true&limit=500" +
    (opts.usadoid ? `&usadoid=eq.${opts.usadoid}` : "")) as OvsUsado[];

  const conDias = raw
    .filter((u) => String(u.fechadealta ?? "").slice(0, 10) >= corteAlta && u.fechadeingreso)
    .map((u) => {
      const ingreso = String(u.fechadeingreso).slice(0, 10);
      const dias = diasEntre(ingreso, hoy);
      const hito = dias < PRIMER_HITO ? 0 : PRIMER_HITO + Math.floor((dias - PRIMER_HITO) / CADA) * CADA;
      return { u, ingreso, dias, hito };
    })
    .filter((x) => x.hito > 0);
  if (!conDias.length) return { ok: true, hoy, candidatos: 0, enviados: [] };

  const ids = conDias.map((x) => x.u.usadoid).join(",");
  const portal = await sb(env, `portal_usados?usadoid=in.(${ids})&select=usadoid,precio_venta,oculto,vendido,reservado`);
  const pm = new Map<number, Record<string, unknown>>(portal.map((p: Record<string, unknown>) => [Number(p.usadoid), p]));
  const consultas = await sb(env, `consultas_usados?usadoid=in.(${ids})&select=usadoid`);
  const nCons = new Map<number, number>();
  for (const c of consultas) nCons.set(Number(c.usadoid), (nCons.get(Number(c.usadoid)) ?? 0) + 1);
  const avisosVend = await sb(env, `usados_avisos_disponible?usadoid=in.(${ids})&estado=eq.enviado&select=usadoid,enviado_at&order=enviado_at`);
  const primerAviso = new Map<number, string>();
  for (const a of avisosVend) if (!primerAviso.has(Number(a.usadoid))) primerAviso.set(Number(a.usadoid), String(a.enviado_at).slice(0, 10));
  const hechos = opts.forzar ? [] : await sb(env, `usados_avisos_dias?usadoid=in.(${ids})&estado=eq.enviado&select=usadoid,hito,destinatario`);
  const ya = new Set(hechos.map((h: Record<string, unknown>) => `${h.usadoid}|${h.hito}|${h.destinatario}`));

  const usuarios = await padron(env);
  const cola: { x: typeof conDias[number]; dest: Usuario; vars: string[] }[] = [];
  for (const x of conDias) {
    const p = pm.get(x.u.usadoid) ?? {};
    if (p.oculto === true || p.vendido === true) continue;
    const precio = Number(p.precio_venta) > 0 ? Number(p.precio_venta) : Number(x.u.preciodeventa) || 0;
    const toma = Number(x.u.preciodetoma) || 0;
    const partes = [
      precio > 0 ? `Precio ${pesos(precio)}` : "SIN PRECIO",
      toma > 0 ? `toma ${pesos(toma)}` : "sin costo de toma en Oversoft",
    ];
    if (precio > 0 && toma > 0) partes.push(`margen ${(((precio - toma) / toma) * 100).toFixed(1).replace(".", ",")}%`);
    partes.push(`entro el ${ddmm(x.ingreso)}`);
    const av = primerAviso.get(x.u.usadoid);
    partes.push(av ? `aviso a vendedores el ${ddmm(av)}` : "nunca salio el aviso a vendedores (faltan fotos o precio)");
    partes.push(`${nCons.get(x.u.usadoid) ?? 0} consultas de mejora de precio`);
    if (p.reservado === true) partes.push("figura RESERVADO en la web");
    const proximo = x.hito + CADA;
    for (const dest of usuarios) {
      if (ya.has(`${x.u.usadoid}|${x.hito}|${dest.usuario}`)) continue;
      cola.push({ x, dest, vars: [
        primerNombre(dest.nombre), "usados en stock",
        `${descUnidad(x.u)} cumplio ${x.hito} dias en el salon (lleva ${x.dias})`,
        partes.join(" · "),
        `Revisemos el precio o que paso. Te vuelvo a avisar a los ${proximo} dias si sigue sin venderse.`,
      ] });
    }
  }

  if (opts.dry) return { ok: true, dry: true, hoy, enviaria: cola.map((c) => ({ usadoid: c.x.u.usadoid, hito: c.x.hito, para: c.dest.usuario, texto: c.vars.slice(2) })) };
  if (cola.length > TOPE_CORRIDA) return { ok: false, frenado: true, motivo: `tope ${TOPE_CORRIDA} superado`, a_mandar: cola.length };

  const enviados: unknown[] = [];
  const errores: unknown[] = [];
  for (const c of cola) {
    const r = await enviar(env, c.dest.telefono_wa, c.vars);
    const fila = {
      usadoid: c.x.u.usadoid, hito: c.x.hito, dias: c.x.dias, destinatario: c.dest.usuario,
      patente: String(c.x.u.patente ?? "").trim() || null, unidad: descUnidad(c.x.u),
      estado: r.ok ? "enviado" : "pendiente", enviado_at: r.ok ? new Date().toISOString() : null,
      meta_id: r.meta_id ?? null, error: r.ok ? null : JSON.stringify(r.error).slice(0, 500),
    };
    await sb(env, "usados_avisos_dias?on_conflict=usadoid,hito,destinatario", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(fila),
    });
    (r.ok ? enviados : errores).push({ usadoid: c.x.u.usadoid, hito: c.x.hito, para: c.dest.usuario, error: r.ok ? undefined : r.error });
  }
  return { ok: true, hoy, enviados, errores };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function descUnidad(u: OvsUsado) {
  const base = [String(u.marca ?? "").trim(), String(u.modelo ?? "").trim()].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const anio = u.anio ? String(u.anio) : "";
  const nombre = anio && !/\b(19|20)\d{2}\b/.test(base) ? `${base} ${anio}` : base;
  const pat = String(u.patente ?? "").trim();
  return pat ? `${nombre} (${pat})` : nombre;
}

const pesos = (n: number) => `$${Math.round(n).toLocaleString("es-AR")}`;
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const fechaAR = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
const primerNombre = (n: string) => (n || "").trim().split(/\s+/)[0] || "equipo";
const limpiar = (s: string) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{4,}/g, "   ").trim();

type Usuario = { usuario: string; nombre: string; telefono_wa: string };

async function padron(env: Env): Promise<Usuario[]> {
  const filas = await sb(env, `tasador_usuarios?usuario=in.(${DESTINATARIOS.map((u) => `"${u}"`).join(",")})&select=usuario,nombre,telefono_wa,activo`);
  return filas
    .filter((u: Record<string, unknown>) => u.activo !== false && u.telefono_wa)
    .map((u: Record<string, unknown>) => ({
      usuario: String(u.usuario), nombre: String(u.nombre || u.usuario),
      telefono_wa: String(u.telefono_wa).replace(/^\+/, "").replace(/[\s-]/g, ""),
    }));
}

async function enviar(env: Env, tel: string, vars: string[]) {
  try {
    const res = await fetch(`${META_API_URL}/${env.WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to: tel, type: "template",
        template: { name: TEMPLATE, language: { code: "es_AR" }, components: [{ type: "body", parameters: vars.map((t) => ({ type: "text", text: limpiar(t) })) }] },
      }),
    });
    const j = await res.json();
    if (res.ok && j.messages?.[0]) return { ok: true, meta_id: j.messages[0].id as string };
    return { ok: false, error: j.error || j };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// deno-lint-ignore no-explicit-any
async function sb(env: Env, path: string, options: RequestInit & { headers?: Record<string, string> } = {}): Promise<any[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: env.SERVICE_KEY, Authorization: `Bearer ${env.SERVICE_KEY}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : [];
}

// deno-lint-ignore no-explicit-any
async function ov(env: Env, path: string): Promise<any[]> {
  const res = await fetch(`${env.OV_URL}/${path}`, { headers: { apikey: env.OV_KEY, Authorization: `Bearer ${env.OV_KEY}` } });
  if (!res.ok) throw new Error(`Oversoft ${res.status}: ${await res.text()}`);
  return await res.json();
}

// deno-lint-ignore no-explicit-any
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
