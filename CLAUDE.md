# Tasador TGA — Contexto del proyecto para Claude Code

## Qué es

App web de tasación de autos usados para **Tito González Automotores (TGA)**, concesionario oficial Volkswagen en CABA, Argentina. Producción: https://tasador.titogonzalez.online (hosting en GitHub Pages con dominio propio vía CNAME).

## Stack técnico

- **HTML único** (index.html ~1520 líneas, 58KB) sin build, sin framework, sin bundler
- CSS y JS vanilla, todo inline
- **Supabase** (REST API directa con fetch, sin SDK). URL y anon key hardcodeadas en index.html
- **Google Fonts**: DM Sans + JetBrains Mono
- **CallMeBot**: notificaciones WhatsApp al submit (teléfono + key hardcodeados)
- **3 hojas de Google Sheets públicas vía CSV** (gviz/tq?tqx=out:csv):
  - **CCA**: precios de referencia de usados (marca+modelo+versión+año)
  - **VW**: 0km Volkswagen con FyF (flete y formularios). Constante FYF = 1.110.000 ARS
  - **TGA**: márgenes y listas VW

## Google Sheet NUEVO de precios 0km (todas las marcas menos VW)

URL pública:
https://docs.google.com/spreadsheets/d/e/2PACX-1vQH_9OtgijB7xV7qZEHoogNXq8TE5gLxz4RNb2DvxbbQ1o2A_Be2my532IJF0nxpJCUkghJrEa3TeDw/pub?gid=647749443&single=true&output=csv

Columnas: Marca, Modelo, Versión, Precio, Moneda (ARS o USD), Actualizado
- 171 filas ARS (rango $24.800.000 – $145.500.000)
- 10 filas USD (todas BYD, rango USD 23.690 – 82.000)
- Primera fila del CSV es basura vacía: filtrarla
- NO incluye VW — VW sigue viniendo de la hoja VW existente

## Roles y flujo

### Usuarios
Tabla `tasador_usuarios` en Supabase. Campos: usuario, clave (TEXTO PLANO, sin hashear — deuda técnica conocida), rol.
- `rol = 'admin'` → vista admin
- cualquier otro valor → vista vendedor

### Vendedor (flujo wizard en 10 pasos)
1. Marca del usado
2. Año
3. Modelo
4. Versión
5. Modelo 0km equivalente del usado (hoy solo VW) ← **A REDISEÑAR: desplegables en cascada marca → modelo → versión para cualquier marca. Para VW = 2 niveles (planilla VW existente). Para otras 8 marcas = 3 niveles (CSV nuevo). Opcional con opción "Sin equivalente". Info referencial, sin precios visibles al vendedor.**
6. KM
7. Color + precio Kavak
8. Modelo 0km que consulta el cliente ← **SE QUEDA VW-only** (TGA solo vende VW 0km). Fuente: planilla VW/TGA como hoy.
9. Precio ofrecido con FyF ← **SE QUEDA.** El vendedor sigue cargando el precio que ofreció al cliente. **Único cambio: sacar la línea chiquita "Precio FyF de referencia: $ X"** debajo del input para que cargue sin ver el FyF base.
10. Fotos

**Qué NO ve el vendedor:** precios de referencia del 0km equivalente (paso 5) ni el FyF base del 0km que compra el cliente (paso 9). Carga a ciegas.
**Qué SÍ carga el vendedor:** selección del 0km equivalente (paso 5), selección del VW que compra el cliente (paso 8), y precio con FyF ofrecido (paso 9).

### Admin
Tabs: Pendientes / Tasadas / Todas. Ve:
- Fotos
- Datos del usado
- 3 métodos de precio: CCA, Fórmula FG, Kavak
- Bloque de margen 0km (comparando precio ofrecido vs. hoja TGA)
- Input para cerrar con "precio de toma final"
- Barra de cotización USD editable

**El admin es quien ve todos los precios.** La Fórmula FG se aplica sobre el precio del 0km equivalente del usado (paso 5 del wizard): si el usado es VW sale de la planilla VW, si es de otra marca sale del CSV nuevo (pesificado con cotización si la moneda es USD, ej: BYD).

## Lógica de tasación (ya implementada, no tocar sin aviso)

- `calcPrecioCCA`: busca marca+modelo+versión+año en hoja CCA. **La moneda la trae la planilla por fila** (columna `moneda` para los años usados, `moneda_0km` para la columna 0 Km — en CCA pueden diferir: BYD tiene el 0km en US$ y los usados en pesos). En ese formato **toda celda viene en MILES de su moneda** → `precio = valor × 1000`. `MARCAS_USD` quedó solo como fallback para planillas viejas sin esas columnas. Ver "Carga mensual del CCA" abajo.
- `ccaAnioCol(anio)`: CCA publica 0 Km + 2025..2012, **no hay columna 2026** → un usado 2026 se busca contra la columna `0Km` (constante `ANIO_0KM`)
- `calcAjusteKm`: año base 2026, km esperados 15.000/año (20.000 para pickups con keywords AMAROK/HILUX/RANGER), aplica tabla de % según ratio real/esperado (+12% a −18%)
- `calcFormulaFG(marca, modelo, version, anio)`: `precio_0km / 1.05 / 1.09^años`. Funciona para cualquier marca. Si es VW, usa `vwData`; si no, usa `precios0kmData` (pesifica USD con `getCotiz()`). Reemplazó a la vieja `calcFormulaVW`.
- Precio toma CCA: ajustado × 0.86 (−14%)
- Precio toma Fórmula FG: ajustado × 0.88 (−12%)
- Margen 0km: compara precio_ofrecido_fyf vs. precio_fyf_base de hoja TGA

## Cambios planeados (en este orden)

### Cambio 1 — Rediseñar paso 5 del wizard + ajustes chicos
**Paso 5 (0km equivalente del usado):**
- Hoy es un único desplegable VW-only con referencia FyF. Se reemplaza por desplegables en cascada marca → modelo → versión.
- Fuente combinada: `precios0kmData` (CSV nuevo, 8 marcas no-VW) + `vwData` (planilla VW existente).
- Si la marca del 0km equivalente es **VOLKSWAGEN**: solo 2 desplegables (marca → modelo), se saltea versión porque la planilla VW no tiene esa granularidad.
- Si la marca es cualquiera de las 8 del CSV: 3 desplegables (marca → modelo → versión).
- Primera opción siempre: **"— Sin equivalente 0km / No aplica —"** (el paso es opcional).
- Texto aclaratorio chico debajo: *"Solo si existe un 0km equivalente actual del mismo modelo. Es información referencial que sirve para el análisis."*
- El vendedor **NO ve precios** en este paso.

**Paso 9 (precio ofrecido con FyF):**
- Se mantiene el input. Único cambio: sacar la línea chiquita "Precio FyF de referencia: $ X" para que el vendedor cargue sin ver el FyF base.

**Admin:**
- El recuadro MARGEN 0KM se mantiene igual (usa planilla TGA + el FyF que cargó el vendedor en paso 9).
- La Fórmula FG se extiende para funcionar con cualquier marca (hoy solo VW). Fuente del precio 0km: CSV nuevo para no-VW, planilla VW para VW.
- BYD (USD) se pesifica con la cotización que ya está en admin.
- Fórmula original: `precio_0km / 1.05 / 1.09^años` — se deja como está. Si más adelante hay que ajustar por marca, consultarle a Fer.

**Schema Supabase:**
- Agregar campos para guardar el paso 5 con granularidad nueva: `equiv_0km_marca`, `equiv_0km_modelo`, `equiv_0km_version`, `equiv_0km_precio`, `equiv_0km_moneda`.
- `modelo_vw_0km` (campo viejo) queda por retrocompatibilidad con tasaciones existentes.

**Estado actual del cambio 1: ✅ COMPLETO**
- ✅ Sub-paso 1: carga del CSV nuevo. `PRECIOS_0KM_CSV_URL`, `precios0kmData`, `loadPrecios0km()` en `Promise.all` del login.
- ✅ Sub-paso 2: paso 5 del wizard rediseñado. Marca auto-detectada del usado (no es desplegable). Si el usado es FIAT → pregunta "¿FIAT tiene un 0km equivalente?" con modelos Fiat del CSV. Si es VW → modelos VW de `vwData` (2 niveles, sin versión). Si es marca sin data → cartelito "No tenemos precios 0km cargados para X". Sin precios visibles al vendedor. Helpers: `getEquiv0kmMarcas`, `getEquiv0kmModelos`, `getEquiv0kmVersiones`, `onEquivModeloChange`.
- ✅ Sub-paso 3: Fórmula FG extendida a cualquier marca (ver `calcFormulaFG`). Campos nuevos guardados al submit: `equiv_0km_marca`, `equiv_0km_modelo`, `equiv_0km_version`, `equiv_0km_precio`, `equiv_0km_moneda`. Admin recalcula Formula FG dinámicamente si hay USD (usa cotiz actual). Fallback al valor guardado para registros viejos. Info row del 0km equivalente renombrada.
- ✅ Sub-paso 4: sacada la línea "Precio FyF de referencia: $ X" del paso 9 del wizard (renderStep8). El vendedor carga el FyF a ciegas.

### Cambio 2 — Análisis de fotos con IA (✅ código listo, ⏳ test pendiente)

**Arquitectura:**
- Edge Function de Supabase llamada `analyze-photos` (ver archivo `supabase/functions/analyze-photos/index.ts`).
- La función recibe `{ fotos: [urls], marca, modelo, version, anio, kilometros }` y llama a `claude-opus-4-7` via `https://api.anthropic.com/v1/messages` con las imágenes como `type: "image", source: { type: "url", ... }`.
- La `ANTHROPIC_API_KEY` vive como secret en Supabase (NUNCA en el cliente).
- Devuelve JSON con estructura definida (resumen_vendedor, chapa/pintura/interior/tapizado/llantas/parabrisas, kilometraje_tablero, danios_detectados, descuento_total_ars).

**Flujo en `index.html`:**
- Al submit de la tasación, después de guardar el record se dispara `analizarFotosIA(tasId, fotoUrls, vehInfo)` en fire-and-forget (no bloquea al vendedor).
- La función marca `analisis_ia_estado = 'pendiente'`, llama a la Edge Function, y al terminar hace PATCH con `analisis_ia_resumen`, `analisis_ia_detalle` (JSONB), `analisis_ia_descuento`, `analisis_ia_estado = 'ok'`.
- Si falla → `analisis_ia_estado = 'error'`.
- Función `reanalizarFotos(tasId)` disparada desde botón en admin re-corre el análisis.

**Vista admin (`renderAnalisisIAAdmin`):**
- Recuadro celeste con cita del resumen, kilometraje leído, secciones con estados coloreados (verde/naranja/rojo), lista de daños con montos, y descuento total en rojo.
- Botón "Re-analizar".
- Estados: 'pendiente' → cartelito gris "Analizando...", 'error' → cartelito rojo con botón reintentar.

