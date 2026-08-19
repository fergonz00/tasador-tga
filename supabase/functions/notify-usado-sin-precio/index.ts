// Edge Function: notify-usado-sin-precio
//
// Cuando un usado que se tomo como parte de pago ya entro fisicamente al
// concesionario y NO tiene precio de venta cargado en Oversoft, le avisa por
// WhatsApp a Fer (solo a el). El aviso se repite UNA VEZ POR DIA mientras la
// unidad siga fisica y sin precio; el dia que se lo cargan en el sistema, deja
// de salir solo. Pedido por Fer el 19/08/2026.
//
// Hermano de `notify-usado-fisico` (ese pide las fotos, este pide el precio).
// Mismo universo de unidades, misma cadencia, distinto corte y distinto
// destinatario.
//
// De donde sale el dato:
//   - Oversoft (replica, SOLO LECTURA) `usados`: `recibida=true` = ya esta
//     fisica (y `fechadeingreso` es el dia que entro). `preciodeventa` es el
//     precio que carga la administracion en el sistema: 0 o null = falta.
//     `preventaorigen` dice de que PV vino cuando se tomo como parte de pago.
//     Se mira el mismo universo vendible que la solapa /usados del portal:
//     estado=Activado, fechadeventa null y alta dentro de los ultimos 18 meses
//     (corta la chatarra historica de 2009-2024).
//   - wjfgl `portal_usados`: se saltean las ocultas y las marcadas vendido (no
//     se van a publicar, no hace falta ponerles precio).
//   - wjfgl `tasaciones` (por patente): km real y color cuando Oversoft no los
//     trae.
//
// OJO: el corte es el precio de OVERSOFT, no el override de `portal_usados`.
// Es a proposito: el pedido es que el precio quede cargado en el sistema, que
// es de donde lo toman la administracion y el resto de los circuitos.
//
// A quien le llega: solo `fngonzalez` (Fer), via tasador_usuarios (respeta
// activo / notificaciones_wa). Se puede cambiar sin tocar codigo con el env
// USADO_PRECIO_DESTINATARIOS (usuarios separados por coma).
//
// Template Meta: `usado_sin_precio_venta` (es_AR, UTILITY, 4 variables)
//   {{1}} destinatario - {{2}} unidad + patente - {{3}} detalle (color/km/toma)
//   {{4}} cuando ingreso + hace cuanto.
//
// Control de duplicados: tabla `usados_avisos_precio` en wjfgl, unica por
// (usadoid, fecha, destinatario). Si el envio falla queda `pendiente` y se
// reintenta en la proxima corrida.
//
// Modos (query string o body JSON):
//   ?dry=1                 -> no manda ni escribe: devuelve que haria
//   ?solo=549113...        -> manda un ejemplo a ese numero (prueba)
//   ?forzar=1              -> ignora lo ya avisado hoy (para probar de nuevo)
//   ?desde=2026-08-01      -> corte de arranque por fechadeingreso
//   ?meses=250             -> ensancha la ventana de antiguedad (solo pruebas)
//   ?listar=1              -> lista los templates de la WABA
//   ?crear_template=1      -> da de alta el template en Meta (una sola vez)
//
// pg_cron (job notify-usado-sin-precio): "0 14 * * 1-6" = 11:00 hora AR, de
// lunes a sabado. Domingo no manda: el salon esta cerrado.

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "usado_sin_precio_venta";
const WABA_ID_DEFAULT = "1183788370595856"; // WABA "Tito Gonzalez | Tasador"

// Mismo criterio que la solapa /usados del portal: mas viejo que esto es stock
// trabado, no algo a lo que haya que ponerle precio.
const ANTIGUEDAD_MAX_MESES = 18;

const DESTINATARIOS = (Deno.env.get("USADO_PRECIO_DESTINATARIOS") ?? "fngonzalez")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Arranque: no avisar unidades que entraron antes de esta fecha.
const DESDE = (Deno.env.get("USADO_PRECIO_DESDE") ?? "2026-08-01").slice(0, 10);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-stock-secret",
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
      forzar: flag("forzar"),
      desde: String(par("desde") ?? DESDE).slice(0, 10),
      meses: Number(par("meses")) > 0 ? Number(par("meses")) : ANTIGUEDAD_MAX_MESES,
    }));
  } catch (e) {
    console.error("notify-usado-sin-precio:", e);
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
  preciodetoma: number | null; preciodeventa: number | null;
  preventaorigen: string | null;
  fechadealta: string | null; fechadeingreso: string | null;
  recibida: boolean | null; enreparacion: boolean | null;
};

// ── Proceso ─────────────────────────────────────────────────────────────────

