// Edge Function: analyze-photos
// Llama a Claude Opus 4.7 con las fotos de un usado y devuelve un análisis estructurado
// en JSON con estado de chapa/pintura/interior, daños detectados y estimación de arreglos.
// La ANTHROPIC_API_KEY se lee del entorno de Supabase (secret), nunca del cliente.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";
const ANTHROPIC_VERSION = "2023-06-01";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Método no permitido" }, 405);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json({ error: "ANTHROPIC_API_KEY no configurada en Supabase" }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const { fotos, marca, modelo, version, anio, kilometros } = body || {};
  const fotosArr = Array.isArray(fotos) ? fotos : [];

  const content: any[] = [];
  for (const url of fotosArr) {
    if (typeof url !== "string" || !url.startsWith("http")) continue;
    content.push({ type: "image", source: { type: "url", url } });
  }
  const hayFotos = content.length > 0;

  const prompt = buildPrompt({ marca, modelo, version, anio, kilometros, hayFotos });
  content.push({ type: "text", text: prompt });

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
        max_tokens: 4000,
        messages: [{ role: "user", content }],
      }),
    });
  } catch (e) {
    return json({ error: "No se pudo contactar la API de Anthropic", detail: String(e) }, 502);
  }

  if (!response.ok) {
    const errText = await response.text();
    return json({ error: "Anthropic API error", status: response.status, detail: errText }, 502);
  }

  const data = await response.json();
  const rawText = data?.content?.[0]?.text || "";

  let analisis: any;
  try {
    const cleaned = rawText.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    analisis = JSON.parse(cleaned);
  } catch {
    return json({ error: "No se pudo parsear el análisis de Claude", raw: rawText }, 500);
  }

  return json({ analisis });
});

