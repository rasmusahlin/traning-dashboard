-- Träningsdashboard – låst Supabase-bootstrap
-- Skapar tabeller men lämnar dem otillgängliga tills
-- supabase/migrations/001_owner_rls_auth.sql har körts.

-- Aktiviteter (summering per pass)
create table if not exists activities (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  activity_date date not null,
  activity_type text not null,
  sport_raw text,
  distance_meters numeric,
  duration_seconds numeric,
  moving_time_seconds numeric,
  avg_hr integer,
  max_hr integer,
  avg_cadence integer,
  avg_speed_ms numeric,
  max_speed_ms numeric,
  elevation_gain_meters numeric,
  elevation_loss_meters numeric,
  calories integer,
  avg_power integer,
  training_stress_score numeric,
  filename text,
  source_hash text,
  notes text,
  raw_data jsonb
);

-- Laps (Garmin-laps, auto eller manuella)
create table if not exists laps (
  id uuid default gen_random_uuid() primary key,
  activity_id uuid references activities(id) on delete cascade,
  lap_index integer,
  start_time timestamptz,
  distance_meters numeric,
  duration_seconds numeric,
  avg_hr integer,
  max_hr integer,
  avg_pace_sec_per_km numeric,
  avg_cadence integer,
  elevation_gain numeric,
  calories integer,
  lap_trigger text
);

-- Km-splits (beräknade från per-sekund-data)
create table if not exists km_splits (
  id uuid default gen_random_uuid() primary key,
  activity_id uuid references activities(id) on delete cascade,
  km integer,
  distance_meters numeric,
  duration_seconds numeric,
  pace_sec_per_km numeric,
  avg_hr integer,
  avg_cadence integer,
  elevation_gain numeric,
  partial boolean default false
);

-- Tidsserie (per-sekund-data, nedsamplad till ~500 punkter)
create table if not exists time_series (
  id uuid default gen_random_uuid() primary key,
  activity_id uuid references activities(id) on delete cascade,
  t numeric,      -- sekunder sedan start
  d numeric,      -- distans i meter
  hr integer,     -- puls bpm
  alt numeric,    -- elevation meter
  speed numeric,  -- hastighet m/s
  cadence integer -- kadens spm
);

-- Kostlogg
create table if not exists nutrition_logs (
  id uuid default gen_random_uuid() primary key,
  log_date date not null unique,
  calories integer,
  protein_g numeric,
  carbs_g numeric,
  fat_g numeric,
  notes text,
  created_at timestamptz default now()
);

-- Index för vanliga queries
create index if not exists idx_activities_date on activities(activity_date desc);
create index if not exists idx_activities_type on activities(activity_type);
create index if not exists idx_laps_activity on laps(activity_id);
create index if not exists idx_splits_activity on km_splits(activity_id);
create index if not exists idx_ts_activity on time_series(activity_id);

-- Fail closed. Migration 001 lägger till ägarskap, policies och authenticated-grants.
alter table public.activities enable row level security;
alter table public.laps enable row level security;
alter table public.km_splits enable row level security;
alter table public.time_series enable row level security;
alter table public.nutrition_logs enable row level security;

revoke all on table public.activities from public, anon;
revoke all on table public.laps from public, anon;
revoke all on table public.km_splits from public, anon;
revoke all on table public.time_series from public, anon;
revoke all on table public.nutrition_logs from public, anon;