async function procesar(env: Env, opts: { dry: boolean; forzar: boolean; desde: string; meses: number }) {
  const hoyAR = fechaAR(new Date());

  // 1) Universo vendible en Oversoft, igual que la solapa /usados.
  const corte = new Date();
  corte.setMonth(corte.getMonth() - opts.meses);
  const corteAlta = corte.toISOString().slice(0, 10);

  const raw = await ov(
    env,
    "usados?select=usadoid,marca,modelo,anio,km,color,patente,preciodetoma,preciodeventa,preventaorigen," +
      "fechadealta,fechadeingreso,recibida,enreparacion" +
      "&estado=eq.Activado&fechadeventa=is.null&recibida=is.true&order=fechadeingreso.desc&limit=500",
  ) as OvsUsado[];

  // Ya fisicas, dentro de la ventana de antiguedad y que entraron a partir del
  // corte. Sin fechadeingreso no podemos fechar el ingreso: cae a la de alta.
  const fisicas = raw.filter((u) => {
    const alta = String(u.fechadealta ?? "").slice(0, 10);
    if (!alta || alta < corteAlta) return false;
    const ingreso = ingresoDe(u);
    return !!ingreso && ingreso >= opts.desde;
  });
  if (!fisicas.length) return { ok: true, hoy: hoyAR, fisicas: 0, sin_precio: 0, enviados: [] };

  // 2) El corte: precio de venta cargado en Oversoft = no se avisa mas.
  const sinPrecio = fisicas.filter((u) => !(Number(u.preciodeventa) > 0));
  if (!sinPrecio.length) {
    return { ok: true, hoy: hoyAR, fisicas: fisicas.length, sin_precio: 0, enviados: [] };
  }

  const ids = sinPrecio.map((u) => u.usadoid);
  const listaIds = ids.join(",");

  // 3) Ocultas / marcadas vendido: no se van a publicar, no hace falta precio.
  const portal = await sb(env, `portal_usados?usadoid=in.(${listaIds})&select=usadoid,oculto,vendido`);
  const fuera = new Set<number>(
    portal.filter((p: { oculto: boolean; vendido: boolean }) => p.oculto === true || p.vendido === true)
      .map((p: { usadoid: number }) => Number(p.usadoid)),
  );

  const pendientes = sinPrecio.filter((u) => !fuera.has(u.usadoid));
  if (!pendientes.length) {
    return { ok: true, hoy: hoyAR, fisicas: fisicas.length, sin_precio: 0, enviados: [] };
  }

  // 4) Enriquecer con el tasador (km/color reales cuando Oversoft no los trae).
  const tas = await tasacionesDe(env, pendientes.map((u) => String(u.patente ?? "").trim()).filter(Boolean));

  // 5) Destinatarios + lo que ya se aviso hoy.
  const usuarios = await padronUsuarios(env);
  const yaHoy = opts.forzar ? new Set<string>() : await avisadosHoy(env, ids, hoyAR);

  const enviados: unknown[] = [];
  const errores: unknown[] = [];
  const omitidos: unknown[] = [];

  for (const u of pendientes) {
    const t = tas.get(normPat(u.patente));
    const unidad = descUnidad(u);
    const detalle = descDetalle(u, t);
    const ingreso = ingresoDe(u)!;
    const cuando = cuandoIngreso(ingreso, hoyAR);
    const dias = diasEntre(ingreso, hoyAR);

    for (const dest of usuarios) {
      const clave = `${u.usadoid}|${dest.usuario}`;
      if (yaHoy.has(clave)) {
        omitidos.push({ usadoid: u.usadoid, para: dest.usuario, motivo: "ya avisado hoy" });
        continue;
      }

      const fila: Record<string, unknown> = {
        usadoid: u.usadoid, fecha: hoyAR, destinatario: dest.usuario, destinatario_tel: dest.telefono_wa,
        patente: String(u.patente ?? "").trim() || null, modelo: String(u.modelo ?? "").trim() || null,
        unidad, fecha_ingreso: ingreso, dias_fisico: dias,
        preventa_origen: String(u.preventaorigen ?? "").trim() || null,
        costo_toma: Number(u.preciodetoma) > 0 ? Number(u.preciodetoma) : null,
      };

      if (opts.dry) {
        enviados.push({ ...fila, detalle, cuando, destinatario_nombre: dest.nombre });
        continue;
      }

      const r = await enviarTemplate(env, dest.telefono_wa, [
        primerNombre(dest.nombre), unidad, detalle, cuando,
      ]);
      if (r.ok) {
        enviados.push({ usadoid: u.usadoid, unidad, para: dest.nombre, dias_fisico: dias });
        await guardar(env, {
          ...fila, estado: "enviado", enviado_at: new Date().toISOString(), meta_id: r.meta_id, error: null,
        });
      } else {
        errores.push({ usadoid: u.usadoid, para: dest.nombre, error: r.error });
        await guardar(env, { ...fila, estado: "pendiente", error: JSON.stringify(r.error).slice(0, 500) });
      }
    }
  }

  return {
    ok: true, hoy: hoyAR, dry: opts.dry, desde: opts.desde,
    fisicas: fisicas.length, sin_precio: pendientes.length,
    destinatarios: usuarios.map((u) => u.usuario),
    enviados, omitidos, errores,
  };
}

