# Aviso de auto en exposición vendido

Sistema de notificación automática para cuando un auto que está en exposición
(salón **ENTRE RIOS** o **INDEPENDENCIA**) se vende y hay que reponerlo.

## Componentes

1. **Apps Script** (`Code.gs`) — corre cada 5 min sobre la planilla de stock,
   detecta cambios y dispara la edge function.
2. **Edge Function** `notify-exposicion-vendida` (en
   `../supabase/functions/notify-exposicion-vendida/`) — recibe el aviso y
   manda WhatsApp por Meta Cloud API a los 3 destinatarios.
3. **Template Meta** `auto_exposicion_vendido` — hay que crearlo en
   Meta Business Manager y esperar aprobación (24-48hs).

---

## Despliegue paso a paso

### 1. Crear template en Meta Business Manager

- Ir a **Meta Business Suite → WhatsApp → Plantillas de mensajes**
  (WABA "Tito Gonzalez | Tasador").
- Crear plantilla nueva:
  - **Nombre**: `auto_exposicion_vendido`
  - **Categoría**: `Utilidad`
  - **Idioma**: `Español (Argentina)` (`es_AR`)
- **Cuerpo** (sin encabezado, sin pie, sin botones):

```
🚨 Auto en exposición vendido - reemplazar.

Modelo {{1}}, color {{2}}, en salón {{3}}. Coordinar reposición.
```

- Ejemplos para Meta (los pide al crear el template):
  - `{{1}}` = `Polo Track MSI`
  - `{{2}}` = `Blanco Candy`
  - `{{3}}` = `ENTRE RIOS`

- Enviar a revisión. Aprobación: típicamente 1-24hs.

### 2. Crear el secret

Generar un string random largo (ej. `openssl rand -hex 32` o equivalente).
Guardarlo a mano — se usa en dos lugares (Supabase y Apps Script).

### 3. Desplegar la Edge Function

En el dashboard de Supabase del proyecto `wjfglsafgaltusmbnccl`:

- **Edge Functions → New function**
  - Nombre: `notify-exposicion-vendida`
  - Pegar el contenido de `../supabase/functions/notify-exposicion-vendida/index.ts`
  - **Important**: desactivar el toggle *Verify JWT with legacy secret*
    (las keys de este proyecto son formato nuevo `sb_secret_*`, mismo patrón
    que `notify-whatsapp` y `notify-pending-sweep`).
- **Settings → Secrets**: agregar `STOCK_NOTIF_SECRET = <el secret generado>`.
  Los demás secrets (`WA_TASADOR_TOKEN`, `WA_TASADOR_PHONE_ID`,
  `SUPABASE_SERVICE_ROLE_KEY`) ya existen del tasador.
- Deploy.

### 4. Configurar el Apps Script

- Abrir la planilla:
  https://docs.google.com/spreadsheets/d/1KvuRZzHuVpWSppZqT8xDf8WSrplR-vYzeY0gQPftlpQ
- **Extensiones → Apps Script**.
- Pegar el contenido de `Code.gs` (reemplaza lo que haya).
- **Project Settings → Script properties → Add**:
  - `EDGE_FN_URL` = `https://wjfglsafgaltusmbnccl.supabase.co/functions/v1/notify-exposicion-vendida`
  - `STOCK_NOTIF_SECRET` = `<mismo secret que cargaste en Supabase>`
- Guardar.

### 5. Bootstrap inicial (clave — no olvidar)

Antes de armar el trigger, ejecutar **una vez a mano** la función
`bootstrapMarcarTodoNotificado` (combo Run en el editor de Apps Script,
seleccionar esa función y dar play). Esto marca todas las series ya vendidas
como "ya notificadas" para que el primer run no avise por las viejas.

Aprobar los permisos que pide Apps Script (acceso a la planilla y a internet).

### 6. Probar end-to-end

- Con el template aún en revisión: ejecutar `testEnvioManual` — debería
  loguear que Meta rechaza por template no aprobado. Eso confirma que la
  edge function y el secret están OK.
- Una vez aprobado el template: re-correr `testEnvioManual`. El mensaje de
  prueba con `serie TEST-0000` te debería llegar a los 3 destinatarios.

### 7. Crear el trigger time-based

En Apps Script: **Triggers** (ícono reloj a la izquierda) → **Add Trigger**:

- Función: `notificarExposicionesVendidas`
- Deployment: Head
- Event source: **Time-driven**
- Type: **Minutes timer**
- Interval: **Every 5 minutes**

Listo.

---

## Cómo funciona

- Cada 5 min, Apps Script lee la hoja `stock`.
- Para cada fila con columna **P** = `ENTRE RIOS` o `INDEPENDENCIA` y
  columna **G** distinta de `#N/A` (ya vendida):
  - Si la serie **no estaba** en el snapshot → envía aviso y la agrega.
  - Si ya estaba → ignora.
- La edge function busca `fngonzalez` y `dlopez` en `tasador_usuarios`
  (necesitan `activo=true`, `notificaciones_wa!=false` y `telefono_wa`
  cargado), y suma a Juan Marquevich (hardcoded `5491133819961`).
- Cada destinatario recibe el template con unidad + color + salón.

## Cambiar destinatarios

- **fngonzalez** y **dlopez**: editar su `telefono_wa` desde el panel
  Usuarios del tasador. Mientras sigan con esos `usuario`, la edge function
  los encuentra.
- **Juan Marquevich**: hardcoded en
  `../supabase/functions/notify-exposicion-vendida/index.ts`
  (constante `JUAN_MARQUEVICH`). Si cambia el número, editar y redesplegar.

## Troubleshooting

- **No llega WA y los logs de Apps Script dicen 200 OK con `enviados: 0`**:
  los 3 usuarios no tienen `telefono_wa` o `notificaciones_wa = false`. Revisar.
- **Apps Script tira 401 `secret inválido`**: `STOCK_NOTIF_SECRET` distinto
  entre Apps Script y Supabase.
- **Apps Script tira 500 `STOCK_NOTIF_SECRET missing`**: falta cargar el
  secret en Supabase (Settings → Edge Functions → Secrets).
- **Quiero re-notificar una venta puntual**: editar manualmente el script
  property `stock_notif_snapshot_v1` (es un JSON) y borrar la entrada de
  esa serie. O correr `resetSnapshot` para limpiar TODO (ojo: vuelve a
  notificar todo lo que esté vendido + en exposición hoy).