**Vista vendedor (Mis tasaciones):**
- Solo muestra `analisis_ia_resumen` en un recuadro celeste con label "OBSERVACIONES". Nunca ve montos.

**Schema Supabase (nuevas columnas en `tasaciones`):**
- `analisis_ia_resumen` (TEXT)
- `analisis_ia_detalle` (JSONB)
- `analisis_ia_descuento` (NUMERIC)
- `analisis_ia_estado` (TEXT: 'pendiente' | 'ok' | 'error')

**Deploy realizado por Fer (16/04/2026):**
- ✅ SQL ejecutado en Supabase (las 5 columnas de cambio 1 + 4 columnas de cambio 2).
- ✅ Edge Function `analyze-photos` deployada vía Dashboard editor.
- ✅ Secret `ANTHROPIC_API_KEY` cargado en Supabase.
- ⏳ Prueba end-to-end pendiente (al cerrar sesión del 16/04 quedó sin testear con fotos reales).

### Cambio 3 — Deploy (✅ pusheado a main)
Commit + push a GitHub (rama `main`). El sitio `tasador.titogonzalez.online` se actualiza solo al pushear (GitHub Pages). Los cambios 1, 2 y 4 están todos en producción al 21/04/2026.

### Cambio 4 — Gestión de usuarios desde admin + cambio de clave forzado (✅ COMPLETO y pusheado)

**Qué hace:**
- Nueva vista "Usuarios" en el header del admin (botón 👥 Usuarios entre "Cambiar de modo" y "Salir"). Permite alta, edición, reset de clave y activación/desactivación (baja lógica).
- Modal obligatorio de cambio de clave en el primer login o después de un reset. Sin escape más que "Salir" (logout).
- Validación de clave: mínimo 8 caracteres, con letras y números.
- "Modo superadmin" hardcodeado para el usuario `fngonzalez`: único que puede crear/editar admins y cambiar el rol de un admin. Cualquier otro admin ve los admins como "solo lectura" y el select de rol no le muestra la opción "Administrador".
- El vendedor nunca toca esta vista — solo la ve quien tenga `rol = admin`.

**Schema Supabase:**
- Columna nueva en `tasador_usuarios`: `debe_cambiar_clave BOOLEAN DEFAULT true`. El `UPDATE tasador_usuarios SET debe_cambiar_clave = true` se corrió en todo el universo al aplicar el cambio, por lo que todos los usuarios existentes están obligados a cambiar la clave la próxima vez que entren. Para exceptuar un usuario puntual (ej. no molestar al admin principal): `UPDATE tasador_usuarios SET debe_cambiar_clave = false WHERE usuario = 'fngonzalez'`.
- Contraseñas siguen en texto plano (deuda técnica consciente).

**Funciones clave en `index.html`:**
- Header button: `abrirUsuarios()` / `cerrarUsuarios()`. Vista `#usuariosView` justo después de `#adminView`.
- Render: `loadUsuarios` + `renderUsuarios` (fila compacta de una línea: usuario — nombre · rol · estado · botones).
- Modales: `_mostrarUsuarioModal(modo, u)` con modos `'nuevo' | 'editar' | 'reset'`. Submit en `guardarUsuarioModal(modo, id)`.
- Toggle activo: `toggleActivoUsuario(id, nuevoEstado)`. También hay checkbox "Usuario activo" dentro del modal de Editar.
- Superadmins: lista `SUPERADMINS_USUARIOS = ['fngonzalez', 'mlubrano']` + helper `_esSuperadmin()`. Reemplaza los guards `if (_esAdmin(u))` por `if (_esAdmin(u) && !_esSuperadmin())`. También gatea el panel de Notificaciones (cambio 5). Extendida a `mlubrano` al agregar el panel WA.
- Login: en `login()` se chequea `currentUser.debe_cambiar_clave` antes de despachar a modo. Si true → `mostrarModalCambioClave()`. Al confirmar → `confirmarCambioClave()` hace PATCH y llama a `_continuarLogin()`.
- Validación de clave reutilizable: `validarClaveUsuario(clave)` devuelve `{ok, msg}`.

### Cambio 5 — Notificaciones WhatsApp vía Meta Cloud API (✅ COMPLETO y pusheado 21/04/2026)

**Qué hace:**
- Reemplaza a CallMeBot. Usa WhatsApp Cloud API de Meta con templates aprobados.
- 5 eventos disparan notificaciones automáticas:
  1. `tasacion_pendiente_carga` — vendedor envía una tasación nueva → avisa al admin
  2. `tasacion_virtual_completada` — admin carga precio virtual → avisa al vendedor
  3. `visita_fisica_agendada` — vendedor agenda inspección (turno nuevo o cambio) → avisa al admin y Fazzini
  4. `tasacion_fisica_completada` — Fazzini sube inspección → avisa al admin
  5. `tasacion_final_definida` — admin cierra precio final → avisa a admin, Fazzini, vendedor
- Los destinatarios fijos de cada evento son editables desde el panel **🔔 Notificaciones** en el header del admin (solo visible para superadmins `fngonzalez` y `mlubrano`). Por cada evento: toggle "incluir vendedor de la tasación" + checkboxes de usuarios fijos.
- Para el evento 5, las observaciones de la inspección física pasan por Claude (`claude-haiku-4-5-20251001`) para corregir ortografía/redacción antes de enviar.
- Log completo por envío en la tabla `notificaciones_log` (incluye `meta_message_id`, payload request/response, error si falló).

**Arquitectura:**
- **Edge Function `notify-whatsapp`** (`supabase/functions/notify-whatsapp/index.ts`). Recibe `{tasacion_id, evento}`. Lee `notificaciones_config` + `tasaciones` + usuarios, resuelve destinatarios (incluye_vendedor + fixed_ids), filtra por `activo=true` y `notificaciones_wa!=false` y que tengan `telefono_wa`. Llama a Meta Cloud API `POST /{phone_id}/messages` con el template. Loguea cada envío.
- Secrets usados por la Edge Function (en Supabase secrets, NO en el código): `WA_TASADOR_TOKEN` (permanent token de Meta), `WA_TASADOR_PHONE_ID` = `955401487647411`, `ANTHROPIC_API_KEY` (reutilizado del cambio 2).
- Meta WABA: "Tito Gonzalez | Tasador" (separada del CRM). App Meta "Tito Gonzalez Tasador" (ID `2218546848681240`). WABA ID `1183788370595856` (no se usa en runtime, solo gestión). Idioma de templates: `es_AR`.
- **Frontend**: función `notifyWA(tasacion_id, evento)` en `index.html` (fire-and-forget, no bloquea al usuario). Reemplaza las viejas `notificarPrecioVirtualVendedor`, `notificarTurnoATasadorFisico`, `notificarAdminInspeccion`, `notificarPrecioFinal`, y el POST directo a callmebot en `submitTasacion`. Las funciones viejas quedaron residuales (sub-paso F de limpieza pendiente).

**Schema Supabase (cambio 5):**
- `tasador_usuarios.notificaciones_wa BOOLEAN DEFAULT true` (opt-out por usuario).
- Tabla `notificaciones_log` (id, tasacion_id, destinatario_id, destinatario_telefono, template, evento, estado, meta_message_id, error_detalle, payload JSONB, created_at).
- Tabla `notificaciones_config` (evento PK, usuarios_ids UUID[], incluir_vendedor_referencia BOOLEAN, updated_at, updated_by). Se inicializa con 5 filas: todos los eventos con `fngonzalez` como fijo, y eventos 2 y 5 con `incluir_vendedor_referencia = true`.
- RLS deshabilitado en `notificaciones_log` y `notificaciones_config` (consistente con el resto del proyecto — se usa la anon key para todo).

**Modo Meta (al 21/04/2026, fin del día):**
- La app está en **Live / Producción**. Ya NO hace falta agregar test recipients — cualquier número de WhatsApp válido con `telefono_wa` cargado recibe los templates.
- Requisitos cumplidos: Business Verification aprobada, Display Name aprobado, App Domain `tasador.titogonzalez.online`, Privacy Policy (`/privacy.html`), Terms (`/terms.html`), Data Deletion URL (reusa privacy), Category "Business".
- Archivos públicos que no hay que borrar: `privacy.html`, `terms.html` (en la raíz del repo, servidos por GitHub Pages).
- Primera prueba end-to-end exitosa con Inés Alonso (mensaje llegado al celu).

**Edge cases pendientes (sin template Meta):**
- Cuando el admin marca la tasación como "NO APTO para toma" (función `notificarNoAptoVendedor`). Hoy sigue usando CallMeBot como residuo.
- Cuando se cancela un turno (`notificarTurnoATasadorFisico('cancelado', ...)`). Idem.
- **A decidir**: crear templates `usado_no_apto` y `turno_cancelado`, o dejar sin notificación WA (el vendedor lo ve en la app). Sub-paso F de limpieza depende de esto.

**Cómo agregar un destinatario nuevo:**
1. En el admin → 👥 Usuarios → asegurarse de que tenga `telefono_wa` cargado (formato `549...` sin `+` ni espacios) y `notificaciones_wa = true`.
2. Mientras la app Meta esté en Desarrollo: agregar el número como recipient test number en Meta y verificar con código.
3. En el panel 🔔 Notificaciones del admin, tildar el checkbox del usuario en los eventos que quiera recibir.

### Cambio 6 — Editor de 0km equivalente desde admin (✅ COMPLETO 27/04/2026)

**Qué hace:**
- En la card de cada tasación admin, junto al "0km equivalente", aparece un botón **"+ Cargar"** (si el vendedor no completó el paso 5) o **"✎ Editar"** (si ya hay datos).
- Al tocarlo se abre un editor inline en cascada (marca → modelo → versión) con la misma data del wizard (`precios0kmData` + `vwData`). VW = 2 niveles, otras 8 marcas = 3 niveles.
- Al guardar hace PATCH a los 5 campos `equiv_0km_*` y la Fórmula FG aparece automáticamente (recalcula dinámicamente).
- Permite también limpiar (seleccionar "— Sin equivalente —") para revertir.

**Funciones clave en `index.html`:**
- `renderEquivBlockAdmin(t)`: render del bloque (modo vista o modo edición según `_equivEditState`).
- `renderEquivBlockEdit(t)`: render del editor con los desplegables.
- `editEquiv0km(tasId)`, `cancelEditEquiv0km(tasId)`: abrir/cerrar.
- `onAdminEquivMarcaChange/ModeloChange/VersionChange(tasId, valor)`: handlers en cascada.
- `guardarEquiv0km(tasId)`: lookup de precio en `vwData`/`precios0kmData` y PATCH.
- Se reemplazó el IIFE viejo del bloque "0km equivalente" en `renderAdminCard` por un único llamado a `renderEquivBlockAdmin(t)`.

**Schema Supabase:** sin cambios — usa las columnas `equiv_0km_*` que ya existen del cambio 1.

### Cambio 7 — Sweeper para garantizar WhatsApp "tasacion_pendiente_carga" (✅ COMPLETO 27/04/2026)

