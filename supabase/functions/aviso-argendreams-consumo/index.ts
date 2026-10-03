// Edge Function: aviso-argendreams-consumo
//
// Le pasa a Valeria Reyna (administracion) lo que gasto en WhatsApp la app del
// tasador de ArgenDreams, para que lo anote y se lo cobremos. Copia a Fer.
// Pedido de Fer el 2-oct-2026: "todos los meses ... el 1er dia habil de cada mes,
// y sumale lo que nunca le pasaste desde que existe la app".
//
// El monto sale de Meta (pricing_analytics de la WABA "ArgenDreams |
// Notificaciones", en pesos, sin impuestos), mes por mes, MENOS lo que haya en
// `argd_consumo_wa.excluir`: hasta el 25-sep-2026 la app le mandaba a Fer una
// copia de cada WhatsApp (WA_BCC_PHONE + notif_admin_bulk) y esas NO se cobran
// (Fer, 2-oct). Desde el 25-sep esas copias no existen.
//
// Corre por pg_cron de lunes a viernes a las 9. Manda si hoy es habil, ya paso el
// 1er dia habil del mes, y hay algun mes cerrado que todavia no se informo. Asi:
//  - sale el 1er dia habil; si ese dia falla (Meta, plantilla), reintenta al otro;
//  - nunca manda dos veces el mismo mes (queda `enviado_at`).
// Los meses anteriores a oct-2026 no salen hasta tener su fila con `excluir`
// cargado (las copias a Fer se calculan aparte): mejor no mandar que cobrar mal.
//
// Deployar con --no-verify-jwt (lo llama pg_cron).
// A mano:  ?dry=1  muestra que mandaria, sin mandar ni escribir
//          ?solo=TEL  manda solo a ese telefono y no marca nada como enviado

const GRAPH = "https://graph.facebook.com/v23.0";
const WABA_ARGD = "1551183599919506";
const PLANTILLA = "argendreams_consumo_whatsapp";
const PRIMER_MES = "2026-05";            // la WABA de ArgenDreams arranco el 28-may-2026
const MES_SIN_COPIAS = "2026-10";        // desde aca no hay copias a Fer que descontar
const DESTINOS = [
  { nombre: "Valeria", tel: "5491162252500" },
  { nombre: "Fer", tel: "5491156559854" },
];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MESES_LARGO = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "octubre", "noviembre", "diciembre"];

