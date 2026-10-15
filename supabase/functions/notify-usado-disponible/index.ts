// Edge Function: notify-usado-disponible
//
// Avisa por WhatsApp a los VENDEDORES que un usado quedo listo para vender:
// ya esta fisico, tiene precio de venta en el portal y tiene las fotos del
// concesionario cargadas. Si despues cambia el precio, vuelve a avisar con el
// precio nuevo (y el anterior). Pedido por Fer el 15/10/2026.
//
// Cuando sale:
//   - Oversoft (replica, SOLO LECTURA) `usados`: mismo universo vendible que la
//     solapa /usados (recibida=true, estado=Activado, fechadeventa null, alta
//     dentro de 18 meses) y que haya ingresado a partir de USADO_DISPONIBLE_DESDE.
//   - Precio = la misma cascada que el portal: `portal_usados.precio_venta`
//     (override) ?? `usados.preciodeventa` de Oversoft. En 0 = no sale.
//   - Fotos: al menos una en `portal_usados_fotos` (las del CONCESIONARIO). Las
//     de la tasacion no cuentan: decision de Fer 15/10/2026.
//   - Se saltean ocultas y marcadas vendido en `portal_usados`.
//
// A quien: USADO_DISPONIBLE_DESTINATARIOS (usuarios de tasador_usuarios,
// separados por coma). Lista de Fer 15/10/2026 = los 8 del default de abajo.
//
// Una sola vez por (usadoid, precio, destinatario): tabla
// `usados_avisos_disponible`. Mismo precio = nunca se repite; precio distinto =
// sale de nuevo como "cambio de precio".
//
// Tope: si una corrida tiene que mandar mas de TOPE_CORRIDA mensajes, NO manda
// nada y avisa a Fer y Matias (template control_automatico_resultado). Regla
// de Fer del 2/10/2026 despues de los ~4.000 avisos repetidos del CRM.
//
// Template Meta: `usado_disponible_venta` (es_AR, UTILITY, 4 variables)
//   {{1}} vendedor - {{2}} unidad + patente - {{3}} color/km/fotos - {{4}} precio
//
// Modos (query string o body JSON):
//   ?dry=1                 -> no manda ni escribe: devuelve que haria
//   ?solo=549113...        -> manda un ejemplo a ese numero (prueba)
//   ?usadoid=1996          -> procesa solo esa unidad
//   ?para=fngonzalez       -> manda solo a ese usuario (prueba real)
//   ?desde=2026-10-01      -> corte de arranque por fechadeingreso
//   ?listar=1              -> lista los templates de la WABA
//   ?crear_template=1      -> da de alta el template en Meta (una sola vez)
//
// pg_cron (job notify-usado-disponible): "20 12-22 * * 1-6" = cada hora a los
// :20, de 9:20 a 19:20 hora AR, lunes a sabado.
// Deployar con --no-verify-jwt (el pg_cron la llama sin header de auth).

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "usado_disponible_venta";
const WABA_ID_DEFAULT = "1183788370595856"; // WABA "Tito Gonzalez | Tasador"

const ANTIGUEDAD_MAX_MESES = 18;
const TOPE_CORRIDA = 40;
const ALERTA_ERRORES = ["fngonzalez", "mlubrano"];

const DESTINATARIOS = (Deno.env.get("USADO_DISPONIBLE_DESTINATARIOS") ??
  "ialonso,tbandiera,jcastro,gbuena,aloisi,mcastro,jnaddeo,dlopez")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Arranque: no avisar unidades que entraron antes (no mandar el stock viejo).
const DESDE = (Deno.env.get("USADO_DISPONIBLE_DESDE") ?? "2026-10-01").slice(0, 10);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-stock-secret",
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
      desde: String(par("desde") ?? DESDE).slice(0, 10),
      usadoid: Number(par("usadoid")) || null,
      para: String(par("para") ?? "").trim() || null,
    }));
  } catch (e) {
    console.error("notify-usado-disponible:", e);
    return json({ error: String(e) }, 500);
  }
});

