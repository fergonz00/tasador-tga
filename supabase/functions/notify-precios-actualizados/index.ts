// Edge Function: notify-precios-actualizados
// La dispara el portal-precios (precios.titogonzalez.online) cuando un admin
// guarda cambios en las ofertas. Avisa por WhatsApp a TODOS los vendedores y
// gerentes para que revisen los precios nuevos.
//
// - Autenticación: header x-stock-secret == STOCK_NOTIF_SECRET (mismo secret que
//   ya usa notify-exposicion-vendida).
// - Destinatarios: tasador_usuarios con rol/roles 'vendedor' o 'gerente',
//   activos, con telefono_wa y notificaciones_wa != false.
// - Template Meta: `precios_actualizados` (es_AR), variable {{1}} = primer nombre.
// - Anti-spam: cooldown configurable (COOLDOWN_MIN, default 25 min). Si ya se
//   avisó hace poco, no vuelve a mandar (tabla `precios_avisos`).

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "precios_actualizados";
const COOLDOWN_MIN = Number(Deno.env.get("PRECIOS_AVISO_COOLDOWN_MIN") ?? "25");

const ROLES_DESTINATARIOS = new Set(["vendedor", "gerente"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info, x-stock-secret",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const WA_PHONE_ID = Deno.env.get("WA_TASADOR_PHONE_ID");
  const WA_TOKEN = Deno.env.get("WA_TASADOR_TOKEN");
  const STOCK_SECRET = Deno.env.get("STOCK_NOTIF_SECRET");

  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "SUPABASE env vars missing" }, 500);
  if (!WA_PHONE_ID || !WA_TOKEN) return json({ error: "WA_TASADOR env vars missing" }, 500);
  if (!STOCK_SECRET) return json({ error: "STOCK_NOTIF_SECRET missing" }, 500);

  const reqSecret = req.headers.get("x-stock-secret");
  if (reqSecret !== STOCK_SECRET) return json({ error: "secret inválido" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* body opcional */ }
  const usuario = String(body?.usuario || "").trim() || null;
  const forzar = body?.forzar === true; // saltea cooldown (para pruebas)
  const sincrono = body?.sync === true; // espera el resultado (para pruebas)

  const env = { SUPABASE_URL, SERVICE_KEY, WA_PHONE_ID, WA_TOKEN };
  const trabajo = procesar(env, usuario, forzar);

  // Fire-and-forget: respondemos enseguida para no colgar el botón "Guardar".
  // El envío a los 16 destinatarios sigue en segundo plano (EdgeRuntime.waitUntil).
  if (sincrono) {
    return json(await trabajo);
  }
  // deno-lint-ignore no-explicit-any
  const ert = (globalThis as any).EdgeRuntime;
  if (ert?.waitUntil) ert.waitUntil(trabajo);
  else trabajo.catch((e) => console.error("procesar error:", e));
  return json({ accepted: true });
});

type Env = {
  SUPABASE_URL: string;
  SERVICE_KEY: string;
  WA_PHONE_ID: string;
  WA_TOKEN: string;
};

async function procesar(env: Env, usuario: string | null, forzar: boolean) {
  const { SUPABASE_URL, SERVICE_KEY, WA_PHONE_ID, WA_TOKEN } = env;

  // ── Cooldown: ¿avisamos hace poco? ────────────────────────────────────────
  if (!forzar && COOLDOWN_MIN > 0) {
    const desde = new Date(Date.now() - COOLDOWN_MIN * 60_000).toISOString();
    try {
      const recientes = await sb(
        SUPABASE_URL,
        SERVICE_KEY,
        `precios_avisos?created_at=gte.${encodeURIComponent(desde)}&select=id&limit=1`,
      );
      if (Array.isArray(recientes) && recientes.length > 0) {
        return { skipped: true, motivo: `cooldown ${COOLDOWN_MIN}min` };
      }
    } catch (_e) {
      // si la tabla no existe o falla, seguimos (mejor avisar que no avisar)
    }
  }

  // ── Destinatarios ─────────────────────────────────────────────────────────
  let users: any[] = [];
  try {
    users = await sb(
      SUPABASE_URL,
      SERVICE_KEY,
      `tasador_usuarios?activo=eq.true&telefono_wa=not.is.null&select=id,nombre,usuario,telefono_wa,notificaciones_wa,rol,roles`,
    );
  } catch (e) {
    return { error: "Error leyendo Supabase", detalle: String(e) };
  }

  const destinatarios: Array<{ nombre: string; telefono_wa: string; usuario: string }> = [];
  const vistos = new Set<string>();
  for (const u of users || []) {
    if (u.notificaciones_wa === false) continue;
    const tel = String(u.telefono_wa || "").trim();
    if (!tel) continue;
    const roles = [u.rol, ...(Array.isArray(u.roles) ? u.roles : [])]
      .filter(Boolean)
      .map((r: string) => String(r).toLowerCase());
    if (!roles.some((r) => ROLES_DESTINATARIOS.has(r))) continue;
    const telE164 = tel.replace(/^\+/, "").replace(/\s|-/g, "");
    if (vistos.has(telE164)) continue; // dedup por teléfono
    vistos.add(telE164);
    destinatarios.push({
      nombre: u.nombre || u.usuario || "",
      telefono_wa: telE164,
      usuario: u.usuario || "",
    });
  }

  if (destinatarios.length === 0) {
    return { enviados: 0, errores: [], detalle: "sin destinatarios" };
  }

  // ── Envío ─────────────────────────────────────────────────────────────────
  const enviados: any[] = [];
  const errores: any[] = [];

  for (const dest of destinatarios) {
    const primerNombre = (dest.nombre.split(/\s+/)[0] || dest.nombre || "").trim() || "equipo";
    const payload = {
      messaging_product: "whatsapp",
      to: dest.telefono_wa,
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        language: { code: META_LANGUAGE },
        components: [{
          type: "body",
          parameters: [{ type: "text", text: primerNombre }],
        }],
      },
    };

    try {
      const metaRes = await fetch(`${META_API_URL}/${WA_PHONE_ID}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const metaJson = await metaRes.json();
      if (metaRes.ok && metaJson.messages && metaJson.messages[0]) {
        enviados.push({ destinatario: dest.nombre, meta_id: metaJson.messages[0].id });
      } else {
        errores.push({ destinatario: dest.nombre, error: metaJson.error || metaJson });
      }
    } catch (e) {
      errores.push({ destinatario: dest.nombre, error: String(e) });
    }
  }

  // ── Registrar el aviso (para el cooldown) ─────────────────────────────────
  if (enviados.length > 0) {
    try {
      await sb(SUPABASE_URL, SERVICE_KEY, `precios_avisos`, {
        method: "POST",
        body: JSON.stringify({ usuario, enviados: enviados.length, errores: errores.length }),
      });
    } catch (_e) {
      // best-effort: si no se registra, a lo sumo se podría reavisar antes
    }
  }

  return { enviados: enviados.length, errores, detalle_enviados: enviados };
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sb(url: string, key: string, path: string, options: RequestInit = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${res.status}: ${t}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : [];
}
