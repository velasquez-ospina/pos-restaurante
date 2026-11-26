-- =====================================================================
-- Despacho de domicilios:
--  * disponibilidad y bandeja de cada domiciliario
--  * estados En camino / Entregado con marcas de tiempo
--  * enlace pedido -> cliente (para conocer la ubicacion)
--  * orden de la ruta asignada
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Disponibilidad de domiciliarios
-- ---------------------------------------------------------------------
create table public.domiciliarios_estado (
    profile_id     uuid primary key references public.profiles (id) on delete cascade,
    disponible     boolean not null default false,
    bandeja        text check (bandeja in ('grande', 'mediana')),
    actualizado_at timestamptz not null default now(),
    constraint domiciliarios_estado_disponible_check check (not disponible or bandeja is not null)
);

revoke all on public.domiciliarios_estado from anon;
revoke delete on public.domiciliarios_estado from authenticated;
alter table public.domiciliarios_estado enable row level security;

create policy "dom_estado_lectura" on public.domiciliarios_estado
    for select to authenticated
    using (profile_id = (select auth.uid()) or (select public.mi_rol()) = 'admin');

create policy "dom_estado_insertar" on public.domiciliarios_estado
    for insert to authenticated
    with check (
        (profile_id = (select auth.uid()) and (select public.mi_rol()) = 'domiciliario')
        or (select public.mi_rol()) = 'admin'
    );

create policy "dom_estado_actualizar" on public.domiciliarios_estado
    for update to authenticated
    using (
        (profile_id = (select auth.uid()) and (select public.mi_rol()) = 'domiciliario')
        or (select public.mi_rol()) = 'admin'
    )
    with check (
        (profile_id = (select auth.uid()) and (select public.mi_rol()) = 'domiciliario')
        or (select public.mi_rol()) = 'admin'
    );

-- ---------------------------------------------------------------------
-- 2. Pedidos: estados nuevos, marcas de tiempo, cliente y ruta
-- ---------------------------------------------------------------------
alter table public.customer_orders
    drop constraint customer_orders_order_status_check,
    add constraint customer_orders_order_status_check
        check (order_status in ('Pendiente', 'En preparación', 'Listo', 'En camino', 'Entregado')),
    add column customer_id     uuid references public.clients (id),
    add column orden_ruta      smallint,
    add column asignado_at     timestamptz,
    add column preparacion_at  timestamptz,
    add column listo_at        timestamptz,
    add column en_camino_at    timestamptz,
    add column entregado_at    timestamptz;

create index customer_orders_customer_idx on public.customer_orders (customer_id) where customer_id is not null;

-- Enlazar pedidos existentes con su cliente por nombre
update public.customer_orders o
   set customer_id = c.id
  from public.clients c
 where o.customer_id is null
   and o.delivery_destination is not null
   and lower(trim(c.name)) = lower(trim(o.delivery_destination));

-- Admin asigna domiciliario y orden de ruta (el trigger valida el rol)
grant update (delivery_person_id, orden_ruta) on public.customer_orders to authenticated;

-- El domiciliario cambia el estado de sus pedidos asignados
create policy "pedidos_estado_domiciliario" on public.customer_orders
    for update to authenticated
    using ((select public.mi_rol()) = 'domiciliario' and delivery_person_id = (select auth.uid()))
    with check ((select public.mi_rol()) = 'domiciliario' and delivery_person_id = (select auth.uid()));

-- Valida quien cambia que, y registra la hora de cada estado
create function public.pedido_antes_de_actualizar()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
    v_rol public.rol_usuario := public.mi_rol();
begin
    -- auth.uid() es null cuando el cambio viene del dashboard / SQL: se permite todo
    if auth.uid() is not null then
        if (new.delivery_person_id is distinct from old.delivery_person_id
            or new.orden_ruta is distinct from old.orden_ruta)
           and v_rol is distinct from 'admin' then
            raise exception 'Solo un administrador puede asignar domicilios' using errcode = '42501';
        end if;

        if new.order_status is distinct from old.order_status then
            if v_rol = 'cocina' and new.order_status not in ('Pendiente', 'En preparación', 'Listo') then
                raise exception 'Cocina no puede marcar un pedido como %', new.order_status using errcode = '42501';
            end if;
            if v_rol = 'domiciliario' and new.order_status not in ('En camino', 'Entregado') then
                raise exception 'El domiciliario no puede marcar un pedido como %', new.order_status using errcode = '42501';
            end if;
        end if;
    end if;

    if new.delivery_person_id is distinct from old.delivery_person_id then
        if new.delivery_person_id is not null and not exists (
            select 1 from public.profiles p
             where p.id = new.delivery_person_id and p.rol = 'domiciliario' and p.activo
        ) then
            raise exception 'El usuario asignado no es un domiciliario activo' using errcode = '22023';
        end if;
        new.asignado_at := case when new.delivery_person_id is null then null else now() end;
        if new.delivery_person_id is null then
            new.orden_ruta := null;
        end if;
    end if;

    if new.order_status is distinct from old.order_status then
        case new.order_status
            when 'En preparación' then new.preparacion_at := coalesce(new.preparacion_at, now());
            when 'Listo'          then new.listo_at       := now();
            when 'En camino'      then new.en_camino_at   := now();
            when 'Entregado'      then new.entregado_at   := now();
            else null;
        end case;
    end if;

    new.updated_at := now();
    return new;
end;
$$;

create trigger pedido_antes_de_actualizar
    before update on public.customer_orders
    for each row execute function public.pedido_antes_de_actualizar();

-- ---------------------------------------------------------------------
-- 3. registrar_pedido: enlazar el cliente por nombre del destino
-- ---------------------------------------------------------------------
create or replace function public.registrar_pedido(
    p_client_id uuid,
    p_tipo      text,
    p_cliente   text,
    p_destino   text,
    p_items     jsonb
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
        (client_id, order_type, customer_name, delivery_destination, total_amount, created_by, customer_id)
    values (
        p_client_id,
        p_tipo,
        nullif(trim(p_cliente), ''),
        nullif(trim(p_destino), ''),
        (select coalesce(sum((i ->> 'quantity')::int * (i ->> 'unit_price')::numeric), 0)
           from jsonb_array_elements(p_items) i),
        auth.uid(),
        (select c.id from public.clients c
          where nullif(trim(p_destino), '') is not null
            and lower(trim(c.name)) = lower(trim(p_destino))
          limit 1)
    )
    on conflict (client_id) do nothing
    returning id into v_id;

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