type Env = {
  SUPABASE_URL: string; SERVICE_KEY: string;
  OV_URL: string; OV_KEY: string;
  WA_PHONE_ID: string; WA_TOKEN: string; WABA_ID: string;
};

type OvsUsado = {
  usadoid: number;
  marca: string | null; modelo: string | null; anio: number | null;
  km: number | null; color: string | null; patente: string | null;
  preciodeventa: number | null;
  fechadealta: string | null; fechadeingreso: string | null;
};

type Envio = {
  u: OvsUsado; dest: Usuario; precio: number; anterior: number | null;
  unidad: string; detalle: string; textoPrecio: string;
};

// ── Proceso ─────────────────────────────────────────────────────────────────

async function procesar(
  env: Env,
  opts: { dry: boolean; desde: string; usadoid: number | null; para: string | null },
) {
  const corte = new Date();
  corte.setMonth(corte.getMonth() - ANTIGUEDAD_MAX_MESES);
  const corteAlta = corte.toISOString().slice(0, 10);

  const raw = await ov(
    env,
    "usados?select=usadoid,marca,modelo,anio,km,color,patente,preciodeventa,fechadealta,fechadeingreso" +
      "&estado=eq.Activado&fechadeventa=is.null&recibida=is.true&order=fechadeingreso.desc&limit=500" +
      (opts.usadoid ? `&usadoid=eq.${opts.usadoid}` : ""),
  ) as OvsUsado[];

  const fisicas = raw.filter((u) => {
    const alta = String(u.fechadealta ?? "").slice(0, 10);
    if (!alta || alta < corteAlta) return false;
    const ingreso = String(u.fechadeingreso ?? u.fechadealta ?? "").slice(0, 10);
    return !!ingreso && ingreso >= opts.desde;
  });
  if (!fisicas.length) return { ok: true, fisicas: 0, listas: 0, enviados: [] };

  const listaIds = fisicas.map((u) => u.usadoid).join(",");

  // Fotos del concesionario (cantidad por unidad).
  const fotos = await sb(env, `portal_usados_fotos?usadoid=in.(${listaIds})&select=usadoid`);
  const nFotos = new Map<number, number>();
  for (const f of fotos as { usadoid: number }[]) {
    nFotos.set(Number(f.usadoid), (nFotos.get(Number(f.usadoid)) ?? 0) + 1);
  }

  // Override de precio + ocultas/vendidas.
  const portal = await sb(env, `portal_usados?usadoid=in.(${listaIds})&select=usadoid,precio_venta,oculto,vendido`);
  const pm = new Map<number, { precio_venta: number | null; oculto: boolean; vendido: boolean }>();
  for (const p of portal) pm.set(Number(p.usadoid), p);

  const listas = fisicas.map((u) => {
    const p = pm.get(u.usadoid);
    const override = Number(p?.precio_venta) || 0;
    const precio = override > 0 ? override : Number(u.preciodeventa) || 0;
    return { u, p, precio, fotos: nFotos.get(u.usadoid) ?? 0 };
  }).filter((x) => x.precio > 0 && x.fotos > 0 && x.p?.oculto !== true && x.p?.vendido !== true);

  if (!listas.length) return { ok: true, fisicas: fisicas.length, listas: 0, enviados: [] };

  // Historial de lo ya mandado (para no repetir y para saber el precio anterior).
  const hist = await sb(
    env,
    `usados_avisos_disponible?usadoid=in.(${listas.map((x) => x.u.usadoid).join(",")})&estado=eq.enviado` +
      `&select=usadoid,precio,destinatario,enviado_at&order=enviado_at.desc&limit=1000`,
  ) as { usadoid: number; precio: number; destinatario: string }[];
  const yaMandado = new Set(hist.map((h) => `${h.usadoid}|${Number(h.precio)}|${h.destinatario}`));
  const ultimoPrecio = new Map<string, number>(); // usadoid|destinatario -> ultimo precio avisado
  for (const h of hist) {
    const k = `${h.usadoid}|${h.destinatario}`;
    if (!ultimoPrecio.has(k)) ultimoPrecio.set(k, Number(h.precio));
  }

  let usuarios = await padronUsuarios(env, opts.para ? [opts.para] : DESTINATARIOS);
  if (opts.para) usuarios = usuarios.filter((x) => x.usuario === opts.para);
  const tas = await tasacionesDe(env, listas.map((x) => String(x.u.patente ?? "").trim()).filter(Boolean));

  const cola: Envio[] = [];
  for (const x of listas) {
    const t = tas.get(normPat(x.u.patente));
    const unidad = descUnidad(x.u);
    const detalle = descDetalle(x.u, t, x.fotos);
    for (const dest of usuarios) {
      if (yaMandado.has(`${x.u.usadoid}|${x.precio}|${dest.usuario}`)) continue;
      const anterior = ultimoPrecio.get(`${x.u.usadoid}|${dest.usuario}`) ?? null;
      const textoPrecio = anterior
        ? `Cambió el precio de venta: ahora ${pesos(x.precio)} (antes ${pesos(anterior)})`
        : `Precio de venta ${pesos(x.precio)}`;
      cola.push({ u: x.u, dest, precio: x.precio, anterior, unidad, detalle, textoPrecio });
    }
  }

  if (opts.dry) {
    return {
      ok: true, dry: true, fisicas: fisicas.length, listas: listas.length,
      destinatarios: usuarios.map((u) => u.usuario),
      enviaria: cola.map((c) => ({
        usadoid: c.u.usadoid, para: c.dest.usuario, unidad: c.unidad, detalle: c.detalle, precio: c.textoPrecio,
      })),
    };
  }

  if (cola.length > TOPE_CORRIDA) {
    const alerta = await alertarTope(env, cola.length);
    return { ok: false, frenado: true, motivo: `tope ${TOPE_CORRIDA} superado`, a_mandar: cola.length, alerta };
  }

  const enviados: unknown[] = [];
  const errores: unknown[] = [];
  for (const c of cola) {
    const fila: Record<string, unknown> = {
      usadoid: c.u.usadoid, precio: c.precio, precio_anterior: c.anterior,
      tipo: c.anterior ? "cambio_precio" : "disponible",
      destinatario: c.dest.usuario, destinatario_tel: c.dest.telefono_wa,
      patente: String(c.u.patente ?? "").trim() || null, unidad: c.unidad,
    };
    const r = await enviarTemplate(env, c.dest.telefono_wa, [
      primerNombre(c.dest.nombre), c.unidad, c.detalle, c.textoPrecio,
    ]);
    if (r.ok) {
      enviados.push({ usadoid: c.u.usadoid, para: c.dest.nombre, tipo: fila.tipo });
      await guardar(env, { ...fila, estado: "enviado", enviado_at: new Date().toISOString(), meta_id: r.meta_id, error: null });
    } else {
      errores.push({ usadoid: c.u.usadoid, para: c.dest.nombre, error: r.error });
      await guardar(env, { ...fila, estado: "pendiente", error: JSON.stringify(r.error).slice(0, 500) });
    }
  }

  return {
    ok: true, fisicas: fisicas.length, listas: listas.length,
    destinatarios: usuarios.map((u) => u.usuario), enviados, errores,
  };
}

