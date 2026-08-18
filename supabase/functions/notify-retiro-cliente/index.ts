// Edge Function: notify-retiro-cliente
//
// A las 9 de la mañana le avisa por WhatsApp al vendedor que su cliente retiró
// la unidad el día anterior, con todo lo que necesita para llamarlo: quién es,
// qué se llevó, cuándo lo retiró, sus teléfonos y su mail. Pedido por Fer el
// 18/08/2026.
//
// De donde sale el dato (replica Oversoft, solo lectura):
//   - `unidades`   -> `entregada`, `fechasalida` (dia del retiro),
//                     `horaprogramada` (hora del turno), `patente`, `modelo`,
//                     `responsable` (quien firmo/retiro) y `preventa`.
//   - `preventas`  -> por `numero` = unidades.preventa: `vendedorid` y el CUIT
//                     del cliente.
//   - `clientes`   -> por `codigo` = ese CUIT: telefonos y email.
//   - `modelos`    -> traduce el codigo VW (AGDC8A MY26) a algo legible
//                     ("VW Amarok Highline V6 AT 4X4 G2 MY26").
//
// A quien le llega (decision de Fer, 18/08/2026): SOLO al vendedor de la PV.
//   - El vendedor sale de `pv_vendedores_map` (vendedorid -> usuario).
//   - Las ventas de "T.G." (vendedorid 22, sin vendedor propio) las sigue
//     Patricia Guajardo, que ademas es el destinatario de respaldo cuando el
//     vendedor no tiene WhatsApp cargado (env RETIRO_FALLBACK).
//
// Template Meta: `retiro_cliente_vendedor` (es_AR, UTILITY, 6 variables)
//   {{1}} destinatario · {{2}} cliente · {{3}} unidad · {{4}} cuando retiro ·
//   {{5}} vendedor · {{6}} contacto (telefonos + mail).
//
// Modos (query string o body JSON):
//   ?dry=1                 -> no manda ni escribe: devuelve que haria
//   ?solo=549113...        -> manda un ejemplo a ese numero (prueba)
//   ?dias=7                -> ventana de retiros hacia atras (default 7)
//   ?desde=2026-08-18      -> corte de arranque (default RETIRO_DESDE)
//   ?listar=1              -> lista los templates de la WABA
//   ?crear_template=1      -> da de alta el template en Meta (una sola vez)
//
// pg_cron: '0 12 * * *' = 9:00 hora AR, todos los dias. Los domingos y feriados
// no manda (se acumula y sale al siguiente dia habil).
//   SELECT cron.schedule(
//     'notify-retiro-cliente', '0 12 * * *',
//     $$ SELECT net.http_post(
//       url := 'https://wjfglsafgaltusmbnccl.supabase.co/functions/v1/notify-retiro-cliente',
//       headers := jsonb_build_object('Content-Type', 'application/json'),
//       body := '{}'::jsonb
//     ); $$
//   );

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "retiro_cliente_vendedor";
const WABA_ID_DEFAULT = "1183788370595856"; // WABA "Tito Gonzalez | Tasador"

const VENTANA_DIAS = Number(Deno.env.get("RETIRO_VENTANA_DIAS") ?? "7");
// Destinatario de respaldo: las ventas "T.G." y todo vendedor sin WhatsApp.
const FALLBACK = Deno.env.get("RETIRO_FALLBACK") ?? "patriciag";
// Arranque: no avisar retiros anteriores a esta fecha.
const DESDE = (Deno.env.get("RETIRO_DESDE") ?? "2026-08-18").slice(0, 10);

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

    const solo = String(par("solo") ?? "").trim();
    if (solo) return json(await pruebaDirigida(env, solo.replace(/^\+/, "").replace(/[\s-]/g, "")));

    return json(await procesar(env, {
      dry: flag("dry"),
      forzar: flag("forzar"),
      dias: Number(par("dias") ?? VENTANA_DIAS) || VENTANA_DIAS,
      desde: String(par("desde") ?? DESDE).slice(0, 10),
    }));
  } catch (e) {
    console.error("notify-retiro-cliente:", e);
    return json({ error: String(e) }, 500);
  }
});

type Env = {
  SUPABASE_URL: string; SERVICE_KEY: string;
  OV_URL: string; OV_KEY: string;
  WA_PHONE_ID: string; WA_TOKEN: string; WABA_ID: string;
};

type Unidad = {
  unidadid: number; modelo: string; patente: string; preventa: string;
  fechasalida: string; horaprogramada: string; responsable: string;
};

// ── Nucleo ──────────────────────────────────────────────────────────────────