**Por qué:** el `notifyWA` del cliente es fire-and-forget. El sábado 25/04 una vendedora cargó una tasación y el WA al admin no llegó (causa puntual no identificada — probablemente red o tab cerrada al momento del submit). Como respaldo defensivo se agregó un sweeper que se autoejecuta y reintenta.

**Edge Function `notify-pending-sweep`** (`supabase/functions/notify-pending-sweep/index.ts`):
- Lista tasaciones con `estado = 'pendiente'` creadas en últimas 48h y `es_presencial != true`.
- Filtra las que ya tienen un envío `enviado` con evento `tasacion_pendiente_carga` en `notificaciones_log`.
- Para las que faltan, llama a `notify-whatsapp` con la `SUPABASE_ANON_KEY` (en este proyecto la `SERVICE_ROLE_KEY` es formato nuevo `sb_secret_*` que no es JWT y se rechaza).
- Devuelve `{revisadas, ya_notificadas, reintentadas, detalle[]}`.

**Configuración importante (gotcha del proyecto):**
- Las keys de este proyecto Supabase son **formato nuevo** (`sb_publishable_*` y `sb_secret_*`), NO JWTs clásicos.
- Por eso, en las Edge Functions `notify-whatsapp` y `notify-pending-sweep` está **desactivado el toggle "Verify JWT with legacy secret"**. Si se vuelve a activar, las llamadas internas dejan de funcionar.
- Las funciones validan internamente sus inputs (evento válido, env vars presentes), así que el riesgo de tener JWT off es bajo.

**pg_cron schedule activo:** `notify-pending-sweep` corre cada 5 minutos (`*/5 * * * *`, jobid 1). Llama al sweeper sin auth header (porque JWT verification está off).

**SQL pendiente para correr en otra instalación o si se rompe:**
```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
SELECT cron.schedule(
  'notify-pending-sweep', '*/5 * * * *',
  $$ SELECT net.http_post(
    url := 'https://wjfglsafgaltusmbnccl.supabase.co/functions/v1/notify-pending-sweep',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  ); $$
);
```

### Cambio 8 — Cartelito "comprado en TGA" en card admin (✅ COMPLETO 27/04/2026)

**Qué hace:**
- En la card admin, debajo de la línea compacta de datos del usado, si el USADO es VW y el vendedor cargó el dato en el wizard (paso `vwCompradoTGA`), aparece un cartelito:
  - **Verde** si fue comprado en TGA: `✓ Usado VW comprado en Tito González`.
  - **Amarillo** si NO: `✗ Usado VW NO comprado en TGA — <lugar>` (lugar = `usado_vw_lugar_compra`).
- Si el usado no es VW o el vendedor no completó el dato, no se muestra nada.
- Sirve para que el admin tenga el historial visible al cargar el precio virtual.

**Implementación:** IIFE inline en `renderAdminCard`, justo después de la línea compacta de datos y antes del bloque `datos_corregidos_at`. Sin schema nuevo (usa `usado_vw_comprado_tga` y `usado_vw_lugar_compra` que ya existían).

### Cambio 9 — Rebote al vendedor + hoja imprimible + reagendar/cancelar desde Fazzini (✅ COMPLETO 08/05/2026)

Tres mejoras de UX implementadas en un único commit (`71839a3`).

**9.A — Rebote al vendedor (admin):**
- Botón **"↩️ Rebotar al vendedor"** en la card admin de pendientes (al lado de "Marcar NO APTO"), dentro del bloque "PRECIO VIRTUAL DE TOMA" cuando todavía no hay precio virtual cargado y la tasación no está rebotada ni marcada como NO APTO.
- Abre modal con textarea pidiendo motivo (obligatorio). Al confirmar hace PATCH con `rebotada=true`, `rebotada_motivo`, `rebotada_at`, `rebotada_por = currentUser.nombre`.
- En la card admin la tasación queda con badge naranja **"REBOTADA"** y un cartel "Esperando que el vendedor complete la info y reenvíe" en lugar de los inputs de precio virtual.
- En la vista del vendedor (Mis tasaciones → Pendientes) la tasación aparece con cartel naranja grande con el motivo y un botón **"✎ Completar info y reenviar"**.
- Ese botón abre un **modal liviano de edición** (no reabre el wizard de 10 pasos) con campos editables: cliente, patente, km, color, provincia, kavak, modelo 0km consultado, precio ofrecido FyF, + input file para fotos adicionales (se concatenan con las existentes, no las reemplazan).
- Al reenviar: PATCH con los datos editados + nuevas URLs de fotos, reset de los 4 campos `rebotada_*` a null/false, y dispara `notifyWA(id, 'tasacion_pendiente_carga')` (template Meta existente) para avisar al admin.
- **WA al vendedor en el momento del rebote**: como todavía no hay template Meta `tasacion_rebotada`, se usa **CallMeBot** vía `notificarRebotadaVendedor(tasId, motivo)` — alineado con el patrón ya usado para `notificarNoAptoVendedor`. Cuando se cree el template Meta, migrar al evento centralizado `notifyWA`.
- **Schema Supabase (correr esto antes de usar la feature):**
  ```sql
  ALTER TABLE tasaciones ADD COLUMN rebotada BOOLEAN DEFAULT false;
  ALTER TABLE tasaciones ADD COLUMN rebotada_motivo TEXT;
  ALTER TABLE tasaciones ADD COLUMN rebotada_at TIMESTAMP WITH TIME ZONE;
  ALTER TABLE tasaciones ADD COLUMN rebotada_por TEXT;
  ```
- **Funciones clave en `index.html`:** `abrirRebotarVendedor`, `cerrarRebotarVendedor`, `confirmarRebotarVendedor` (admin); `abrirCompletarRebotada`, `cerrarCompletarRebotada`, `onFotosRebotadaChange`, `renderRebotadaFotosPreview`, `quitarFotoRebotada`, `reenviarTasacionRebotada` (vendedor); `notificarRebotadaVendedor` (CallMeBot).
- **Limitación conocida**: el modal liviano del vendedor no permite editar marca/modelo/versión/año porque cambiarlos requeriría rehacer cálculos (CCA, FG, ajuste km). Si el vendedor cargó mal alguno de esos, hay que borrar y rehacer la tasación.

**9.B — Hoja imprimible (admin + Fazzini):**
- Botón **"🖨️ Imprimir hoja"** disponible cuando `precio_toma_final` está cargado.
  - En admin: dentro del recuadro verde "PRECIO FINAL DE TOMA", al lado de "Actualizar".
  - En Fazzini: en la card de la tasación (pestaña "Final"), al lado del botón "Ver detalle".
- Función `imprimirHojaFinal(tasId)`: arma un HTML print-friendly (A4, `@media print`) y lo abre en `window.open` que dispara `window.print()` al cargar.
- **Contenido de la hoja:** datos del cliente y unidad (marca, modelo, versión, año, KM, color, patente, provincia, tapizado, pintura, vendedor) + observaciones generales del tasador físico + daños observados sobre la silueta (sin costos) + checklist técnico de interior y mecánica (solo ítems con observación o estado distinto de bueno) + accesorios + **precio final destacado en verde**.
- **Lo que NO incluye** (decisión consciente para que sea hoja "limpia" de entrega al cliente): fotos del usado, precios CCA, Kavak, Fórmula FG, análisis IA.
- Bucket `tasaciones-fotos` no se toca; la hoja es texto puro.

**9.C — Reagendar / Cancelar turno desde la vista de Fazzini:**
- En la card de Fazzini (pestaña "Pendientes"), cuando la tasación está pendiente de inspección y tiene turno agendado, aparecen botones **"📅 Reagendar"** y **"❌ Cancelar turno"** al pie de la card.
- Reusan funciones existentes: `abrirAgendarTurno(tasId)` y `cancelarTurno(tasId)`. Sin schema nuevo.
- `cancelarTurno` ahora también refresca `loadTasadorFisicoList()` cuando la vista de Fazzini está activa.
- Caso de uso: cliente no se presentó al turno → Fazzini mismo lo cancela o reagenda sin tener que ir a la agenda.

### Cambio 10 — Fix Agenda + Cancelar visita con motivo (✅ COMPLETO 12/05/2026)

**10.A — Fix filtro Agenda:**
- Bug: la solapa Agenda filtraba "pendientes/inspeccionadas" por `estado_fisico === 'tasada_fisico'`, pero ese valor **nunca se setea** en el código (Fazzini graba `'pendiente_revision'` al cargar la inspección). Resultado: las consultas inspeccionadas seguían apareciendo como pendientes en la agenda eternamente.
- Arreglo: el filtro ahora usa `precio_sugerido_fisico || precio_toma_final` para determinar si está inspeccionada (mismo criterio que `renderFisicoList`). Se agregaron `analisis_fisico, precio_sugerido_fisico, precio_toma_final` al SELECT de `loadAgenda()`.

**10.B — Cancelar visita con motivo (vendedor + Fazzini):**
- **Schema Supabase (correr antes de usar la feature):**
  ```sql
  ALTER TABLE tasaciones ADD COLUMN turno_cancelado_motivo TEXT;
  ALTER TABLE tasaciones ADD COLUMN turno_cancelado_detalle TEXT;
  ALTER TABLE tasaciones ADD COLUMN turno_cancelado_at TIMESTAMP WITH TIME ZONE;
  ALTER TABLE tasaciones ADD COLUMN turno_cancelado_por TEXT;
  ```
- Motivo: las consultas se acumulaban en la vista de Fazzini porque solo había "No avanza con la toma" (que es decisión final post-precio), no había una forma natural de cancelar la visita cuando el cliente no se presenta o pide reagendar más adelante.
- Nuevo modal `abrirCancelarVisita(tasId)` con motivos radio: `no_se_presento`, `reprogramara`, `desistio`, `otro` (con textarea libre).
- **Vendedor (Mis tasaciones)**:
  - Cuando hay turno: botón **"❌ Cancelar visita"** al lado de "Cambiar".
  - Cuando NO hay turno pero hay `turno_cancelado_motivo` + virtual cargado + no marcado como "no avanza"/no apto: cartel rojo "❌ VISITA CANCELADA — motivo" + botones "📅 Reagendar inspección" y "🚫 No avanza con la toma".
- **Fazzini (Inspección → Pendientes)**: el viejo botón "❌ Cancelar turno" (cambio 9C, era un `confirm` seco) ahora es **"❌ Cancelar revisión"** y abre el mismo modal con motivo.
- **Filtro Fazzini Pendientes**: ahora excluye también `no_avanza_motivo`, `virtual_no_apto` y `turno_cancelado_motivo` (helper `_vivaParaFazzini`). Esto resuelve el caso de presenciales con "no avanza" que antes quedaban acumulados.
- **WA**: usa CallMeBot existente vía `notificarTurnoATasadorFisico('cancelado', ...)`. Se le agregó parámetro `motivoExtra` para incluir el motivo en el mensaje. Cuando se cree el template Meta `turno_cancelado` (pendiente del cambio 5), migrar.
- **Reseteo al reagendar**: `confirmarTurno` ahora limpia los 4 campos `turno_cancelado_*` al PATCH, así una unidad reagendada vuelve a estado limpio.
- **Funciones clave en `index.html`**: `abrirCancelarVisita`, `cerrarCancelarVisita`, `confirmarCancelarVisita`, `_renderVisitaCanceladaCartel`, constante `CANCEL_VISITA_MOTIVOS`.

