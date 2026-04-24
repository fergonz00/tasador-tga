// Edge Function: notify-whatsapp
// Envía notificaciones por WhatsApp Cloud API (Meta) según el evento.
// Los destinatarios se configuran en la tabla `notificaciones_config` desde el panel admin.
// Log de cada envío en `notificaciones_log`.
// Para el evento `tasacion_final_definida`, las observaciones de la inspección física
// se pulen con Claude antes de enviarse al vendedor.

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

const EVENTOS_VALIDOS = new Set([
  "tasacion_pendiente_carga",
  "tasacion_virtual_completada",
  "visita_fisica_agendada",
  "tasacion_fisica_completada",
  "tasacion_final_definida",
  "usado_no_apto",
]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const WA_PHONE_ID = Deno.env.get("WA_TASADOR_PHONE_ID");
  const WA_TOKEN = Deno.env.get("WA_TASADOR_TOKEN");
  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");

  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "SUPABASE env vars missing" }, 500);
  if (!WA_PHONE_ID || !WA_TOKEN) return json({ error: "WA_TASADOR env vars missing" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  const { tasacion_id, evento } = body || {};
  if (!tasacion_id || typeof tasacion_id !== "string") return json({ error: "tasacion_id requerido" }, 400);
  if (!evento || !EVENTOS_VALIDOS.has(evento)) return json({ error: "evento inválido" }, 400);

  // 1) Traer config del evento + tasación en paralelo
  let cfgArr: any[], tasArr: any[];
  try {
    [cfgArr, tasArr] = await Promise.all([
      sb(SUPABASE_URL, SERVICE_KEY, `notificaciones_config?evento=eq.${evento}&select=*`),
      sb(SUPABASE_URL, SERVICE_KEY, `tasaciones?id=eq.${tasacion_id}&select=*`),
    ]);
  } catch (e) {
    return json({ error: "Error leyendo Supabase", detalle: String(e) }, 500);
  }

  if (!Array.isArray(cfgArr) || cfgArr.length === 0) return json({ error: `Sin config para evento ${evento}` }, 404);
  if (!Array.isArray(tasArr) || tasArr.length === 0) return json({ error: "Tasación no encontrada" }, 404);

  const cfg = cfgArr[0];
  const tas = tasArr[0];

  // 2) Resolver destinatarios: vendedor de referencia (si toggle) + usuarios fijos
  const destIds = new Set<string>();
  if (cfg.incluir_vendedor_referencia && tas.vendedor_id) destIds.add(String(tas.vendedor_id));
  for (const u of (cfg.usuarios_ids || [])) destIds.add(String(u));

  if (destIds.size === 0) return json({ enviados: 0, errores: [], info: "sin destinatarios configurados" });

  const idsArr = Array.from(destIds);
  const idsCsv = idsArr.map((id) => `"${id}"`).join(",");
  const users = await sb(
    SUPABASE_URL,
    SERVICE_KEY,
    `tasador_usuarios?id=in.(${idsCsv})&select=id,nombre,usuario,telefono_wa,notificaciones_wa,activo,rol,roles`,
  );

  const destinatarios = (users || []).filter((u: any) =>
    u.activo !== false &&
    u.notificaciones_wa !== false &&
    u.telefono_wa && String(u.telefono_wa).trim().length > 0
  );

  if (destinatarios.length === 0) {
    return json({ enviados: 0, errores: [], info: "sin destinatarios válidos (sin teléfono o opt-out)" });
  }

  // 3) Construir variables del template
  const getVars = await buildVariables(evento, tas, ANTHROPIC_KEY || null);

  // 4) Enviar a cada destinatario
  const enviados: any[] = [];
  const errores: any[] = [];

  for (const u of destinatarios) {
    const vars = getVars(u);
    const telE164 = String(u.telefono_wa).replace(/^\+/, "").replace(/\s|-/g, "");
    const components = vars.length > 0
      ? [{ type: "body", parameters: vars.map((v: string) => ({ type: "text", text: String(v || "") })) }]
      : [];
    const payload = {
      messaging_product: "whatsapp",
      to: telE164,
      type: "template",
      template: {
        name: evento,
        language: { code: META_LANGUAGE },
        components,
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
        await log(SUPABASE_URL, SERVICE_KEY, {
          tasacion_id,
          destinatario_id: u.id,
          destinatario_telefono: telE164,
          template: evento,
          evento,
          estado: "enviado",
          meta_message_id: metaJson.messages[0].id,
          payload: { request: payload, response: metaJson },
        });
        enviados.push({ usuario: u.usuario, meta_id: metaJson.messages[0].id });
      } else {
        await log(SUPABASE_URL, SERVICE_KEY, {
          tasacion_id,
          destinatario_id: u.id,
          destinatario_telefono: telE164,
          template: evento,
          evento,
          estado: "error",
          error_detalle: JSON.stringify(metaJson.error || metaJson).slice(0, 2000),
          payload: { request: payload, response: metaJson },
        });
        errores.push({ usuario: u.usuario, error: metaJson.error || metaJson });
      }
    } catch (e) {
      await log(SUPABASE_URL, SERVICE_KEY, {
        tasacion_id,
        destinatario_id: u.id,
        destinatario_telefono: telE164,
        template: evento,
        evento,
        estado: "fallido",
        error_detalle: String(e),
        payload: { request: payload },
      });
      errores.push({ usuario: u.usuario, error: String(e) });
    }
  }

  return json({ enviados: enviados.length, errores });
});

