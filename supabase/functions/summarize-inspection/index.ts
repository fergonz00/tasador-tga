// Edge Function: summarize-inspection
// Recibe el análisis físico del tasador + datos del vehículo y devuelve un texto
// en castellano rioplatense profesional que el vendedor puede usar para explicarle
// el precio al cliente. Se guarda en `comentario_borrador_ia` (el admin lo puede editar).
//
// Se invoca fire-and-forget desde index.html al guardar la inspección física.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";
const ANTHROPIC_VERSION = "2023-06-01";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY no configurada" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  const {
    marca, modelo, version, anio, kilometros, color, cliente_nombre,
    precio_toma_virtual, precio_sugerido_fisico,
    analisis_fisico
  } = body || {};

  if (!analisis_fisico) return json({ error: "Falta analisis_fisico" }, 400);

  const prompt = buildPrompt({
    marca, modelo, version, anio, kilometros, color, cliente_nombre,
    precio_toma_virtual, precio_sugerido_fisico, analisis_fisico,
  });

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    return json({ error: "Fetch a Claude falló", detail: String(e) }, 500);
  }

  if (!response.ok) {
    const txt = await response.text();
    return json({ error: "Claude API error", status: response.status, detail: txt }, 500);
  }

  const data = await response.json();
  const texto = (data?.content?.[0]?.text || "").trim();
  if (!texto) return json({ error: "Respuesta vacía de Claude" }, 500);

  return json({ ok: true, comentario: texto });
});

function buildPrompt(input: any) {
  const af = input.analisis_fisico || {};
  const marcadores = Array.isArray(af.marcadores) ? af.marcadores : [];
  const items = af.items || {};
  const accesorios = Array.isArray(af.accesorios) ? af.accesorios : [];
  const totalArreglos = Number(af.total_arreglos) || marcadores.reduce((s: number, m: any) => s + (Number(m.costo) || 0), 0);
  const implicito = af.precio_implicito_bruto || (input.precio_sugerido_fisico && totalArreglos ? input.precio_sugerido_fisico + totalArreglos : null);

  // Lista legible de daños de la foto
  const TIPOS: Record<string, string> = {
    rayon: "rayón",
    abolladura: "abolladura",
    golpe: "golpe",
    falta: "falta / rotura de pieza",
    pintura: "problema de pintura",
    repintado: "repintado",
    otro: "otro",
  };
  const daniosTxt = marcadores.length === 0
    ? "Ninguno."
    : marcadores.map((m: any, i: number) => {
        const tipo = TIPOS[m.tipo] || m.tipo || "daño";
        const costo = Number(m.costo) || 0;
        const costoStr = costo > 0 ? ` · estimado $${costo.toLocaleString("es-AR")}` : "";
        const nota = m.nota ? ` — ${m.nota}` : "";
        return `${i + 1}. ${tipo}${nota}${costoStr}`;
      }).join("\n");

  // Items del checklist con observaciones
  const itemsObs: string[] = [];
  Object.keys(items).forEach((g) => {
    Object.keys(items[g] || {}).forEach((k) => {
      const it = items[g][k] || {};
      const estado = it.estado || "bueno";
      if (estado !== "bueno" && it.obs) {
        itemsObs.push(`${k} (${estado}): ${it.obs}`);
      }
    });
  });
  const checklistTxt = itemsObs.length === 0 ? "Sin observaciones adicionales." : itemsObs.join("\n");

  // Pintura
  const PINTURA: Record<string, string> = {
    original: "Pintura 100% original",
    repintada_total: "Repintada total",
    repintada_parcial: "Repintada parcial",
    otro: "Otro",
  };
  const pinturaEstado = af.pintura_estado || "";
  const pinturaTxt = pinturaEstado
    ? `${PINTURA[pinturaEstado] || pinturaEstado}${af.pintura_obs ? " — " + af.pintura_obs : ""}`
    : "No especificada";

  // Tapizado + prueba dinámica
  const pd = af.prueba_dinamica || {};
  const tapTxt = af.tipo_tapizado || "No especificado";
  const pruebaTxt = pd.realizada ? `Realizada${pd.realizo ? " por " + pd.realizo : ""}` : "No realizada";

  // Observaciones generales
  const obsGrales = af.observaciones_grales || "Sin observaciones generales.";

  // Precios
  const virtualStr = input.precio_toma_virtual ? `$${Number(input.precio_toma_virtual).toLocaleString("es-AR")}` : "no cargado";
  const fisicoStr = input.precio_sugerido_fisico ? `$${Number(input.precio_sugerido_fisico).toLocaleString("es-AR")}` : "no cargado";
  const arreglosStr = totalArreglos > 0 ? `$${totalArreglos.toLocaleString("es-AR")}` : "$0";
  const implicitoStr = implicito ? `$${Number(implicito).toLocaleString("es-AR")}` : "—";

  return `Sos el administrador de Tito González Automotores (TGA), concesionario VW en CABA. Un vendedor te va a consultar por la tasación de un usado y necesitás darle un texto claro y profesional para que pueda explicarle al cliente por qué se llega a determinado precio.

ESCRIBILO EN CASTELLANO RIOPLATENSE PROFESIONAL (tono cálido pero directo, segunda persona del singular — "vos"). Sin formalismos rebuscados. El vendedor lo va a copiar/usar casi literal cuando hable con el cliente.

Estructura sugerida (no pongas títulos, es prosa fluida):
- Arrancá validando lo bueno que vimos (estado general / lo que está OK).
- Después, de forma honesta, nombrá los detalles principales y aproximadamente qué cuesta repararlos (si hay montos).
- Si hay algo destacable de la pintura, mencionalo.
- Cerrá explicando que por todo lo observado, el precio de toma neto queda en el valor sugerido.

No uses viñetas ni listas. Es un texto fluido de 1 a 2 párrafos.
No menciones el precio virtual — solo el precio final sugerido físico.
No inventes datos que no estén en el análisis.
Si el auto tiene muy pocos detalles, sé breve (no inventes defectos).

DATOS DEL VEHÍCULO
- ${input.marca || ""} ${input.modelo || ""} ${input.anio || ""} — ${input.version || ""}
- ${input.kilometros ? Number(input.kilometros).toLocaleString("es-AR") + " km" : ""}${input.color ? " · " + input.color : ""}
- Cliente: ${input.cliente_nombre || "—"}

INSPECCIÓN FÍSICA

Daños marcados sobre la foto:
${daniosTxt}

Pintura: ${pinturaTxt}

Tapizado: ${tapTxt}
Prueba dinámica: ${pruebaTxt}

Checklist mecánico/interior con observaciones:
${checklistTxt}

Accesorios detectados: ${accesorios.length === 0 ? "ninguno cargado" : accesorios.join(", ")}

Observaciones generales del tasador:
${obsGrales}

PRECIOS
- Precio virtual de referencia: ${virtualStr}
- Total arreglos estimados: ${arreglosStr}
- Valor implícito en buen estado: ${implicitoStr}
- Precio sugerido físico (neto, que es el que hay que comunicar al cliente): ${fisicoStr}

Respondé SOLO con el texto para el vendedor. Sin encabezados, sin "Claro, acá tenés", sin firma. Directo el texto.`;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