### Cambio 11 — Recordatorios de consultas SIN RESPONDER (✅ COMPLETO 28/07/2026)

**Qué hace:** si una consulta entra y a los **60 minutos** sigue sin contestar, llega otro WhatsApp. Y otro cada 60 min, hasta un **tope de 5 avisos**. Corre 24/7 (sin horario comercial). Cubre **los tres circuitos** que comparten este proyecto Supabase: `tasaciones` (tasador), `consultas_0km` y **`consultas_usados`** (los dos en consulta0km.titogonzalez.online).

**⚠️ Deployar SIEMPRE con `--no-verify-jwt`.** El pg_cron la llama sin header de auth: si se deploya sin el flag, empieza a devolver `UNAUTHORIZED_NO_AUTH_HEADER` y **los recordatorios mueren en silencio** (el cron no avisa). Pasó el 19/08/2026 al agregar la fuente de usados y se corrigió en el momento. Es al revés que `notify-whatsapp-consulta`, que va con verify_jwt ON.

**Fuente `consulta_usado` (19/08/2026):** misma lógica que la de 0km pero **sin agrupar** — el wizard de usados guarda una fila por consulta (un usado es una unidad única), así que cada una insiste por su cuenta; agrupar sellaría dos pedidos distintos con un aviso que nombra uno solo. Fila propia en `recordatorios_config` con `desde` = 19/08/2026. Ver el `CLAUDE.md` de consulta-0km.

**Cómo sabe que ya se contestó — no hay flag nuevo, es derivado.** En cuanto la fila deja de matchear el filtro, no llega nada más. No hay que marcar nada a mano:
- **Tasador**: `estado='pendiente'` AND `es_presencial IS NOT TRUE` AND `precio_toma_virtual IS NULL` AND `precio_toma_final IS NULL` AND `virtual_no_apto IS NOT TRUE` AND `rebotada IS NOT TRUE` AND `no_avanza_motivo IS NULL`. O sea: cargar el precio virtual, marcar NO APTO, rebotar al vendedor o "no avanza" **cortan** los recordatorios.
- **Consulta 0km**: `estado='pendiente'`. Aceptar / rechazar / contraofertar corta.
- Las **presenciales quedan afuera** a propósito: dependen de un turno con Fazzini, no de que el admin cargue un precio (mismo criterio que `notify-pending-sweep`).

**Edge Function `notify-sin-responder`** (`supabase/functions/notify-sin-responder/index.ts`) — barre las dos tablas, agrupa, dispara y sella. **pg_cron cada 10 min, jobid 5.** Aceptar `?dry=1` para ver qué mandaría **sin mandar nada** (usar siempre eso para probar).

**Destinatarios: los mismos del aviso original, sin config duplicada.** El map `CONFIG_EVENTO` de cada Edge Function hace que el evento de recordatorio lea la config del evento original (`tasacion_sin_responder` → `tasacion_pendiente_carga`; `consulta_0km_sin_responder` → `consulta_0km_nueva`). Si mañana agregás a alguien en el panel 🔔 Notificaciones, el recordatorio lo hereda solo.

**⚠️ Templates de Meta: falta crear los propios.** Hoy los recordatorios **reusan el template del aviso original** y meten el aviso adentro de la variable `{{1}}`, que es la que arranca el cuerpo:
`⏰ SIN RESPONDER hace 2 h (aviso 3) — Juan Pérez`.
Funciona y se entiende, pero el resto del cuerpo sigue diciendo "consulta nueva". Cuando existan los templates dedicados en la WABA `1183788370595856`, cambiar `EVENT_TO_TEMPLATE` en las dos Edge Functions y redeployar. **No hace falta tocar nada más.**

**Config editable por SQL — tabla `recordatorios_config`** (una fila por fuente: `tasador` y `consulta_0km`):

| campo | default | qué hace |
|---|---|---|
| `activo` | true | apagar los recordatorios de esa fuente |
| `intervalo_min` | 60 | cada cuánto insiste |
| `max_recordatorios` | 5 | tope de avisos por consulta |
| `desde` | fecha de instalación | **sólo entran las creadas después de esta marca**. Evita que al activar la feature se dispare el backlog histórico. Si se resetea hacia atrás, cuidado. |

**Schema (ya corrido en `wjfgl`):**
```sql
ALTER TABLE tasaciones    ADD COLUMN IF NOT EXISTS recordatorios_enviados INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasaciones    ADD COLUMN IF NOT EXISTS ultimo_recordatorio_at TIMESTAMPTZ;
ALTER TABLE consultas_0km ADD COLUMN IF NOT EXISTS recordatorios_enviados INTEGER NOT NULL DEFAULT 0;
ALTER TABLE consultas_0km ADD COLUMN IF NOT EXISTS ultimo_recordatorio_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS recordatorios_config (
  fuente TEXT PRIMARY KEY, activo BOOLEAN NOT NULL DEFAULT true,
  intervalo_min INTEGER NOT NULL DEFAULT 60, max_recordatorios INTEGER NOT NULL DEFAULT 5,
  desde TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO recordatorios_config (fuente) VALUES ('tasador'), ('consulta_0km') ON CONFLICT DO NOTHING;
```

**pg_cron:**
```sql
SELECT cron.schedule('notify-sin-responder', '*/10 * * * *',
  $$ SELECT net.http_post(
    url := 'https://wjfglsafgaltusmbnccl.supabase.co/functions/v1/notify-sin-responder',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb); $$);
```

**Detalles de implementación:**
- El contador sólo se incrementa si la llamada devolvió **HTTP 200**. Si falla la red o Meta, se reintenta en la corrida siguiente sin gastar un aviso.
- `LIMITE_POR_CORRIDA = 40` por fuente: red de contención si algo se descontrola.
- **Consulta 0km agrupa por submit**: como el wizard guarda N consultas separadas cuando el vendedor pide N modelos, el sweeper junta las del mismo vendedor creadas con menos de 30 s de diferencia y manda **UN** recordatorio que las nombra a todas (`Polo Track + Nivus Comfortline`), sellando las N. Sin esto, 3 modelos × 5 avisos = 15 WhatsApps.
- `notify-whatsapp-consulta` tiene **verify_jwt = ON** (al revés que las del tasador). `invocarNotify` prueba con `SUPABASE_ANON_KEY` y, sólo ante 401/403, reintenta con la service key. **No deployar esa función con `--no-verify-jwt`.**

**Verificado end-to-end el 28/07/2026** con filas de prueba aisladas (`vendedor_nombre='PRUEBA Claude'`, `intervalo_min=0`): los 2 WhatsApps llegaron, el agrupado juntó las 2 consultas en uno, los contadores se sellaron y el tope de 5 frenó el barrido. Datos de prueba borrados y config restaurada.

## Carga mensual del CCA (⚠️ leer antes de tocar la planilla)

**El PDF de CCA viene ROTADO 90°**: cada vehículo es una *columna* y los años corren en vertical. Por eso `pdftotext -layout` desalinea todo — así se cargó abril 2026 y quedó con 496 filas (8,8%) con precios corridos de año y 605 modelos mal asignados. **Nunca más parsear el PDF con `pdftotext`.**

Circuito correcto (probado con abril y julio 2026):

```bash
cd scripts
python parse_cca_pdf.py "../Autos.pdf" cca_julio_parsed.csv   # PDF → CSV por coordenadas
python build_cca_sheet.py cca_julio_parsed.csv cca_julio_2026.xlsx
python subir_cca.py cca_julio_2026.xlsx cca_precios_julio_2026   # sube solo, sin File→Import
```

`subir_cca.py` postea al Apps Script del **simulador VWFS** (`simulador-presupuestos-vwfs`, action `cargarCCA` en `live/cargaCCA.js`), que es el que ya tiene autorización de escritura sobre esa planilla — así no hace falta autorizar un proyecto nuevo ni que Fer importe a mano. URL y token en `C:\proyectos\.secrets\simulador-vwfs.env` (deployment **@35**, separado del **@34** que consume portal-precios: no redeployar el @34).

El script de Apps Script **reemplaza el contenido de la pestaña, nunca la recrea** — el tasador la lee por `gid` (`904791552`), así que si cambiara la pestaña se rompería. Renombrarla sí es seguro (el gid no cambia), y tiene que seguir empezando con `cca_precios_` porque `_getHojaCCA()` del simulador busca por ese prefijo. Antes de pisar deja un backup `backup_cca_<mes>` (conserva los últimos 3; el prefijo es distinto a propósito para que `_getHojaCCA()` no lo agarre).

**Gotcha gviz (costó encontrarlo):** la URL del CCA lleva **`&headers=1`**. Sin eso, gviz tipa la columna `0Km` como numérica y **descarta su encabezado** (queda `""`), así que `row['0Km']` nunca resuelve. Los encabezados de año zafan sólo porque `"2025"` se parsea como número.

Si hay que cargar a mano, tiene que ser **.xlsx** vía File → Import → Replace current sheet — pegar CSV/TSV rompe las celdas con coma (`5P 1,4 GENERATION`) y convierte `111,660` en `111.7`.

- `parse_cca_pdf.py` deduce todo del PDF: eje de años por coordenada, fuente del modelo (cambia entre ediciones), marca por hueco de columna. No hay nada hardcodeado por marca.
- `build_cca_sheet.py` sí tiene hardcodeadas las **reglas de moneda**, que salen de las anotaciones en color del PDF (`FERRARI EN US$`, `HB20 0KM EN PESOS`, etc.). **Cada mes, revisar que esas anotaciones no hayan cambiado**: el script las lista si corrés el bloque de anotaciones. Al 07/2026: 100% en US$ = FERRARI, JAGUAR, LOTUS, MASERATI, McLAREN, PORSCHE; el resto en pesos con el 0 Km en US$ salvo excepciones (HB20, Jeep menos Commander/Compass/Renegade, Sprinter, Ram Dakota/Rampage, y en Honda/Toyota solo algunos modelos).
- La hoja tiene que quedar con encabezados exactos: `marca, modelo, version, moneda, moneda_0km, 0Km, 2025…2012`.

## Control de fechas de pago de las PVs (`notify-pv-fecha-no-habil`)

Dos controles sobre la forma de pago que el vendedor carga en la PV, los dos avisando por WhatsApp a los mismos destinatarios. Pedidos por Fer el 18/08/2026.

