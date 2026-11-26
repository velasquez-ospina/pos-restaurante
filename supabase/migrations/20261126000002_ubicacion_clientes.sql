-- =====================================================================
-- Ubicacion de clientes (base para el algoritmo de rutas de domicilios)
-- =====================================================================

alter table public.clients
    add column direccion             text,
    add column lat                   double precision,
    add column lng                   double precision,
    add column ubicacion_fuente      text,                           -- 'web', 'manual', ...
    add column ubicacion_nota        text,                           -- de donde salio el dato / dudas
    add column ubicacion_verificada  boolean not null default false; -- true cuando un humano la confirma
