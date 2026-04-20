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

### Cambio 3 — Deploy (⏳ pendiente)
Commit + push a GitHub (rama `main`). El sitio `tasador.titogonzalez.online` se actualiza solo al pushear (GitHub Pages).
Al día del 16/04/2026, NADA de los cambios está pusheado — todo está solo en `C:\proyectos\tasador-tga\` local.

## Estado del entorno local al 16/04/2026

- Servidor local corriendo en `http://localhost:8765/` (iniciado con `python -m http.server 8765` desde la raíz del proyecto). Si se cerró la terminal, hay que reiniciarlo.
- Fer probó sub-paso 2 y 3 con un Ford Bronco Sport 2021. Funcionó el paso 5 (selección del equiv 0km). Tema abierto: en el CCA para ese Bronco apareció el precio del año 2023 cuando Fer cargó 2024. Sospecha: la columna "2024" en la planilla CCA tiene la data vieja del 2023 (data issue, no bug de código). A verificar en la planilla de Google Sheets de CCA.

## Pendientes al retomar

1. **Probar cambio 2 end-to-end**: refrescar local (Ctrl+F5), hacer una tasación con 2-3 fotos reales, esperar ~60s, entrar como admin, verificar recuadro celeste "ANÁLISIS IA".
2. **Verificar tema CCA 2024**: abrir la planilla CCA, columna 2024, ver si para Ford Bronco Sport BIG BEND la data está desactualizada. Si sí, es tema de la planilla.
3. **Cambio 3 — deploy**: commit + push a main una vez que cambio 2 esté probado. Mensaje de commit sugerido: `feat: rediseño paso 5 wizard + análisis de fotos con IA`.

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
