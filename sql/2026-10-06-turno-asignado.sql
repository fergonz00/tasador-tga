-- ============================================================================
-- Estado "Turno asignado" en la solapa Usados del CRM
-- 06-oct-2026
-- ============================================================================
-- Cuando se confirma el turno desde el tasador (la tasacion salio de un caso de
-- Usados con "Solicitar turno"), el caso pasa solo a "Turno asignado" en el CRM.
-- Antes habia que acordarse de moverlo a mano, y el estado existe justamente
-- para reflejar que el procedimiento quedo confirmado con fecha y hora.
--
-- Va por RPC porque `usados_leads` esta cerrada a la llave publica (RLS activa y
-- sin politicas) y el tasador no tiene la cookie crm_sess con la que la lee el
-- CRM. Misma firma de sesion y misma allowlist que usado_lead_para_tasacion.
-- ============================================================================

-- Gisela Buena se suma al circuito (antes solo Ines).
update public.app_config
   set valor = 'ialonso,gbuena,fngonzalez,fgonzalez,cgonzalez,mlubrano'
 where clave = 'usados_tasacion_usuarios';

create or replace function public.usado_lead_turno_asignado(
  p_actor text, p_actor_exp bigint, p_actor_sig text,
  p_id bigint, p_fecha date, p_hora text)
 returns text
 language plpgsql
 security definer
 set search_path to ''
as $fn$
declare v_permitidos text; v_estado text;
begin
  if not public.sesion_firmada_valida(p_actor, p_actor_exp, p_actor_sig) then
    raise exception 'no autorizado';
  end if;

  select c.valor into v_permitidos
    from public.app_config c where c.clave = 'usados_tasacion_usuarios';
  if v_permitidos is null
     or lower(p_actor) <> all (string_to_array(lower(v_permitidos), ',')) then
    raise exception 'no autorizado';
  end if;

  select u.estado into v_estado from public.usados_leads u where u.id = p_id;
  if v_estado is null then
    return 'no existe';
  end if;

  -- Un caso ya comprado no vuelve atras por reagendar un turno. El resto si:
  -- si estaba en "No avanza" y le dan fecha nueva, es que volvio a moverse.
  if v_estado = 'Comprado' then
    return 'sin cambios';
  end if;

  update public.usados_leads
     set estado = 'Turno asignado',
         nota = trim(both E'\n' from
                  coalesce(nota, '') || E'\n' ||
                  'Turno ' || to_char(p_fecha, 'DD/MM/YYYY') || ' ' || coalesce(p_hora, '') ||
                  ' (desde el tasador)'),
         updated_at = now()
   where id = p_id;

  return 'ok';
end;
$fn$;

grant execute on function public.usado_lead_turno_asignado(text, bigint, text, bigint, date, text)
  to anon, authenticated;

-- ============================================================================
-- REVERT
-- ============================================================================
-- drop function if exists public.usado_lead_turno_asignado(text, bigint, text, bigint, date, text);
-- update public.app_config set valor='ialonso,fngonzalez,fgonzalez,cgonzalez,mlubrano'
--  where clave='usados_tasacion_usuarios';
