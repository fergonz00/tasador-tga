// Edge Function: notify-pending-sweep
// Garantiza que el WhatsApp "tasacion_pendiente_carga" siempre llegue al admin,
// aunque el disparo fire-and-forget del cliente haya fallado (red, tab cerrada,
// rate-limit de Meta, lo que sea). Corre cada N minutos via pg_cron.
//
// Lógica:
//   1. Lista tasaciones con estado='pendiente' creadas en las últimas 48h
//      (excluye presenciales: el flujo presencial no notifica al admin por diseño).
//   2. Para cada una, chequea si en notificaciones_log hay un envío con
//      estado='enviado' y evento='tasacion_pendiente_carga'.
//   3. Si NO hay envío exitoso → llama a notify-whatsapp para esa tasación.
//   4. Devuelve resumen con cuántas reintentó.
//
// pg_cron en Supabase (correr una sola vez para schedulearlo cada 5 min):
//   CREATE EXTENSION IF NOT EXISTS pg_cron;
//   CREATE EXTENSION IF NOT EXISTS pg_net;
//   SELECT cron.schedule(
//     'notify-pending-sweep', '*/5 * * * *',
//     $$ SELECT net.http_post(
//       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/notify-pending-sweep',
//       headers := jsonb_build_object(
//         'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
//         'Content-Type', 'application/json'
//       ),
//       body := '{}'::jsonb
//     ); $$
//   );
//
// Para correrlo manualmente desde Supabase SQL Editor (debug):
//   SELECT net.http_post(
//     url := 'https://<PROJECT_REF>.supabase.co/functions/v1/notify-pending-sweep',
//     headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>', 'Content-Type','application/json'),
//     body := '{}'::jsonb
//   );

const EVENTO = "tasacion_pendiente_carga";
const VENTANA_HORAS = 48;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Para invocar otras Edge Functions usamos la ANON_KEY (que es un JWT clásico),
  // porque algunas instalaciones de Supabase tienen SERVICE_ROLE_KEY en formato sb_secret_*
  // que es rechazado por el verificador de JWT.
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "SUPABASE env vars missing" }, 500);
  if (!ANON_KEY) return json({ error: "SUPABASE_ANON_KEY missing" }, 500);

  try {
    // 1) Tasaciones pendientes (últimas 48h, no presenciales) — el flujo presencial no notifica al admin.
    const desde = new Date(Date.now() - VENTANA_HORAS * 3600 * 1000).toISOString();
    const desdeEnc = encodeURIComponent(desde);
    const tasUrl = "tasaciones?estado=eq.pendiente&es_presencial=not.eq.true&created_at=gte." + desdeEnc + "&select=id,created_at";
    const tasaciones = await sb(SUPABASE_URL, SERVICE_KEY, tasUrl);
    if (!Array.isArray(tasaciones) || tasaciones.length === 0) {
      return json({ revisadas: 0, reintentadas: 0, info: "sin tasaciones pendientes en ventana" });
    }

    // 2) Buscar log de envíos exitosos para esas tasaciones
    const ids = tasaciones.map((t: any) => t.id);
    const idsCsv = ids.map((id: string) => '"' + id + '"').join(",");
    const logUrl = "notificaciones_log?evento=eq." + EVENTO + "&estado=eq.enviado&tasacion_id=in.(" + idsCsv + ")&select=tasacion_id";
    const logs = await sb(SUPABASE_URL, SERVICE_KEY, logUrl);
    const yaEnviado = new Set<string>((logs || []).map((r: any) => r.tasacion_id));

    // 3) Las que no tienen envío exitoso → reintentar
    const aReintentar = tasaciones.filter((t: any) => !yaEnviado.has(t.id));
    const detalle: any[] = [];

    for (const t of aReintentar) {
      try {
        const res = await fetch(SUPABASE_URL + "/functions/v1/notify-whatsapp", {
          method: "POST",
          headers: {
            "apikey": ANON_KEY,
            "Authorization": "Bearer " + ANON_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tasacion_id: t.id, evento: EVENTO }),
        });
        const status = res.status;
        const data = await res.json().catch(() => ({}));
        detalle.push({
          tasacion_id: t.id,
          status,
          enviados: data.enviados || 0,
          errores: (data.errores || []).length,
          info: data.info || null,
          error: data.error || null,
        });
      } catch (e) {
        detalle.push({ tasacion_id: t.id, error: String(e) });
      }
    }

    return json({
      revisadas: tasaciones.length,
      ya_notificadas: yaEnviado.size,
      reintentadas: aReintentar.length,
      detalle,
    });
  } catch (e) {
    return json({ error: "sweep failed", detalle: String(e) }, 500);
  }
});

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sb(url: string, key: string, path: string) {
  const res = await fetch(url + "/rest/v1/" + path, {
    headers: {
      "apikey": key,
      "Authorization": "Bearer " + key,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("Supabase " + res.status + ": " + t);
  }
  return res.json();
}
