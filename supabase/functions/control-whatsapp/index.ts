// Edge Function: control-whatsapp
//
// Vigia de TODO lo que mandamos por WhatsApp con Meta. Nace del 22-sep-2026: el
// motor de SLA del CRM perdio la memoria de lo que ya habia mandado y repitio los
// mismos avisos cada 10 minutos durante una semana (~4.000 WhatsApp de mas,
// ~US$105). Nadie se entero hasta mirar la factura.
//
// No mira el codigo de cada sistema (son decenas, en varios repos): mira lo que
// Meta dice que salio, que es lo que se cobra. Corre por pg_cron cada hora.
//
//   1) costo    lo gastado HOY en cada cuenta pasa un tope fijo por dia.
//   2) plantilla  una plantilla lleva HOY mas de max(PISO, VECES x su mediana de
//                los ultimos 14 dias). Un aviso que sale 30 veces por dia y hoy
//                va 400 es un error, no un dia movido.
//   3) crm      el motor de SLA dice que mando mas de lo que dejo registrado
//                (la firma exacta del error del 22-sep).
//
// Si algo pasa el limite: UN WhatsApp a Fer y a Matias (ALERTA_ERRORES) con todo
// junto, template `control_automatico_resultado`. Se repite cada REAVISO_HORAS
// mientras siga pasado. Silencio cuando anda todo.
//
// Estado en `wa_control_estado` (una fila por problema).
//
// Deployar SIEMPRE con --no-verify-jwt: el pg_cron la llama sin header de auth.
//   supabase functions deploy control-whatsapp --no-verify-jwt
//
// A mano:  ?dry=1        corre todo y devuelve que avisaria, sin mandar ni escribir
//          ?dia=AAAA-MM-DD  (con dry) mira las plantillas de ese dia: con 2026-09-22 tiene que gritar
//          ?simular=1    inventa un problema para probar el WhatsApp de verdad
//          ?solo=TEL     manda solo a ese telefono (para probar sin molestar a Matias)

const GRAPH = "https://graph.facebook.com/v23.0";

const CUENTAS = [
  // tope = gasto maximo de UN dia en la moneda de la cuenta. Normal al 2-oct-2026:
  // Tasador ~US$7/dia, ArgenDreams ~$3.700/dia, Chat $0 (solo conversaciones gratis).
  { id: "1183788370595856", nombre: "Tito Gonzalez | Tasador", tope: 20, moneda: "US$" },
  { id: "1551183599919506", nombre: "ArgenDreams | Notificaciones", tope: 15000, moneda: "$" },
  { id: "851367000657472", nombre: "Tito Gonzalez Chat", tope: 20, moneda: "AED " },
];

const PISO = 40;          // una plantilla puede mandar hasta esto por dia sin que se mire
const VECES = 4;          // ... o hasta 4 veces su dia normal (mediana de 14 dias)
const CRM_DIFERENCIA = 20; // avisos mandados por el motor y no registrados, en el dia
const REAVISO_HORAS = 6;
const ALERTA_ERRORES = ["fngonzalez", "mlubrano"];
const CONTROL = "envios de WhatsApp (todas las cuentas)";

type Problema = { clave: string; texto: string };