// ---------- Helpers ----------

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
      "Prefer": "return=representation",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${res.status}: ${t}`);
  }
  return res.json();
}

async function log(url: string, key: string, row: any) {
  try {
    await fetch(`${url}/rest/v1/notificaciones_log`, {
      method: "POST",
      headers: {
        "apikey": key,
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify(row),
    });
  } catch (e) {
    console.error("log err:", e);
  }
}

function fmtNum(n: any): string {
  const v = Number(n);
  if (!isFinite(v)) return "";
  return new Intl.NumberFormat("es-AR").format(Math.round(v));
}
function fmtPrecio(n: any, moneda: string = "ARS"): string {
  const s = fmtNum(n);
  if (!s) return "—";
  return moneda === "USD" ? `USD ${s}` : `$ ${s}`;
}
function unidad(t: any): string {
  return [t.marca, t.modelo, t.version].filter((x) => !!x).join(" ").trim() || "—";
}
function fechaHora(iso?: string, hora?: string): string {
  if (!iso) return "—";
  const d = new Date(iso + "T12:00:00");
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear());
  return `${dd}/${mm}/${yy}${hora ? " " + hora : ""}`;
}

async function buildVariables(
  evento: string,
  tas: any,
  anthropicKey: string | null,
): Promise<(u: any) => string[]> {
  const uni = unidad(tas);
  const km = tas.kilometros ? fmtNum(tas.kilometros) + " km" : "—";
  const color = tas.color || "—";
  const rad = tas.provincia_radicacion || "—";
  const cli = tas.cliente_nombre || "—";

  if (evento === "tasacion_pendiente_carga") {
    // {{1}} = vendedor real de la tasacion (no el destinatario)
    const vendedor = tas.vendedor_nombre || "—";
    return (_u: any) => [vendedor, uni, cli];
  }
  if (evento === "usado_no_apto") {
    // {{1}} = vendedor, {{2}} = unidad, {{3}} = cliente
    const vendedor = tas.vendedor_nombre || "—";
    return (_u: any) => [vendedor, uni, cli];
  }
  if (evento === "tasacion_virtual_completada") {
    const precio = fmtPrecio(tas.precio_toma_virtual);
    return (u: any) => [u.nombre || u.usuario || "", uni, km, color, rad, precio];
  }
  if (evento === "visita_fisica_agendada") {
    const fh = fechaHora(tas.turno_fecha, tas.turno_hora);
    const virtual = fmtPrecio(tas.precio_toma_virtual);
    const ccaMoneda = tas.precio_cca_moneda || "ARS";
    const cca = fmtPrecio(tas.precio_cca, ccaMoneda);
    const kavak = fmtPrecio(tas.precio_kavak);
    return (_u: any) => [fh, cli, uni, km, color, rad, virtual, cca, kavak];
  }
  if (evento === "tasacion_fisica_completada") {
    const precio = fmtPrecio(tas.precio_sugerido_fisico);
    return (u: any) => [u.nombre || u.usuario || "", uni, cli, precio];
  }
  if (evento === "tasacion_final_definida") {
    const precio = fmtPrecio(tas.precio_toma_final);
    let observaciones = "";

    // 1) Si la IA ya armó un comentario completo, lo usamos como base
    if (typeof tas.comentario_borrador_ia === "string" && tas.comentario_borrador_ia.trim()) {
      observaciones = tas.comentario_borrador_ia.trim();
    }

    // 2) Si no hay comentario IA, armamos desde analisis_fisico crudo (texto libre + danios)
    if (!observaciones && tas.analisis_fisico && typeof tas.analisis_fisico === "object") {
      const af = tas.analisis_fisico;
      const partes: string[] = [];

      // Texto libre del tasador (campo nuevo: observaciones_grales; fallback a viejos)
      const txtLibre = af.observaciones_grales || af.observaciones || af.comentario || af.resumen || "";
      if (typeof txtLibre === "string" && txtLibre.trim()) {
        partes.push(txtLibre.trim());
      }

      // Pintura
      if (af.pintura_estado || af.pintura_obs) {
        const p = [af.pintura_estado, af.pintura_obs].filter((x: any) => x).join(" — ");
        if (p) partes.push("Pintura: " + p);
      }

      // Daños con costo (marcadores en la foto) - el campo texto se llama "nota"
      if (Array.isArray(af.marcadores) && af.marcadores.length > 0) {
        const danios = af.marcadores
          .filter((m: any) => m && (m.nota || m.descripcion || m.costo))
          .map((m: any) => {
            const desc = m.nota || m.descripcion || "—";
            const costo = m.costo ? "$" + fmtNum(m.costo) : "";
            return costo ? `${desc} (${costo})` : desc;
          });
        if (danios.length) partes.push("Daños: " + danios.join("; "));
      }

      // Items del checklist con costo o con observación cargada
      if (af.items && typeof af.items === "object") {
        const itemsTxt: string[] = [];
        for (const grupo of Object.keys(af.items)) {
          const grp = af.items[grupo] || {};
          for (const item of Object.keys(grp)) {
            const it = grp[item] || {};
            const costo = Number(it.costo) || 0;
            const obs = (it.obs || "").toString().trim();
            if (costo > 0 || obs) {
              const partesItem: string[] = [item];
              if (obs) partesItem.push(obs);
              if (costo > 0) partesItem.push("$" + fmtNum(costo));
              itemsTxt.push(partesItem.join(" — "));
            }
          }
        }
        if (itemsTxt.length) partes.push("Checklist: " + itemsTxt.join("; "));
      }

      observaciones = partes.join(". ");
    }

    // 3) Si quedó muy largo y tenemos IA, pasamos por Claude para sintetizar
    if (anthropicKey && observaciones && observaciones.length > 250) {
      observaciones = await corregirConAnthropic(observaciones, anthropicKey);
    }
    if (!observaciones) observaciones = "Sin observaciones particulares.";
    return (_u: any) => [uni, km, color, rad, precio, observaciones];
  }
  return (_u: any) => [];
}

async function corregirConAnthropic(texto: string, apiKey: string): Promise<string> {
  try {
    const prompt =
      "Corregí ortografía, redacción y síntesis del siguiente texto de observaciones de una inspección física de auto usado. " +
      "El resultado tiene que ser claro, profesional, en español rioplatense, máximo 500 caracteres. " +
      "No agregues información que no esté en el original. No uses comillas ni encabezados. " +
      "Devolvé SOLO el texto corregido.\n\nTexto original:\n" + texto;
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return texto;
    const j = await res.json();
    const out = j.content && j.content[0] && j.content[0].text;
    return (out || texto).trim().slice(0, 900);
  } catch {
    return texto;
  }
}