| tipo | qué detecta | cuándo avisa |
|---|---|---|
| `fecha_no_habil` | la fecha de pago cae **sábado, domingo o feriado** | a los ~15 min de cargada (20 min de gracia) |
| `vencido_impago` | pasó la fecha prometida y el pago **no figura cobrado** (o quedó saldo) | a los **3 días hábiles** del vencimiento (`PVFECHA_GRACIA_HABILES`) |

El de vencidos mira `detcash.saldo`: `0` = cobrado, `> 0` = falta. Avisa también los **cobros parciales**, diciendo cuánto falta de cuánto. **No usa el corte `PVFECHA_DESDE`** — una deuda vencida sigue viva sea de la PV que sea (decisión de Fer). Se cierra sola cuando entra la plata o cuando reprograman la fecha a futuro.

**De dónde sale el dato:** réplica Oversoft → `detcash` con `origen = 'VTOKM'` y `referencia = 'PV xxxxx/n'`. Cada fila es un renglón de la forma de pago que el vendedor carga a la izquierda de la PV: `motivo` = concepto (SEÑA, CANCOKM, FIN0KMBBVA, REFUESEÑA, FIN0KMNAC…), `importe`, **`vencimiento` = la fecha de pago que se controla**, `fecha` = cuándo se cargó. Los conceptos vienen con la **Ñ rota** (doble UTF-8: `SEÃ‘A`) — `nombreMotivo()` normaliza antes de mapear.

**Tablas nuevas en wjfgl:**
- `feriados_ar` — feriados nacionales. Cargados 2026 y 2027 (35 filas) desde `https://api.argentinadatos.com/v1/feriados/<año>` (gratis, sin key, **exige User-Agent**). Incluye los "puente turístico no laborable". Para sumar un asueto bancario que no es feriado nacional (Día del Bancario, etc.): `insert` a mano con `origen='manual'`. **Cada diciembre hay que cargar el año siguiente.**
- `pv_fechas_alertas` — una fila por renglón y control (**PK compuesta `(detcashid, tipo)`**: el mismo renglón puede tener las dos alertas). Estados: `abierta` · `corregida` · `anulada` (PV anulada) · `historica` (PV anterior al arranque, no avisa) · `cerrada_manual`.
- `pv_vendedores_map` — `vendedorid` de Oversoft → `usuario` de `tasador_usuarios`. Mapeo N:1 (Castro y Loisi tienen un vendedorid extra "- Autoahorro"). **Vendedor nuevo = agregar acá o no le llega el aviso a él** (sí a los fijos).

**Destinatarios:** el vendedor de la PV + los fijos del env `PVFECHA_FIJOS` (default `dlopez,mgerez,fngonzalez` = Daniel López, Mónica Gerez, Fernando N. González). Teléfonos de `tasador_usuarios.telefono_wa`, respeta `notificaciones_wa`.

**Excepción — vendedor "T.G." (pedido de Fer, 24/08/2026):** el vendedorid **22** de Oversoft es `T.G.`, la venta de la casa, y está mapeado a `patriciag`. Esas PVs **no le avisan a Patricia**: el mensaje sale solo a los fijos. Vive en el env `PVFECHA_VENDEDORES_SIN_AVISO` (default `22`, lista de vendedorid separados por coma) — se saca o se suma otro sin tocar código. Se resolvió acá y **no** dando de baja la fila de `pv_vendedores_map`, porque ese map también lo usa `gestion-next/lib/validarPreventa.ts`.

**Cadencia:** pg_cron **jobid 9**, `*/10 15-23 * * *` (cada 10 min, **12 a 20 hora AR** — Fer lo corrió de 9 a 12 el 19/08/2026; el piso también vive en el env `PVFECHA_HORA_DESDE=12`). Un mensaje **por PV y por tipo** (agrupa todos los renglones de esa PV), no por renglón. Si no se corrige, **1 recordatorio por día hábil** hasta `PVFECHA_MAX_AVISOS` (10). Domingos y feriados no molesta; los sábados sí (el salón trabaja). Gracia de 20 min desde la carga para no pegarle al vendedor mientras tipea.

**Cierre automático:** cada corrida re-lee los renglones y cierra la alerta si la fecha se corrigió, si la PV se anuló, si apareció el contra-asiento negativo o si el renglón fue reemplazado por otro del mismo concepto con fecha hábil. `detcash` **sí** refleja ediciones posteriores (verificado: 147/147 filas de mayo con `saldo ≠ importe`), a diferencia de `clientes`.

**Templates Meta:** `pv_fecha_no_habil` y `pv_pago_vencido` (los dos es_AR, UTILITY, 4 vars: nombre · nº de PV · detalle · vendedor) en la WABA "Tito Gonzalez | Tasador" (`1183788370595856`), la misma de `precios_actualizados`. Se crean **desde la propia función** (`?crear_template=1`, que saltea los que ya existen), porque el token de Meta solo vive como secret de Supabase. **Mientras Meta los tiene en PENDING el envío falla y `avisos` no se sella** — cuando aprueba, la corrida siguiente los manda solos.

**Modos de prueba** (query string o body): `?dry=1` (no manda ni escribe, devuelve qué haría) · `?solo=<E164>` (manda un ejemplo de cada template a un número) · `?tipo=vencido_impago` (corre un solo control) · `?forzar=1` (ignora horario y el tope de 1 aviso/día) · `?dias=120` (agranda la ventana) · `?listar=1` (templates de la WABA) · `{"cerrar":[detcashid]}` (baja alertas a mano).

**Arranque:** `PVFECHA_DESDE` (default `2026-08-18`) — el control corre **sobre las PVs hechas a partir de esa fecha** (decisión de Fer: "lo viejo ya está"). El corte mira `preventas.fecha`, **no** cuándo se cargó el renglón: si a una PV vieja le agregan hoy un renglón con fecha mala, tampoco avisa. Lo anterior queda como `historica` (registro, sin aviso): 42 casos de los 120 días previos (22 sábados, 3 domingos, 17 feriados) — Naddeo 13, J. Castro 11, Loisi 9, Buena 5, Fazzini 3, Alonso 1. Se puede correr el corte sin redeploy con `?desde=YYYY-MM-DD`.

## Aviso al vendedor cuando su cliente retiró (`notify-retiro-cliente`)

A las **9 de la mañana** le llega un WhatsApp al vendedor con los datos para llamar al cliente que retiró el día anterior. Pedido por Fer el 18/08/2026.

**Programar la entrega no es entregar:** `fechaprogramada`/`horaprogramada` se cargan al pactar el turno; `entregada = true` y `fechasalida` recién cuando la entregan **por sistema**. El aviso usa siempre las segundas (verificado 18/08: 0 unidades entregadas sin `fechasalida`, 0 con `fechasalida` sin `entregada`, y 7 turnos vencidos sin entregar que correctamente no avisan).

**De dónde sale el dato** (réplica Oversoft): `unidades` con `entregada = true` → `fechasalida` (día del retiro), `horaprogramada` (hora del turno), `patente`, `modelo`, `responsable` (quien firmó) y `preventa`. De ahí se cruza a `preventas` (por `numero`) para el vendedor y el CUIT, a `clientes` (por `codigo` = ese CUIT) para teléfonos y mail, y a `modelos` para traducir el código VW (`AGDC8A MY26` → "VW Amarok Highline V6 AT 4X4 G2 MY26").

**Destinatario: solo el vendedor** (decisión de Fer — no va copia a gerencia). Sale de `pv_vendedores_map`. Las ventas de **"T.G." (vendedorid 22) las sigue Patricia Guajardo** (`patriciag`, tel cargado el 18/08), que además es el **respaldo** (`RETIRO_FALLBACK`) cuando el vendedor no tiene WhatsApp: así ningún cliente queda sin llamado.

**Cadencia:** pg_cron **jobid 10**, `0 12 * * *` (9:00 hora AR). Toma los retiros de `fechasalida < hoy` dentro de una ventana de 7 días y saltea los ya avisados (tabla `retiros_avisos`, PK `unidadid`, estados `enviado` · `sin_destinatario` · `pendiente`). **Domingos y feriados no manda** — se acumula y sale el siguiente día hábil. Si el cron falla un día, al otro salen igual (por eso la ventana de 7).

**Template Meta:** `retiro_cliente_vendedor` (es_AR, UTILITY, 6 vars: destinatario · cliente · unidad · cuándo retiró · vendedor · contacto).

**Dos gotchas de los datos, ya resueltos en el código:**
- `unidades.responsable` está **cortado a 25 caracteres** ("DALLOCHIO ESTEVEZ, CONSTA") pero está al día; `clientes.nombre` viene entero pero puede haber quedado viejo (esa tabla no re-sincroniza ediciones). `mejorNombre()` usa el de `clientes` solo si continúa al truncado.
- Los teléfonos vienen como `(caracteristica)numero`, a veces con la característica vacía, con `0` adelante o con el `15` del celular intercalado (`(221 )155079805` → `2215079805`). `normalizarTel()` lo limpia; **el formateo con guiones solo se aplica a los `11`**, porque en el interior la característica puede ser de 2, 3 o 4 dígitos y cortar a ojo daría un número mal escrito.

**Arranque:** `RETIRO_DESDE` (default `2026-08-18`) — no avisa retiros anteriores. Modos de prueba: `?dry=1` · `?solo=<E164>` · `?forzar=1` (saltea el corte de domingo/feriado) · `?dias=20&desde=2026-08-01`.

## Pedido de fotos cuando un usado entra físico (`notify-usado-fisico`)

A las **10 de la mañana**, de **lunes a sábado**, les llega un WhatsApp a **Fer (`fngonzalez`), Jorge Fazzini (`jfazzini`) y Nadia Vera (`nvera`)** por cada usado que ya entró físicamente al concesionario y **todavía no tiene fotos del concesionario cargadas**. Pedido por Fer el 18/08/2026; Nadia sumada el 19/08/2026.

**Nadia va solo en el aviso de fotos, no en el de precios** (pedido explícito de Fer). **Ojo con el padrón**: Nadia Vera está cargada **dos veces** en `tasador_usuarios` (`nadiav` del 06/05 y `nvera` del 14/05), las dos activas y **con el mismo teléfono**. Se usa `nvera` porque respeta la convención del resto (inicial + apellido). Si algún día se suman las dos al mismo aviso, le llegan dos WhatsApps iguales — conviene desactivar una.

**El aviso se repite todos los días hasta que las fotos estén** (decisión de Fer: "1 aviso x día hasta q estén las fotos"). El **único** corte es que aparezca al menos una fila en `portal_usados_fotos` para ese `usadoid` — ahí deja de salir solo. Domingo no manda: el salón está cerrado y nadie puede sacarlas.

**Quién carga las fotos:** sigue siendo **solo Fer**, desde Baratito (`/precios` → sección Usados). Se le preguntó a Fer el 18/08/2026 si le daba permiso a Fazzini y dijo **no**: el aviso es para que Jorge las saque y las pase, no para que las suba. **No se tocó `puedeGestionarUsados()`.**