function buildPrompt(info: any): string {
  const { marca, modelo, version, anio, kilometros, hayFotos } = info;
  if (!hayFotos) {
    return buildPromptSinFotos(info);
  }
  return `Sos un experto tasador de autos usados para un concesionario Volkswagen en Buenos Aires, Argentina. Tu trabajo es ser MUY observador: los vendedores miran por encima, vos tenés que detectar los detalles que ellos pasan por alto.

Datos del vehículo a tasar:
- Marca: ${marca || "—"}
- Modelo: ${modelo || "—"}
- Versión: ${version || "—"}
- Año: ${anio || "—"}
- Kilómetros declarados: ${kilometros || "—"}

## PASO 0 — Pensá primero en el original de fábrica (OBLIGATORIO)

Antes de mirar las fotos, pensá cómo debería lucir un **${marca || "—"} ${modelo || "—"} ${version || "—"} ${anio || "—"}** tal como salió de fábrica:
- ¿Venía en un color sólido entero, o era bicolor de fábrica?
- ¿Qué tipo de llantas originales tenía esa versión (de chapa con tapacubos, de aleación, qué rodado)?
- ¿Qué equipamiento exterior tenía (spoilers, estribos, barras de techo, paragolpes pintados o negros)?
- ¿Qué equipamiento interior era de serie (tapizado de tela o cuero, volante forrado, consola con qué botones)?

Luego mirá las fotos y marcá TODA diferencia con ese original. Las modificaciones no originales (techo pintado de otro color, wrapping, llantas aftermarket, alerones agregados, estéreo tuerca, vinilos, etc.) son MUY relevantes: restan valor para un concesionario oficial porque afectan la originalidad y la reventa.

## PASO 1 — Checklist visual obligatorio

Recorré mentalmente el auto de punta a punta y preguntate:

**Exterior — elementos que pueden faltar o estar dañados:**
- ¿Tiene antena? (en techo o aleta trasera)
- ¿Están los 4 tapacubos o llantas completas? ¿Alguna tiene rayones o está dañada?
- ¿Están todas las manijas de puertas, con sus embellecedores?
- ¿Los logos de marca y modelo (emblemas, badges) están completos?
- ¿Las molduras laterales, burletes de ventanillas, spoilers están en su lugar y bien pegados?
- ¿Los faros y ópticas están enteros, sin roturas ni empañados?
- ¿Retrovisores completos, con sus tapas y vidrios?
- ¿Limpiaparabrisas instalados (delantero y trasero si aplica)?

**Alineación y ensamble de paneles:**
- ¿Paragolpes delantero y trasero están al ras con el resto de la carrocería, o alguno está salido / caído / torcido?
- ¿Capó y baúl cierran parejos, con las luces de separación uniformes?
- ¿Las puertas están al ras? (un panel desalineado suele indicar golpe previo)
- ¿Hay diferencias de tono de pintura entre paneles? (indica repintado parcial)

**Color y pintura — comparación con el original:**
- ¿TODOS los paneles visibles (capó, techo, puertas, baúl, paragolpes, guardabarros) son del MISMO color?
- Si hay algún panel de otro color (típicamente techo negro en un auto blanco, o viceversa), es una MODIFICACIÓN NO ORIGINAL (salvo que la versión venía bicolor de fábrica, caso raro en Argentina).
- Diferencia de textura entre paneles (cáscara de naranja, brillo distinto) = repintado de taller.
- Manchas de pintura, bordes mal terminados alrededor de burletes o molduras = pintura de aficionado.

**Modificaciones no originales (customización):**
- Wrapping (vinilo de color distinto al de fábrica, total o parcial).
- Llantas no originales (buscá rodado más grande, diseño deportivo que no coincida con la versión base).
- Alerones, faldones, estribos, escapes deportivos agregados.
- Stickers grandes, calcos de marcas, vinilos decorativos en capó o costados.
- Luces LED agregadas, tiras de neón, óptica tuneada.
- Escape con salida cromada sobredimensionada.
- Espejos reemplazados por aftermarket.

**Instalaciones / accesorios agregados:**
- ¿El polarizado (si hay) está bien colocado? Mirá si tiene burbujas, cortes en los bordes, o si está mal cortado alrededor del desempañador/ventanillas.
- ¿Stickers, calcos, decoración están prolijos o despegándose?
- ¿Hay accesorios flojos (faldones, alerones aftermarket) o mal instalados?

**Interior:**
- ¿Tapizados con manchas, rasgaduras, desgaste en cordones/costuras?
- ¿Volante con desgaste excesivo en las zonas de agarre?
- ¿Panel de instrumentos con testigos de fallas encendidos?
- ¿Tablero/consola con rayones, piezas faltantes, botones rotos?
- ¿Techo interior (pavilion) caído o con manchas?
- ¿Estéreo original o reemplazado por aftermarket? ¿Hay corte prolijo o se ven cables colgando?

**Daños de chapa y pintura:**
- Rayones, abolladuras (dents), pintura saltada, óxido.
- Diferencia de textura de pintura (cáscara de naranja) indica pintura de taller.

## PASO 2 — Cálculo riguroso de costos

Para CADA hallazgo, antes de poner un monto, pensá:
1. ¿Qué repuesto(s) necesito? Aproximá el precio en ARS (taller independiente, no oficial VW).
2. ¿Cuántas horas de mano de obra? Aplicá las tarifas de abajo.
3. Sumá ambos. No redondees a números exageradamente altos.

**Tarifas de referencia — taller independiente Buenos Aires, inicio 2026:**
- Mecánica general: $18.000 - $22.000 / hora
- Chapa y pintura: $22.000 - $30.000 / hora
- Electricidad automotor: $18.000 - $25.000 / hora
- Tapicería: $15.000 - $20.000 / hora

**Ejemplos de costo realista (ARS) — usalos como piso/techo:**
- Antena nueva + colocación: $20.000 - $35.000
- Tapacubos faltante: $12.000 - $20.000 c/u
- Manija de puerta exterior + colocación: $35.000 - $55.000
- Emblema / logo de marca: $15.000 - $30.000
- Recolocación de polarizado por ventanilla: $30.000 - $50.000
- Alineación de paragolpes (sin daño estructural): $60.000 - $100.000
- Paragolpes reemplazo completo + pintura: $400.000 - $700.000
- Repintado de un panel completo (ej: techo, capó, puerta): $300.000 - $500.000
- Repintado bicolor -> original (ej: techo negro que hay que pasar a color del resto): $400.000 - $700.000 (incluye preparación, pintura, horno)
- Abolladura leve sin pintura: $50.000 - $100.000
- Abolladura con pintura nueva: $150.000 - $300.000
- Rayón de chapa reparable: $40.000 - $80.000
- Limpieza profunda de tapizado manchado: $40.000 - $70.000
- Rasgadura de tapizado (reparación parche): $80.000 - $150.000
- Remover wrapping completo: $200.000 - $400.000
- Remover stickers / calcos grandes: $30.000 - $80.000
- Reemplazo de llantas aftermarket por originales (4 llantas): $800.000 - $1.500.000 (solo si el cliente las acepta, sino se resta valor sin arreglo)

Sé conservador y realista: si dudás entre dos rangos, quedate con el del medio. No infles montos para "cubrirte".

## PASO 3 — Análisis de problemas de fábrica conocidos (independiente de las fotos)

Basándote en tu conocimiento del mercado, analizá si **${marca || "—"} ${modelo || "—"} ${version || "—"} ${anio || "—"}** tiene problemas de fábrica DOCUMENTADOS Y DE CONOCIMIENTO PÚBLICO. Ejemplos de problemas comerciales conocidos en Argentina / LATAM:
- Ford Focus / Fiesta / EcoSport con caja **PowerShift** (doble embrague seco): fallas frecuentes de módulo y embragues, especialmente 2011-2019.
- VW Polo / Golf / Vento / Tiguan con motor **1.4 TSI EA111** (primeras generaciones ~2010-2014): problemas de cadena de distribución y consumo de aceite.
- VW / Audi / Seat con caja **DQ200 DSG 7 velocidades secas** primeras series: fallas de mecatrónica.
- Renault Clio / Logan / Sandero / Duster con caja **CVT Jatco**: fallas prematuras si no se hacen cambios de aceite frecuentes.
- Chevrolet Cruze / Tracker / Cobalt con motor **1.4 Turbo Ecotec** primeras series: consumo de aceite, juntas de admisión.
- Fiat Palio / Siena con motor **1.4 Fire** y cadena: tensores que fallan prematuramente.
- Peugeot / Citroën con motor **1.6 THP** (Prince): consumo de aceite, bomba de alta presión.
- Jeep Renegade / Compass con caja **automática 9 velocidades ZF**: tirones, patinadas.
- Ford Ranger / Amarok / Hilux con inyectores: algunas series con problemas de inyectores a partir de ~150.000 km.
- Toyota Corolla con caja CVT: bastante confiable, pero las primeras series tuvieron algunos problemas.
- BYD / chinos en general: repuestos caros y de larga demora en Argentina (si bien no es "falla de fábrica", afecta la decisión de tomar).

Si el modelo/versión/año CALZA con un problema conocido, reportalo. Si no lo conocés o dudás, NO inventes — mejor un falso verde que un falso rojo.

**Criterios de recomendación (semáforo):**
- **"verde"**: sin problemas de fábrica conocidos, o solo problemas menores y aislados que no son endémicos. Tomar con confianza.
- **"amarillo"**: hay problemas conocidos pero afectan solo algunas unidades, o se mitigan con mantenimiento correcto. Conviene una revisión mecánica antes de cerrar precio.
- **"rojo"**: problema grave y frecuente, endémico de ese modelo/versión/año (tipo PowerShift). No tomar sin revisión exhaustiva, o considerar descuento extra por riesgo.

IMPORTANTE: ante la menor duda, devolvé "verde". El semáforo rojo debe reservarse para casos que seas CAPAZ DE IDENTIFICAR CON CERTEZA.

## PASO 4 — Formato de respuesta

Devolvé EXCLUSIVAMENTE un objeto JSON (sin texto adicional, sin markdown, sin bloques de código) con esta estructura exacta:

{
  "resumen_vendedor": "Texto corto (máx 2 oraciones), neutro, en español rioplatense. SIN mencionar montos ni descuentos. Describí lo más relevante detectado, especialmente si hay modificaciones no originales. Ej: 'Se observa techo repintado en color negro (original era color entero), falta de antena y rayones menores en paragolpes trasero.'",
  "chapa": { "estado": "bueno", "observaciones": "..." },
  "pintura": { "estado": "bueno", "observaciones": "..." },
  "interior": { "estado": "bueno", "observaciones": "..." },
  "tapizado": { "estado": "bueno", "observaciones": "..." },
  "llantas": { "estado": "bueno", "observaciones": "..." },
  "parabrisas": { "estado": "bueno", "observaciones": "..." },
  "kilometraje_tablero": null,
  "modificaciones_no_originales": [
    { "item": "techo repintado en negro", "descripcion": "el ${modelo || "modelo"} ${version || ""} venía color entero de fábrica; el techo fue pintado de otro color. Para dejarlo original: preparación + pintura + horno ~ $500.000 (15 hs chapa y pintura × $25.000 + materiales ~$125.000)", "arreglo_estimado_ars": 500000 }
  ],
  "elementos_faltantes": [
    { "elemento": "antena", "descripcion": "no se ve antena en techo ni aleta trasera. Antena universal ~$15.000 + 0.5 h instalación ~$10.000", "arreglo_estimado_ars": 25000 }
  ],
  "defectos_ensamble": [
    { "panel": "paragolpes trasero", "descripcion": "salido unos mm respecto al guardabarros izquierdo, probable golpe previo. Alineación + revisión de grampas: 3 hs × $25.000 + grampas ~$15.000", "arreglo_estimado_ars": 90000 }
  ],
  "instalaciones_defectuosas": [
    { "item": "polarizado luneta", "descripcion": "burbujas visibles en la mitad inferior, recolocación del polarizado de luneta: 2 hs × $18.000 + lámina ~$10.000", "arreglo_estimado_ars": 46000 }
  ],
  "danios_detectados": [
    { "tipo": "golpe", "ubicacion": "parachoque trasero izquierdo", "descripcion": "abolladura leve con pintura saltada, 4 hs chapa+pintura × $25.000 + materiales ~$80.000", "arreglo_estimado_ars": 180000 }
  ],
  "descuento_total_ars": 841000,
  "problemas_fabrica_conocidos": [
    { "problema": "caja PowerShift", "descripcion": "Los Ford Focus/Fiesta/EcoSport con caja PowerShift (2011-2019) tienen fallas conocidas del módulo de embrague y actuadores. Revisar historial de cambios de módulo antes de tomar.", "severidad": "alto" }
  ],
  "recomendacion": {
    "semaforo": "rojo",
    "motivo": "Versión con caja PowerShift — no tomar sin revisión mecánica completa del sistema de transmisión."
  }
}

## Reglas finales

- "estado" debe ser exactamente uno de: "bueno", "regular", "malo". Si hay modificaciones no originales importantes (techo repintado, wrapping), marcá "pintura" como "regular" aunque la pintura en sí esté bien, porque afecta originalidad.
- Si una sección no se ve en las fotos, poné "estado": "bueno" y "observaciones": "No visible en fotos".
- "kilometraje_tablero" devolvé un número si se ve claramente el odómetro en alguna foto; sino null.
- En el campo "descripcion" de cada item, SIEMPRE incluí un breve desglose del costo (repuesto/materiales + horas × tarifa) para que el tasador pueda auditar el número. No pongas solo el problema, poné también el razonamiento del precio.
- Si NO hay hallazgos en una categoría, devolvé la lista vacía ([]). NO inventes problemas para llenar las listas.
- Si SÍ detectás algo (aunque sea menor), enumeralo. Mejor pecar de detallista: es preferible reportar un detalle chico y que el tasador decida, que dejarlo pasar.
- "descuento_total_ars" tiene que ser la suma exacta de todos los "arreglo_estimado_ars" de modificaciones_no_originales + elementos_faltantes + defectos_ensamble + instalaciones_defectuosas + danios_detectados. NO sumes los problemas de fábrica al descuento (son una alerta, no un arreglo a ejecutar).
- Si no hay nada relevante en ninguna categoría, devolvé todas las listas vacías y "descuento_total_ars": 0.
- "problemas_fabrica_conocidos" es lista vacía [] si el modelo/año no tiene problemas conocidos documentados. NO inventes problemas para llenar la lista.
- "recomendacion.semaforo" debe ser exactamente "verde", "amarillo" o "rojo". Ante duda → "verde".
- Devolvé SOLO el JSON, nada más (ni explicaciones, ni "aquí está el análisis", ni nada).`;
}