const guardar = (env: Env, fila: Record<string, unknown>) =>
  sb(env, "usados_avisos_precio?on_conflict=usadoid,fecha,destinatario", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(fila),
  });

/** Claves usadoid|destinatario que ya salieron hoy (solo cuentan los enviados). */
async function avisadosHoy(env: Env, ids: number[], hoyAR: string) {
  const filas = await sb(
    env,
    `usados_avisos_precio?fecha=eq.${hoyAR}&estado=eq.enviado&usadoid=in.(${ids.join(",")})&select=usadoid,destinatario`,
  );
  return new Set<string>(
    filas.map((f: { usadoid: number; destinatario: string }) => `${f.usadoid}|${f.destinatario}`),
  );
}

// ── Textos ──────────────────────────────────────────────────────────────────

// Oversoft ya trae la version dentro de `modelo` ("CROSSFOX 1.6 MSI 16V 2016"),
// asi que el anio se agrega solo si no viene ya en el texto (mismo criterio que
// tituloUsado() en portal-precios).
function descUnidad(u: OvsUsado) {
  const base = [String(u.marca ?? "").trim(), String(u.modelo ?? "").trim()]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const anio = u.anio ? String(u.anio) : "";
  const nombre = anio && !/\b(19|20)\d{2}\b/.test(base) ? `${base} ${anio}` : base;
  const pat = String(u.patente ?? "").trim();
  return pat ? `${nombre} (${pat})` : nombre || "usado sin identificar";
}

function descDetalle(u: OvsUsado, t?: TasRow) {
  const partes: string[] = [];
  const color = String(t?.color ?? u.color ?? "").trim();
  partes.push(color || "color sin cargar");
  const km = t?.kilometros != null && t.kilometros > 0 ? t.kilometros : Number(u.km) || 0;
  partes.push(km > 0 ? `${km.toLocaleString("es-AR")} km` : "km sin cargar");
  const toma = Number(u.preciodetoma) || 0;
  partes.push(toma > 0 ? `se tomo a $${toma.toLocaleString("es-AR")}` : "sin costo de toma cargado");
  const pv = String(u.preventaorigen ?? "").trim();
  if (pv) partes.push(`vino de la ${pv}`);
  if (u.enreparacion === true) partes.push("esta en preparacion en el taller");
  return partes.join(" - ");
}

// "ingresó ayer lunes 17/08" / "ingresó el miércoles 05/08, hace 13 días"
function cuandoIngreso(ingreso: string, hoyAR: string) {
  const dias = diasEntre(ingreso, hoyAR);
  const etiqueta = `${DIAS[diaSemana(ingreso)]} ${ingreso.slice(8, 10)}/${ingreso.slice(5, 7)}`;
  if (dias <= 0) return `ingresó hoy ${etiqueta}`;
  if (dias === 1) return `ingresó ayer ${etiqueta}`;
  return `ingresó el ${etiqueta}, hace ${dias} días`;
}

const ingresoDe = (u: OvsUsado) =>
  String(u.fechadeingreso ?? u.fechadealta ?? "").slice(0, 10) || null;

const diaSemana = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay();
const fechaAR = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const diasEntre = (desde: string, hasta: string) => Math.round(
  (Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86400_000,
);
const primerNombre = (n: string) => (n || "").trim().split(/\s+/)[0] || "equipo";
const normPat = (s: string | null | undefined) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ── Datos auxiliares ────────────────────────────────────────────────────────

type TasRow = { patente: string | null; color: string | null; kilometros: number | null };

/** Tasacion por patente normalizada; la mas reciente gana si hay varias. */
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
  // Orden estable segun como estan listados en el env.
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
    "PRUEBA - VOLKSWAGEN CROSSFOX 1.6 MSI 16V 2016 (AA374IG)",
    "Gris - 118.000 km - se tomo a $12.500.000 - vino de la PV 08083/1",
    "ingresó el miércoles 05/08, hace 14 días",
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
        { type: "HEADER", format: "TEXT", text: "Falta el precio de venta de un usado" },
        {
          type: "BODY",
          text: "Hola {{1}}, el usado {{2}} ya está físico en el concesionario y todavía no tiene precio de venta cargado en el sistema. {{3}}. {{4}}. Sin precio no se puede publicar ni presupuestar. Este aviso se repite todos los días hasta que esté cargado.",
          example: {
            body_text: [[
              "Fer",
              "VOLKSWAGEN CROSSFOX 1.6 MSI 16V 2016 (AA374IG)",
              "Gris - 118.000 km - se tomo a $12.500.000 - vino de la PV 08083/1",
              "ingresó el miércoles 05/08, hace 14 días",
            ]],
          },
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
