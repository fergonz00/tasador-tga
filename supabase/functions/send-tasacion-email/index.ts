// Edge Function: send-tasacion-email
// Envía un email al vendedor cuando el tasador cierra una tasación con precio final.
// Usa Gmail SMTP con App Password (secret GMAIL_APP_PASSWORD) y la cuenta GMAIL_USER.

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

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

  const gmailUser = Deno.env.get("GMAIL_USER");
  const gmailPass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!gmailUser || !gmailPass) {
    return json({ error: "GMAIL_USER o GMAIL_APP_PASSWORD no configurados en Supabase" }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  const { to, tasacion } = body || {};
  if (!to || typeof to !== "string" || !tasacion) {
    return json({ error: "Faltan 'to' (email destinatario) o 'tasacion' (datos)" }, 400);
  }

  const t = tasacion;
  const formatNum = (n: any): string => {
    if (n === null || n === undefined || isNaN(Number(n))) return "-";
    return Math.round(Number(n)).toLocaleString("es-AR");
  };

  const subject = `Tasación final: ${t.marca || ""} ${t.modelo || ""} ${t.anio || ""} — ${t.patente || "s/patente"}`;

  // Si el admin dejó comentario para el vendedor (resumen del tasador físico, lo que observó),
  // lo mostramos en un bloque destacado. Es lo que el vendedor va a usar para hablar con el cliente.
  const comentario = t.comentario_admin_vendedor || "";
  const comentarioHTML = comentario ? `
    <div style="background: #ECFDF5; border-left: 4px solid #065F46; padding: 16px; border-radius: 6px; margin-bottom: 20px;">
      <div style="font-size: 11px; font-weight: 700; color: #065F46; letter-spacing: 1px; margin-bottom: 8px;">📝 OBSERVACIONES DE LA INSPECCIÓN — USALAS CON EL CLIENTE</div>
      <div style="font-size: 14px; color: #1B1B1B; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(comentario)}</div>
    </div>
  ` : "";
  const comentarioText = comentario ? `\n\nObservaciones de la inspección (usalas con el cliente):\n${comentario}\n` : "";

  // Si hubo precio virtual previo, lo mostramos como referencia
  const precioVirtualHTML = t.precio_toma_virtual ? `
    <div style="font-size: 11px; opacity: 0.7; margin-top: 8px;">Referencial previo: $ ${formatNum(t.precio_toma_virtual)}</div>
  ` : "";

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1B1B1B;">
      <h2 style="color: #001E50; margin: 0 0 8px 0;">Precio final de tu tasación</h2>
      <p style="color: #555; font-size: 14px; margin: 0 0 20px 0;">
        Hola${t.vendedor_nombre ? " " + t.vendedor_nombre : ""}, después de la inspección física se confirmó el precio definitivo:
      </p>

      <div style="background: #001E50; color: white; padding: 20px; border-radius: 8px; text-align: center; margin-bottom: 20px;">
        <div style="font-size: 12px; opacity: 0.8; letter-spacing: 1px; margin-bottom: 6px;">PRECIO FINAL DE TOMA</div>
        <div style="font-size: 30px; font-weight: 700; font-family: 'Courier New', monospace;">$ ${formatNum(t.precio_toma_final)}</div>
        ${t.tasado_por ? `<div style="font-size: 12px; opacity: 0.75; margin-top: 10px;">Tasado por ${t.tasado_por}</div>` : ""}
        ${precioVirtualHTML}
      </div>

      ${comentarioHTML}

      <div style="background: #F5F5F5; padding: 16px; border-radius: 8px; margin-bottom: 20px;">
        <div style="font-size: 11px; font-weight: 700; color: #666; letter-spacing: 1px; margin-bottom: 10px;">DATOS DEL VEHÍCULO</div>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr><td style="padding: 5px 0; color: #666; width: 40%;">Marca</td><td style="padding: 5px 0; font-weight: 600;">${t.marca || "-"}</td></tr>
          <tr><td style="padding: 5px 0; color: #666;">Modelo</td><td style="padding: 5px 0; font-weight: 600;">${t.modelo || "-"}</td></tr>
          <tr><td style="padding: 5px 0; color: #666;">Versión</td><td style="padding: 5px 0;">${t.version || "-"}</td></tr>
          <tr><td style="padding: 5px 0; color: #666;">Año</td><td style="padding: 5px 0;">${t.anio || "-"}</td></tr>
          <tr><td style="padding: 5px 0; color: #666;">Kilómetros</td><td style="padding: 5px 0;">${formatNum(t.kilometros)} km</td></tr>
          <tr><td style="padding: 5px 0; color: #666;">Color</td><td style="padding: 5px 0;">${t.color || "-"}</td></tr>
          <tr><td style="padding: 5px 0; color: #666;">Patente</td><td style="padding: 5px 0; font-family: 'Courier New', monospace; font-weight: 700; font-size: 15px;">${t.patente || "-"}</td></tr>
          <tr><td style="padding: 5px 0; color: #666;">Radicado en</td><td style="padding: 5px 0;">${t.provincia_radicacion || "-"}</td></tr>
          ${t.cliente_nombre ? `<tr><td style="padding: 5px 0; color: #666;">Cliente</td><td style="padding: 5px 0; font-weight: 600;">${escapeHtml(t.cliente_nombre)}</td></tr>` : ""}
        </table>
      </div>

      <p style="color: #999; font-size: 12px; margin-top: 30px; text-align: center;">
        Tasador TGA — <a href="https://tasador.titogonzalez.online" style="color: #001E50; text-decoration: none;">Abrir el portal</a>
      </p>
    </div>
  `;

  const fallbackText = `Precio final de tu tasación: ${t.marca || ""} ${t.modelo || ""} ${t.anio || ""} (${t.patente || "sin patente"}).\nPrecio: $ ${formatNum(t.precio_toma_final)}${t.tasado_por ? " — Tasado por " + t.tasado_por : ""}.${comentarioText}\nAbrí el mail en HTML para ver el detalle completo.`;

  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: {
        username: gmailUser,
        password: gmailPass.replace(/\s/g, ""),
      },
    },
  });

  try {
    await client.send({
      from: `Tasador TGA <${gmailUser}>`,
      to,
      subject,
      content: fallbackText,
      html,
    });
    await client.close();
    return json({ ok: true });
  } catch (e) {
    try { await client.close(); } catch (_) { /* ignore */ }
    return json({ error: "Error al enviar mail", detail: String(e) }, 502);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

// Escapa caracteres especiales de HTML para evitar problemas con texto que tenga <, >, &, etc.
function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
