-- TravelFlow Migration 0001: identity and trips
-- Supabase Auth owns auth.users. Application data references auth.users.id.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  name text,
  timezone text not null default 'UTC',
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint profiles_preferences_object check (jsonb_typeof(preferences) = 'object'),
  constraint profiles_timezone_not_blank check (length(trim(timezone)) > 0)
);

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  name text not null,
  destination_summary text,
  start_at timestamptz,
  end_at timestamptz,
  timezone text not null,
  status text not null default 'draft',
  source text not null default 'user_input',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint trips_name_not_blank check (length(trim(name)) > 0),
  constraint trips_timezone_not_blank check (length(trim(timezone)) > 0),
  constraint trips_status_check check (status in ('draft', 'confirmed', 'active', 'completed')),
  constraint trips_source_check check (source in ('user_input', 'imported_booking', 'internal')),
  constraint trips_time_order check (start_at is null or end_at is null or end_at > start_at)
);

create index if not exists trips_user_status_idx on public.trips (user_id, status);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, timezone)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'name', '')), ''),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'timezone'), ''), 'UTC')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();

drop trigger if exists trips_set_updated_at on public.trips;
create trigger trips_set_updated_at
before update on public.trips
for each row execute procedure public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.trips enable row level security;

grant select, insert, update on table public.profiles to authenticated;
grant select, insert, update on table public.trips to authenticated;

-- Profiles are user-owned. The auth trigger creates the initial row.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles for select
to authenticated
using (id = (select auth.uid()));

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
on public.profiles for insert
to authenticated
with check (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
on public.profiles for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- Trips are owned directly by the authenticated user.
drop policy if exists trips_select_own on public.trips;
create policy trips_select_own
on public.trips for select
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists trips_insert_own on public.trips;
create policy trips_insert_own
on public.trips for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists trips_update_own on public.trips;
create policy trips_update_own
on public.trips for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

comment on table public.profiles is 'Application profile linked to Supabase Auth identity.';
comment on table public.trips is 'User-owned business travel trips.';
