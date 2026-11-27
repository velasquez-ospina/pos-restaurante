-- =====================================================================
-- El admin puede editar/cancelar pedidos en cualquier estado (salvo
-- cancelados) y de cualquier dia. El mesero mantiene las reglas: solo
-- pedidos de hoy, no despachados y no asignados a un domiciliario.
-- Si el admin cambia un pedido asignado a un tipo distinto de Domicilio,
-- se quita la asignacion.
-- =====================================================================

create or replace function public._pedido_editable(p_id uuid)
returns public.customer_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_rol public.rol_usuario := public.mi_rol();
    v_ped public.customer_orders;
begin
    if v_rol is null or v_rol not in ('admin', 'mesero') then
        raise exception 'No autorizado para modificar pedidos' using errcode = '42501';
    end if;

    select * into v_ped from public.customer_orders where id = p_id for update;
    if not found then
        raise exception 'Pedido no encontrado' using errcode = 'P0002';
    end if;
    if v_ped.order_status = 'Cancelado' then
        raise exception 'El pedido está cancelado y no se puede modificar' using errcode = '55000';
    end if;

    if v_rol = 'mesero' then
        if v_ped.created_at < public.inicio_del_dia() then
            raise exception 'Solo se pueden modificar pedidos de hoy' using errcode = '42501';
        end if;
        if v_ped.order_status in ('En camino', 'Entregado') then
            raise exception 'El pedido ya está % y no se puede modificar', lower(v_ped.order_status) using errcode = '55000';
        end if;
        if v_ped.delivery_person_id is not null then
            raise exception 'El pedido ya está asignado a un domiciliario. Pide al administrador que quite la asignación en Despacho.'
                using errcode = '55000';
        end if;
    end if;
    return v_ped;
end;
$$;

revoke execute on function public._pedido_editable(uuid) from public, anon, authenticated;

create or replace function public.editar_pedido(
    p_id      uuid,
    p_tipo    text,
    p_cliente text,
    p_destino text,
    p_items   jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_ped    public.customer_orders;
    v_cambio boolean;
begin
    v_ped := public._pedido_editable(p_id);

    if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
        raise exception 'El pedido no puede quedar vacío. Si el cliente se retracta, cancélalo.' using errcode = '22023';
    end if;

    select
        (select coalesce(jsonb_agg(x order by x::text), '[]'::jsonb) from (
            select jsonb_build_object('d', menu_dish_id, 'q', quantity, 'm', coalesce(modifications_selected, '')) x
              from public.order_line_items where customer_order_id = p_id) a)
        is distinct from
        (select coalesce(jsonb_agg(x order by x::text), '[]'::jsonb) from (
            select jsonb_build_object('d', (i ->> 'menu_dish_id')::uuid, 'q', (i ->> 'quantity')::int,
                                      'm', coalesce(nullif(i ->> 'modifications_selected', ''), '')) x
              from jsonb_array_elements(p_items) i) b)
    into v_cambio;

    delete from public.order_line_items where customer_order_id = p_id;
    insert into public.order_line_items
        (customer_order_id, menu_dish_id, quantity, unit_price, modifications_selected)
    select p_id,
           (i ->> 'menu_dish_id')::uuid,
           (i ->> 'quantity')::int,
           (i ->> 'unit_price')::numeric,
           nullif(i ->> 'modifications_selected', '')
      from jsonb_array_elements(p_items) i;

    update public.customer_orders set
        order_type           = p_tipo,
        customer_name        = nullif(trim(p_cliente), ''),
        delivery_destination = nullif(trim(p_destino), ''),
        customer_id          = (select c.id from public.clients c
                                 where nullif(trim(p_destino), '') is not null
                                   and lower(trim(c.name)) = lower(trim(p_destino))
                                 limit 1),
        total_amount         = (select coalesce(sum((i ->> 'quantity')::int * (i ->> 'unit_price')::numeric), 0)
                                  from jsonb_array_elements(p_items) i),
        order_status         = case when v_cambio and v_ped.order_status = 'Listo'
                                    then 'En preparación' else v_ped.order_status end,
        -- Solo un pedido a domicilio puede tener domiciliario (solo el admin llega aqui con uno asignado)
        delivery_person_id   = case when p_tipo = 'Domicilio' then v_ped.delivery_person_id else null end,
        modificado_at        = now()
    where id = p_id;
end;
$$;
