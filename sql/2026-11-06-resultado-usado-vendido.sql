-- =============================================================================
-- Resultado de cada usado comprado y vendido.
--
-- POR QUE: el circuito de stock guardaba a cuanto se TOMO la unidad
-- (precio_toma_final) y, al marcarla vendida, solo la fecha y quien la marco.
-- No quedaba a cuanto se vendio ni cuanto se gasto en arreglarla, asi que no se
-- podia saber si la operacion dejo plata o no. Lo pidio Matias el 06/11/2026:
--   venta - toma - arreglos = diferencia (verde a favor / roja en contra)
--
-- Los arreglos son los REALES, lo que efectivamente se gasto. El estimado de la
-- inspeccion ya existe y vive en analisis_fisico.total_arreglos: son dos cosas
-- distintas y por eso no se pisan (en el modal se muestra el estimado al lado,
-- como referencia).
--
-- Todo nullable a proposito: una unidad marcada como vendida antes de hoy no
-- tiene estos datos y tiene que seguir funcionando igual.
-- =============================================================================

alter table public.tasaciones
  add column if not exists vendido_precio           numeric,
  add column if not exists vendido_arreglos         numeric,
  add column if not exists vendido_arreglos_detalle text;

comment on column public.tasaciones.vendido_precio   is 'A cuanto se vendio el usado que estaba en stock (ARS).';
comment on column public.tasaciones.vendido_arreglos is 'Lo que REALMENTE se gasto en arreglarlo antes de venderlo (ARS). 0 = no se hicieron.';
comment on column public.tasaciones.vendido_arreglos_detalle is 'Que se le hizo, en una linea. Opcional.';
