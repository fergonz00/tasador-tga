// Edge Function: notify-github
// Vigía de las automatizaciones que corren en GitHub Actions.
//
// Por qué vive acá y no en GitHub (Fer, 28-09-2026): el 27/09 a la noche GitHub
// frenó la cuenta entera por un problema de facturación y durante 18 horas no
// corrió NINGÚN control (compras de repuestos, ML, mail-tga, stock de fábrica,
// competencia). Los avisos de "falló el control" que tienen los propios
// workflows adentro tampoco salieron, porque el runner nunca llega a arrancar.
// Un vigía dentro de GitHub no sirve para esto: éste corre en Supabase (pg_cron)
// y mira GitHub desde afuera.
//
// Qué avisa (decisión de Fer, 28-09-2026: sólo cuando se corta todo, sin ruido):
//   1. La cuenta frenada: corridas que fallan sin arrancar (job de pocos
//      segundos y cero pasos). Se confirma leyendo las anotaciones del check-run,
//      que es donde GitHub deja el motivo real ("recent account payments have
//      failed or your spending limit needs to be increased"); en el log no está.
//   2. Silencio: ninguna corrida exitosa en las últimas HORAS_SIN_EXITO horas.
//      Medido sobre 7 días reales, el hueco normal más largo es 5,6 h (de
//      madrugada), así que 6 h ya es anormal. No cuentan los deploys de GitHub
//      Pages: ésos siguen andando aunque Actions esté frenado y taparían el corte.
//   3. El token de GitHub vencido o sin permisos (si no, el vigía se queda ciego
//      y el silencio parece calma).
//   4. El consumo del mes contra el tope de gasto (Fer, 28-09-2026: tope de
//      US$50/mes, avisar al 80% y al 90% "así lo vemos con anticipación"). El
//      100% ya lo cubre la señal 1: cuando el tope se llena, GitHub frena la
//      cuenta y las corridas empiezan a fallar sin arrancar.
//
// Vuelve a avisar cada HORAS_REPETIR mientras siga caído, y manda un aviso
// cuando se recupera. Entre las 23 y las 7 no manda nada: queda para la primera
// corrida de la mañana (de noche no se destraba igual).
//
// - Autenticación: header x-stock-secret == STOCK_NOTIF_SECRET.
// - Estado en `github_vigia` (wjfgl), una sola fila (clave = 'cuenta').
// - El WhatsApp lo manda notify-ml-excepciones con el template
//   `control_automatico_resultado` (UTILITY, aprobado). Destinatarios: env
//   GITHUB_VIGIA_DESTINATARIOS (default "fngonzalez,mlubrano" — Fer y Matías).
// - Necesita el secret GITHUB_TOKEN (PAT de GitHub con acceso a los repos privados;
//   el mismo de C:\proyectos\.secrets\github.env). También acepta GH_TOKEN.
//
//   POST {}                  -> chequea y avisa si corresponde
//   POST {"dry":true}        -> dice qué haría, sin mandar ni tocar el estado
//   POST {"forzar":true}     -> ignora el horario y el "ya avisé"
//   POST {"prueba":true,"solo":"549..."} -> manda un aviso de ejemplo a ese número

const GH_API = "https://api.github.com";
const GH_USER = Deno.env.get("GH_USUARIO") ?? "fergonz00";
const HORAS_SIN_EXITO = Number(Deno.env.get("GITHUB_VIGIA_HORAS") ?? 6);
const HORAS_REPETIR = 6;
const VENTANA_HORAS = 30; // corridas que se miran
const SIN_ARRANCAR_SEG = 15; // primer filtro: un job que "falla" en menos de esto es sospechoso
const MAX_CONFIRMAR = 8; // cuántas de esas se confirman contra la API (una llamada cada una)
const DESDE_HORA = 7; // horario en que se puede mandar (hora argentina)
const HASTA_HORA = 23;
const HORAS_SIN_CONEXION = 1; // sin conexión con GitHub: avisa recién si dura esto
const DESTINATARIOS = Deno.env.get("GITHUB_VIGIA_DESTINATARIOS") ?? "fngonzalez,mlubrano";

