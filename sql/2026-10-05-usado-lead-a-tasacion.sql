-- ============================================================================
-- "Solicitar turno" desde la solapa Usados del CRM
-- 05-oct-2026
-- ============================================================================
-- Inés abre un caso de `usados_leads` (los dueños de MercadoLibre que quieren
-- vendernos el auto) y aprieta "Solicitar turno". Eso abre el tasador con
-- ?usado=<id>, que precarga el wizard y entra derecho como "tasación del
-- portal".
--
-- Por qué una función y no leer la tabla: `usados_leads` está cerrada a la
-- llave pública (RLS activa y SIN políticas, así que niega todo: verificado,
-- un select con la anon devuelve [] y un insert da 401). El CRM la lee por su
-- proxy firmado con la cookie crm_sess, que el tasador no tiene. Entonces el
-- tasador pide la fila con la MISMA firma de sesión que ya usa para todo lo
-- demás, y en el link solo viaja el id: ni datos del cliente ni precios en la
-- URL, el historial del navegador o los logs intermedios.
--
-- Quién puede: una sesión firmada vigente Y estar en la lista. La lista vive en
-- app_config para poder sumar gente sin tocar código ni deployar.
-- ============================================================================

insert into public.app_config (clave, valor)
  values ('usados_tasacion_usuarios', 'ialonso,fngonzalez,fgonzalez,cgonzalez,mlubrano')
  on conflict (clave) do nothing;

create or replace function public.usado_lead_para_tasacion(
  p_actor text, p_actor_exp bigint, p_actor_sig text, p_id bigint)
 returns table(
   id bigint, titulo text, anio integer, km integer, color text,
   version_ficha text, localidad text, link text,
   pide numeric, ofrecimos numeric,
   kavak_version text, kavak_inmediata numeric, kavak_permuta numeric,
   cca_version text, cca_valor numeric,
   cero_km text, respuesta text, nota text, estado text)
 language plpgsql
 security definer
 set search_path to ''
as $fn$
declare v_permitidos text;
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

  return query
    select u.id, u.titulo, u.anio, u.km, u.color,
           u.version_ficha, u.localidad, u.link,
           u.pide, u.ofrecimos,
           u.kavak_version, u.kavak_inmediata, u.kavak_permuta,
           u.cca_version, u.cca_valor,
           u.cero_km, u.respuesta, u.nota, u.estado
      from public.usados_leads u
     where u.id = p_id;
end;
$fn$;

grant execute on function public.usado_lead_para_tasacion(text, bigint, text, bigint)
  to anon, authenticated;

-- ----------------------------------------------------------------------------
-- De qué caso de Usados salió la tasación.
-- Sin esto no hay forma de saber después si un caso ya tiene turno pedido, ni
-- de evitar que se cargue dos veces el mismo auto.
-- ----------------------------------------------------------------------------
alter table public.tasaciones
  add column if not exists usado_lead_id bigint;

comment on column public.tasaciones.usado_lead_id is
  'id de usados_leads cuando la tasacion se inicio con "Solicitar turno" desde la solapa Usados del CRM; null en el resto';

create index if not exists tasaciones_usado_lead_id_idx
  on public.tasaciones (usado_lead_id) where usado_lead_id is not null;

-- ============================================================================
-- REVERT
-- ============================================================================
-- drop function if exists public.usado_lead_para_tasacion(text, bigint, text, bigint);
-- drop index if exists public.tasaciones_usado_lead_id_idx;
-- alter table public.tasaciones drop column if exists usado_lead_id;
-- delete from public.app_config where clave='usados_tasacion_usuarios';
