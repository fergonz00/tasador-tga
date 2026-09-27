// Edge Function: ml-preguntar
//
// Publica la oferta de compra como pregunta en el aviso de Mercado Libre de un
// particular. La llama el tasador desde la solapa "Compra ML", en dos pasos:
// Fer pone el precio, le mostramos el mensaje, confirma y recién acá se envía.
//
// Por qué existe esta función y el tasador no llama a ML directo: el tasador es
// una página estática y el token de ML no puede vivir en el navegador. Y por qué
// no habla con ML ella misma: el `refresh_token` de ML es de UN SOLO USO, así que
// el token lo maneja UN solo dueño (portal-precios, src/lib/mlApi.ts) y el resto
// le pide. Acá se valida quién pide, se arma nada y se guarda el resultado.
//
// Secretos que necesita:
//   ML_PREGUNTAR_URL     https://precios.titogonzalez.online/api/ml/preguntar
//   ML_PREGUNTAR_SECRET  el mismo CRON_SECRET del portal de precios

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PREGUNTAR_URL = Deno.env.get("ML_PREGUNTAR_URL")!;
const PREGUNTAR_SECRET = Deno.env.get("ML_PREGUNTAR_SECRET")!;

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

// ---- sesión firmada (mismo esquema que db-proxy de consulta-0km) -------------
let _secret: string | null = null;
async function getSecret(): Promise<string> {
  if (_secret) return _secret;
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/app_config?clave=eq.tga_session_secret&select=valor`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  const rows = await r.json().catch(() => []);
  _secret = (Array.isArray(rows) && rows[0]?.valor) || "";
  return _secret;
}
function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function igual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
/**
 * La firma es HMAC de "<usuario>.<exp>" y va atada al usuario al que se le
 * emitió. Cuando un superadmin impersona, el dueño de la firma es el operador
 * real: por eso se verifica contra `session_usuario || usuario`.
 */
async function sesionValida(sess: any): Promise<string | null> {
  if (!sess || typeof sess !== "object") return null;
  const dueno = String(sess.session_usuario || sess.usuario || "").trim().toLowerCase();
  const exp = Number(sess.session_exp);
  const sig = String(sess.session_sig || "");
  if (!dueno || !exp || !sig) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;
  const secret = await getSecret();
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${dueno}.${exp}`));
  return igual(toHex(mac), sig) ? dueno : null;
}

async function rest(path: string, init?: RequestInit) {
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
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

  const quien = await sesionValida(body?.session);
  if (!quien) return json({ error: "No autorizado" }, 401);

  const tasacionId = String(body?.tasacion_id || "").trim();
  const texto = String(body?.texto || "").trim();
  if (!tasacionId) return json({ error: "Falta tasacion_id" }, 400);
  if (texto.length < 10) return json({ error: "El mensaje es muy corto" }, 400);
  if (texto.length > 2000) return json({ error: "El mensaje pasa los 2.000 caracteres de ML" }, 400);

  // La tasación manda: de acá sale el aviso al que se pregunta, no del cliente.
  // Así el navegador no puede hacer que le preguntemos a un aviso cualquiera.
  const rTas = await rest(
    `tasaciones?id=eq.${encodeURIComponent(tasacionId)}` +
      `&select=id,origen,numero_interno,precio_toma_virtual,origen_datos`,
  );
  const filas = await rTas.json().catch(() => []);
  const t = Array.isArray(filas) ? filas[0] : null;
  if (!t) return json({ error: "No encontré esa tasación" }, 404);
  if (t.origen !== "ml") return json({ error: "Esa tasación no es de Mercado Libre" }, 400);
  if (!(Number(t.precio_toma_virtual) > 0)) {
    return json({ error: "Primero hay que guardar el precio que ofrecemos" }, 400);
  }

  const datos = (t.origen_datos || {}) as Record<string, unknown>;
  if (datos.oferta_enviada_at) {
    return json(
      { error: `A este aviso ya le preguntamos el ${String(datos.oferta_enviada_at).slice(0, 10)}.` },
      409,
    );
  }

  const itemId = String(t.numero_interno || "").trim().toUpperCase();
  if (!/^MLA\d{6,}$/.test(itemId)) {
    return json({ error: `La tasación no tiene el id del aviso (${itemId || "vacío"})` }, 400);
  }

  const r = await fetch(PREGUNTAR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PREGUNTAR_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ item_id: itemId, text: texto }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.ok) {
    return json({ error: j?.error || `No pude publicar la pregunta (${r.status})` }, 502);
  }

  // Recién con la pregunta publicada se marca. Si falla el guardado, la pregunta
  // ya salió: se devuelve ok con el aviso, porque reintentar publicaría otra.
  datos.oferta_enviada_at = new Date().toISOString();
  datos.oferta_enviada_por = quien;
  datos.oferta_pregunta_id = j.question_id ?? null;
  datos.oferta_texto = texto;
  datos.oferta_precio = Number(t.precio_toma_virtual);

  const up = await rest(`tasaciones?id=eq.${encodeURIComponent(tasacionId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ origen_datos: datos, updated_at: new Date().toISOString() }),
  });

  return json({
    ok: true,
    question_id: j.question_id ?? null,
    guardado: up.ok,
    aviso: up.ok ? null : "La pregunta salió pero no pude marcarla en la tasación.",
  });
});