// Tope de gasto y umbrales de aviso. GitHub NO nos deja leer los dólares:
// /users/<u>/settings/billing/usage da 404 con este token (pide permiso de
// "Plan", que un PAT de repo+workflow no tiene). Así que el gasto se ESTIMA
// sumando la duración de cada corrida de los repos PRIVADOS del mes, redondeada
// al minuto para arriba, que es como factura GitHub. Los repos públicos no
// cuentan: ahí Actions es gratis e ilimitado.
// ⚠️ La estimación queda por arriba: las corridas que esperan por `concurrency:`
// suman tiempo de cola, que GitHub no cobra. Y el precio por minuto va por env
// porque no está confirmado (0,008 en el tarifario que miré yo, 0,006 en el de
// Fer): queda el más caro, así el aviso llega antes y no después.
const PRESUPUESTO_USD = Number(Deno.env.get("GITHUB_PRESUPUESTO_USD") ?? 50);
const PRECIO_MINUTO = Number(Deno.env.get("GITHUB_PRECIO_MINUTO") ?? 0.008);
const MINUTOS_GRATIS = Number(Deno.env.get("GITHUB_MINUTOS_GRATIS") ?? 2000);
const AVISAR_EN = (Deno.env.get("GITHUB_AVISAR_EN") ?? "80,90").split(",").map(Number)
  .filter((n) => n > 0).sort((a, b) => a - b);
const HORAS_ENTRE_CONSUMO = Number(Deno.env.get("GITHUB_HORAS_CONSUMO") ?? 1);