**De dónde sale el dato:** réplica Oversoft `usados` con `recibida = true` (= ya está física) y `fechadeingreso` = el día que entró. Mismo universo vendible que la solapa `/usados` de portal-precios: `estado = Activado`, `fechadeventa is null` y `fechadealta` dentro de los últimos **18 meses** (corta la chatarra histórica de 2009-2024). Se saltean las **ocultas** y las marcadas **vendido** en `portal_usados` — no tiene sentido pedir fotos de algo que no se va a publicar. `tasaciones` (por patente) completa km real y color, y cuenta las fotos de la **tasación** que se están mostrando mientras tanto.

**Salió de acá un bug del portal, ya arreglado (portal-precios `e166dc8`):** las fotos del concesionario **borraban de la vista** a las de la tasación (era un ternario, o unas o las otras). Ahora conviven: concesionario primero, tasación atrás. Por eso el aviso dejó de decir "provisorias".

**Antes de culpar al portal:** que un usado físico no tenga fotos casi siempre es que **el vendedor no las sacó al tasar**. El Crossfox AA374IG nunca las tuvo — José Castro lo tasó dos veces (18/07 y 25/07) y en ninguna cargó una sola (`tasaciones.fotos` vacío **y** 0 objetos en `tasaciones-fotos/{id}/`). Chequear las dos cosas antes de tocar código.

**Cadencia y control:** pg_cron **jobid 11**, `0 13 * * 1-6` (10:00 hora AR, lun-sáb). Tabla `usados_avisos_fotos` en wjfgl, única por **(usadoid, fecha, destinatario)** — una fila por unidad, día y persona. Solo cuentan como "ya avisado hoy" las filas en estado `enviado`; un envío fallido queda `pendiente` y se reintenta en la corrida siguiente.

**Template Meta:** `usado_fisico_fotos` (es_AR, UTILITY, 4 vars: destinatario · unidad+patente · detalle color/km/fotos · cuándo ingresó + hace cuántos días). El "hace N días" hace que el recordatorio diario escale solo sin necesidad de contar avisos.

**Arranque:** `USADO_FOTOS_DESDE` (default `2026-08-01`) — no avisa unidades que entraron antes. Al 18/08/2026 eso deja **1 unidad**: VW Crossfox 1.6 MSI 2016 (AA374IG), ingresó el 05/08, sin ninguna foto (al día de hoy `portal_usados_fotos` está **vacía**, nunca se usó). Destinatarios cambiables sin redeploy con el env `USADO_FOTOS_DESTINATARIOS` (usuarios separados por coma).

**Modos de prueba:** `?dry=1` · `?solo=<E164>` · `?forzar=1` (ignora lo ya avisado hoy) · `?desde=2026-07-01` · `?listar=1` · `?crear_template=1`.

## Aviso cuando un usado físico no tiene precio de venta (`notify-usado-sin-precio`)

A las **11 de la mañana**, de **lunes a sábado**, le llega un WhatsApp **solo a Fer (`fngonzalez`)** por cada usado que ya entró físicamente al concesionario y **no tiene precio de venta cargado en Oversoft**. Pedido por Fer el 19/08/2026.

Es el hermano de `notify-usado-fisico` (aquel pide las fotos, este pide el precio): mismo universo de unidades, misma cadencia, distinto corte y distinto destinatario. Va una hora más tarde a propósito, para que los dos avisos no lleguen apilados por la misma unidad.

**El corte es el precio de OVERSOFT (`usados.preciodeventa` > 0), no el override de `portal_usados`.** Es a propósito: el pedido es que el precio quede cargado **en el sistema**, que es de donde lo toman la administración y el resto de los circuitos. Cargarlo solo en Baratito no apaga el aviso.

**Se repite todos los días hasta que el precio esté** (decisión de Fer, mismo criterio que las fotos). Domingo no manda. El mensaje dice "hace N días", así que el recordatorio escala solo sin contar avisos.

**No filtra por "parte de pago".** Fer lo pidió pensando en los usados que entran por una PV, pero un usado físico sin precio es un problema venga de donde venga, así que entran también las compras directas. Cuando la unidad tiene `preventaorigen` cargado, el mensaje lo dice (`vino de la PV 08083/1`).

**De dónde sale el dato:** réplica Oversoft `usados` con `recibida = true`, `estado = Activado`, `fechadeventa is null` y `fechadealta` dentro de los últimos **18 meses** (mismo universo vendible que la solapa `/usados`). Se saltean las **ocultas** y las marcadas **vendido** en `portal_usados`. `tasaciones` (por patente) completa km real y color. El mensaje incluye el **costo de toma** (`preciodetoma`) para que Fer pueda decidir el precio sin abrir nada — es plata interna, pero el aviso va solo a él.

**Ojo con la nota vieja:** el punto 14 de la memoria del panel de usados decía que "casi todo el stock está en 0 en Oversoft". **Ya no es así** (verificado 19/08/2026): de las 6 unidades físicas sin vender, las únicas dos en 0 son chatarra de 2009 y 2024, que además quedan afuera por la ventana de 18 meses. Con el corte de arranque puesto, hoy el aviso **no dispara ninguno** — recién suena cuando entra una unidad nueva sin precio, que es justo lo que se buscaba.

**Cadencia y control:** pg_cron **jobid 12**, `0 14 * * 1-6` (11:00 hora AR, lun-sáb). Tabla `usados_avisos_precio` en wjfgl, única por **(usadoid, fecha, destinatario)**, con `preventa_origen` y `costo_toma` guardados para poder auditar después. Solo cuentan como "ya avisado hoy" las filas en estado `enviado`; un envío fallido queda `pendiente` y se reintenta en la corrida siguiente.

**Template Meta:** `usado_sin_precio_venta` (es_AR, UTILITY, 4 vars: destinatario · unidad+patente · detalle color/km/costo de toma/PV · cuándo ingresó + hace cuántos días). Creado el 19/08/2026 desde la propia función (`?crear_template=1`) y **APROBADO ese mismo día**: el circuito está 100% operativo.

**Arranque:** `USADO_PRECIO_DESDE` (default `2026-08-01`) — no avisa unidades que entraron antes. Destinatarios cambiables sin redeploy con `USADO_PRECIO_DESTINATARIOS` (usuarios separados por coma; hoy `fngonzalez` a secas, Fer pidió expresamente que sea solo a él).

**Modos de prueba:** `?dry=1` · `?solo=<E164>` · `?forzar=1` · `?desde=2009-01-01` · **`?meses=250`** (ensancha la ventana de antigüedad; sirve para validar la detección cuando el stock real está todo con precio) · `?listar=1` · `?crear_template=1`.

## Unidades a recibir que no llegan (`notify-unidad-demorada`)

A las **10 de la mañana**, de **lunes a sábado**, les llega un WhatsApp a **Fer (`fngonzalez`) y Daniel López (`dlopez`)** por cada unidad que figura **A RECIBIR** en Oversoft y lleva más de **7 días hábiles** cargada sin entrar físicamente, para que le consulten a VW qué pasa. Pedido por Fer el 21/08/2026.

**El caso que lo origino:** había dos Amarok Hero a recibir (una ya vendida) que no llegaban. Recién al reclamarlas VW dijo que los papeles de esa unidad estaban demorados y que no llegaba en el corto plazo. El vendedor ya le había prometido una fecha al cliente. El problema de fondo es que **una unidad a recibir cuenta como stock y se puede vender** (ver `feedback_definicion_stock`), así que en las pantallas se ve igual que un auto que está en el salón.

**El circuito no termina en el aviso:**
1. La Edge detecta la demora y avisa a Fer y a Daniel.
2. Ellos le consultan a VW.
3. **Fer** anota el problema y la fecha estimada de llegada en el panel **/precios** de portal-precios (sección "🚚 A recibir").
4. El **vendedor** ve esa nota en `/ofertas`, en `/presupuesto` y en **consulta-0km**, y con eso sabe qué plazo prometerle al cliente.

**Cadencia (definida por Fer):** primer aviso a los **7 días hábiles**; si no hay nada anotado insiste **cada 5 días hábiles**. Cargar la nota **apaga** el aviso y reinicia el reloj: vuelve a los 5 días hábiles para actualizar el estado. **Excepción:** si la nota trae una fecha estimada que todavía no venció, se calla hasta esa fecha — ya sabemos cuándo llega, no hay nada que consultar; si la fecha pasa y la unidad sigue sin llegar, vuelve a avisar. La unidad **se cierra sola** cuando Oversoft la marca recibida o entregada.

**De dónde sale el dato:** réplica Oversoft `unidades` con `recibida = false` y `entregada = false`. **`fechadepedido` es la fecha de alta en Oversoft** (coincide con `statusfec`), y es contra eso que se cuentan los días hábiles. `preventa != ''` = ya vendida: ese caso es el urgente y el mensaje lo canta, porque hay un cliente esperando. **No se filtra por `asignada`/`preventa`**: la unidad vendida es justamente la que más importa.

**Nombrar la unidad:** `modelos.descripcionoperativa` por código de compra; si el model-year es tan nuevo que Oversoft no lo describió todavía **y** el código base es ambiguo (`AGDD8A` = Extreme / Hero / Black Style), cae a la descripción real de ESE chasis según la factura de VW (`compras_vw.modelo_valeria`) o el reparto (`reparto_vw.descripcion`). Sin ese fallback las dos Hero se avisaban como "código AGDD8A MY26". Mismo pipeline que `portal-precios/src/lib/unidades.ts`.

**Tablas nuevas en wjfgl:**
- `unidades_demora` — una fila por chasis a recibir. La Edge escribe el espejo de Oversoft (`modelo`, `color`, `fecha_oversoft`, `preventa`, `recibida_at`) y el control de avisos (`avisos`, `ultimo_aviso_at`); **Fer escribe `problema`, `fecha_estimada`, `nota_por`, `nota_at`** desde el portal. Cada uno toca sus columnas: el sync nunca pisa la nota.
- `unidades_demora_avisos` — log de envíos, único por `(serie, fecha, destinatario)`. Un envío fallido queda `pendiente` y se reintenta.

**El contador se sella solo si el mensaje salió** (HTTP 200 de Meta). Si el template está PENDING o el token venció, la unidad no se marca como avisada y se reintenta en la corrida siguiente, en vez de quedar muda 5 días hábiles.

**Cadencia técnica:** pg_cron **jobid 14**, `0 13 * * 1-6` (10:00 hora AR, lun-sáb). Domingos y feriados no manda: no hay a quién consultarle. Tope de `UNIDAD_DEMORA_MAX` (10) unidades por corrida, las más viejas primero.

**Template Meta:** `unidad_a_recibir_demorada` (es_AR, UTILITY, 4 vars: destinatario · unidad con modelo/color/chasis · desde cuándo está y si está vendida · qué sabemos hasta ahora). Creado el 21/08/2026 con `?crear_template=1`, **en PENDING al cierre de esa sesión**.

