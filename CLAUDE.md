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

- `calcPrecioCCA`: busca marca+modelo+versión+año en hoja CCA. Detecta moneda por lista MARCAS_PESOS (marcas en pesos × 1000; resto en USD × cotización)
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
- Tema abierto histórico (16/04/2026): en el CCA para un Ford Bronco Sport 2021 apareció el precio del año 2023 cuando Fer cargó 2024. Sospecha: la columna "2024" en la planilla CCA tiene la data vieja del 2023 (data issue, no bug). A verificar en la planilla de Google Sheets de CCA.

## Pendientes al retomar

1. **Verificar tema CCA 2024** (heredado): abrir la planilla CCA, columna 2024, ver si para Ford Bronco Sport BIG BEND la data está desactualizada.
2. **Edge cases sin template Meta** (heredado del cambio 5): decidir si crear templates `usado_no_apto` y `turno_cancelado` o dejar sin notificación WA. Mientras tanto sigue usando CallMeBot para esos casos puntuales.
3. **Eventual**: si el sweeper detecta tasaciones que se reintentan muchas veces sin éxito, mirar `notificaciones_log` para entender la causa (Meta error, número inválido, etc).

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
