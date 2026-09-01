// Edge Function: notify-marketshell
//
// Aviso DIARIO por WhatsApp cuando el feed de MarketShell (Shell) no esta ok.
// Pedido de Fer, 1-sep-2026: "avisame a mi, a Ines Alonso y a Nadia una vez por
// dia si hay algo que no esta ok".
//
// Que mira — DOS COSAS, desde el 01/09/2026:
//   1. La planilla de Grupo Simpli ("Copia de Shell2"), via el Apps Script del
//      feed en `?modo=chequeo` (marketshell-feed/live/Chequeo.js). Eso detecta
//      lo que rompe la importacion (precio vacio, #ERROR!, feed frenado).
//   2. ⭐ LO QUE SHELL REALMENTE PUBLICA. `marketshell.shell.com.ar` es una app
//      SvelteKit que trae los autos ya renderizados en el HTML (el array `cars`
//      con `name` / `unified_amount` / `stock`). Se compara auto por auto contra
//      el catalogo que manda la planilla.
//
//      ⚠️ ESA LECTURA NO LA PUEDE HACER ESTA FUNCION. El portal contesta **429 a
//      toda IP de datacenter** — probado desde Supabase Y desde Google (Apps
//      Script); solo pasan las IP de oficina. Por eso la corre
//      `marketshell-feed/chequeo_portal.py` en la PC de Fer (tarea programada,
//      igual que scraper-autoahorro) y le POSTea el resultado a esta funcion en
//      `problemas`. La funcion igual intenta leerlo sola: si algun dia Shell
//      deja de bloquear, empieza a andar sin tocar nada.
//
// ⭐ EL PUNTO 2 ES EL QUE IMPORTA, y se agrego despues de tropezar: el 01/09 la
// planilla estaba perfecta y el portal publicaba precios de marzo. Un control que
// solo mira nuestra planilla habria dicho "todo ok" todos esos dias. Si alguna vez
// hay que elegir, el que no se puede perder es el del portal.
//
// (Un primer intento de leer el portal dio HTTP 429 y se concluyo que estaba
// bloqueado. Era transitorio: con headers de navegador devuelve 200. No volver a
// darlo por imposible sin reintentar.)
//
// Cadencia: pg_cron `0 12 * * *` = 9:00 AR, TODOS los dias. Si esta todo ok NO
// manda nada (silencio = todo bien). Una fila por dia en `marketshell_avisos`
// hace que no se repita aunque el cron corra dos veces.
//
// ⚠️ Si el chequeo NO se puede correr (Apps Script caido, token vencido, red),
// eso TAMBIEN se avisa. Si no, un chequeo roto se veria igual que "todo bien".
//
// Destinatarios: usuarios de `tasador_usuarios` cuyo `usuario` este en
// MARKETSHELL_DESTINATARIOS (default fngonzalez,nvera), activos y con
// telefono_wa. Dedup por telefono (Nadia tiene dos cuentas con el mismo numero).
//
// Probar sin mandar nada:
//   POST {"dry":true}                      -> corre el chequeo y muestra a quien le mandaria
//   POST {"dry":true,"simular":true}       -> ademas inventa problemas, para ver el texto
//   POST {"solo":"5491156559854"}          -> manda solo a ese numero
//   POST {"forzar":true}                   -> ignora la fila del dia (reenvia)
//   POST {"listar":true}                   -> estado del template en Meta
//   POST {"crear_template":true}           -> alta del template (una sola vez)
//   POST {"origen":"local","publicados":36,"problemas":[...]}  -> lo que manda
//        chequeo_portal.py desde la PC de Fer

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const WABA_ID = Deno.env.get("WA_TASADOR_WABA_ID") ?? "1183788370595856";

const TEMPLATE_NAME = "marketshell_feed_alerta";
// ⚠️ Sin fallback a proposito (misma decision que notify-feed): el unico
// template de 1 parametro aprobado (`precios_actualizados`) cierra con "Se
// actualizaron los valores en el portal de Tito Gonzalez", o sea que avisaria de
// un cambio de precios que no paso. Preferible que no salga el aviso y quede el
// error registrado en `marketshell_avisos` a que salga diciendo otra cosa.