async function procesar(env: Env, opts: { dry: boolean; forzar: boolean; dias: number; desde: string }) {
  const hoyAR = fechaAR(new Date());
  const feriados = await feriadosMap(env);

  // Domingos y feriados no se molesta: los retiros quedan pendientes y salen
  // en la corrida del siguiente dia habil.
  if (!opts.forzar && (diaSemana(hoyAR) === 0 || feriados.has(hoyAR))) {
    return { ok: true, hoy: hoyAR, enviados: 0, detalle: "domingo o feriado: no se avisa hoy" };
  }

  // Retiros del dia anterior para atras (los de hoy se avisan mañana).
  const desdeLectura = maxIso(isoMasDias(hoyAR, -Math.abs(opts.dias)), opts.desde);
  const unidades: Unidad[] = await ov(
    env,
    `unidades?entregada=eq.true&fechasalida=gte.${desdeLectura}&fechasalida=lt.${hoyAR}` +
    `&select=unidadid,modelo,patente,preventa,fechasalida,horaprogramada,responsable&order=fechasalida.asc&limit=500`,
  );
  if (!unidades.length) return { ok: true, hoy: hoyAR, desde: desdeLectura, retiros: 0, enviados: 0 };

  // Ya avisados (o descartados) en corridas anteriores.
  const previos = await sb(
    env,
    `retiros_avisos?unidadid=in.(${unidades.map((u) => u.unidadid).join(",")})&select=unidadid,estado`,
  );
  const yaHechos = new Set(previos.filter((p: { estado: string }) => p.estado !== "pendiente").map((p: { unidadid: number }) => Number(p.unidadid)));
  const pendientes = unidades.filter((u) => !yaHechos.has(Number(u.unidadid)));
  if (!pendientes.length) return { ok: true, hoy: hoyAR, retiros: unidades.length, nuevos: 0, enviados: 0 };

  // ── Enriquecer: PV -> vendedor y CUIT; CUIT -> contacto; codigo -> modelo ──
  const refs = [...new Set(pendientes.map((u) => u.preventa).filter(Boolean))];
  const pvs = await preventasDe(env, refs);
  const cuits = [...new Set([...pvs.values()].map((p) => p.cliente).filter(Boolean))];
  const clientes = await clientesDe(env, cuits);
  const modelos = await modelosDe(env, [...new Set(pendientes.map((u) => u.modelo).filter(Boolean))]);
  const padron = await padronUsuarios(env);

  const enviados: unknown[] = [];
  const errores: unknown[] = [];
  const sinDestino: unknown[] = [];

  for (const u of pendientes) {
    const pv = pvs.get(u.preventa);
    const cli = pv?.cliente ? clientes.get(pv.cliente) : undefined;
    const cliente = mejorNombre(u.responsable, cli?.nombre);
    const unidad = [modelos.get(u.modelo) || u.modelo, u.patente ? `(${u.patente})` : ""].filter(Boolean).join(" ");
    const cuando = cuandoRetiro(u.fechasalida, u.horaprogramada, hoyAR);
    const contacto = contactoDe(cli);
    const vendedorNombre = pv?.vendedor ?? "sin identificar";

    const dest = destinatario(padron, pv?.vendedorid ?? null);
    const fila: Record<string, unknown> = {
      unidadid: u.unidadid, preventa: u.preventa, patente: u.patente, modelo: u.modelo,
      modelo_desc: modelos.get(u.modelo) ?? null, cliente, cliente_cuit: pv?.cliente ?? null,
      cliente_tel: cli ? telefonos(cli).join(" / ") : null, cliente_mail: cli?.email ?? null,
      fecha_retiro: u.fechasalida.slice(0, 10), hora_retiro: (u.horaprogramada || "").trim() || null,
      vendedorid: pv?.vendedorid ?? null, vendedor_nombre: vendedorNombre,
      destinatario: dest?.usuario ?? null, destinatario_tel: dest?.telefono_wa ?? null,
    };

    if (opts.dry) {
      enviados.push({ ...fila, unidad, cuando, contacto, destinatario_nombre: dest?.nombre ?? "SIN DESTINATARIO" });
      continue;
    }

    if (!dest) {
      sinDestino.push({ preventa: u.preventa, vendedorid: pv?.vendedorid ?? null });
      await guardar(env, { ...fila, estado: "sin_destinatario" });
      continue;
    }

    const r = await enviarTemplate(env, dest.telefono_wa, [
      primerNombre(dest.nombre), cliente, unidad, cuando, vendedorNombre, contacto,
    ]);
    if (r.ok) {
      enviados.push({ preventa: u.preventa, cliente, para: dest.nombre });
      await guardar(env, { ...fila, estado: "enviado", enviado_at: new Date().toISOString(), meta_id: r.meta_id });
    } else {
      errores.push({ preventa: u.preventa, para: dest.nombre, error: r.error });
      await guardar(env, { ...fila, estado: "pendiente", error: JSON.stringify(r.error).slice(0, 500) });
    }
  }

  return {
    ok: true, hoy: hoyAR, dry: opts.dry, desde: desdeLectura,
    retiros: unidades.length, nuevos: pendientes.length,
    enviados, sin_destinatario: sinDestino, errores,
  };
}