type Run = {
  id: number;
  name: string;
  repo: string;
  conclusion: string | null;
  run_started_at: string | null;
  updated_at: string;
  jobId?: number;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const STOCK_SECRET = Deno.env.get("STOCK_NOTIF_SECRET");
  const GH_TOKEN = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN");
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "SUPABASE env vars missing" }, 500);
  if (!STOCK_SECRET) return json({ error: "STOCK_NOTIF_SECRET missing" }, 500);
  if (req.headers.get("x-stock-secret") !== STOCK_SECRET) return json({ error: "secret inválido" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* body opcional */ }
  const dry = body?.dry === true;
  const forzar = body?.forzar === true;

  if (body?.prueba === true) {
    const r = await avisar(SUPABASE_URL, STOCK_SECRET, {
      resumen: "PRUEBA. Hace 13 horas que no corre ninguna automatización: GitHub frenó la cuenta",
      detalle:
        "Prueba del vigía. La última que corrió bien fue el domingo a las 21:36. Fallaron 12 corridas de repuestos-tga, mail-tga, tienda-repuestos y portal-precios sin llegar a arrancar",
      accion: "Es una prueba, no hay que hacer nada",
    }, body?.solo ? String(body.solo) : null);
    return json({ prueba: true, ...r });
  }

  if (!GH_TOKEN) {
    return await resolver(SUPABASE_URL, SERVICE_KEY, STOCK_SECRET, {
      caida: true,
      clave: "sin-token",
      resumen: "el vigía de GitHub se quedó sin token y no puede ver si los controles están corriendo",
      detalle: "Falta el secret GITHUB_TOKEN en la función notify-github",
      accion: "Generá un token nuevo en GitHub y cargalo con supabase secrets set GITHUB_TOKEN",
      // Mientras el vigía todavía no arrancó nunca (no hay fila de estado), esto
      // no se avisa: sería un WhatsApp por algo que nadie prendió todavía.
      soloSiYaAndaba: true,
    }, { dry, forzar });
  }

  // ---- corridas de las últimas horas, repo por repo
  const desdeISO = new Date(Date.now() - VENTANA_HORAS * 3600_000).toISOString();
  let repos: string[];
  // Para el consumo van TODOS los privados, sin el filtro de 4 meses: un repo
  // que sólo tiene cron puede gastar minutos sin que nadie le haga un push.
  let privados: string[] = [];
  try {
    const rs = await gh<Array<Record<string, string>>>(GH_TOKEN, "/user/repos?per_page=100&sort=pushed&affiliation=owner");
    const limite = Date.now() - 120 * 24 * 3600_000; // repos tocados en los últimos 4 meses
    repos = rs.filter((r) => new Date(r.pushed_at ?? 0).getTime() > limite).map((r) => r.full_name);
    privados = rs.filter((r) => String(r.private) === "true").map((r) => r.full_name);
  } catch (e) {
    if (esErrorDeToken(e)) {
      return await resolver(SUPABASE_URL, SERVICE_KEY, STOCK_SECRET, {
        caida: true,
        clave: "token",
        resumen: "el vigía no puede entrar a GitHub, así que no sabe si los controles están corriendo",
        detalle: "GitHub rechazó el token: " + String(e).slice(0, 200),
        accion: "Revisá el token de GitHub (secret GITHUB_TOKEN de la función notify-github): si venció, generá uno nuevo",
        soloSiYaAndaba: true,
      }, { dry, forzar });
    }
    // No hubo conexión (o GitHub dio error de su lado) aun después de reintentar.
    // No es el token: se avisa sólo si sigue así HORAS_SIN_CONEXION seguidas.
    return await resolver(SUPABASE_URL, SERVICE_KEY, STOCK_SECRET, {
      caida: true,
      clave: "sin-conexion",
      resumen: "el vigía no logra conectarse con GitHub hace más de " + HORAS_SIN_CONEXION +
        " h, así que no sabe si los controles están corriendo",
      detalle: "No es el token: la conexión no llega. Último error: " + String(e).slice(0, 200),
      accion: "Mirá githubstatus.com. Si GitHub anda bien, avisá para revisar la conexión desde Supabase",
      soloSiYaAndaba: true,
      minHoras: HORAS_SIN_CONEXION,
    }, { dry, forzar });
  }

  const runs: Run[] = [];
  for (const full of repos) {
    try {
      const j = await gh<{ workflow_runs?: Array<Record<string, never>> }>(
        GH_TOKEN,
        "/repos/" + full + "/actions/runs?per_page=50&created=%3E" + desdeISO,
      );
      for (const x of j.workflow_runs ?? []) {
        const r = x as unknown as Record<string, string>;
        runs.push({
          id: Number(r.id),
          name: r.name ?? "",
          repo: full.split("/")[1],
          conclusion: r.conclusion,
          run_started_at: r.run_started_at,
          updated_at: r.updated_at,
        });
      }
    } catch { /* un repo que no contesta no puede tumbar el chequeo */ }
  }

  const ahora = Date.now();
  // Los deploys de GitHub Pages siguen andando con la cuenta frenada: no cuentan como señal de vida.
  const vivos = runs.filter((r) => r.conclusion === "success" && !/pages/i.test(r.name))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const ultimoExito = vivos.length ? new Date(vivos[0].updated_at).getTime() : 0;
  const horasSinExito = ultimoExito ? (ahora - ultimoExito) / 3600_000 : VENTANA_HORAS;

  // ⚠️ Sólo cuentan las que fallaron DESPUES de la última corrida buena. Si algo
  // corrió bien más tarde, la cuenta está andando y esas fallas ya son historia.
  // Sin esto, el 28-09 el vigía seguía gritando "cuenta frenada" durante 12 horas
  // después de que Fer destrabara el pago y todo volviera a correr.
  const candidatos = runs.filter((r) =>
    r.conclusion === "failure" && r.run_started_at &&
    (new Date(r.updated_at).getTime() - new Date(r.run_started_at).getTime()) / 1000 <= SIN_ARRANCAR_SEG &&
    (ahora - new Date(r.updated_at).getTime()) / 3600_000 <= HORAS_SIN_EXITO * 2 &&
    new Date(r.updated_at).getTime() > ultimoExito
  ).sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  // ⚠️ Durar pocos segundos NO alcanza para decir que nunca arrancó. El 29-09-2026
  // el control de nombres de tienda-repuestos moría en 13 segundos porque el script
  // reventaba en el import, y el vigía lo leyó como "GitHub frenó la cuenta". Lo que
  // de verdad las distingue es la cantidad de PASOS: al que nunca arrancó el runner
  // no lo tomó nunca y el job vuelve con cero pasos; al que arrancó y se cayó se le
  // ven todos (Set up job, checkout, el paso que falló, Complete job).
  const sinArrancar: Run[] = [];
  for (const r of candidatos.slice(0, MAX_CONFIRMAR)) {
    try {
      const jobs = await gh<{ jobs?: Array<{ id: number; steps?: unknown[] }> }>(
        GH_TOKEN,
        "/repos/" + GH_USER + "/" + r.repo + "/actions/runs/" + r.id + "/jobs",
      );
      const j = jobs.jobs?.[0];
      if (j && (j.steps ?? []).length === 0) sinArrancar.push({ ...r, jobId: j.id });
    } catch { /* si GitHub no contesta por una corrida, no invento una caída */ }
  }

  // El motivo real está en las anotaciones del check-run, no en el log (que viene vacío).
  let motivo = "";
  if (sinArrancar.length && sinArrancar[0].jobId) {
    const r = sinArrancar[0];
    try {
      const an = await gh<Array<{ annotation_level: string; message: string }>>(
        GH_TOKEN,
        "/repos/" + GH_USER + "/" + r.repo + "/check-runs/" + r.jobId + "/annotations",
      );
      motivo = (an.find((a) => a.annotation_level === "failure")?.message ?? "").trim();
    } catch { /* si no se puede leer, alcanza con el síntoma */ }
  }

  const facturacion = /payment|spending limit|billing/i.test(motivo);
  // El silencio se afirma aparte: si algo corrió bien hace un rato, decir "no corre
  // ninguna automatización" es mentira y hace perder tiempo buscando donde no es.
  const silencio = horasSinExito >= HORAS_SIN_EXITO;
  const caida = sinArrancar.length > 0 || silencio;
  const afectados = [...new Set(sinArrancar.map((r) => r.repo))];
  const yNoCorre = silencio ? " y hace " + hs(horasSinExito) + " que no corre ninguna automatización" : "";

  const resumen = !caida ? "" : facturacion
    ? "GitHub frenó la cuenta" + yNoCorre
    : sinArrancar.length
    ? sinArrancar.length + (sinArrancar.length === 1 ? " corrida falló" : " corridas fallaron") +
      " sin llegar a arrancar" + yNoCorre
    : "hace " + hs(horasSinExito) + " que no corre ninguna automatización";

  const detalle = !caida ? "" : [
    ultimoExito
      ? "La última que corrió bien fue " + cuando(ultimoExito) + " (" + vivos[0].repo + ")"
      : "No hubo ninguna corrida buena en las últimas " + VENTANA_HORAS + " horas",
    afectados.length ? "Fallan sin arrancar: " + afectados.slice(0, 6).join(", ") : "",
    motivo ? "GitHub dice: " + motivo.replace(/\s+/g, " ").slice(0, 220) : "",
  ].filter(Boolean).join(". ");

  const accion = !caida ? "" : facturacion
    ? "Entrá a GitHub, Settings, Billing & plans y destrabá el pago o subí el límite de gasto. Hasta que eso no se resuelva no corre ningún control automático"
    : "Mirá la solapa Actions en GitHub. Mientras esté así no corre ningún control automático";

  // Señal 4: el consumo del mes contra el tope. Va aparte de la caída, porque
  // puede estar todo corriendo bien y aun así convenir avisar que el gasto se
  // acerca al límite: eso es lo que Fer quiere ver con anticipación.
  const horaAhora = (new Date().getUTCHours() + 21) % 24;
  let consumo: Record<string, unknown>;
  try {
    consumo = await mirarConsumo(GH_TOKEN, SUPABASE_URL, SERVICE_KEY, STOCK_SECRET, privados, {
      dry,
      forzar,
      enHorario: horaAhora >= DESDE_HORA && horaAhora < HASTA_HORA,
    });
  } catch (e) {
    // Que un error midiendo el gasto no tumbe el vigía: la señal 1 es la importante.
    consumo = { error: String(e).slice(0, 200) };
  }

  return await resolver(SUPABASE_URL, SERVICE_KEY, STOCK_SECRET, {
    caida,
    clave: facturacion ? "facturacion" : sinArrancar.length ? "no-arranca" : "silencio",
    resumen,
    detalle,
    accion,
  }, {
    dry,
    forzar,
    extra: {
      repos: repos.length,
      corridas: runs.length,
      horas_sin_exito: Number(horasSinExito.toFixed(1)),
      sin_arrancar: sinArrancar.length,
      motivo,
      consumo,
    },
  });
});

