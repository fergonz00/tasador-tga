// Edge Function: notify-marketshell
//
// Aviso DIARIO por WhatsApp cuando el feed de MarketShell (Shell) no esta ok.
// Pedido de Fer, 1-sep-2026: "avisame a mi, a Ines Alonso y a Nadia una vez por
// dia si hay algo que no esta ok".
//
// Que mira: NO mira el portal publico de Shell (marketshell.shell.com.ar esta
// detras del checkpoint de Vercel y no se puede leer por HTTP). Mira la planilla
// de Grupo Simpli "Copia de Shell2", que es de donde Simpli arma el portal y es
// lo unico que nosotros controlamos. La auditoria la hace el Apps Script del
// feed en `?modo=chequeo` (marketshell-feed/live/Chequeo.js), que devuelve el
// JSON con la lista de problemas y su nivel (critico / aviso).
//
// Cadencia: pg_cron `0 12 * * *` = 9:00 AR, TODOS los dias. Si esta todo ok NO
// manda nada (silencio = todo bien). Una fila por dia en `marketshell_avisos`
// hace que no se repita aunque el cron corra dos veces.
//
// ⚠️ Si el chequeo NO se puede correr (Apps Script caido, token vencido, red),
// eso TAMBIEN se avisa. Si no, un chequeo roto se veria igual que "todo bien".
//
// Destinatarios: usuarios de `tasador_usuarios` cuyo `usuario` este en
// MARKETSHELL_DESTINATARIOS (default fngonzalez,ialonso,nvera), activos y con
// telefono_wa. Dedup por telefono (Nadia tiene dos cuentas con el mismo numero).
//
// Probar sin mandar nada:
//   POST {"dry":true}                      -> corre el chequeo y muestra a quien le mandaria
//   POST {"dry":true,"simular":true}       -> ademas inventa problemas, para ver el texto
//   POST {"solo":"5491156559854"}          -> manda solo a ese numero
//   POST {"forzar":true}                   -> ignora la fila del dia (reenvia)
//   POST {"listar":true}                   -> estado del template en Meta
//   POST {"crear_template":true}           -> alta del template (una sola vez)

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const WABA_ID = Deno.env.get("WA_TASADOR_WABA_ID") ?? "1183788370595856";

const TEMPLATE_NAME = "marketshell_feed_alerta";
// ⚠️ Sin fallback a proposito (misma decision que notify-feed): el unico
// template de 1 parametro aprobado (`precios_actualizados`) cierra con "Se
// actualizaron los valores en el portal de Tito Gonzalez", o sea que avisaria de
// un cambio de precios que no paso. Preferible que no salga el aviso y quede el
// error registrado en `marketshell_avisos` a que salga diciendo otra cosa.

const DESTINATARIOS_DEFAULT = "fngonzalez,ialonso,nvera";

// Cuantos problemas entran en el parametro {{3}}. Meta corta el body largo y
// el detalle completo esta en la planilla igual.
const MAX_DETALLE = 6;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info, x-stock-secret",
};

type Problema = { nivel: string; codigo: string; texto: string };
type Chequeo = {
  ok: boolean;
  criticos?: number;
  avisos?: number;
  resumen?: string;
  problemas?: Problema[];
  hoja1_filas?: number;
  horas_sin_correr?: number | null;
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

  if (chequeo.ok) {
    return json({ hoy, ok: true, enviados: 0, info: "el feed esta al dia, no se avisa nada" });
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

  return json({ hoy, ok: false, resumen, detalle, enviados, errores, sin_telefono_o_inactivos: faltan });
});

// -----------------------------------------------------------------------------

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
    resumen: "1 modelos sin precio en Hoja 1 - 1 modelos con stock sin publicar",
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