const guardar = (env: Env, fila: Record<string, unknown>) =>
  sb(env, "retiros_avisos?on_conflict=unidadid", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(fila),
  });

// ── Textos ──────────────────────────────────────────────────────────────────

// "ayer martes 18/08 a las 11:00" / "el sábado 15/08 a las 09:30"
function cuandoRetiro(fechaSalida: string, horaProgramada: string, hoyAR: string) {
  const dia = fechaSalida.slice(0, 10);
  const ayer = dia === isoMasDias(hoyAR, -1);
  const hora = (horaProgramada || "").trim();
  const cuando = `${ayer ? "ayer" : "el"} ${DIAS[diaSemana(dia)]} ${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
  return hora ? `${cuando} a las ${hora}` : cuando;
}

type Cliente = {
  codigo: string; nombre: string; email: string;
  telefono: string; celular: string; telefonolaboral: string; celularlaboral: string;
};

// `unidades.responsable` (quien firmo el retiro) esta al dia pero el sistema lo
// corta a 25 caracteres; `clientes.nombre` viene entero pero puede haber quedado
// viejo (esa tabla no re-sincroniza ediciones). Si el de clientes continua al
// truncado, gana el entero; si son personas distintas, gana el de la unidad.
function mejorNombre(responsable?: string, enClientes?: string) {
  const r = (responsable ?? "").trim();
  const c = (enClientes ?? "").trim();
  if (!r) return c || "sin identificar";
  if (!c) return r;
  const norm = (s: string) => s.toUpperCase().replace(/\s+/g, " ");
  const mismoArranque = norm(c).startsWith(norm(r).slice(0, 20));
  return mismoArranque && c.length > r.length ? c : r;
}

// En Oversoft el telefono viene partido en "(caracteristica)numero", a veces con
// la caracteristica vacia, con 0 adelante o con el 15 del celular en el medio.
function normalizarTel(crudo: string) {
  let d = String(crudo ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (!d) return "";
  // Saca el 15 que se intercala entre caracteristica y numero (221 15 5079805).
  if (d.length === 12) {
    for (const largoCar of [2, 3, 4]) {
      if (d.slice(largoCar, largoCar + 2) === "15") {
        d = d.slice(0, largoCar) + d.slice(largoCar + 2);
        break;
      }
    }
  }
  // Formato viejo porteño sin caracteristica: 15-5716-0084 = 11 5716-0084.
  if (d.length === 10 && d.startsWith("15")) d = "11" + d.slice(2);
  return d;
}

// Solo separo cuando estoy seguro de donde termina la caracteristica (CABA/GBA).
// En el interior la caracteristica puede ser de 2, 3 o 4 digitos: cortar a ojo
// daria un numero mal escrito, asi que va entero.
function formatearTel(d: string) {
  if (d.length === 10 && d.startsWith("11")) return `11 ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

function telefonos(c?: Cliente) {
  if (!c) return [];
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const campo of ["celular", "telefono", "celularlaboral", "telefonolaboral"] as const) {
    const d = normalizarTel(c[campo]);
    // Los "(    )00000000" del sistema son relleno, no un telefono.
    if (!d || d.length < 6 || /^0+$/.test(d) || vistos.has(d)) continue;
    vistos.add(d);
    out.push(formatearTel(d));
  }
  return out;
}

function contactoDe(c?: Cliente) {
  const tels = telefonos(c);
  const partes: string[] = [];
  if (tels.length) partes.push(`Tel ${tels.join(" / ")}`);
  else partes.push("Tel: no figura en el sistema");
  partes.push(c?.email ? `Mail ${c.email.trim().toLowerCase()}` : "Mail: no figura");
  return partes.join(" · ");
}

// ── Datos ───────────────────────────────────────────────────────────────────