// ---------------------------------------------------------------- estado y aviso
type Fila = { estado: string; avisado_en: string | null; desde: string | null; anduvo: boolean };

type Estado = {
  caida: boolean;
  clave: string;
  resumen: string;
  detalle: string;
  accion: string;
  soloSiYaAndaba?: boolean;
  /** No avisa hasta que la caída lleve estas horas seguidas (para cortes sueltos de red). */
  minHoras?: number;
};

async function resolver(
  url: string,
  key: string,
  secret: string,
  e: Estado,
  o: { dry: boolean; forzar: boolean; extra?: Record<string, unknown> },
) {
  const filas = await sb<Fila[]>(url, key, "github_vigia?clave=eq.cuenta&select=*");
  const prev: Fila = filas[0] ?? { estado: "ok", avisado_en: null, desde: null, anduvo: false };
  const ahora = new Date();
  const horaAr = (ahora.getUTCHours() + 21) % 24; // Argentina = UTC-3
  const enHorario = horaAr >= DESDE_HORA && horaAr < HASTA_HORA;
  const nuevo = e.caida ? "caida" : "ok";
  const cambio = prev.estado !== nuevo;
  const desdeAviso = prev.avisado_en ? (ahora.getTime() - new Date(prev.avisado_en).getTime()) / 3600_000 : Infinity;

  // `anduvo` se prende la primera vez que el vigia pudo leer GitHub de verdad.
  // Hasta entonces no avisa que esta ciego: seria un WhatsApp por algo que nadie
  // prendio todavia (el secret recien se carga).
  const anduvo = prev.anduvo === true;

  let manda: false | "caida" | "recuperada" = false;
  if (e.caida && (o.forzar || ((cambio || desdeAviso >= HORAS_REPETIR) && enHorario))) manda = "caida";
  if (manda === "caida" && e.soloSiYaAndaba && !anduvo) manda = false;
  // La caída cuenta desde que empezó (aunque haya arrancado con otro motivo).
  const desdeCaida = prev.estado === "caida" && prev.desde ? new Date(prev.desde).getTime() : ahora.getTime();
  const horasCaida = (ahora.getTime() - desdeCaida) / 3600_000;
  if (manda === "caida" && e.minHoras && horasCaida < e.minHoras && !o.forzar) manda = false;
  if (!e.caida && prev.estado === "caida" && prev.avisado_en) manda = "recuperada";

  const plan = {
    estado: nuevo,
    clave: e.clave,
    manda,
    en_horario: enHorario,
    resumen: e.resumen,
    detalle: e.detalle,
    ...(o.extra ?? {}),
  };
  if (o.dry) return json({ dry: true, ...plan });

  let envio: unknown = null;
  if (manda === "caida") {
    envio = await avisar(url, secret, { resumen: e.resumen, detalle: e.detalle, accion: e.accion }, null);
  } else if (manda === "recuperada") {
    const desde = prev.desde ? " Estuvo cortado desde " + cuando(new Date(prev.desde).getTime()) + "." : "";
    envio = await avisar(url, secret, {
      resumen: "las automatizaciones volvieron a correr",
      detalle: "GitHub está andando otra vez." + desde +
        " Lo que tenía que correr mientras estuvo frenado no se recupera solo",
      accion: "Si algún control tenía que haber corrido en ese rato, conviene dispararlo a mano",
    }, null);
  }

  await sbUpsert(url, key, "github_vigia", {
    clave: "cuenta",
    estado: nuevo,
    motivo: e.clave,
    detalle: [e.resumen, e.detalle].filter(Boolean).join(". ").slice(0, 900) || null,
    desde: e.caida ? (prev.estado === "caida" && prev.desde ? prev.desde : ahora.toISOString()) : null,
    avisado_en: manda === "caida" ? ahora.toISOString() : (e.caida ? prev.avisado_en : null),
    anduvo: anduvo || !["sin-token", "token", "sin-conexion"].includes(e.clave),
    chequeado_en: ahora.toISOString(),
  });
  return json({ ...plan, envio });
}

