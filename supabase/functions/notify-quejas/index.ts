// Manda por WhatsApp los avisos del circuito de quejas.
//
// QUE HACE Y QUE NO
// -----------------
// Esta funcion NO decide nada: solo manda. Quien decide a quien se le avisa y
// cuando es `mail-tga/quejas_circuito.py`, que es el unico que lleva el reloj
// (dia habil siguiente, feriados incluidos). Si el calculo viviera en los dos
// lados, el portal y el WhatsApp podrian decir cosas distintas y nadie sabria
// cual mirar.
//
// El que llama manda los avisos ya armados y esta funcion devuelve, uno por
// uno, si salio o no. El que llama marca en la base SOLO los que salieron: si
// Meta falla, la queja queda pendiente y se reintenta en la proxima corrida.
//
//   POST {"avisos":[...]}          -> manda
//   POST {"avisos":[...],"dry":true} -> dice que mandaria, no manda
//   POST {"listar":true}           -> estado del template
//   POST {"crear_template":true}   -> alta del template (una sola vez)
//
// Un aviso con `plantilla: "resumen"` sale por el template del resumen
// semanal de calidad, que tiene otra forma (periodo + detalle) porque el
// de quejas habla de un cliente y el resumen no habla de ninguno.

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const WABA_ID = Deno.env.get("WA_TASADOR_WABA_ID") ?? "1183788370595856";
const TEMPLATE_NAME = "queja_plazo";
const TEMPLATE_RESUMEN = "calidad_resumen_semana";
const PORTAL_URL = Deno.env.get("CALIDAD_PORTAL_URL") ??
  "https://calidad.titogonzalez.online";

// Meta corta los parametros largos y el mensaje queda ilegible.
const MAX_PARAM = 700;

type Aviso = {
  /** E.164 sin +, como los guarda tasador_usuarios. */
  telefono: string;
  /** Nombre de pila, para que el mensaje no arranque en seco. */
  nombre: string;
  /** Que paso: "hay una queja nueva", "vence en 5 horas", "vencio". */
  motivo: string;
  /** Cliente y unidad. */
  quien: string;
  /** El texto de la queja y el vencimiento. */
  detalle: string;
  /** Para poder devolver el resultado atado a la queja. */
  queja_id?: number;
  /** "resumen" usa el template semanal; por defecto, el de quejas. */
  plantilla?: "queja" | "resumen";
  /** Solo para el resumen: "03/09 al 10/09". */
  periodo?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

/** Corta sin dejar una palabra por la mitad. */
function recortar(t: string, max = MAX_PARAM) {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const corte = s.slice(0, max);
  const punto = corte.lastIndexOf(". ");
  if (punto > max * 0.6) return corte.slice(0, punto + 1);
  const espacio = corte.lastIndexOf(" ");
  return (espacio > 0 ? corte.slice(0, espacio) : corte) + "...";
}

/** El template ya cierra la frase: si el texto trae su punto, queda doble. */
function sinPuntoFinal(t: string) {
  return t.replace(/[.\s]+$/, "");
}

async function enviar(phoneId: string, token: string, a: Aviso) {
  const res = await fetch(`${META_API_URL}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: a.telefono, type: "template",
      template: {
        name: TEMPLATE_NAME, language: { code: META_LANGUAGE },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: recortar(a.nombre, 60) },
            { type: "text", text: sinPuntoFinal(recortar(a.motivo, 120)) },
            { type: "text", text: recortar(a.quien, 200) },
            { type: "text", text: sinPuntoFinal(recortar(a.detalle)) },
          ],
        }],
      },
    }),
  });
  const j = await res.json();
  if (!res.ok || j?.error) {
    return { ok: false, error: j?.error?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, id: j?.messages?.[0]?.id };
}

async function enviarResumen(phoneId: string, token: string, a: Aviso) {
  const res = await fetch(`${META_API_URL}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: a.telefono, type: "template",
      template: {
        name: TEMPLATE_RESUMEN, language: { code: META_LANGUAGE },
        components: [{
          type: "body",
          parameters: [
            { type: "text", text: recortar(a.nombre, 60) },
            { type: "text", text: recortar(a.periodo ?? "", 60) },
            { type: "text", text: sinPuntoFinal(recortar(a.detalle)) },
          ],
        }],
      },
    }),
  });
  const j = await res.json();
  if (!res.ok || j?.error) {
    return { ok: false, error: j?.error?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, id: j?.messages?.[0]?.id };
}