Deno.serve(async (req: Request) => {
  const URL_ = Deno.env.get("SUPABASE_URL")!;
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TOKEN = Deno.env.get("WA_TASADOR_TOKEN");
  const PHONE = Deno.env.get("WA_TASADOR_PHONE_ID");
  if (!TOKEN || !PHONE) return json({ error: "falta WA_TASADOR_TOKEN / WA_TASADOR_PHONE_ID" }, 500);

  const p = new URL(req.url).searchParams;
  const dry = p.get("dry") === "1";
  const simular = p.get("simular") === "1";
  const solo = p.get("solo");

  const hoy0 = inicioDiaAR(new Date());
  const ahora = Math.floor(Date.now() / 1000);
  const problemas: Problema[] = [];
  const lecturas: Record<string, unknown> = {};
  const fallasLectura: string[] = [];

  for (const c of CUENTAS) {
    // 1) costo del dia
    try {
      const r = await graph(TOKEN, `/${c.id}`, {
        fields: `pricing_analytics.start(${hoy0}).end(${ahora}).granularity(DAILY)`,
      });
      const pts = r?.pricing_analytics?.data?.[0]?.data_points ?? [];
      const costo = pts.reduce((s: number, x: any) => s + (x.cost || 0), 0);
      const volumen = pts.reduce((s: number, x: any) => s + (x.volume || 0), 0);
      lecturas[c.nombre] = { costo: redondo(costo), mensajes: volumen };
      if (costo > c.tope) {
        problemas.push({
          clave: `costo|${c.id}`,
          texto: `${c.nombre}: hoy van ${c.moneda}${fmt(costo)} (${volumen} mensajes), el tope es ${c.moneda}${fmt(c.tope)}`,
        });
      }
    } catch (e) {
      fallasLectura.push(`${c.nombre} costo: ${corto(e)}`);
    }

    // 2) por plantilla
    try {
      const plantillas = await listarPlantillas(TOKEN, c.id);
      // OJO: template_analytics corta los dias en UTC (no en hora argentina como
      // pricing_analytics). "Hoy" aca arranca a las 21 hs de Buenos Aires.
      // ?dia=AAAA-MM-DD mira las plantillas de ese dia (para probar contra el 22-sep).
      const dia = p.get("dia");
      const hoyUtc = dia ? Date.parse(dia + "T00:00:00Z") / 1000 : Math.floor(ahora / 86400) * 86400;
      const desde = hoyUtc - 14 * 86400;
      const hasta = Math.min(ahora, hoyUtc + 86400);
      const porDia = new Map<string, Map<number, number>>();
      for (let i = 0; i < plantillas.length; i += 10) {
        const ids = plantillas.slice(i, i + 10).map((t) => t.id);
        const r = await graph(TOKEN, `/${c.id}/template_analytics`, {
          start: String(desde), end: String(hasta), granularity: "DAILY",
          metric_types: '["SENT"]', template_ids: JSON.stringify(ids), limit: "1000",
        });
        for (const blk of r?.data ?? []) {
          for (const x of blk.data_points ?? []) {
            const m = porDia.get(x.template_id) ?? new Map<number, number>();
            m.set(x.start, (m.get(x.start) ?? 0) + (x.sent || 0));
            porDia.set(x.template_id, m);
          }
        }
      }
      const nombre = new Map(plantillas.map((t) => [t.id, t.name]));
      const resumen: Record<string, string> = {};
      for (const [tid, m] of porDia) {
        const hoy = m.get(hoyUtc) ?? 0;
        const previos: number[] = [];
        for (let d = desde; d < hoyUtc; d += 86400) previos.push(m.get(d) ?? 0);
        const normal = mediana(previos);
        const limite = Math.max(PISO, VECES * normal);
        if (hoy) resumen[nombre.get(tid) ?? tid] = `${hoy} (normal ${normal}, limite ${limite})`;
        if (hoy > limite) {
          problemas.push({
            clave: `plantilla|${c.id}|${tid}`,
            texto: `${c.nombre}: la plantilla ${nombre.get(tid)} va ${hoy} envios hoy; un dia normal son ${normal}`,
          });
        }
      }
      lecturas[`${c.nombre} plantillas hoy`] = resumen;
    } catch (e) {
      fallasLectura.push(`${c.nombre} plantillas: ${corto(e)}`);
    }
  }

  // 3) CRM: mandados segun el motor vs registrados en sla_avisos, hoy
  try {
    const desdeIso = new Date(hoy0 * 1000).toISOString();
    const corridas = await rest(URL_, KEY, `sla_corridas?dry=eq.false&corrida_at=gte.${desdeIso}&select=resumen&limit=1000`);
    const mandados = corridas.reduce((s: number, x: any) => s + Number(x.resumen?.avisos_enviados || 0), 0);
    const reg = await rest(URL_, KEY, `sla_avisos?enviado_at=gte.${desdeIso}&ok=eq.true&select=id&limit=5000`);
    lecturas["CRM hoy"] = { mandados_segun_motor: mandados, registrados: reg.length };
    if (mandados - reg.length > CRM_DIFERENCIA) {
      problemas.push({
        clave: "crm|sin_registro",
        texto: `CRM: el motor de SLA mando ${mandados} avisos hoy y solo registro ${reg.length}; esta repitiendo mensajes`,
      });
    }
    const topes = corridas.filter((x: any) => x.resumen?.frenado_por_tope).length;
    if (topes) {
      problemas.push({ clave: "crm|tope", texto: `CRM: ${topes} corridas del motor de SLA quedaron frenadas por el tope hoy` });
    }
  } catch (e) {
    fallasLectura.push(`CRM: ${corto(e)}`);
  }

  if (simular) problemas.push({ clave: "simulado", texto: "PRUEBA: problema inventado para probar este aviso" });

  // Si no pudimos leer nada de Meta, eso tambien es un problema: callar seria
  // igual que estar muerto.
  if (fallasLectura.length >= CUENTAS.length * 2) {
    problemas.push({ clave: "lectura", texto: `No pude leer los datos de Meta: ${fallasLectura[0]}` });
  }

  // Que toca avisar: lo nuevo, y lo viejo cada REAVISO_HORAS.
  const estado = dry ? [] : await rest(URL_, KEY, "wa_control_estado?select=clave,avisado_at");
  const ultimo = new Map(estado.map((e: any) => [e.clave, new Date(e.avisado_at).getTime()]));
  const avisar = problemas.filter((x) => {
    const t = ultimo.get(x.clave);
    return !t || Date.now() - t > REAVISO_HORAS * 3600000;
  });

  let envio: unknown = null;
  if (avisar.length && !dry) {
    const destinos = solo
      ? [{ nombre: "Prueba", tel: solo.replace(/\D/g, "") }]
      : await destinatarios(URL_, KEY);
    const detalle = avisar.map((x) => x.texto).join(" // ");
    envio = [];
    for (const d of destinos) {
      const r = await mandar(TOKEN, PHONE, d.tel, [
        d.nombre, CONTROL,
        `${avisar.length} ${avisar.length === 1 ? "cosa paso" : "cosas pasaron"} el limite de lo normal`,
        detalle.slice(0, 900),
        "Puede ser un sistema mandando mensajes de mas por error. Hay que revisarlo hoy.",
      ]);
      (envio as unknown[]).push({ a: d.nombre, ...r });
    }
    if (!solo && !simular) {
      await rest(URL_, KEY, "wa_control_estado?on_conflict=clave", "POST",
        avisar.map((x) => ({ clave: x.clave, avisado_at: new Date().toISOString(), detalle: x.texto })),
        "resolution=merge-duplicates,return=minimal");
    }
  }

  return json({ dry, problemas, avisados: avisar.map((x) => x.clave), envio, lecturas, fallasLectura });
});

