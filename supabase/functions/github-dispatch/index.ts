// Edge Function: github-dispatch
// Dispara workflows de GitHub Actions a horario, desde pg_cron.
//
// Por qué existe (Fer, 20-11-2026): el `schedule:` de GitHub es "si puedo". Medido
// del 6 al 20/11 en mail-tga: "Correo y circulares" está programado cada hora
// (24 por día) y GitHub lo corrió 3 o 4 veces por día; desde el 17/11, además,
// ~8 h todas las noches sin largar NADA (el vigía notify-github lo detectó el
// 20/11 a la mañana). No fue facturación ni caída de GitHub: simplemente no
// dispara. pg_cron sí es puntual, así que el reloj vive acá y GitHub sólo corre.
//
// Decisión de Fer (20-11-2026): opción B, correo y quejas cada 2 horas (~US$0
// con el cupo de Pro). Arranca sólo con "Correo y circulares"; se suman los demás
// después de medir 2 días. El `schedule:` del yml queda puesto como respaldo.
//
// - Autenticación: header x-stock-secret == STOCK_NOTIF_SECRET.
// - Token: secret GITHUB_TOKEN (el mismo PAT repo+workflow del vigía), o GH_TOKEN.
// - Sólo dispara lo que está en PERMITIDOS: el endpoint no sirve para correr
//   cualquier workflow de la cuenta.
//
//   POST {"repo":"mail-tga","workflow":"correo.yml"}            -> dispara
//   POST {"repo":"mail-tga","workflow":"correo.yml","dry":true} -> dice qué haría

const GH_USER = Deno.env.get("GH_USUARIO") ?? "fergonz00";

const PERMITIDOS: Record<string, string[]> = {
  "mail-tga": ["correo.yml", "quejas.yml", "calidad.yml", "resenas.yml"],
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const SECRET = Deno.env.get("STOCK_NOTIF_SECRET");
  const TOKEN = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN");
  if (!SECRET) return json({ error: "STOCK_NOTIF_SECRET missing" }, 500);
  if (req.headers.get("x-stock-secret") !== SECRET) return json({ error: "secret inválido" }, 401);
  if (!TOKEN) return json({ error: "GITHUB_TOKEN missing" }, 500);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* sin body */ }
  const repo = String(body.repo ?? "");
  const workflow = String(body.workflow ?? "");
  const ref = String(body.ref ?? "main");
  if (!(PERMITIDOS[repo] ?? []).includes(workflow)) {
    return json({ error: "workflow no permitido", repo, workflow }, 400);
  }
  if (body.dry === true) return json({ dry: true, repo, workflow, ref });

  // Reintenta ante error de red o 5xx; un 4xx es definitivo (token, ref, nombre).
  let ultimo = "";
  for (const espera of [0, 2000, 5000]) {
    if (espera) await new Promise((r) => setTimeout(r, espera));
    try {
      const r = await fetch(
        `https://api.github.com/repos/${GH_USER}/${repo}/actions/workflows/${workflow}/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + TOKEN,
            Accept: "application/vnd.github+json",
            "User-Agent": "dispatch-tga",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref }),
        },
      );
      if (r.status === 204) return json({ ok: true, repo, workflow });
      ultimo = r.status + " " + (await r.text()).slice(0, 200);
      if (r.status < 500) break;
    } catch (e) {
      ultimo = String(e).slice(0, 200);
    }
  }
  return json({ ok: false, repo, workflow, error: ultimo }, 502);
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
