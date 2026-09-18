// Edge Function: notify-fedpat
// Avisa por WhatsApp cuando ganamos una licitación de repuestos de Federación
// Patronal, para que alguien prepare la pieza y la entregue en el plazo prometido.
//
// Pedido de Fer (18-sep-2026): Fer, Catalina, Maxi López, Juan Carlos Caputo y
// Germán Orozco. Los destinatarios salen de `fedpat_avisos_destinatarios` (se
// editan ahí, sin tocar código).
//
// La dispara repuestos-tga/scripts/sync_fedpat.py (GitHub Actions, cada hora):
// ese script lee SELF y marca en `fedpat_ordenes` las órdenes NUEVAS que vienen de
// un pedido de licitación (`avisar = true`). Esta función manda esas y las marca
// con `avisado_en`, así un reintento no duplica. Los siniestros que entran por
// taller (tipo OR) nunca se marcan para avisar.
//
// - Autenticación: header x-stock-secret == STOCK_NOTIF_SECRET.
// - Template Meta `fedpat_licitacion_ganada` (UTILITY, es_AR): {{1}} primer
//   nombre, {{2}} orden y pieza, {{3}} detalle. Mientras Meta no lo apruebe, cae
//   a `precios_actualizados` con el aviso entero en {{1}}.
//
//   POST {}                         -> manda lo pendiente
//   POST {"dry":true}               -> muestra qué mandaría, sin mandar
//   POST {"solo":"549115..."}       -> manda lo pendiente SOLO a ese número (no marca)
//   POST {"prueba":true,"solo":...} -> manda un aviso de prueba inventado a ese número
//   POST {"listar":true}            -> estado de los templates
//   POST {"crear_template":true}    -> alta del template (una sola vez)

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";
const TEMPLATE_NAME = "fedpat_licitacion_ganada";
const TEMPLATE_FALLBACK = "precios_actualizados";
const WABA_ID = Deno.env.get("WA_TASADOR_WABA_ID") ?? "1183788370595856";
const PORTAL = "repuestos.titogonzalez.online";
const MAX_POR_CORRIDA = 6;

