-- =====================================================================
-- Productos que ocupan espacio en la bandeja del domiciliario.
-- La capacidad de una bandeja se mide en productos que ocupan bandeja
-- (bandeja grande = 10, mediana = 7). Bebidas y fritos de desayuno no cuentan.
-- =====================================================================

alter table public.menu_dishes
    add column ocupa_bandeja boolean not null default true;

update public.menu_dishes d
   set ocupa_bandeja = false
  from public.menu_sections s
 where s.id = d.menu_section_id
   and (
        s.name = 'Bebidas'
        or (s.name = 'Desayuno' and d.name in (
            'Buñuelos', 'Empanada', 'Palo de queso', 'Panzerotti',
            'Papa', 'Pastel de pollo', 'Torta de Carne'
        ))
   );