// Fer + Nadia Vera. Ines Alonso salio el 01/09/2026 por pedido de Fer.
const DESTINATARIOS_DEFAULT = "fngonzalez,nvera";

// Cuantos problemas entran en el parametro {{3}}. Meta corta el body largo y
// el detalle completo esta en la planilla igual.
const MAX_DETALLE = 6;

// Horas sin que nadie verifique lo publicado a partir de las cuales se avisa.
// 30 h = un dia con margen, para que un atraso del cron no dispare en falso.
const MAX_HORAS_PORTAL = Number(Deno.env.get("MARKETSHELL_MAX_HORAS_PORTAL") ?? 30);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info, x-stock-secret",
};

type Problema = { nivel: string; codigo: string; texto: string };
type ItemCatalogo = { modelo: string; precio: number | null; stock: number | null };
type AutoShell = { id: string; name: string; amount: number; stock: number | null };
type Chequeo = {
  ok: boolean;
  criticos?: number;
  avisos?: number;
  resumen?: string;
  problemas?: Problema[];
  hoja1_filas?: number;
  horas_sin_correr?: number | null;
  catalogo?: ItemCatalogo[];
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const WA_PHONE_ID = Deno.env.get("WA_TASADOR_PHONE_ID");
  const WA_TOKEN = Deno.env.get("WA_TASADOR_TOKEN");
  const STOCK_SECRET = Deno.env.get("STOCK_NOTIF_SECRET");
  const MS_URL = Deno.env.get("MARKETSHELL_URL");
  const MS_TOKEN = Deno.env.get("MARKETSHELL_TOKEN");
  const PORTAL_URL = Deno.env.get("MARKETSHELL_PORTAL_URL") ??
    "https://marketshell.shell.com.ar/autos?seller=tito%20gonzalez";

  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "SUPABASE env vars missing" }, 500);
  if (!WA_PHONE_ID || !WA_TOKEN) return json({ error: "WA_TASADOR env vars missing" }, 500);
  if (!STOCK_SECRET) return json({ error: "STOCK_NOTIF_SECRET missing" }, 500);
  if (req.headers.get("x-stock-secret") !== STOCK_SECRET) {
    return json({ error: "secret inválido" }, 401);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* body opcional */ }

  // --- utilidades de template, se corren a mano una sola vez ---
  if (body?.listar === true) {
    const res = await fetch(
      `${META_API_URL}/${WABA_ID}/message_templates?fields=name,language,status,category,components&limit=200`,
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } },
    );
    const j = await res.json();
    return json({
      templates: (j?.data ?? []).filter((t: { name: string }) => t.name === TEMPLATE_NAME),
      error: j?.error,
    });
  }
  if (body?.crear_template === true) return json(await crearTemplate(WA_TOKEN));
  if (body?.borrar_template === true) return json(await borrarTemplate(WA_TOKEN));

  if (!MS_URL || !MS_TOKEN) return json({ error: "MARKETSHELL_URL / MARKETSHELL_TOKEN missing" }, 500);

  const url = new URL(req.url);
  const dry = body?.dry === true || url.searchParams.get("dry") === "1";
  const forzar = body?.forzar === true;
  const simular = body?.simular === true;
  const solo = String(body?.solo ?? "").trim() || null;
  // Problemas del portal calculados afuera (script de la PC). Ver cabecera.
  const externos: Problema[] | null = Array.isArray(body?.problemas)
    ? (body.problemas as Problema[]).filter((x) => x && x.texto)
    : null;

  const hoy = fechaAR();

  // --- 1) correr el chequeo -------------------------------------------------
  let chequeo: Chequeo;
  try {
    chequeo = simular ? chequeoSimulado() : await pedirChequeo(MS_URL, MS_TOKEN);
  } catch (e) {
    // No poder chequear TAMBIEN es "no esta ok": se avisa igual.
    chequeo = {
      ok: false,
      criticos: 1,
      avisos: 0,
      resumen: "no se pudo revisar el feed",
      problemas: [{
        nivel: "critico",
        codigo: "chequeo_inalcanzable",
        texto: `No pude correr el chequeo del feed (${String(e)}). Hay que revisar la planilla a mano.`,
      }],
    };
  }

  // --- 1.b) lo que Shell PUBLICA --------------------------------------------
  // El control que de verdad importa: la planilla puede estar impecable y el
  // portal seguir mostrando precios viejos (paso el 01/09/2026).
  let shell: { autos: AutoShell[]; declarado: number | null; error: string | null } =
    { autos: [], declarado: null, error: "no se corrio" };
  let problemasShell: Problema[] = [];
  let origenPortal = "ninguno";

  if (externos) {
    // Vino del script de la PC de Fer: ya trae la comparacion hecha.
    problemasShell = externos;
    origenPortal = String(body?.origen ?? "local");
    await sbInsert(SUPABASE_URL, SERVICE_KEY, "marketshell_portal_chequeos", {
      publicados: Number(body?.publicados ?? 0) || null,
      problemas: externos,
      ok: externos.length === 0,
      origen: origenPortal,
    });
  } else if (!simular) {
    shell = await leerShell(PORTAL_URL);
    if (shell.error === null) {
      // Shell dejo de bloquear las IP de datacenter: se compara aca mismo.
      problemasShell = compararShell(chequeo.catalogo ?? [], shell);
      origenPortal = "edge";
      await sbInsert(SUPABASE_URL, SERVICE_KEY, "marketshell_portal_chequeos", {
        publicados: shell.autos.length,
        problemas: problemasShell,
        ok: problemasShell.length === 0,
        origen: "edge",
      });
    } else {
      // No se pudo leer (lo esperable). En vez de avisar todos los dias que no
      // se pudo, se mira si el script de la PC lo verifico hace poco. Si hace
      // mas de MAX_HORAS_PORTAL que nadie lo verifica, ESO si es un problema:
      // seria quedarse sin el unico control que mira lo publicado.
      const ultimo = await sb(SUPABASE_URL, SERVICE_KEY,
        `marketshell_portal_chequeos?select=corrido_at&order=corrido_at.desc&limit=1`);
      const at = ultimo?.[0]?.corrido_at ? new Date(ultimo[0].corrido_at).getTime() : 0;
      const horas = at ? Math.floor((Date.now() - at) / 3600000) : null;
      if (horas === null || horas >= MAX_HORAS_PORTAL) {
        problemasShell = [{
          nivel: "critico",
          codigo: "portal_sin_verificar",
          texto: horas === null
            ? "Nadie verifico todavia lo que Shell publica: el chequeo del portal nunca corrio."
            : `Hace ${horas} h que no se verifica lo que Shell publica (el chequeo corre en la PC de la oficina). Mientras tanto, un precio mal publicado no lo detecta nadie.`,
        }];
      }
    }
  }

  chequeo.problemas = [...(chequeo.problemas ?? []), ...problemasShell];
  if (problemasShell.length) {
    chequeo.ok = false;
    chequeo.resumen = resumirTodo(chequeo.problemas);
  }

  if (chequeo.ok) {
    return json({
      hoy, ok: true, enviados: 0,
      info: "la planilla y lo publicado en Shell coinciden, no se avisa nada",
      verificacion_portal: origenPortal,
      publicados: externos ? Number(body?.publicados ?? 0) : shell.autos.length,
      en_planilla: (chequeo.catalogo ?? []).length,
    });
  }

  // --- 2) una sola vez por dia ---------------------------------------------
  if (!dry && !solo && !forzar) {
    const previo = await sb(SUPABASE_URL, SERVICE_KEY,
      `marketshell_avisos?fecha=eq.${hoy}&enviados=gt.0&select=fecha`);
    if (previo.length) {
      return json({ hoy, ok: false, enviados: 0, info: "ya se aviso hoy" });
    }
  }

  // --- 3) armar el mensaje --------------------------------------------------
  const problemas = chequeo.problemas ?? [];
  const criticos = problemas.filter((p) => p.nivel === "critico");
  const orden = [...criticos, ...problemas.filter((p) => p.nivel !== "critico")];
  // Los parametros de template de Meta NO aceptan saltos de linea.
  const detalle = unaLinea(
    orden.slice(0, MAX_DETALLE).map((p) => p.texto).join(" · ") +
      (orden.length > MAX_DETALLE ? ` · (+${orden.length - MAX_DETALLE} más)` : ""),
  );
  const resumen = unaLinea(chequeo.resumen ?? `${problemas.length} problema(s)`);

  if (solo) {
    const r = await enviar(WA_PHONE_ID, WA_TOKEN, solo.replace(/^\+/, "").replace(/[\s-]/g, ""), "equipo", resumen, detalle);
    return json({ prueba: true, hoy, resumen, detalle, ...r });
  }

  // --- 4) destinatarios -----------------------------------------------------
  const usuarios = (Deno.env.get("MARKETSHELL_DESTINATARIOS") ?? DESTINATARIOS_DEFAULT)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  let users: Array<Record<string, string>> = [];
  try {
    users = await sb(SUPABASE_URL, SERVICE_KEY,
      `tasador_usuarios?activo=eq.true&telefono_wa=not.is.null&select=nombre,usuario,telefono_wa`);
  } catch (e) {
    return json({ error: "Error leyendo Supabase", detalle: String(e) }, 500);
  }

  const destinatarios: Array<{ nombre: string; tel: string; usuario: string }> = [];
  const vistos = new Set<string>();
  for (const u of users) {
    if (!usuarios.includes(String(u.usuario || "").toLowerCase())) continue;
    const tel = String(u.telefono_wa).replace(/^\+/, "").replace(/[\s-]/g, "");
    if (!tel || vistos.has(tel)) continue; // Nadia tiene 2 cuentas, mismo numero
    vistos.add(tel);
    destinatarios.push({ nombre: primerNombre(u.nombre), tel, usuario: String(u.usuario) });
  }

  const faltan = usuarios.filter((n) =>
    !destinatarios.some((d) => d.usuario.toLowerCase() === n)
  );

  if (dry) {
    return json({
      dry: true, hoy, resumen, detalle,
      criticos: criticos.length, avisos: problemas.length - criticos.length,
      destinatarios: destinatarios.map((d) => `${d.nombre} ${d.tel}`),
      sin_telefono_o_inactivos: faltan,
      publicados_en_shell: externos ? Number(body?.publicados ?? 0) : shell.autos.length,
      en_planilla: (chequeo.catalogo ?? []).length,
      verificacion_portal: origenPortal,
      shell_error: shell.error,
      problemas,
    });
  }

  // --- 5) enviar ------------------------------------------------------------
  let enviados = 0;
  const errores: string[] = [];
  for (const d of destinatarios) {
    const r = await enviar(WA_PHONE_ID, WA_TOKEN, d.tel, d.nombre, resumen, detalle);
    if (r.ok) enviados++;
    else errores.push(`${d.usuario}: ${r.error}`);
  }

  // Se registra siempre (tambien con enviados=0): asi se ve en la tabla que el
  // chequeo corrio y que fallo el envio, en vez de parecer un dia sin problemas.
  await sbUpsert(SUPABASE_URL, SERVICE_KEY, "marketshell_avisos", {
    fecha: hoy,
    resumen,
    detalle,
    criticos: criticos.length,
    avisos: problemas.length - criticos.length,
    enviados,
    error: errores.length ? errores.join(" | ") : null,
  });

  return json({
    hoy, ok: false, resumen, detalle, enviados, errores,
    sin_telefono_o_inactivos: faltan,
    publicados_en_shell: externos ? Number(body?.publicados ?? 0) : shell.autos.length,
    verificacion_portal: origenPortal, shell_error: shell.error,
  });
});

