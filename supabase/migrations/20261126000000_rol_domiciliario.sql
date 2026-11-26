-- =====================================================================
-- Rol domiciliario (parte 1 de 2)
-- Postgres no permite usar un valor nuevo de enum en la misma transaccion
-- en que se agrega, por eso las politicas van en la migracion siguiente.
-- =====================================================================

alter type public.rol_usuario add value if not exists 'domiciliario';