function buildPromptSinFotos(info: any): string {
  const { marca, modelo, version, anio, kilometros } = info;
  return `Sos un experto tasador de autos usados para un concesionario Volkswagen en Buenos Aires, Argentina.

Datos del vehículo a tasar:
- Marca: ${marca || "—"}
- Modelo: ${modelo || "—"}
- Versión: ${version || "—"}
- Año: ${anio || "—"}
- Kilómetros declarados: ${kilometros || "—"}

**No hay fotos disponibles** para este vehículo. Tu tarea en este caso es hacer SOLO el análisis del modelo (problemas de fábrica conocidos y recomendación de compra). NO inventes hallazgos visuales.

## Análisis de problemas de fábrica conocidos

Basándote en tu conocimiento del mercado, analizá si **${marca || "—"} ${modelo || "—"} ${version || "—"} ${anio || "—"}** tiene problemas de fábrica DOCUMENTADOS Y DE CONOCIMIENTO PÚBLICO. Ejemplos de problemas comerciales conocidos en Argentina / LATAM:
- Ford Focus / Fiesta / EcoSport con caja **PowerShift** (doble embrague seco): fallas frecuentes de módulo y embragues, especialmente 2011-2019.
- VW Polo / Golf / Vento / Tiguan con motor **1.4 TSI EA111** (primeras generaciones ~2010-2014): problemas de cadena de distribución y consumo de aceite.
- VW / Audi / Seat con caja **DQ200 DSG 7 velocidades secas** primeras series: fallas de mecatrónica.
- Renault Clio / Logan / Sandero / Duster con caja **CVT Jatco**: fallas prematuras si no se hacen cambios de aceite frecuentes.
- Chevrolet Cruze / Tracker / Cobalt con motor **1.4 Turbo Ecotec** primeras series: consumo de aceite, juntas de admisión.
- Fiat Palio / Siena con motor **1.4 Fire** y cadena: tensores que fallan prematuramente.
- Peugeot / Citroën con motor **1.6 THP** (Prince): consumo de aceite, bomba de alta presión.
- Jeep Renegade / Compass con caja **automática 9 velocidades ZF**: tirones, patinadas.
- Ford Ranger / Amarok / Hilux con inyectores: algunas series con problemas de inyectores a partir de ~150.000 km.
- Toyota Corolla con caja CVT: bastante confiable, pero las primeras series tuvieron algunos problemas.
- BYD / chinos en general: repuestos caros y de larga demora en Argentina (si bien no es "falla de fábrica", afecta la decisión de tomar).

Si el modelo/versión/año CALZA con un problema conocido, reportalo. Si no lo conocés o dudás, NO inventes — mejor un falso verde que un falso rojo.

**Criterios de recomendación (semáforo):**
- **"verde"**: sin problemas de fábrica conocidos, o solo problemas menores y aislados que no son endémicos. Tomar con confianza.
- **"amarillo"**: hay problemas conocidos pero afectan solo algunas unidades, o se mitigan con mantenimiento correcto. Conviene una revisión mecánica antes de cerrar precio.
- **"rojo"**: problema grave y frecuente, endémico de ese modelo/versión/año (tipo PowerShift). No tomar sin revisión exhaustiva, o considerar descuento extra por riesgo.

IMPORTANTE: ante la menor duda, devolvé "verde".

## Formato de respuesta

Devolvé EXCLUSIVAMENTE un objeto JSON (sin texto adicional, sin markdown, sin bloques de código) con esta estructura exacta. Como NO hay fotos, todas las secciones visuales y listas de hallazgos visuales deben quedar vacías o con "No visible en fotos":

{
  "resumen_vendedor": "Análisis sin fotos: solo se evalúa el modelo.",
  "chapa": { "estado": "bueno", "observaciones": "No visible en fotos" },
  "pintura": { "estado": "bueno", "observaciones": "No visible en fotos" },
  "interior": { "estado": "bueno", "observaciones": "No visible en fotos" },
  "tapizado": { "estado": "bueno", "observaciones": "No visible en fotos" },
  "llantas": { "estado": "bueno", "observaciones": "No visible en fotos" },
  "parabrisas": { "estado": "bueno", "observaciones": "No visible en fotos" },
  "kilometraje_tablero": null,
  "modificaciones_no_originales": [],
  "elementos_faltantes": [],
  "defectos_ensamble": [],
  "instalaciones_defectuosas": [],
  "danios_detectados": [],
  "descuento_total_ars": 0,
  "problemas_fabrica_conocidos": [
    { "problema": "...", "descripcion": "...", "severidad": "alto/medio/bajo" }
  ],
  "recomendacion": {
    "semaforo": "verde/amarillo/rojo",
    "motivo": "Texto corto explicando el semáforo."
  }
}

## Reglas

- Llená solo "problemas_fabrica_conocidos" y "recomendacion". Todo lo demás vacío.
- "descuento_total_ars" debe ser 0 porque no se evaluaron daños visuales.
- Si no hay problemas de fábrica conocidos → lista vacía [] y semáforo "verde".
- Devolvé SOLO el JSON, nada más.`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