// -----------------------------------------------------------------------------

// =============================================================================
// Lo que Shell PUBLICA
// =============================================================================
// marketshell.shell.com.ar es una app SvelteKit: el HTML de cada pagina ya trae
// los autos serializados (array `cars` con name / unified_amount / stock), asi
// que no hace falta correr JS. Sin headers de navegador contesta 429.

const UA_NAVEGADOR =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// La plataforma guarda el importe con precision de ~7 digitos, asi que devuelve
// 27.700.012 donde mandamos 27.700.011 y 70.200.030 donde mandamos 70.200.034.
// Son pesos sobre precios de decenas de millones: se ignoran. Una diferencia de
// precio de verdad es de cientos de miles, nunca de $100.
const TOLERANCIA_PESOS = 100;

const RE_AUTO = /\{id:"[0-9a-f-]{36}".*?new_cars_total_count:"\d+"/g;

function _campo(bloque: string, re: RegExp): string | null {
  const m = bloque.match(re);
  return m ? m[1] : null;
}

async function bajarPagina(url: string): Promise<string> {
  // El 429 de Shell es transitorio: se reintenta antes de darlo por caido.
  let ultimo = "";
  for (let intento = 1; intento <= 3; intento++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA_NAVEGADOR,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-AR,es;q=0.9",
      },
    });
    if (res.ok) return await res.text();
    ultimo = `HTTP ${res.status}`;
    await new Promise((r) => setTimeout(r, 1500 * intento));
  }
  throw new Error(ultimo);
}