const guardar = (env: Env, fila: Record<string, unknown>) =>
  sb(env, "usados_avisos_disponible?on_conflict=usadoid,precio,destinatario", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(fila),
  });

async function alertarTope(env: Env, cantidad: number) {
  const usuarios = await padronUsuarios(env, ALERTA_ERRORES);
  const out: unknown[] = [];
  for (const u of usuarios) {
    const res = await fetch(`${META_API_URL}/${env.WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to: u.telefono_wa, type: "template",
        template: {
          name: "control_automatico_resultado", language: { code: META_LANGUAGE },
          components: [{
            type: "body",
            parameters: [
              primerNombre(u.nombre),
              "aviso de usados disponibles a vendedores",
              `la corrida tenía que mandar ${cantidad} mensajes y el tope es ${TOPE_CORRIDA}`,
              "no se mandó ninguno",
              "revisar notify-usado-disponible y la tabla usados_avisos_disponible antes de volver a correrlo",
            ].map((text) => ({ type: "text", text: limpiar(text) })),
          }],
        },
      }),
    });
    out.push({ para: u.usuario, ok: res.ok });
  }
  return out;
}

// ── Textos ──────────────────────────────────────────────────────────────────

// Mismo criterio que tituloUsado() del portal: el anio solo si no viene en el modelo.
function descUnidad(u: OvsUsado) {
  const base = [String(u.marca ?? "").trim(), String(u.modelo ?? "").trim()]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const anio = u.anio ? String(u.anio) : "";
  const nombre = anio && !/\b(19|20)\d{2}\b/.test(base) ? `${base} ${anio}` : base;
  const pat = String(u.patente ?? "").trim();
  return pat ? `${nombre} (${pat})` : nombre || "usado sin identificar";
}

function descDetalle(u: OvsUsado, t: TasRow | undefined, fotos: number) {
  const partes: string[] = [];
  const color = String(t?.color ?? u.color ?? "").trim();
  if (color) partes.push(color);
  const km = t?.kilometros != null && t.kilometros > 0 ? t.kilometros : Number(u.km) || 0;
  if (km > 0) partes.push(`${km.toLocaleString("es-AR")} km`);
  partes.push(`${fotos} ${fotos === 1 ? "foto" : "fotos"} del concesionario`);
  return partes.join(" - ");
}

const pesos = (n: number) => `$${Math.round(n).toLocaleString("es-AR")}`;
const primerNombre = (n: string) => (n || "").trim().split(/\s+/)[0] || "equipo";
const normPat = (s: string | null | undefined) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ── Datos auxiliares ────────────────────────────────────────────────────────

type TasRow = { patente: string | null; color: string | null; kilometros: number | null };

async function tasacionesDe(env: Env, patentes: string[]) {
  const m = new Map<string, TasRow>();
  if (!patentes.length) return m;
  const lista = patentes.map((p) => `"${p}"`).join(",");
  const filas = await sb(
    env,
    `tasaciones?patente=in.(${encodeURIComponent(lista)})&select=patente,color,kilometros,created_at&order=created_at.desc&limit=500`,
  );
  for (const r of filas as TasRow[]) {
    const k = normPat(r.patente);
    if (!k || m.has(k)) continue;
    m.set(k, r);
  }
  return m;
}

type Usuario = { usuario: string; nombre: string; telefono_wa: string };

async function padronUsuarios(env: Env, quienes: string[]): Promise<Usuario[]> {
  const lista = quienes.map((u) => `"${u}"`).join(",");
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
  out.sort((a, b) => quienes.indexOf(a.usuario) - quienes.indexOf(b.usuario));
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

const limpiar = (s: string) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{4,}/g, "   ").trim();

const EJEMPLO = [
  "Fer",
  "VOLKSWAGEN AMAROK HIGHLINE 4X2 MT 2019 (AD763ER)",
  "plata - 42.671 km - 8 fotos del concesionario",
  "Precio de venta $36.900.000",
];

async function pruebaDirigida(env: Env, tel: string) {
  const r = await enviarTemplate(env, tel, [EJEMPLO[0], `PRUEBA - ${EJEMPLO[1]}`, EJEMPLO[2], EJEMPLO[3]]);
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

// Redaccion calcada de los UTILITY que ya andan: un registro propio concreto y
// que hacer con el. Nada de "nuevo", "novedad" ni "llego".
async function crearTemplate(env: Env) {
  const res = await fetch(`${META_API_URL}/${env.WABA_ID}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: TEMPLATE_NAME,
      language: META_LANGUAGE,
      category: "UTILITY",
      components: [
        { type: "HEADER", format: "TEXT", text: "Usado listo para la venta" },
        {
          type: "BODY",
          text: "Hola {{1}}, el usado {{2}} ya está en el concesionario con fotos y precio cargados en el portal: {{3}}. {{4}}. Lo podés ver y presupuestar desde la solapa Usados de precios.titogonzalez.online.",
          example: { body_text: [EJEMPLO] },
        },
        { type: "FOOTER", text: "Aviso automático · Tito Gonzalez" },
      ],
    }),
  });
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
