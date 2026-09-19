-- Apply after 001–004. Additive; does not change existing activities or logs.
begin;
create table if not exists public.training_profiles (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  revision integer not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);
alter table public.training_profiles enable row level security;
revoke all on public.training_profiles from public, anon;
grant select, insert, update on public.training_profiles to authenticated;
drop policy if exists training_profiles_own on public.training_profiles;
create policy training_profiles_own on public.training_profiles
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.save_training_profile(p_patch jsonb, p_revision integer)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare current_row public.training_profiles;
declare next_settings jsonb;
declare field_name text;
declare date_value text;
declare available jsonb;
declare days numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if jsonb_typeof(p_patch) is distinct from 'object' or p_revision is null then
    raise exception 'Invalid profile update' using errcode = '22023';
  end if;
  insert into public.training_profiles(user_id) values (auth.uid()) on conflict do nothing;
  select * into current_row from public.training_profiles where user_id = auth.uid() for update;
  if current_row.revision <> p_revision then
    raise exception 'PROFILE_CONFLICT: Inställningarna har ändrats på en annan enhet.' using errcode = '40001';
  end if;
  next_settings := current_row.settings || p_patch;
  foreach field_name in array array['goal','activityTags','activityOverrides','planPreferences'] loop
    if p_patch ? field_name then
      if jsonb_typeof(p_patch->field_name) is distinct from 'object' then raise exception 'Invalid profile object' using errcode='22023'; end if;
      next_settings := jsonb_set(next_settings, array[field_name], coalesce(current_row.settings->field_name, '{}'::jsonb) || (p_patch->field_name));
    end if;
  end loop;
  if not (coalesce((next_settings->>'hrRest')::numeric,60) between 30 and 120)
     or not (coalesce((next_settings->>'hrMax')::numeric,190) between 100 and 240)
     or coalesce((next_settings->>'hrRest')::numeric,60) >= coalesce((next_settings->>'hrMax')::numeric,190)
     or not (coalesce((next_settings#>>'{goal,distanceKm}')::numeric,10) between 1 and 200)
     or not (coalesce((next_settings#>>'{goal,targetSeconds}')::numeric,2400) between 60 and 172800)
     or not (coalesce((next_settings->>'daysPerWeek')::numeric,4) between 1 and 7)
     or not (coalesce((next_settings->>'weeklyMinutes')::numeric,240) between 20 and 3000) then
    raise exception 'Invalid profile values' using errcode='22023';
  end if;
  days := coalesce((next_settings->>'daysPerWeek')::numeric,4);
  available := coalesce(next_settings->'availableDays','[1,3,5,6]'::jsonb);
  if days <> trunc(days) or jsonb_typeof(available) is distinct from 'array' then
    raise exception 'Invalid available days' using errcode='22023';
  end if;
  if jsonb_array_length(available) < days
     or exists(select 1 from jsonb_array_elements(available) d where jsonb_typeof(d) <> 'number' or d::text !~ '^[0-6]$')
     or (select count(*) from jsonb_array_elements(available)) <> (select count(distinct d) from jsonb_array_elements(available) d) then
    raise exception 'Invalid available days' using errcode='22023';
  end if;
  foreach date_value in array array[next_settings#>>'{goal,targetDate}',next_settings->>'coverageStart',next_settings->>'coverageThrough'] loop
    if coalesce(date_value,'') <> '' and (date_value !~ '^\d{4}-\d{2}-\d{2}$' or to_char(date_value::date,'YYYY-MM-DD') <> date_value) then
      raise exception 'Invalid profile date' using errcode='22023';
    end if;
  end loop;
  if (coalesce(next_settings->>'coverageStart','') = '') <> (coalesce(next_settings->>'coverageThrough','') = '')
     or nullif(next_settings->>'coverageStart','')::date > nullif(next_settings->>'coverageThrough','')::date
     or nullif(next_settings->>'coverageThrough','')::date > (now() at time zone 'Europe/Stockholm')::date then
    raise exception 'Invalid coverage dates' using errcode='22023';
  end if;
  update public.training_profiles set settings = next_settings, revision = revision + 1, updated_at = now()
    where user_id = auth.uid() returning * into current_row;
  return jsonb_build_object('settings', current_row.settings, 'revision', current_row.revision, 'updated_at', current_row.updated_at);
end $$;
revoke all on function public.save_training_profile(jsonb, integer) from public, anon;
grant execute on function public.save_training_profile(jsonb, integer) to authenticated;
commit;