function parsearAutos(html: string): AutoShell[] {
  const out: AutoShell[] = [];
  for (const b of html.match(RE_AUTO) ?? []) {
    const id = _campo(b, /id:"([0-9a-f-]{36})"/);
    const name = _campo(b, /name:"([^"]*)"/);
    const amount = _campo(b, /unified_amount:(-?\d+)/);
    const stock = _campo(b, /stock:(-?\d+)/);
    if (id && name && amount !== null) {
      out.push({ id, name, amount: Number(amount), stock: stock === null ? null : Number(stock) });
    }
  }
  return out;
}

async function leerShell(portalUrl: string) {
  const autos = new Map<string, AutoShell>();
  let declarado: number | null = null;
  try {
    // La pagina 1 va SIN `page`: con `&page=1` el portal devuelve 500.
    const primera = await bajarPagina(portalUrl);
    parsearAutos(primera).forEach((a) => autos.set(a.id, a));
    const tot = primera.match(/new_cars_total_count:"(\d+)"/);
    if (tot) declarado = Number(tot[1]);
    const paginas = Number(primera.match(/totalPages:(\d+)/)?.[1] ?? 1);
    for (let pag = 2; pag <= Math.min(paginas, 20); pag++) {
      parsearAutos(await bajarPagina(`${portalUrl}&page=${pag}`))
        .forEach((a) => autos.set(a.id, a));
    }
    if (autos.size === 0) throw new Error("el portal no devolvio ningun auto");
    return { autos: [...autos.values()], declarado, error: null as string | null };
  } catch (e) {
    return { autos: [...autos.values()], declarado, error: String(e) };
  }
}

