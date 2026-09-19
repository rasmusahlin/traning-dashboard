-- Approved restriction of the optional legacy coach table to server access.
-- Does not read, update or delete note contents, or alter other tables.
begin;
do $$
declare
  columns_sql text;
  client_role text;
  permission text;
begin
  if to_regclass('public.coach_notes') is null then return; end if;
  revoke all privileges on table public.coach_notes from public, anon, authenticated;
  select string_agg(quote_ident(attname), ', ' order by attnum)
    into columns_sql from pg_attribute
    where attrelid = 'public.coach_notes'::regclass and attnum > 0 and not attisdropped;
  execute format('revoke all privileges (%s) on table public.coach_notes from public, anon, authenticated', columns_sql);
  foreach client_role in array array['anon', 'authenticated'] loop
    if has_table_privilege(client_role, 'public.coach_notes', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege(client_role, 'public.coach_notes', 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Client access remains for %; rolling back', client_role;
    end if;
  end loop;
  foreach permission in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if not has_table_privilege('service_role', 'public.coach_notes', permission) then
      raise exception 'Server privilege % missing; rolling back', permission;
    end if;
  end loop;
end $$;
commit;
