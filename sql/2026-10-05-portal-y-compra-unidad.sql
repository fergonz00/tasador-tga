-- ============================================================================
-- Tasador: flujo "Tasación del Portal" + "¿el cliente compra unidad?"
-- 05-oct-2026
-- ============================================================================
-- Dos columnas nuevas, las dos nullables y sin default destructivo: lo que ya
-- existe queda igual.
--
-- 1) cliente_compra_unidad
--    Respuesta a la consulta que se le hace al vendedor en el wizard, entre el
--    paso de color/Kavak y el del 0km que consulta.
--      null  = no se preguntó (todas las tasaciones viejas y los vendedores
--              que todavia no tienen el paso habilitado)
--      true  = el cliente va a adquirir una unidad -> camino normal
--      false = el cliente SOLO vende su usado -> se saltean los pasos del 0km
--              y del precio ofrecido, y el tasador fisico lo ve remarcado.
--
-- 2) flujo_carga
--    Distingue las dos formas de saltear la etapa de precio virtual, que hoy
--    comparten `es_presencial = true`:
--      null       = flujo virtual de siempre, o una presencial vieja
--      'presencial' = el cliente esta en el concesionario CON el auto
--      'portal'     = el cliente consulto por la web y NO esta presente: se le
--                     agenda turno para que traiga la unidad.
--    Hace falta porque la pantalla del tasador fisico muestra el cartel
--    "CLIENTE PRESENCIAL", que para una del portal seria falso: el auto todavia
--    no llego.
-- ============================================================================

alter table public.tasaciones
  add column if not exists cliente_compra_unidad boolean,
  add column if not exists flujo_carga text;

comment on column public.tasaciones.cliente_compra_unidad is
  'null = no se pregunto; true = adquiere unidad (camino normal); false = solo vende su usado (se saltean 0km y precio ofrecido)';

comment on column public.tasaciones.flujo_carga is
  'null = virtual (o presencial vieja); presencial = cliente en el concesionario con el auto; portal = consulto por la web, se le agenda turno';

-- Las presenciales que ya existen son, por definicion, del flujo presencial:
-- ninguna tiene turno (verificado: 42 filas, 0 con turno_fecha).
update public.tasaciones
   set flujo_carga = 'presencial'
 where es_presencial is true
   and flujo_carga is null;

-- ============================================================================
-- REVERT
-- ============================================================================
-- alter table public.tasaciones
--   drop column if exists cliente_compra_unidad,
--   drop column if exists flujo_carga;