type Orden = {
  id: number; orden: string; renglon: string | null; vehiculo: string | null; patente: string | null;
  centro: string | null; f_generacion: string | null; oferta_id: number | null;
};
type Oferta = { id: number; precio: number; origen_stock: string | null; entrega: string | null; numero_ofertado: string | null };

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const WA_PHONE_ID = Deno.env.get("WA_TASADOR_PHONE_ID");
  const WA_TOKEN = Deno.env.get("WA_TASADOR_TOKEN");
  const STOCK_SECRET = Deno.env.get("STOCK_NOTIF_SECRET");
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "SUPABASE env vars missing" }, 500);
  if (!WA_PHONE_ID || !WA_TOKEN) return json({ error: "WA_TASADOR env vars missing" }, 500);
  if (!STOCK_SECRET) return json({ error: "STOCK_NOTIF_SECRET missing" }, 500);
  if (req.headers.get("x-stock-secret") !== STOCK_SECRET) return json({ error: "secret inválido" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* body opcional */ }

  if (body?.crear_template === true) {
    return json(await postJson(`${META_API_URL}/${WABA_ID}/message_templates`, WA_TOKEN, {
      name: TEMPLATE_NAME, language: META_LANGUAGE, category: "UTILITY", components: TEMPLATE_COMPONENTS,
    }));
  }
  if (body?.listar === true) {
    const res = await fetch(
      `${META_API_URL}/${WABA_ID}/message_templates?fields=name,status,category,components&limit=200`,
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } },
    );
    const j = await res.json();
    return json((j?.data ?? []).filter((t: any) => [TEMPLATE_NAME, TEMPLATE_FALLBACK].includes(t.name)));
  }

  const dry = body?.dry === true;
  const solo = String(body?.solo || "").replace(/\D/g, "");

  // Qué avisar
  let items: { orden: Orden; oferta?: Oferta }[] = [];
  if (body?.prueba === true) {
    if (!solo) return json({ error: "la prueba necesita 'solo'" }, 400);
    items = [{
      orden: { id: 0, orden: "PRUEBA", renglon: "PARAGOLPES DELANTERO", vehiculo: "VW GOL 1.6 5 P. TREND L/13",
               patente: "AA000AA", centro: "CAPITAL - ZONA CABA 2", f_generacion: null, oferta_id: null },
      oferta: { id: 0, precio: 513427.94, origen_stock: "propio", entrega: "2026-09-22", numero_ofertado: "5U0-807-221-J -GRU" },
    }];
  } else {
    try {
      const ordenes: Orden[] = await sb(SUPABASE_URL, SERVICE_KEY,
        "fedpat_ordenes?avisar=is.true&avisado_en=is.null&es_licitacion=is.true" +
        "&select=id,orden,renglon,vehiculo,patente,centro,f_generacion,oferta_id" +
        `&order=f_generacion.asc&limit=${MAX_POR_CORRIDA}`);
      const ids = [...new Set(ordenes.map((o) => o.oferta_id).filter(Boolean))];
      const ofertas: Oferta[] = ids.length ? await sb(SUPABASE_URL, SERVICE_KEY,
        `fedpat_ofertas?id=in.(${ids.join(",")})&select=id,precio,origen_stock,entrega,numero_ofertado`) : [];
      const porId = new Map(ofertas.map((o) => [o.id, o]));
      items = ordenes.map((o) => ({ orden: o, oferta: o.oferta_id ? porId.get(o.oferta_id) : undefined }));
    } catch (e) {
      return json({ error: "Error leyendo órdenes", detalle: String(e) }, 500);
    }
  }
  if (!items.length) return json({ ok: true, enviados: 0, info: "nada pendiente" });

  // A quién
  let destinatarios: { nombre: string; telefono: string }[] = [];
  if (solo) {
    destinatarios = [{ nombre: "equipo", telefono: solo }];
  } else {
    try {
      destinatarios = await sb(SUPABASE_URL, SERVICE_KEY, "fedpat_avisos_destinatarios?activo=eq.true&select=nombre,telefono");
    } catch (e) {
      return json({ error: "Error leyendo destinatarios", detalle: String(e) }, 500);
    }
  }
  if (!destinatarios.length) return json({ error: "sin destinatarios" }, 500);

  const resultados: any[] = [];
  for (const { orden, oferta } of items) {
    const pieza = limpiar([
      `orden ${orden.orden}`,
      `${orden.renglon || "repuesto"} para ${orden.vehiculo || "vehículo sin dato"}${orden.patente ? " (" + orden.patente + ")" : ""}`,
    ].join(" · "));
    const detalle = sinPuntoFinal(limpiar(oferta
      ? `Ofertamos ${money(oferta.precio)} sin IVA${oferta.numero_ofertado ? " (" + oferta.numero_ofertado.replace(/\s+/g, " ") + ")" : ""}, ` +
        `${oferta.origen_stock === "propio" ? "con stock NUESTRO" : "con stock de VW (hay que pedirla)"}, ` +
        `entrega prometida ${fecha(oferta.entrega)}. Siniestro en ${orden.centro || "sin dato"}`
      : `La oferta no se cargó desde el sistema: revisar precio y plazo en SELF. Siniestro en ${orden.centro || "sin dato"}`));

    if (dry) { resultados.push({ orden: orden.orden, pieza, detalle, a: destinatarios.map((d) => d.nombre) }); continue; }

    let algunoOk = false;
    const vistos = new Set<string>();
    for (const d of destinatarios) {
      const tel = String(d.telefono || "").replace(/\D/g, "");
      if (!tel || vistos.has(tel)) continue;
      vistos.add(tel);
      const nombre = (String(d.nombre || "").split(/\s+/)[0] || "equipo").trim();
      const r = await enviar(WA_PHONE_ID, WA_TOKEN, tel, nombre, pieza, detalle);
      resultados.push({ orden: orden.orden, destinatario: d.nombre, ...r });
      if (r.ok) algunoOk = true;
    }
    // se marca solo si salió a alguien y no es una prueba ni un envío dirigido
    if (algunoOk && !solo && orden.id) {
      await sbPatch(SUPABASE_URL, SERVICE_KEY, `fedpat_ordenes?orden=eq.${orden.orden}&avisar=is.true`,
        { avisado_en: new Date().toISOString() });
    }
  }
  return json({ ok: true, dry, avisos: items.length, resultados });
});