async function crearTemplate(token: string) {
  const res = await fetch(`${META_API_URL}/${WABA_ID}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      // UTILITY y no MARKETING: Meta acepta las MARKETING pero no las entrega,
      // y despues no deja recategorizar. Ya paso con las circulares.
      name: TEMPLATE_NAME, language: META_LANGUAGE, category: "UTILITY",
      components: [{
        type: "BODY",
        text: "Hola {{1}}, {{2}}. Cliente: {{3}}. {{4}}. " +
          "Cargá la solución en el portal de Tito Gonzalez.",
        example: {
          body_text: [[
            "Maxi",
            "hay una queja nueva de Postventa para resolver",
            "TEVEZ FRANCO LEONEL, VW Amarok, OR 281002",
            "El sapito no funciona y espera que lo llamen. Vence mañana a las 10:30",
          ]],
        },
      }],
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function listarTemplate(token: string) {
  const res = await fetch(
    `${META_API_URL}/${WABA_ID}/message_templates?fields=name,language,status,category&limit=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await res.json();
  const todas = (j?.data ?? []) as Array<Record<string, unknown>>;
  return { total: todas.length, mio: todas.filter((t) => t.name === TEMPLATE_NAME) };
}

Deno.serve(async (req) => {
  const secreto = Deno.env.get("STOCK_SECRET");
  if (secreto && req.headers.get("x-stock-secret") !== secreto) {
    return json({ error: "no autorizado" }, 401);
  }
  const WA_TOKEN = Deno.env.get("WA_TASADOR_TOKEN");
  const PHONE_ID = Deno.env.get("WA_TASADOR_PHONE_ID");
  if (!WA_TOKEN || !PHONE_ID) return json({ error: "faltan credenciales de WhatsApp" }, 500);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* sin cuerpo: no hay nada que mandar */ }

  if (body?.listar === true) return json(await listarTemplate(WA_TOKEN));
  if (body?.crear_template === true) return json(await crearTemplate(WA_TOKEN));

  const avisos = (body?.avisos ?? []) as Aviso[];
  if (!Array.isArray(avisos) || !avisos.length) {
    return json({ enviados: 0, resultados: [], nota: "nada para mandar" });
  }

  const resultados: Array<Record<string, unknown>> = [];
  for (const a of avisos) {
    if (!a?.telefono) {
      resultados.push({ queja_id: a?.queja_id, ok: false, error: "sin telefono" });
      continue;
    }
    const resumen = a.plantilla === "resumen";
    if (body?.dry === true) {
      resultados.push({
        queja_id: a.queja_id, telefono: a.telefono, ok: true, dry: true,
        texto: resumen
          ? `Hola ${a.nombre}, esto es lo que dejaron las encuestas de calidad ` +
            `del ${a.periodo}.

Detalle: ${sinPuntoFinal(recortar(a.detalle))}` +
            `

El detalle completo esta en el portal de Tito Gonzalez.`
          : `Hola ${a.nombre}, ${sinPuntoFinal(a.motivo)}. Cliente: ${a.quien}. ` +
            `${sinPuntoFinal(recortar(a.detalle))}.`,
      });
      continue;
    }
    const r = resumen
      ? await enviarResumen(PHONE_ID, WA_TOKEN, a)
      : await enviar(PHONE_ID, WA_TOKEN, a);
    resultados.push({ queja_id: a.queja_id, telefono: a.telefono, ...r });
  }
  return json({
    enviados: resultados.filter((r) => r.ok).length,
    fallados: resultados.filter((r) => !r.ok).length,
    portal: PORTAL_URL,
    resultados,
  });
});
