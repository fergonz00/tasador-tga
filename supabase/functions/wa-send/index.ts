// Edge Function: wa-send
// Envía notificaciones de WhatsApp por CallMeBot SIN exponer la callmebot_key al
// navegador. Antes tasador/index.html leía telefono_wa + callmebot_key con la
// anon key y llamaba a CallMeBot desde el cliente → la key quedaba a la vista de
// cualquiera con la anon pública. Ahora el cliente manda {usuarioId|rol, mensaje}
// con su sesión firmada; el servidor resuelve la key con service_role y envía.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function svc(path: string): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
}

let _secret: string | null = null;
async function getSecret(): Promise<string> {
  if (_secret) return _secret;
  const r = await svc("app_config?clave=eq.tga_session_secret&select=valor");
  const rows = await r.json().catch(() => []);
  _secret = (Array.isArray(rows) && rows[0]?.valor) || "";
  return _secret;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Verifica la firma del tga_session: cualquier usuario logueado del ecosistema
// puede disparar una notificación (igual que hoy, que la dispara el navegador).
async function sesionValida(sess: any): Promise<boolean> {
  if (!sess || typeof sess !== "object") return false;
  const usuario = String(sess.usuario || "").trim().toLowerCase();
  const exp = Number(sess.session_exp);
  const sig = String(sess.session_sig || "");
  if (!usuario || !exp || !sig) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;
  const secret = await getSecret();
  if (!secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${usuario}.${exp}`));
  return timingSafeEqual(toHex(mac), sig);
}

async function enviarCallMeBot(telefono: string, apikey: string, mensaje: string): Promise<boolean> {
  if (!telefono || !apikey) return false;
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(telefono)}&text=${encodeURIComponent(mensaje)}&apikey=${encodeURIComponent(apikey)}`;
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  if (!(await sesionValida(body?.session))) return json({ error: "No autorizado" }, 401);

  const mensaje = String(body?.mensaje || "");
  if (!mensaje) return json({ error: "Falta el mensaje" }, 400);

  try {
    // Destinatarios: por id de usuario, o todos los de un rol.
    let destinatarios: any[] = [];
    if (body?.usuarioId) {
      const r = await svc(`tasador_usuarios?id=eq.${encodeURIComponent(String(body.usuarioId))}&select=usuario,telefono_wa,callmebot_key`);
      destinatarios = await r.json().catch(() => []);
    } else if (body?.rol) {
      const rol = String(body.rol);
      const r = await svc(`tasador_usuarios?activo=eq.true&select=usuario,telefono_wa,callmebot_key,roles,rol`);
      const todos = await r.json().catch(() => []);
      destinatarios = (Array.isArray(todos) ? todos : []).filter((u: any) => {
        const arr = Array.isArray(u.roles) && u.roles.length ? u.roles : (u.rol ? [u.rol] : []);
        return arr.includes(rol);
      });
    } else {
      return json({ error: "Falta usuarioId o rol" }, 400);
    }

    let enviados = 0;
    await Promise.all(
      (destinatarios || []).map(async (u: any) => {
        if (u?.telefono_wa && u?.callmebot_key) {
          if (await enviarCallMeBot(u.telefono_wa, u.callmebot_key, mensaje)) enviados++;
        }
      }),
    );
    return json({ ok: true, enviados });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