async function preventasDe(env: Env, refs: string[]) {
  const out = new Map<string, { vendedorid: number; vendedor: string; cliente: string }>();
  if (!refs.length) return out;
  // Las PVs pueden ser viejas (unidad pedida hace meses): ventana amplia.
  const pvs = await ov(env, `preventas?fecha=gte.2024-01-01&select=numero,vendedorid,cliente&limit=20000`);
  const vends = await ov(env, `vendedores?select=vendedorid,nombre&limit=1000`);
  const nombreVend = new Map<number, string>(vends.map((v: { vendedorid: number; nombre: string }) => [Number(v.vendedorid), String(v.nombre || "").trim()]));
  const buscados = new Set(refs);
  for (const p of pvs) {
    if (!buscados.has(p.numero)) continue;
    out.set(p.numero, {
      vendedorid: Number(p.vendedorid),
      vendedor: nombreVend.get(Number(p.vendedorid)) || `vendedor ${p.vendedorid}`,
      cliente: String(p.cliente || "").trim(),
    });
  }
  return out;
}

async function clientesDe(env: Env, cuits: string[]) {
  const out = new Map<string, Cliente>();
  if (!cuits.length) return out;
  const lista = cuits.map((c) => `"${c}"`).join(",");
  const filas = await ov(
    env,
    `clientes?codigo=in.(${encodeURIComponent(lista)})` +
    `&select=codigo,nombre,email,telefono,celular,telefonolaboral,celularlaboral&limit=500`,
  );
  for (const c of filas) out.set(String(c.codigo), c as Cliente);
  return out;
}

async function modelosDe(env: Env, codigos: string[]) {
  const out = new Map<string, string>();
  if (!codigos.length) return out;
  const lista = codigos.map((c) => `"${c}"`).join(",");
  const filas = await ov(
    env,
    `modelos?modelo=in.(${encodeURIComponent(lista)})&select=modelo,descripcionoperativa&limit=500`,
  );
  for (const m of filas) {
    const desc = String(m.descripcionoperativa || "").trim();
    if (desc) out.set(String(m.modelo), desc);
  }
  return out;
}

// ── Destinatario ────────────────────────────────────────────────────────────

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
  return { porUsuario, porVendedor };
}

function destinatario(
  padron: { porUsuario: Map<string, Usuario>; porVendedor: Map<number, string> },
  vendedorid: number | null,
) {
  if (vendedorid != null) {
    const usuario = padron.porVendedor.get(Number(vendedorid));
    const u = usuario ? padron.porUsuario.get(usuario) : undefined;
    if (u) return u;
  }
  return padron.porUsuario.get(FALLBACK); // Patricia Guajardo
}

// ── Calendario ──────────────────────────────────────────────────────────────

async function feriadosMap(env: Env) {
  const filas = await sb(env, `feriados_ar?select=fecha&limit=2000`);
  return new Set<string>(filas.map((f: { fecha: string }) => String(f.fecha).slice(0, 10)));
}

const diaSemana = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay();
const fechaAR = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const isoMasDias = (iso: string, dias: number) =>
  new Date(new Date(`${iso.slice(0, 10)}T12:00:00Z`).getTime() + dias * 86400_000).toISOString().slice(0, 10);
const maxIso = (a: string, b: string) => (a > b ? a : b);
const primerNombre = (n: string) => (n || "").trim().split(/\s+/)[0] || "equipo";

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
    "PRUEBA - Aguilera, Franco Agustín",
    "VW Amarok Highline V6 AT 4X4 G2 MY26 (AH515OR)",
    "ayer lunes 17/08 a las 11:00",
    "Julian Naddeo",
    "Tel 11 2158-1062 / 2473 40-1118 · Mail fgaguilera@gmail.com",
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
  const res = await fetch(`${META_API_URL}/${env.WABA_ID}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: TEMPLATE_NAME,
      language: META_LANGUAGE,
      category: "UTILITY",
      components: [
        { type: "HEADER", format: "TEXT", text: "Retiró un cliente tuyo" },
        {
          type: "BODY",
          text: "Hola {{1}}, retiró un cliente tuyo: {{2}}. Unidad: {{3}}. Retiró {{4}}. Vendedor: {{5}}. Para contactarlo: {{6}}. Llamalo para saber cómo fue la entrega y si necesita algo.",
          example: {
            body_text: [[
              "Julián",
              "Aguilera, Franco Agustín",
              "VW Amarok Highline V6 AT 4X4 G2 MY26 (AH515OR)",
              "ayer lunes 17/08 a las 11:00",
              "Julian Naddeo",
              "Tel 11 2158-1062 · Mail fgaguilera@gmail.com",
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