**Arranque:** `UNIDAD_DEMORA_DESDE` (default `2026-06-01`), medido por `fechadepedido` — sin ese corte entrarían las unidades viejas que quedaron colgadas en Oversoft sin recibirse nunca. Al 21/08/2026 la lista tiene 5 unidades a recibir, 4 de ellas ya pasadas de plazo (dos Hero de 14 días hábiles, una Trendline de 16 vendida en la PV 08753/3, una Extreme de 12).

**Envs:** `UNIDAD_DEMORA_DIAS` (7) · `UNIDAD_DEMORA_REPASO` (5) · `UNIDAD_DEMORA_MAX` (10) · `UNIDAD_DEMORA_DESTINATARIOS` (`fngonzalez,dlopez`) · `UNIDAD_DEMORA_DESDE`.

**Modos de prueba:** `?dry=1` (no manda ni escribe) · **`?sync=1`** (actualiza la lista de unidades **sin avisar** — es lo que alimenta el panel y consulta-0km; sirve para poblar la tabla antes de que Meta apruebe el template) · `?solo=<E164>` · `?forzar=1` · `?desde=YYYY-MM-DD` · `?dias=7` · `?listar=1` · `?crear_template=1`.

## Tienda de Mercado Libre desactualizada (`notify-ml-desactualizado`)

Cuando un precio publicado en la **tienda oficial de ML** (`mercadolibre.com.ar/tienda/tito-gonzalez-automotores`) lleva mas de **6 horas** distinto a la oferta vigente del portal, sale un WhatsApp a **Nadia Vera (`nvera`), Matias Lubrano (`mlubrano`) y Fer (`fngonzalez`)** para que lo corrijan. Pedido por Fer el 24/08/2026.

**El motor no vive aca — vive en portal-precios.** Esta Edge Function es solo el brazo que manda el WhatsApp (el token de Meta solo existe como secret de Supabase). Quien scrapea, compara y lleva el reloj es `portal-precios/src/lib/mlTienda.ts`, disparado por el cron `/api/cron/ml-tienda` (`0 * * * *` en `vercel.json`).

**Por que scraping y no la API de ML:** `api.mercadolibre.com` exige OAuth del vendedor — `/sites/MLA/search`, `/items/{id}` y el multiget devuelven 403/401 sin token. La **vidriera publica**, en cambio, trae las 20 publicaciones con id, titulo y precio dentro del JSON de las "polycards" embebido en el HTML. **Verificado que Vercel no queda bloqueado** (el que si bloquea es `listado.mercadolibre.com.ar`, que devuelve la pagina de "trafico sospechoso"). Si algun dia ML corta el scraping, la funcion tira error y **no** pisa el estado ni avisa de mas.

**El reloj arranca cuando Fer cambio el precio, no cuando lo vemos.** Fer lo pidio como "6 horas despues de que YO los cambie": la primera vez que se detecta el desvio, `desviado_desde` sale del ultimo cambio de `oferta_fyf` en `portal_precios_hist`. Por eso el primer aviso pudo decir "hace 4 dias" en vez de "hace 6 horas".

**Cadencia (definida por Fer):** primer aviso a las **6 h** de cambiado el precio, y despues **uno cada 24 h, SIN TOPE**, hasta que ML quede actualizado (`ML_HORAS_AVISO` / `ML_HORAS_REPASO`, envs de portal-precios). El **unico corte** es que el precio de ML vuelva a coincidir con la oferta — ahi se resetea solo y no hay nada que marcar a mano. El contador se sella **solo si Meta acepto el envio**.

**El mapeo publicacion -> modelo es manual, en la tabla `ml_publicaciones`** (`ml_id` PK, `modelo` = modelo del portal, `ignorar` para los accesorios). Se sembraron las 17 publicaciones de autos + 3 accesorios ignorados. **Una publicacion nueva entra sola con `modelo = null` y queda "sin mapear"**: se ve en el panel y NO se compara hasta que alguien le asigne el modelo (`update ml_publicaciones set modelo = '...' where ml_id = '...'`). Es el mismo riesgo que la col "Uso concesionaria" de elcerokm-feed.

**Template Meta:** `ml_tienda_precios` (es_AR, UTILITY, 3 vars: primer nombre - hace cuanto - detalle en UNA linea, porque Meta rechaza los saltos de linea dentro de un parametro). Se da de alta con `{"crear_template":true}`. **Mientras esta PENDING cae a `precios_actualizados`** metiendo el aviso entero en `{{1}}`: se entiende, pero el remate sigue diciendo "se actualizaron los valores en el portal". Cuando Meta apruebe, la corrida siguiente usa el propio sin tocar nada.

**Gotcha Meta (costo una vuelta):** un template en **PENDING no se puede editar** ("solo se pueden editar si se rechazaron"), y si lo borras **Meta te bloquea reusar ese nombre** por un rato largo (`error_subcode 2388023`). Si hay que cambiarle el cuerpo antes de la aprobacion: borrar y crear con **otro nombre**. Por eso el primer intento (`ml_tienda_desactualizada`) quedo muerto.

**Panel:** `precios.titogonzalez.online/ml-tienda` — precio publicado vs oferta, hace cuanto, stock, ademas de **que modelos con stock no estan publicados** y cuales quedaron publicados sin stock. Lo ven los tres duenios **+ `nvera` y `mlubrano`** (helper `puedeVerTiendaML` en `portal-precios/src/lib/acceso.ts`), porque son los que tienen que arreglarlo. Es solo lectura y no muestra costos ni margenes. **Entrar al panel refresca el estado pero NUNCA manda WhatsApp** (corre en modo `avisar: false`).

**Modos de prueba:** `/api/cron/ml-tienda?dry=1` (compara y guarda, no avisa) - en la Edge: `{"solo":"<E164>"}`, `{"listar":true,"nombre":"ml_tienda_precios"}`, `{"crear_template":true}`, `{"borrar_template":true}`.

**Envs:** `ML_TIENDA_DESTINATARIOS` (default `nvera,mlubrano,fngonzalez`) en Supabase - `ML_HORAS_AVISO` (6), `ML_HORAS_REPASO` (24), `ML_TIENDA_URL` en portal-precios.

## Feed de MarketShell (Shell) desactualizado (`notify-marketshell`)

A las **9 de la manana, todos los dias**, les llega un WhatsApp a **Fer (`fngonzalez`), Ines Alonso (`ialonso`) y Nadia Vera (`nvera`)** **solo si hay algo mal** en el feed que alimenta `marketshell.shell.com.ar/autos?seller=tito gonzalez`. Si esta todo bien no llega nada. Pedido por Fer el 01/09/2026.

**Que se audita — y que NO.** El portal publico de Shell **no se puede leer**: esta detras del checkpoint de Vercel y devuelve **HTTP 429** a curl, WebFetch y cualquier cliente sin browser real. Lo que se controla es la **planilla de Grupo Simpli "Copia de Shell2"** (`1qpm0C-gb5YZRQ72kbdTVFiprSKRi9O_2guhLZhmi3G8`), que es de donde ellos arman el portal y lo unico que manejamos nosotros. Si Simpli dejara de importar el archivo, eso no se ve desde aca.

**El motor de la auditoria no vive aca.** Esta Edge Function es el brazo que manda el WhatsApp (el token de Meta solo existe como secret de Supabase). Quien mira la planilla es el Apps Script del feed, en `marketshell-feed/live/Chequeo.js`, expuesto como **`?modo=chequeo`** (JSON, solo lectura) del mismo web app que ya corria el feed.

**Que cuenta como "no esta ok":**

| nivel | codigo | que pasa |
|---|---|---|
| critico | `precio_vacio` | fila de "Hoja 1" sin precio o en 0 |
| critico | `inv_sin_match` | fila de "Copia de importNewVehicle" que no matchea "Hoja 1" -> col P vacia |
| critico | `inv_error` / `inv_precio_vacio` | P o Q en `#ERROR!`, o P sin precio |
| critico | `hoja1_sin_match` | modelo publicado que ya no existe en el portal de precios |
| critico | `feed_caido` | hace >= 3 h que no corre `aplicarFeed`, o se perdio el trigger horario |
| critico | `portal_caido` | `/api/public/ofertas` no responde o devuelve 0 modelos |
| aviso | `alta_pendiente` | modelo con stock en baratito que no llega al archivo de Simpli |
| aviso | `formula_pisada` | P o Q con un valor pegado a mano en vez de la formula |
| aviso | `duplicado` | el mismo modelo dos veces en "Hoja 1" |

**Por que el precio vacio es critico y no un detalle:** el importador de Grupo Simpli **rechaza el archivo entero** si una sola fila viene sin `new_car_trims.amount` (lo aviso Nadia Vera el 01/09/2026). Un hueco en un modelo sin stock tira abajo la actualizacion de todos los demas.

**Como se detecta que el feed se freno:** `aplicarFeed` sella `ScriptProperties.ultimaCorridaOK` al terminar bien, y el chequeo compara contra eso (`FEED_MAX_HORAS = 3`). **El desfasaje suelto NO se avisa**: el trigger es horario, asi que casi siempre hay alguna fila esperando turno y avisarlo seria ruido todos los dias. Solo se nombra si ademas el feed esta caido.

**Si el chequeo no se puede correr, eso tambien se avisa.** Sin eso, un Apps Script caido o un token vencido se verian igual que "todo bien" — que es el modo de falla peligroso de cualquier alerta que solo habla cuando hay problemas.

**Cadencia:** pg_cron **jobid 26** `marketshell-chequeo-diario`, `0 12 * * *` (9:00 hora AR, todos los dias). Tabla **`marketshell_avisos`** en wjfgl (PK `fecha`): no repite el aviso si el cron corre dos veces y deja el historial de que dias el feed estuvo mal. Se escribe la fila **aunque el envio falle** (`enviados = 0` + `error`), para que un dia con problemas no parezca un dia limpio.

**Template Meta:** `marketshell_feed_alerta` (es_AR, UTILITY, 3 vars: nombre - resumen - detalle en UNA linea, porque Meta rechaza los saltos de linea dentro de un parametro). Creado y **APROBADO el 01/09/2026**. **Sin fallback a proposito** (misma decision que `notify-feed`): el unico template generico aprobado, `precios_actualizados`, cierra con "se actualizaron los valores en el portal", o sea avisaria de otra cosa. Preferible que el aviso no salga y quede el error en la tabla.

**Envs (Supabase secrets):** `MARKETSHELL_URL` (exec URL del web app) - `MARKETSHELL_TOKEN` - `MARKETSHELL_DESTINATARIOS` (default `fngonzalez,ialonso,nvera`, dedup por telefono porque Nadia tiene dos cuentas con el mismo numero).

**Modos de prueba:** `{"dry":true}` (corre el chequeo, no manda) - `{"dry":true,"simular":true}` (inventa problemas para ver el texto; el resumen arranca con "PRUEBA" a proposito) - `{"solo":"<E164>"}` - `{"forzar":true}` (ignora la fila del dia) - `{"listar":true}` / `{"crear_template":true}`.

**⚠️ Deployar con `--no-verify-jwt`** (gatea con `x-stock-secret`, igual que `notify-ml-desactualizado`).

