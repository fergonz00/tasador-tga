// Edge Function: daily-agenda
// Se invoca por pg_cron cada día a las 11 UTC (8am Argentina).
// Lee turnos del día y manda WhatsApp:
//   - A cada tasador físico: lista completa de turnos.
//   - A cada vendedor: SU turno individual (recordatorio).
// Si no hay turnos, no manda nada.
//
// pg_cron en Supabase (correr una sola vez):
//   CREATE EXTENSION IF NOT EXISTS pg_cron;
//   CREATE EXTENSION IF NOT EXISTS pg_net;
//   SELECT cron.schedule(
//     'daily-agenda', '0 11 * * *',
//     $$ SELECT net.http_post(
//       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/daily-agenda',
//       headers := jsonb_build_object(
//         'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
//         'Content-Type', 'application/json'
//       ),
//       body := '{}'::jsonb
//     ); $$
//   );

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

console.info("daily-agenda function started");

Deno.serve(async (_req: Request) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Fecha de hoy en formato YYYY-MM-DD (zona Argentina)
    const hoy = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
    });

    // 1. Traer turnos de hoy ordenados por hora (sólo los pendientes de inspección)
    const { data: turnosRaw, error: errTurnos } = await supabase
      .from("tasaciones")
      .select("id, marca, modelo, anio, version, patente, cliente_nombre, vendedor_id, vendedor_nombre, turno_hora, estado_fisico")
      .eq("turno_fecha", hoy)
      .order("turno_hora", { ascending: true });

    if (errTurnos) {
      console.error("Error consultando tasaciones:", errTurnos);
      return json({ error: errTurnos.message }, 500);
    }

    const turnos = (turnosRaw ?? []).filter((t) => t.estado_fisico !== "tasada_fisico");

    if (turnos.length === 0) {
      console.info(`daily-agenda: sin turnos para ${hoy}`);
      return json({ ok: true, fecha: hoy, mensaje: "Sin turnos hoy" });
    }

    // 2. Traer todos los usuarios con WhatsApp configurado
    const { data: usuarios, error: errUsr } = await supabase
      .from("tasador_usuarios")
      .select("id, usuario, nombre, telefono_wa, callmebot_key, roles, rol");

    if (errUsr) {
      console.error("Error consultando usuarios:", errUsr);
      return json({ error: errUsr.message }, 500);
    }

    const enviados: any[] = [];
    const errores: any[] = [];

    // 3. WA a cada tasador físico con la lista completa
    const tasadores = (usuarios ?? []).filter((u) => {
      const roles = Array.isArray(u.roles) && u.roles.length > 0 ? u.roles : (u.rol ? [u.rol] : []);
      return roles.includes("tasador_fisico");
    });

    const lista = turnos
      .map((t) =>
        `${t.turno_hora} — ${t.marca || ""} ${t.modelo || ""} ${t.anio || ""}${t.cliente_nombre ? " (" + t.cliente_nombre + ")" : ""}${t.patente ? " · " + t.patente : ""}`
      )
      .join("\n");
    const msgTasador = `📅 *Agenda de hoy* (${formatFecha(hoy)})\n\n${lista}\n\nTotal: ${turnos.length} turno${turnos.length === 1 ? "" : "s"}`;

    for (const u of tasadores) {
      if (!u.telefono_wa || !u.callmebot_key) {
        console.info(`Saltando tasador ${u.usuario}: sin WA configurado`);
        continue;
      }
      const r = await sendWA(u.telefono_wa, u.callmebot_key, msgTasador);
      if (r.ok) enviados.push({ tipo: "tasador_fisico", a: u.usuario });
      else errores.push({ tipo: "tasador_fisico", a: u.usuario, detalle: r.error });
    }

    // 4. WA a cada vendedor con SU turno individual
    for (const t of turnos) {
      if (!t.vendedor_id) continue;
      const v = (usuarios ?? []).find((u) => u.id === t.vendedor_id);
      if (!v) continue;
      if (!v.telefono_wa || !v.callmebot_key) {
        console.info(`Saltando vendedor ${v.usuario}: sin WA configurado`);
        continue;
      }
      const datosVeh = `${t.marca || ""} ${t.modelo || ""} ${t.anio || ""}`;
      const cliente = t.cliente_nombre ? ` con ${t.cliente_nombre}` : "";
      const msgVendedor = `🔔 *Recordatorio*\n\nHoy ${t.turno_hora} traés${cliente} para inspección física:\n\n${datosVeh}${t.patente ? "\nPatente: " + t.patente : ""}`;
      const r = await sendWA(v.telefono_wa, v.callmebot_key, msgVendedor);
      if (r.ok) enviados.push({ tipo: "vendedor", a: v.usuario, turno: t.turno_hora });
      else errores.push({ tipo: "vendedor", a: v.usuario, detalle: r.error });
    }

    console.info(`daily-agenda: ${turnos.length} turnos · ${enviados.length} enviados · ${errores.length} errores`);

    return json({
      ok: true,
      fecha: hoy,
      total_turnos: turnos.length,
      enviados: enviados.length,
      errores: errores.length,
      detalle: { enviados, errores },
    });
  } catch (err) {
    console.error("Error inesperado:", err);
    return json({ error: String(err) }, 500);
  }
});

async function sendWA(phone: string, apikey: string, mensaje: string) {
  try {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(mensaje)}&apikey=${encodeURIComponent(apikey)}`;
    const r = await fetch(url);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function formatFecha(iso: string) {
  const p = iso.split("-");
  return `${p[2]}/${p[1]}/${p[0]}`;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Connection": "keep-alive" },
  });
}
