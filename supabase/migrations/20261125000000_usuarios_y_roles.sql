-- =====================================================================
-- Usuarios, roles (admin / mesero / cocina) y seguridad RLS
-- =====================================================================
-- Ejecutar completo en: Supabase > SQL Editor.
-- IMPORTANTE: despues de ejecutarlo, la version anterior de la app
-- (sin login) deja de funcionar. Publicar el frontend nuevo al mismo tiempo.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Perfiles y roles
-- ---------------------------------------------------------------------
create type public.rol_usuario as enum ('admin', 'mesero', 'cocina');

create table public.profiles (
    id         uuid primary key references auth.users (id) on delete cascade,
    nombre     text not null default '',
    rol        public.rol_usuario,            -- null = sin acceso hasta que un admin le asigne rol
    activo     boolean not null default true, -- false = acceso bloqueado sin borrar el usuario
    created_at timestamptz not null default now()
);

-- Cada usuario creado en Auth recibe su perfil automaticamente (sin rol).
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, nombre)
    values (new.id, coalesce(new.raw_user_meta_data ->> 'nombre', split_part(new.email, '@', 1)));
    return new;
end;
$$;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- Perfiles para usuarios creados antes de esta migracion.
insert into public.profiles (id, nombre)
select id, coalesce(raw_user_meta_data ->> 'nombre', split_part(email, '@', 1))
  from auth.users
on conflict (id) do nothing;

-- Rol del usuario actual (null si no tiene rol o esta inactivo).
create function public.mi_rol()
returns public.rol_usuario
language sql
stable
security definer
set search_path = ''
as $$
    select rol from public.profiles where id = auth.uid() and activo;
$$;

-- Medianoche de hoy en hora de Colombia.
create function public.inicio_del_dia()
returns timestamptz
language sql
stable
set search_path = ''
as $$
    select date_trunc('day', now() at time zone 'America/Bogota') at time zone 'America/Bogota';
$$;

-- ---------------------------------------------------------------------
-- 2. Ajustes a pedidos
-- ---------------------------------------------------------------------
-- Normalizar datos existentes
update public.customer_orders set order_type   = 'Salón'     where order_type = 'Salon';
update public.customer_orders set order_status = 'Pendiente' where order_status is null or order_status = 'Pending';

alter table public.customer_orders
    add column created_by uuid references public.profiles (id) default auth.uid(),
    add column client_id  uuid unique,  -- id generado en el dispositivo; evita pedidos duplicados al reintentar
    alter column order_status set default 'Pendiente',
    alter column order_status set not null,
    add constraint customer_orders_order_status_check
        check (order_status in ('Pendiente', 'En preparación', 'Listo')),
    add constraint customer_orders_order_type_check
        check (order_type in ('Salón', 'Domicilio', 'Para Llevar'));

create index customer_orders_created_at_idx      on public.customer_orders (created_at desc);
create index order_line_items_customer_order_idx on public.order_line_items (customer_order_id);