**Dos cosas que el chequeo NO mira y quedaron para preguntarle a Nadia Vera (Simpli):** la columna `new_car_trims.currency` esta **vacia en las 38 filas** (dato preexistente, el feed no la toca — si su importador la valida es la misma bomba que el precio vacio), y las columnas de imagenes/brochure estan vacias en todas. No se metieron como alerta porque, al estar siempre vacias, avisarian todos los dias hasta que se resuelvan.

## Puente con ArgenDreams — TGA tasa los usados VW de ellos (`sync-argendreams`)

**El acuerdo (Fer con ArgenDreams, 24/08/2026):** ArgenDreams vende BYD y recibe usados de todas las marcas, que reparte entre 8 reventas. Lo que es **Volkswagen lo tasa TGA**. Por ahora solo VW; más adelante puede abrirse a más marcas (constante `MARCAS` en la función).

**Cómo funciona.** TGA entra al circuito de ArgenDreams como **una reventa más** (usuario `tga`, rol reventa), pero en vez de cotizar en la web de ellos lo hace desde su propio tasador. El puente es la Edge Function **`sync-argendreams`** (pg_cron `*/2 * * * *`, jobid 20), que hace tres pasadas por corrida:

1. **PULL** — trae las tasaciones VW que Agustín ya mandó a reventas (`en_reventa` / `precios_recibidos`) y las espeja en `tasaciones` de TGA. Las que están en `pendiente_admin` NO se traen: se ve solo lo moderado.
2. **PUSH** — el precio que carga Fer se escribe en `reventas_precios` de ArgenDreams (upsert por `on_conflict=tasacion_id,reventa_id,ronda`, así corregirlo pisa el anterior en vez de duplicar). Se dispara al guardar y el cron es la red de seguridad.
3. **AVISO DE ENTRADA** — apenas entra un VW nuevo le llega el WhatsApp a Fer con los datos del auto. Es imprescindible por la ventana corta (ver abajo).
4. **FEEDBACK** — cuando ArgenDreams cierra (`precio_al_vendedor` / `cerrada`), compara contra el mejor precio de la ronda y le manda WhatsApp a Fer con el resultado.

**WhatsApp por Meta Cloud API**, como todo el proyecto (mismos secrets `WA_TASADOR_PHONE_ID` / `WA_TASADOR_TOKEN`). Nada de CallMeBot: Fer lo pidió expresamente y además es un tercero gratuito sin garantías. Dos templates propios `es_AR` / UTILITY: **`argendreams_nuevo_vw`** (3 variables: nombre, auto, ficha+cliente+avisos) y **`argendreams_resultado`** (5: nombre, ganamos/no, auto, nuestro precio, cierre). Se dan de alta con **`?crear_templates=1`** (una sola vez) y se controlan con **`?listar=1`**. Destinatarios en el env `ARGD_DESTINATARIOS` (default `fngonzalez`), respetando el opt-out `notificaciones_wa`.

**Los sellos van solo si el WhatsApp salió de verdad** (`estado === "enviado"`). Si Meta rechaza —template sin aprobar, lo que sea—, la fila queda sin sellar y la próxima corrida reintenta. El resultado de la tasación, en cambio, se guarda siempre: el panel lo muestra aunque el aviso haya fallado.

**Se cotiza A CIEGAS** (decisión de Fer): no se ven los precios de las otras reventas hasta que cierra la ronda. Si se vieran antes, uno copia y pone un peso más — gana la operación pero pierde el termómetro de si está tasando bien, que es justamente para lo que se hizo.

**Solo fngonzalez.** El tab y el feedback son de Fer (`ARGD_USUARIOS` en `index.html`). Los otros admins no ven ni el tab.

**El precio que se carga es lo que TGA paga por la unidad**, no el precio al cliente: ArgenDreams le suma su comisión de plataforma (7-9%) antes de pasárselo. Es otro significado que el `precio_toma_final` del circuito propio, por eso vive en campos aparte (`externa_*`).

**Aislamiento — por qué las externas no ensucian nada.** Van con `origen='argendreams'` y **`estado='argendreams'`**. Ese estado propio es lo que las mantiene fuera de `notify-pending-sweep` y `notify-sin-responder`, que filtran `estado=eq.pendiente`. Como además no tienen patente ni turno, tampoco las agarran `portal-precios/usados.ts`, `daily-agenda`, `notify-usado-fisico` ni `notify-usado-sin-precio` (todos filtran por esos campos). En el front se filtran de los tabs del admin, del selector de vendedores y de "Mis tasaciones". Si mañana se agrega un consumidor nuevo de `tasaciones`, **acordarse de filtrar `origen='tga'`**.

**Columnas nuevas en `tasaciones`:** `origen` (default `'tga'`), `origen_ref_id` (uuid en ArgenDreams, con índice único), `origen_datos` (jsonb: BYD que consultaba el cliente, peritaje, ronda), `externa_precio` + `_at` + `_por`, `externa_ronda`, `externa_push_at`, `externa_estado_origen`, `externa_resultado` (`ganada`/`perdida`/`empatada`), `externa_mejor_precio`, `externa_cerrada_at`, `externa_avisado_at`.

**CCA y Fórmula FG se calculan en vivo** al renderizar la card, no vienen del sync: las dos apps leen la **misma planilla CCA** (`1MJWeHCTbxdqBJwifzgNbHssLLsxAwaSkb66Zc9yv3ko` gid=904791552), así que marca/modelo/versión matchean exacto sin normalizar. Al guardar el precio se snapshotean en `precio_cca` / `precio_formula_vw` para saber después con qué números se decidió.

**Probar sin escribir:** `?dry=1`. Devuelve las tres pasadas con el detalle de qué haría.

**⚠️ Deployar con `--no-verify-jwt`** (el pg_cron la llama sin header de auth).

**IDs:** reventa `tga` en ArgenDreams = `ef892191-d868-41c3-957a-860693c99f1d` (la función igual lo resuelve sola por `usuario='tga'`, no está hardcodeado). Si el usuario se desactiva, el puente corta solo y devuelve 412 sin escribir nada.

**Ventana real para cotizar (medida 24/08/2026 sobre 186 casos):** desde `enviada_a_reventas_at` hasta `precio_al_vendedor_at` pasan **2,9 h de mediana**; 110 de 186 cerraron en menos de 4 h y 13 en menos de 1 h (mínimo 11 minutos). Por eso el **aviso de entrada es obligatorio**, no un lujo: sin él la mitad se pasa de largo. Sella en `externa_aviso_entrada_at` (si CallMeBot falla, reintenta en la próxima corrida), tope de 5 por corrida y solo lo creado en las últimas 24 h.

**⚠️ `tasaciones.estado` tiene CHECK constraint.** Era `('pendiente','tasada','cerrada')` y hubo que ampliarlo con `'argendreams'` — sin eso el sync fallaba al insertar. Si mañana se agrega otro estado, ampliar el constraint primero.

## Gotchas y decisiones del proyecto

### Keys de Supabase formato nuevo (`sb_secret_*` / `sb_publishable_*`)
- Este proyecto Supabase usa el formato nuevo de keys, **NO JWTs clásicos** (`eyJ...`).
- Cualquier Edge Function que verifique JWT (toggle "Verify JWT with legacy secret" en Settings) va a rechazar las llamadas internas con 401 `UNAUTHORIZED_INVALID_JWT_FORMAT`.
- **Decisión**: tener ese toggle **OFF** en `notify-whatsapp` y `notify-pending-sweep`. Las funciones validan internamente sus inputs.
- Si en algún momento se vuelve a activar el toggle, las llamadas internas (sweeper → notify-whatsapp, cron → sweeper) dejan de funcionar.

### Project ref Supabase
- `wjfglsafgaltusmbnccl` — usar para construir URLs de funciones: `https://wjfglsafgaltusmbnccl.supabase.co/functions/v1/<nombre>`.

## Estado del entorno local al 27/04/2026

- Servidor local corriendo en `http://localhost:8765/` (iniciado con `python -m http.server 8765` desde la raíz del proyecto). Si se cerró la terminal, hay que reiniciarlo.
- Producción se sirve desde GitHub Pages en `tasador.titogonzalez.online`. Tras un push a `main` puede haber **caché del browser**: si los cambios no aparecen, hacer **Ctrl+Shift+R** (hard reload) o probar en ventana incógnita antes de pensar que el cambio falló.
- ~~Tema abierto histórico (16/04/2026): Ford Bronco Sport, precio del año equivocado.~~ **CERRADO 21/07/2026**: se auditaron las 6 filas de BRONCO SPORT contra el PDF de abril y coinciden exacto — no había data vieja en la columna 2024. Lo que sí existía era un corrimiento de años en **otras 496 filas** de la planilla (ver "Carga mensual del CCA").

## Pendientes al retomar

1. **Edge cases sin template Meta** (heredado del cambio 5): decidir si crear templates `usado_no_apto` y `turno_cancelado` o dejar sin notificación WA. Mientras tanto sigue usando CallMeBot para esos casos puntuales.
2. **Eventual**: si el sweeper detecta tasaciones que se reintentan muchas veces sin éxito, mirar `notificaciones_log` para entender la causa (Meta error, número inválido, etc).

## Convenciones y restricciones

- **Español rioplatense** en todo lo visible al usuario. Comentarios de código en español también.
- **Siempre pedir autorización antes de editar archivos.** Fer quiere paso a paso.
- **Commits con mensajes claros en español**, prefijos convencionales (feat, fix, refactor, docs).
- **NO modificar la lógica existente de CCA, ajuste km, o Kavak** sin consultar.
- **NO sugerir migrar a un framework** (React, Vue, etc.). Fer quiere mantener vanilla JS.
- **NO mover cosas a archivos separados** (CSS, JS) sin consultar. El single-file es intencional.
- **Credenciales hardcodeadas (Supabase anon key, CallMeBot)**: dejar como están. Son deuda técnica conocida, no prioridad.
- **Contraseñas en texto plano en tabla**: deuda técnica conocida, no tocar ahora.
- **Año base 2026 hardcodeado**: dejarlo (se actualiza manualmente cada año).

## Repositorio y deploy

- Repo: `fergonz00/tasador-tga` (privado) en GitHub
- Archivo principal: `index.html` (raíz)
- `CNAME`: dominio personalizado para GitHub Pages
- Branch principal: `main`
- Hosting: GitHub Pages con dominio `tasador.titogonzalez.online` (CNAME en el repo)

## Contacto y estilo de trabajo con Fer

- Fer es **no-técnico** pero con buen ojo de producto. Explicá decisiones técnicas en lenguaje claro.
- Fer trabaja **paso a paso con autorización en cada cambio**.
- Fer prefiere **archivos completos ready-to-paste** cuando se trabaja fuera de Claude Code, pero con Claude Code directo preferí editar in-place.
- Antes de un cambio grande, siempre presentar un **PLAN** primero y esperar aprobación.
- Micro-commits > big bang.
- Idioma de comunicación: **español**.
