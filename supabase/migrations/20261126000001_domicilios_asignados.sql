-- =====================================================================
-- Rol domiciliario (parte 2 de 2): asignacion de domicilios y acceso
-- =====================================================================
-- El domiciliario solo ve los pedidos tipo Domicilio que tiene asignados.
-- La forma de asignarlos desde la app se definira mas adelante; por ahora
-- solo se asignan desde el dashboard (nadie tiene permiso UPDATE en la columna).
-- =====================================================================

alter table public.customer_orders
    add column delivery_person_id uuid references public.profiles (id),
    add constraint customer_orders_delivery_person_check
        check (delivery_person_id is null or order_type = 'Domicilio');

create index customer_orders_delivery_person_idx
    on public.customer_orders (delivery_person_id)
    where delivery_person_id is not null;

create policy "pedidos_lectura_domiciliario" on public.customer_orders
    for select to authenticated
    using (
        (select public.mi_rol()) = 'domiciliario'
        and order_type = 'Domicilio'
        and delivery_person_id = (select auth.uid())
    );