async function destinatarios(url: string, key: string) {
  const filtro = ALERTA_ERRORES.map((u) => `"${u}"`).join(",");
  const rows = await rest(url, key, `vendedores?usuario=in.(${filtro})&select=nombre,telefono`);
  return rows
    .map((r: any) => ({ nombre: r.nombre, tel: normalizar(r.telefono) }))
    .filter((r: any) => r.tel);
}

function normalizar(t: string | null): string | null {
  let d = String(t || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("549")) return d;
  if (d.startsWith("54")) return "549" + d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) return "549" + d;
  return d;
}

async function listarPlantillas(token: string, waba: string) {
  const out: { id: string; name: string }[] = [];
  let r = await graph(token, `/${waba}/message_templates`, { fields: "id,name", limit: "200" });
  while (true) {
    out.push(...(r?.data ?? []));
    const next = r?.paging?.next;
    if (!next) break;
    r = await (await fetch(next, { headers: { "User-Agent": "Mozilla/5.0" } })).json();
  }
  return out;
}

async function graph(token: string, path: string, params: Record<string, string>) {
  const u = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("access_token", token);
  const res = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25000) });
  const j = await res.json();
  if (j?.error) throw new Error(j.error.message);
  return j;
}

async function mandar(token: string, phone: string, to: string, params: string[]) {
  const res = await fetch(`${GRAPH}/${phone}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to, type: "template",
      template: {
        name: "control_automatico_resultado", language: { code: "es_AR" },
        components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text: limpio(text) })) }],
      },
    }),
  });
  const j = await res.json().catch(() => null);
  return { ok: res.ok, id: j?.messages?.[0]?.id, error: j?.error?.message };
}

async function rest(url: string, key: string, path: string, method = "GET", body?: unknown, prefer?: string) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path.split("?")[0]} ${res.status} ${(await res.text()).slice(0, 200)}`);
  return method === "GET" ? await res.json() : null;
}

// Medianoche de hoy en Buenos Aires (UTC-3), en segundos: es como Meta corta los dias.
function inicioDiaAR(d: Date): number {
  const ar = new Date(d.getTime() - 3 * 3600000);
  return Math.floor(Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate()) / 1000) + 3 * 3600;
}

function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Meta rechaza parametros con saltos de linea, tabs o mas de 4 espacios seguidos.
const limpio = (s: string) => s.replace(/[\n\t]+/g, " ").replace(/ {4,}/g, "   ");
const redondo = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => n.toLocaleString("es-AR", { maximumFractionDigits: 2 });
const corto = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 160);
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