async function enviar(phoneId: string, token: string, tel: string, nombre: string, pieza: string, detalle: string) {
  const propio = await postMeta(phoneId, token, tel, TEMPLATE_NAME, [nombre, recortar(pieza, 250), recortar(detalle, 700)]);
  if (propio.ok) return { ...propio, template: TEMPLATE_NAME };
  const code = propio.error?.code;
  const noExiste = code === 132001 || code === 132000 || code === 132015 || code === 132012;
  if (!noExiste) return { ...propio, template: TEMPLATE_NAME };
  const texto = recortar(`🏆 LICITACIÓN GANADA — Fed. Patronal: ${pieza}. ${detalle}. Hay que preparar la pieza y entregarla en el plazo prometido. Detalle en ${PORTAL}`, 900);
  const fb = await postMeta(phoneId, token, tel, TEMPLATE_FALLBACK, [texto]);
  return { ...fb, template: TEMPLATE_FALLBACK };
}

async function postMeta(phoneId: string, token: string, tel: string, template: string, params: string[]) {
  try {
    const res = await fetch(`${META_API_URL}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to: tel, type: "template",
        template: { name: template, language: { code: META_LANGUAGE },
          components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] },
      }),
    });
    const j = await res.json();
    if (res.ok && j.messages && j.messages[0]) return { ok: true, meta_id: j.messages[0].id };
    return { ok: false, error: j.error || j };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// {{1}} primer nombre · {{2}} orden y pieza · {{3}} detalle. Redactado como un
// registro propio que pide una acción (así Meta lo clasifica UTILITY y se entrega).
const TEMPLATE_COMPONENTS = [{
  type: "BODY",
  text: "Hola {{1}}, Federación Patronal generó en SELF una orden de servicio a nombre de Tito González " +
    "por un pedido que licitamos: {{2}}. {{3}}. Hay que preparar la pieza y entregarla en el plazo prometido; " +
    "el detalle está en el portal de Repuestos.",
  example: { body_text: [[
    "Juan Carlos",
    "orden 6123456 · PARAGOLPES DELANTERO para VW GOL 1.6 5 P. TREND L/13 (AB123CD)",
    "Ofertamos $ 513.427,94 sin IVA (5U0-807-221-J GRU), con stock NUESTRO, entrega prometida 22/09/2026. Siniestro en CAPITAL - ZONA CABA 2",
  ]] },
}];

async function postJson(url: string, token: string, payload: unknown) {
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                                 body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json() };
}
async function sb(url: string, key: string, path: string) {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return await res.json();
}
async function sbPatch(url: string, key: string, path: string, body: unknown) {
  const res = await fetch(`${url}/rest/v1/${path}`, { method: "PATCH", body: JSON.stringify(body),
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" } });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}
// Meta rechaza saltos de línea dentro de un parámetro.
function limpiar(s: unknown) { return String(s ?? "").replace(/\s+/g, " ").trim(); }
function sinPuntoFinal(s: string) { return s.replace(/\s*\.+\s*$/, ""); }
function recortar(s: string, max: number) { return s.length <= max ? s : s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…"; }
function money(v: number) { return "$ " + Number(v).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fecha(iso: string | null) { return iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "sin fecha"; }
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