/** El WhatsApp sale por notify-ml-excepciones (template control_automatico_resultado). */
async function avisar(
  url: string,
  secret: string,
  t: { resumen: string; detalle: string; accion: string },
  solo: string | null,
) {
  const r = await fetch(url + "/functions/v1/notify-ml-excepciones", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-stock-secret": secret },
    body: JSON.stringify({
      tipo: "resultado",
      control: "GitHub, donde corren los controles automáticos",
      resumen: t.resumen,
      detalle: t.detalle,
      accion: t.accion,
      cantidad: "1",
      ...(solo ? { solo } : { usuarios: DESTINATARIOS }),
    }),
  });
  return { status: r.status, respuesta: await r.json().catch(() => null) };
}

// ------------------------------------------------------- consumo contra el tope
type FilaConsumo = { motivo: string | null; chequeado_en: string | null; avisado_en: string | null };

async function mirarConsumo(
  token: string,
  url: string,
  key: string,
  secret: string,
  privados: string[],
  o: { dry: boolean; forzar: boolean; enHorario: boolean },
): Promise<Record<string, unknown>> {
  const ahora = new Date();
  const mes = ahora.toISOString().slice(0, 7);
  const filas = await sb<FilaConsumo[]>(url, key, "github_vigia?clave=eq.consumo&select=*");
  const prev = filas[0] ?? null;

  // Medir cuesta una llamada por repo privado: con una vez por hora alcanza.
  const desdeUltima = prev?.chequeado_en
    ? (ahora.getTime() - new Date(prev.chequeado_en).getTime()) / 3600_000
    : Infinity;
  if (!o.forzar && desdeUltima < HORAS_ENTRE_CONSUMO) {
    return { medido: false, hace_horas: Number(desdeUltima.toFixed(1)) };
  }

  const desde = mes + "-01T00:00:00Z";
  let minutos = 0;
  const porRepo: Record<string, number> = {};
  for (const full of privados) {
    for (let p = 1; p <= 6; p++) {
      const j = await gh<{ workflow_runs?: Array<Record<string, string>> }>(
        token,
        "/repos/" + full + "/actions/runs?per_page=100&page=" + p + "&created=%3E%3D" + desde,
      );
      const rs = j.workflow_runs ?? [];
      for (const r of rs) {
        if (!r.run_started_at || /pages/i.test(r.name ?? "")) continue; // Pages no se cobra
        const seg = (new Date(r.updated_at).getTime() - new Date(r.run_started_at).getTime()) / 1000;
        const m = Math.max(1, Math.ceil(seg / 60)); // GitHub redondea cada corrida al minuto
        minutos += m;
        const corto = full.split("/")[1];
        porRepo[corto] = (porRepo[corto] ?? 0) + m;
      }
      if (rs.length < 100) break;
    }
  }

  const pagos = Math.max(0, minutos - MINUTOS_GRATIS);
  const gasto = pagos * PRECIO_MINUTO;
  const pct = PRESUPUESTO_USD > 0 ? Math.round((gasto / PRESUPUESTO_USD) * 100) : 0;

  // Lo ya avisado se guarda como "2026-09:80". Si cambia el mes, arranca de cero.
  const avisado = (prev?.motivo ?? "").startsWith(mes + ":")
    ? Number((prev?.motivo ?? "").split(":")[1]) || 0
    : 0;
  const pasados = AVISAR_EN.filter((u) => pct >= u);
  const umbral = pasados.length ? pasados[pasados.length - 1] : 0;
  const manda = umbral > avisado && (o.forzar || o.enHorario);

  const top = Object.entries(porRepo).sort((a, b) => b[1] - a[1])[0];
  const info: Record<string, unknown> = {
    medido: true,
    minutos,
    pagos,
    gasto: Number(gasto.toFixed(2)),
    tope: PRESUPUESTO_USD,
    pct,
    umbral,
    avisado,
    manda,
    top: top ? top[0] + ": " + top[1] + " min" : null,
  };
  if (o.dry) return info;

  let envio: unknown = null;
  if (manda) {
    envio = await avisar(url, secret, {
      resumen: "el gasto de GitHub va por el " + pct + "% del tope de " + plata(PRESUPUESTO_USD) + " del mes",
      detalle: [
        "Este mes se usaron " + miles(minutos) + " minutos: " + miles(Math.min(minutos, MINUTOS_GRATIS)) +
        " gratis y " + miles(pagos) + " pagos, o sea " + plata(gasto) + " de " + plata(PRESUPUESTO_USD),
        top ? "El que más gasta es " + top[0] + ", con " + miles(top[1]) + " minutos" : "",
        "Es una estimación: GitHub no deja leer el gasto real con este token",
      ].filter(Boolean).join(". "),
      accion: "Si el tope se llena se frenan TODAS las automatizaciones de la cuenta, como pasó el 27/09. " +
        "Mirá Settings, Billing, Usage con el filtro product:actions y decidí si subir el tope o bajarle " +
        "la frecuencia a " + (top ? top[0] : "lo que más gasta"),
    }, null);
  }

  await sbUpsert(url, key, "github_vigia", {
    clave: "consumo",
    estado: umbral ? "gastando" : "ok",
    motivo: mes + ":" + (manda ? umbral : avisado),
    detalle: miles(minutos) + " min, " + plata(gasto) + " de " + plata(PRESUPUESTO_USD) + " (" + pct + "%)" +
      (top ? ". El que más gasta: " + top[0] : ""),
    avisado_en: manda ? ahora.toISOString() : (prev?.avisado_en ?? null),
    anduvo: true,
    chequeado_en: ahora.toISOString(),
  });
  return { ...info, envio };
}