const _k = (v: string) => String(v || "").trim().toLowerCase();

function plata(n: number): string {
  return "$" + Math.round(n).toLocaleString("es-AR");
}

function compararShell(
  catalogo: ItemCatalogo[],
  shell: { autos: AutoShell[]; declarado: number | null; error: string | null },
): Problema[] {
  const probs: Problema[] = [];

  if (shell.error || shell.autos.length === 0) {
    // No poder mirar el portal no es "todo bien": se avisa. Va como aviso y no
    // como critico porque Shell corta la conexion cada tanto sin que pase nada.
    probs.push({
      nivel: "aviso",
      codigo: "shell_ilegible",
      texto: `No pude leer el portal de Shell para verificar lo publicado (${shell.error ?? "0 autos"}). Hay que mirarlo a mano.`,
    });
    return probs;
  }

  const porNombre = new Map(shell.autos.map((a) => [_k(a.name), a]));
  const enPlanilla = new Set(catalogo.map((c) => _k(c.modelo)));

  for (const c of catalogo) {
    const a = porNombre.get(_k(c.modelo));
    if (!a) {
      // Solo importa si tiene unidades: no publicar un modelo sin stock da igual.
      if ((c.stock ?? 0) > 0) {
        probs.push({
          nivel: "critico",
          codigo: "shell_falta",
          texto: `"${c.modelo}" tiene ${c.stock} unidad(es) y NO esta publicado en Shell.`,
        });
      }
      continue;
    }
    if (c.precio !== null && Math.abs(a.amount - c.precio) > TOLERANCIA_PESOS) {
      probs.push({
        nivel: "critico",
        codigo: "shell_precio",
        texto: `"${c.modelo}": Shell publica ${plata(a.amount)} y nuestro precio es ${plata(c.precio)}.`,
      });
    }
    if (c.stock !== null && a.stock !== null && a.stock !== c.stock) {
      probs.push({
        nivel: "critico",
        codigo: "shell_stock",
        texto: `"${c.modelo}": Shell publica ${a.stock} unidad(es) y nosotros tenemos ${c.stock}.`,
      });
    }
  }

  for (const a of shell.autos) {
    if (!enPlanilla.has(_k(a.name))) {
      probs.push({
        nivel: "critico",
        codigo: "shell_sobra",
        texto: `Shell publica "${a.name}" a ${plata(a.amount)} y ese modelo no esta en nuestro archivo: nadie le actualiza el precio.`,
      });
    }
  }

  // El paginador de Shell repite alguna fila entre paginas y su contador puede no
  // cerrar con lo que se ve. Se dice, pero no dispara el aviso por si solo.
  if (shell.declarado !== null && shell.declarado !== shell.autos.length && probs.length) {
    probs.push({
      nivel: "aviso",
      codigo: "shell_conteo",
      texto: `Shell dice tener ${shell.declarado} autos publicados pero el listado muestra ${shell.autos.length}: puede que alguno este cargado y no se vea.`,
    });
  }

  return probs;
}

