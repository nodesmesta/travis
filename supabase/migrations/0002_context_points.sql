-- TravelFlow Migration 0002: trip context points

create table if not exists public.context_points (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  type text not null,
  label text not null,
  address text,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  timezone text not null,
  external_place_id text,
  status text not null default 'active',
  resolution_status text not null default 'unresolved',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint context_points_type_check check (type in (
    'airport', 'station', 'hotel', 'meeting', 'conference',
    'event', 'restaurant', 'attraction', 'custom_location'
  )),
  constraint context_points_label_not_blank check (length(trim(label)) > 0),
  constraint context_points_timezone_not_blank check (length(trim(timezone)) > 0),
  constraint context_points_status_check check (status in ('active', 'archived')),
  constraint context_points_resolution_check check (resolution_status in ('resolved', 'ambiguous', 'unresolved')),
  constraint context_points_latitude_check check (latitude is null or latitude between -90 and 90),
  constraint context_points_longitude_check check (longitude is null or longitude between -180 and 180),
  constraint context_points_resolved_fields_check check (
    resolution_status <> 'resolved'
    or (latitude is not null and longitude is not null and external_place_id is not null)
  )
);

create index if not exists context_points_trip_type_status_idx
  on public.context_points (trip_id, type, status);

create index if not exists context_points_trip_label_idx
  on public.context_points (trip_id, label);

drop trigger if exists context_points_set_updated_at on public.context_points;
create trigger context_points_set_updated_at
before update on public.context_points
for each row execute procedure public.set_updated_at();

alter table public.context_points enable row level security;

grant select, insert, update on table public.context_points to authenticated;

-- Ownership is inherited through trip_id → trips.user_id.
drop policy if exists context_points_select_own_trip on public.context_points;
create policy context_points_select_own_trip
on public.context_points for select
to authenticated
using (
  exists (
    select 1
    from public.trips
    where trips.id = context_points.trip_id
      and trips.user_id = (select auth.uid())
  )
);

drop policy if exists context_points_insert_own_trip on public.context_points;
create policy context_points_insert_own_trip
on public.context_points for insert
to authenticated
with check (
  exists (
    select 1
    from public.trips
    where trips.id = context_points.trip_id
      and trips.user_id = (select auth.uid())
  )
);

drop policy if exists context_points_update_own_trip on public.context_points;
create policy context_points_update_own_trip
on public.context_points for update
to authenticated
using (
  exists (
    select 1
    from public.trips
    where trips.id = context_points.trip_id
      and trips.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.trips
    where trips.id = context_points.trip_id
      and trips.user_id = (select auth.uid())
  )
);

comment on table public.context_points is 'Resolved or unresolved locations belonging to a trip.';
