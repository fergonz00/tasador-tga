-- ============================================================================
-- Relleno de origen_datos.portal en las tasaciones que ya venian del portal
-- 06-oct-2026
-- ============================================================================
-- Desde hoy, al crear una tasacion desde la solapa Usados del CRM se copia en
-- `origen_datos.portal` lo que el dueño pedia en el aviso de MercadoLibre, el
-- link y el titulo. Asi el admin los ve sin tener que consultar `usados_leads`,
-- que esta cerrada a la llave publica y no puede leer el tasador.
--
-- Esto rellena las que ya se habian creado antes del cambio, tomando el dato de
-- usados_leads por usado_lead_id. Solo toca las que tienen el vinculo y todavia
-- no tienen el bloque `portal` guardado.
-- ============================================================================

update public.tasaciones t
   set origen_datos = coalesce(t.origen_datos, '{}'::jsonb) || jsonb_build_object(
         'portal', jsonb_build_object(
           'pide',   u.pide,
           'link',   u.link,
           'titulo', u.titulo
         ))
  from public.usados_leads u
 where u.id = t.usado_lead_id
   and t.usado_lead_id is not null
   and (t.origen_datos is null or not (t.origen_datos ? 'portal'));

-- Control
select t.patente,
       t.origen_datos->'portal'->>'pide'   as pide,
       t.origen_datos->'portal'->>'link'   as link,
       t.origen_datos->'portal'->>'titulo' as titulo
  from public.tasaciones t
 where t.usado_lead_id is not null;

-- ============================================================================
-- REVERT
-- ============================================================================
-- update public.tasaciones set origen_datos = origen_datos - 'portal'
--  where usado_lead_id is not null;