// Rearma el resumen de una linea cuando se suman los problemas del portal.
function resumirTodo(problemas: Problema[]): string {
  const etiqueta: Record<string, string> = {
    shell_precio: "modelos con OTRO precio publicado en Shell",
    shell_stock: "modelos con otro stock publicado en Shell",
    shell_falta: "modelos con unidades sin publicar en Shell",
    shell_sobra: "modelos publicados en Shell que no estan en nuestro archivo",
    shell_ilegible: "no se pudo leer el portal de Shell",
    portal_sin_verificar: "dias sin verificar lo que Shell publica",
    shell_conteo: "diferencia en el conteo del portal",
    portal_caido: "no se puede leer el portal de precios",
    feed_caido: "el feed dejo de actualizarse",
    desfasadas: "modelos con precio o stock viejo",
    precio_vacio: "modelos sin precio en Hoja 1",
    hoja1_sin_match: "modelos publicados que ya no existen en el portal",
    inv_sin_match: "filas del archivo sin precio",
    inv_error: "celdas del archivo en error",
    inv_precio_vacio: "filas del archivo sin precio",
    alta_pendiente: "modelos con stock sin dar de alta en el archivo",
    formula_pisada: "celdas con un valor pegado a mano",
    duplicado: "modelos repetidos",
  };
  const por: Record<string, number> = {};
  for (const p of problemas) por[p.codigo] = (por[p.codigo] ?? 0) + 1;
  return Object.keys(por).map((k) => `${por[k]} ${etiqueta[k] ?? k}`).join(" - ");
}