Deno.serve(async (req: Request) => {
  const URL_ = Deno.env.get("SUPABASE_URL")!;
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TOKEN = Deno.env.get("WA_TASADOR_TOKEN")!;
  const PHONE = Deno.env.get("WA_TASADOR_PHONE_ID")!;
  const p = new URL(req.url).searchParams;
  const dry = p.get("dry") === "1";
  const solo = p.get("solo");

  const hoy = hoyAR();
  const feriados = new Set(
    (await rest(URL_, KEY, `feriados_ar?select=fecha&fecha=gte.${hoy.slice(0, 7)}-01&limit=100`))
      .map((f: any) => String(f.fecha).slice(0, 10)),
  );
  const habil = (f: string) => {
    const d = new Date(f + "T12:00:00Z").getUTCDay();
    return d !== 0 && d !== 6 && !feriados.has(f);
  };
  let primerHabil = hoy.slice(0, 7) + "-01";
  while (!habil(primerHabil)) primerHabil = sumarDia(primerHabil);
  if (!solo && !dry && (!habil(hoy) || hoy < primerHabil)) {
    return json({ manda: false, motivo: `hoy ${hoy} no toca (1er habil del mes: ${primerHabil})` });
  }

  // Meses cerrados: de PRIMER_MES al mes anterior a hoy.
  const cerrados: string[] = [];
  for (let m = PRIMER_MES; m < hoy.slice(0, 7); m = sumarMes(m)) cerrados.push(m);

  // Costo de Meta por mes (moneda de la cuenta: ARS).
  const desde = Date.parse(PRIMER_MES + "-01T03:00:00Z") / 1000;
  const hasta = Date.parse(hoy.slice(0, 7) + "-01T03:00:00Z") / 1000;
  const u = new URL(`${GRAPH}/${WABA_ARGD}`);
  u.searchParams.set("fields", `pricing_analytics.start(${desde}).end(${hasta}).granularity(MONTHLY)`);
  u.searchParams.set("access_token", TOKEN);
  const meta = await (await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } })).json();
  if (meta?.error) return json({ error: "Meta: " + meta.error.message }, 500);
  const costoMes = new Map<string, number>();
  for (const x of meta?.pricing_analytics?.data?.[0]?.data_points ?? []) {
    const m = new Date((x.start - 3 * 3600) * 1000).toISOString().slice(0, 7);
    costoMes.set(m, (costoMes.get(m) ?? 0) + (x.cost || 0));
  }

  const filas = new Map<string, any>(
    (await rest(URL_, KEY, "argd_consumo_wa?select=*")).map((r: any) => [r.mes, r]),
  );
  const pendientes = cerrados.filter((m) => !filas.get(m)?.enviado_at);
  const sinAjuste = pendientes.filter((m) => m < MES_SIN_COPIAS && !filas.has(m));
  if (sinAjuste.length) {
    return json({ manda: false, motivo: `faltan las copias a Fer a descontar de ${sinAjuste.join(", ")}`, pendientes });
  }
  if (!pendientes.length) return json({ manda: false, motivo: "no hay meses sin informar" });

  const detalle = pendientes.map((m) => {
    const costo = costoMes.get(m) ?? 0;
    const excluir = Number(filas.get(m)?.excluir ?? 0);
    return { mes: m, costo_meta: redondo(costo), excluir, monto: redondo(Math.max(0, costo - excluir)) };
  });
  const total = detalle.reduce((s, d) => s + d.monto, 0);
  const periodo = pendientes.length === 1
    ? `${nombreMes(pendientes[0])}`
    : `${nombreMes(pendientes[0])} a ${nombreMes(pendientes[pendientes.length - 1])}`;
  const porMes = detalle.map((d) => `${MESES[Number(d.mes.slice(5)) - 1]} ${pesos(d.monto)}`).join(" / ");

  if (dry) return json({ dry: true, periodo, total: pesos(total), porMes, detalle });

  const destinos = solo ? [{ nombre: "Prueba", tel: solo.replace(/\D/g, "") }] : DESTINOS;
  const envio = [];
  for (const d of destinos) {
    const res = await fetch(`${GRAPH}/${PHONE}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to: d.tel, type: "template",
        template: {
          name: PLANTILLA, language: { code: "es_AR" },
          components: [{
            type: "body",
            parameters: [d.nombre, periodo, pesos(total), porMes].map((text) => ({ type: "text", text })),
          }],
        },
      }),
    });
    const j = await res.json().catch(() => null);
    envio.push({ a: d.nombre, ok: res.ok, id: j?.messages?.[0]?.id, error: j?.error?.message });
  }
  // Se marca enviado solo si le llego a Valeria (la que cobra).
  const aValeria = envio.find((e) => e.a === "Valeria");
  if (!solo && aValeria?.ok) {
    await rest(URL_, KEY, "argd_consumo_wa?on_conflict=mes", "POST",
      detalle.map((d) => ({
        mes: d.mes, costo_meta: d.costo_meta, excluir: d.excluir,
        motivo_excluir: filas.get(d.mes)?.motivo_excluir ?? null,
        enviado_at: new Date().toISOString(), envio: { total, periodo, envio },
      })),
      "resolution=merge-duplicates,return=minimal");
  }
  return json({ manda: true, periodo, total: pesos(total), porMes, envio });
});

function hoyAR(): string {
  return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
}
function sumarDia(f: string): string {
  return new Date(Date.parse(f + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
}
function sumarMes(m: string): string {
  const [a, mm] = m.split("-").map(Number);
  return mm === 12 ? `${a + 1}-01` : `${a}-${String(mm + 1).padStart(2, "0")}`;
}
function nombreMes(m: string): string {
  return `${MESES_LARGO[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
}
const redondo = (n: number) => Math.round(n * 100) / 100;
const pesos = (n: number) => "$ " + Math.round(n).toLocaleString("es-AR");

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
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