-- Registrar pedido + lineas en una sola transaccion (idempotente por client_id).
create function public.registrar_pedido(
    p_client_id uuid,
    p_tipo      text,
    p_cliente   text,
    p_destino   text,
    p_items     jsonb  -- [{menu_dish_id, quantity, unit_price, modifications_selected}]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_id uuid;
begin
    if public.mi_rol() is null or public.mi_rol() not in ('admin', 'mesero') then
        raise exception 'No autorizado para registrar pedidos' using errcode = '42501';
    end if;

    if p_client_id is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
        raise exception 'Pedido invalido o vacio' using errcode = '22023';
    end if;

    insert into public.customer_orders
        (client_id, order_type, customer_name, delivery_destination, total_amount, created_by)
    values (
        p_client_id,
        p_tipo,
        nullif(trim(p_cliente), ''),
        nullif(trim(p_destino), ''),
        (select coalesce(sum((i ->> 'quantity')::int * (i ->> 'unit_price')::numeric), 0)
           from jsonb_array_elements(p_items) i),
        auth.uid()
    )
    on conflict (client_id) do nothing
    returning id into v_id;

    -- Ya se habia registrado (reintento de la cola offline): devolver el existente.
    if v_id is null then
        select id into v_id from public.customer_orders where client_id = p_client_id;
        return v_id;
    end if;

    insert into public.order_line_items
        (customer_order_id, menu_dish_id, quantity, unit_price, modifications_selected)
    select v_id,
           (i ->> 'menu_dish_id')::uuid,
           (i ->> 'quantity')::int,
           (i ->> 'unit_price')::numeric,
           nullif(i ->> 'modifications_selected', '')
      from jsonb_array_elements(p_items) i;

    return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Permisos de tabla
-- ---------------------------------------------------------------------
-- Sin sesion no se puede hacer nada.
revoke all on all tables in schema public from anon;

-- Los pedidos solo se crean via registrar_pedido(); de los pedidos solo se edita el estado.
revoke insert, update on public.customer_orders  from authenticated;
revoke insert, update on public.order_line_items from authenticated;
grant update (order_status, updated_at) on public.customer_orders to authenticated;

-- Los perfiles se gestionan desde el dashboard.
revoke insert, update, delete on public.profiles from authenticated;

-- Funciones
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.registrar_pedido(uuid, text, text, text, jsonb) from public, anon;
revoke execute on function public.mi_rol() from public, anon;
revoke execute on function public.inicio_del_dia() from public, anon;
grant execute on function public.registrar_pedido(uuid, text, text, text, jsonb) to authenticated;
grant execute on function public.mi_rol() to authenticated;
grant execute on function public.inicio_del_dia() to authenticated;

-- ---------------------------------------------------------------------
-- 4. Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.menu_sections      enable row level security;
alter table public.menu_dishes        enable row level security;
alter table public.dish_modifications enable row level security;
alter table public.clients            enable row level security;
alter table public.customer_orders    enable row level security;
alter table public.order_line_items   enable row level security;

-- Perfiles: cada quien ve el suyo; el personal activo ve los nombres del equipo.
create policy "perfiles_lectura" on public.profiles
    for select to authenticated
    using (id = (select auth.uid()) or (select public.mi_rol()) is not null);

-- Menu y clientes: todo el personal lee; solo admin modifica.
create policy "menu_sections_lectura" on public.menu_sections
    for select to authenticated using ((select public.mi_rol()) is not null);
create policy "menu_sections_admin" on public.menu_sections
    for all to authenticated
    using ((select public.mi_rol()) = 'admin') with check ((select public.mi_rol()) = 'admin');

create policy "menu_dishes_lectura" on public.menu_dishes
    for select to authenticated using ((select public.mi_rol()) is not null);
create policy "menu_dishes_admin" on public.menu_dishes
    for all to authenticated
    using ((select public.mi_rol()) = 'admin') with check ((select public.mi_rol()) = 'admin');

create policy "dish_modifications_lectura" on public.dish_modifications
    for select to authenticated using ((select public.mi_rol()) is not null);
create policy "dish_modifications_admin" on public.dish_modifications
    for all to authenticated
    using ((select public.mi_rol()) = 'admin') with check ((select public.mi_rol()) = 'admin');

create policy "clients_lectura" on public.clients
    for select to authenticated using ((select public.mi_rol()) is not null);
create policy "clients_admin" on public.clients
    for all to authenticated
    using ((select public.mi_rol()) = 'admin') with check ((select public.mi_rol()) = 'admin');

-- Pedidos: admin ve todo; mesero y cocina solo los de hoy.
create policy "pedidos_lectura" on public.customer_orders
    for select to authenticated
    using (
        (select public.mi_rol()) = 'admin'
        or ((select public.mi_rol()) in ('mesero', 'cocina') and created_at >= (select public.inicio_del_dia()))
    );

-- Cambiar estado: admin cualquiera, cocina solo los de hoy (la columna esta limitada por GRANT).
create policy "pedidos_estado" on public.customer_orders
    for update to authenticated
    using (
        (select public.mi_rol()) = 'admin'
        or ((select public.mi_rol()) = 'cocina' and created_at >= (select public.inicio_del_dia()))
    )
    with check ((select public.mi_rol()) in ('admin', 'cocina'));

create policy "pedidos_borrar_admin" on public.customer_orders
    for delete to authenticated using ((select public.mi_rol()) = 'admin');

-- Lineas: visibles si el pedido es visible (hereda la regla de arriba).
create policy "lineas_lectura" on public.order_line_items
    for select to authenticated
    using (exists (select 1 from public.customer_orders o where o.id = customer_order_id));

create policy "lineas_borrar_admin" on public.order_line_items
    for delete to authenticated using ((select public.mi_rol()) = 'admin');

commit;