async function pedirChequeo(baseUrl: string, token: string): Promise<Chequeo> {
  const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}&modo=chequeo`;
  const res = await fetch(url, { redirect: "follow" });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Apps Script HTTP ${res.status}`);
  let j: Chequeo;
  try { j = JSON.parse(txt); }
  catch { throw new Error(`Apps Script no devolvio JSON: ${txt.slice(0, 200)}`); }
  if (typeof j?.ok !== "boolean") throw new Error("Apps Script devolvio un JSON inesperado");
  return j;
}

// Solo para probar el texto del aviso sin romper nada en la planilla.
function chequeoSimulado(): Chequeo {
  const problemas: Problema[] = [
    { nivel: "critico", codigo: "precio_vacio", texto: 'Hoja 1 f12 "Polo Track MSI MT" quedo SIN PRECIO. Una sola celda vacia hace que Simpli rechace el archivo entero.' },
    { nivel: "aviso", codigo: "alta_pendiente", texto: '"Tera Comfort MSI AT" tiene 3 unidad(es) en baratito y no esta publicado en Shell.' },
  ];
  return {
    ok: false, criticos: 1, avisos: 1, problemas,
    // Arranca con "PRUEBA" a proposito: este texto solo sale con {"simular":true}
    // y no tiene que poder confundirse con un aviso real.
    resumen: "PRUEBA del aviso (esto es un ejemplo, el feed esta bien) - 1 modelo sin precio - 1 modelo con stock sin publicar",
  };
}

function unaLinea(s: string): string {
  return String(s).replace(/\s+/g, " ").trim().slice(0, 900);
}

function primerNombre(n: string | null | undefined): string {
  return String(n || "").trim().split(/\s+/)[0] || "equipo";
}

function fechaAR(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

async function enviar(
  phoneId: string, token: string, tel: string,
  nombre: string, resumen: string, detalle: string,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const res = await fetch(`${META_API_URL}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: tel,
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        language: { code: META_LANGUAGE },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: nombre },
            { type: "text", text: resumen },
            { type: "text", text: detalle },
          ],
        }],
      },
    }),
  });
  const j = await res.json();
  if (!res.ok || j?.error) return { ok: false, error: j?.error?.message ?? `HTTP ${res.status}` };
  return { ok: true, id: j?.messages?.[0]?.id };
}

async function crearTemplate(token: string) {
  const res = await fetch(`${META_API_URL}/${WABA_ID}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: TEMPLATE_NAME,
      language: META_LANGUAGE,
      category: "UTILITY",
      components: [
        {
          type: "BODY",
          text: "Hola {{1}}, hay algo para revisar en el feed de MarketShell (Shell) de Tito Gonzalez: {{2}}. Detalle: {{3}}. Se corrige en la planilla de Grupo Simpli. Este control corre una vez por dia.",
          example: {
            body_text: [[
              "Fernando",
              "1 modelos sin precio en Hoja 1 - 1 modelos con stock sin publicar",
              'Hoja 1 f12 "Polo Track MSI MT" quedo SIN PRECIO, Simpli rechaza el archivo entero · "Tera Comfort MSI AT" tiene 3 unidades en baratito y no esta publicado en Shell',
            ]],
          },
        },
      ],
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function borrarTemplate(token: string) {
  const res = await fetch(
    `${META_API_URL}/${WABA_ID}/message_templates?name=${TEMPLATE_NAME}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  return { status: res.status, body: await res.json() };
}

async function sb(url: string, key: string, path: string) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`${path}: ${await res.text()}`);
  return await res.json();
}

async function sbInsert(url: string, key: string, tabla: string, fila: Record<string, unknown>) {
  const res = await fetch(`${url}/rest/v1/${tabla}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(fila),
  });
  if (!res.ok) console.error("insert", tabla, await res.text());
}

async function sbUpsert(url: string, key: string, tabla: string, fila: Record<string, unknown>) {
  const res = await fetch(`${url}/rest/v1/${tabla}?on_conflict=fecha`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(fila),
  });
  if (!res.ok) console.error("upsert", tabla, await res.text());
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