function plata(n: number) {
  return "US$" + n.toFixed(2).replace(".", ",");
}

function miles(n: number) {
  return Math.round(n).toLocaleString("es-AR");
}

// ---------------------------------------------------------------- helpers
class GhError extends Error {
  constructor(public status: number | null, msg: string) {
    super(msg);
  }
}

// Un corte de red suelto entre Supabase y GitHub pasa (03/10/2026 a las 18:45:
// "connection err" de un solo intento, el anterior y el siguiente anduvieron).
// Se reintenta antes de rendirse; un 401 no se reintenta, ahí es el token.
const ESPERAS_REINTENTO_MS = [2000, 5000];

async function gh<T>(token: string, path: string): Promise<T> {
  for (let intento = 0; ; intento++) {
    let err: GhError;
    try {
      const r = await fetch(GH_API + path, {
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "User-Agent": "vigia-tga",
        },
      });
      if (r.ok) return await r.json() as T;
      err = new GhError(r.status, r.status + " " + (await r.text()).slice(0, 120));
      if (r.status < 500) throw err;
    } catch (e) {
      if (e instanceof GhError && e.status !== null && e.status < 500) throw e;
      err = e instanceof GhError ? e : new GhError(null, String(e));
    }
    if (intento >= ESPERAS_REINTENTO_MS.length) throw err;
    await new Promise((res) => setTimeout(res, ESPERAS_REINTENTO_MS[intento]));
  }
}

/** true si GitHub rechazó el token (vencido, revocado o sin permisos); false si fue la red o GitHub caído. */
function esErrorDeToken(e: unknown) {
  if (!(e instanceof GhError) || e.status === null) return false;
  return e.status === 401 || (e.status === 403 && !/rate limit/i.test(e.message));
}

async function sb<T>(url: string, key: string, path: string): Promise<T> {
  const r = await fetch(url + "/rest/v1/" + path, { headers: { apikey: key, Authorization: "Bearer " + key } });
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + await r.text());
  return await r.json() as T;
}

async function sbUpsert(url: string, key: string, tabla: string, fila: Record<string, unknown>) {
  await fetch(url + "/rest/v1/" + tabla + "?on_conflict=clave", {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(fila),
  });
}

function hs(h: number) {
  if (h < 1) return "menos de una hora";
  const n = Math.round(h);
  return n <= 1 ? "una hora" : n + " horas";
}

function cuando(ms: number) {
  const d = new Date(ms - 3 * 3600_000);
  const dias = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return "el " + dias[d.getUTCDay()] + " " + dd + "/" + mm + " a las " + hh + ":" + mi;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
