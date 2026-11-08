-- TravelFlow demo seed
-- This seed is intentionally a no-op until auth.users contains the demo email.
-- Create the demo Auth user through Supabase Auth first; never insert passwords here.

begin;

do $$
declare
  demo_user_id uuid;
  existing_trip_owner uuid;
begin
  select id
  into demo_user_id
  from auth.users
  where email = 'demo@travelflow.local'
  limit 1;

  if demo_user_id is null then
    return;
  end if;

  select user_id
  into existing_trip_owner
  from public.trips
  where id = '00000000-0000-0000-0000-000000000001'::uuid;

  if existing_trip_owner is not null and existing_trip_owner <> demo_user_id then
    raise exception
      'Demo trip UUID is already owned by another user: %',
      existing_trip_owner;
  end if;

  if exists (
    select 1
    from public.context_points
    where id in (
      '00000000-0000-0000-0000-000000000011'::uuid,
      '00000000-0000-0000-0000-000000000012'::uuid,
      '00000000-0000-0000-0000-000000000013'::uuid
    )
    and trip_id <> '00000000-0000-0000-0000-000000000001'::uuid
  ) then
    raise exception 'A demo context point UUID is already owned by another trip';
  end if;
end;
$$;

with demo_user as (
  select id
  from auth.users
  where email = 'demo@travelflow.local'
  limit 1
)
insert into public.profiles (id, name, timezone)
select id, 'TravelFlow Demo User', 'Asia/Jakarta'
from demo_user
on conflict (id) do update
set name = excluded.name,
    timezone = excluded.timezone;

with demo_user as (
  select id
  from auth.users
  where email = 'demo@travelflow.local'
  limit 1
)
insert into public.trips (
  id, user_id, name, destination_summary, start_at, end_at, timezone, status, source
)
select
  '00000000-0000-0000-0000-000000000001'::uuid,
  id,
  'Jakarta Business Trip',
  'Jakarta, Indonesia',
  '2026-11-12T07:00:00+07:00'::timestamptz,
  '2026-11-14T18:00:00+07:00'::timestamptz,
  'Asia/Jakarta',
  'confirmed',
  'user_input'
from demo_user
on conflict (id) do update
set user_id = excluded.user_id,
    name = excluded.name,
    destination_summary = excluded.destination_summary,
    start_at = excluded.start_at,
    end_at = excluded.end_at,
    timezone = excluded.timezone,
    status = excluded.status,
    source = excluded.source;

with demo_user as (
  select id
  from auth.users
  where email = 'demo@travelflow.local'
  limit 1
), demo_points (
  id, trip_id, type, label, address, latitude, longitude,
  timezone, external_place_id, status, resolution_status,
  source, confirmation_status, metadata
) as (
  values
  (
    '00000000-0000-0000-0000-000000000011'::uuid,
    '00000000-0000-0000-0000-000000000001'::uuid,
    'hotel',
    'Hotel Indonesia Kempinski',
    'Jl. M.H. Thamrin No. 1, Jakarta',
    -6.1954,
    106.8230,
    'Asia/Jakarta',
    'demo_here_hotel_indonesia_kempinski',
    'active',
    'resolved',
    'user_input',
    'confirmed',
    '{}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-000000000012'::uuid,
    '00000000-0000-0000-0000-000000000001'::uuid,
    'conference',
    'Jakarta Convention Center',
    'Jl. Gatot Subroto, Jakarta',
    -6.2147,
    106.8097,
    'Asia/Jakarta',
    'demo_here_jakarta_convention_center',
    'active',
    'resolved',
    'user_input',
    'confirmed',
    '{}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-000000000013'::uuid,
    '00000000-0000-0000-0000-000000000001'::uuid,
    'airport',
    'Soekarno-Hatta International Airport',
    'Tangerang, Banten',
    -6.1256,
    106.6559,
    'Asia/Jakarta',
    'demo_here_soekarno_hatta',
    'active',
    'resolved',
    'user_input',
    'confirmed',
    '{}'::jsonb
  )
)
insert into public.context_points (
  id, trip_id, type, label, address, latitude, longitude,
  timezone, external_place_id, status, resolution_status,
  source, confirmation_status, metadata
)
select
  demo_points.id,
  demo_points.trip_id,
  demo_points.type,
  demo_points.label,
  demo_points.address,
  demo_points.latitude,
  demo_points.longitude,
  demo_points.timezone,
  demo_points.external_place_id,
  demo_points.status,
  demo_points.resolution_status,
  demo_points.source,
  demo_points.confirmation_status,
  demo_points.metadata
from demo_points
cross join demo_user
on conflict (id) do update
set trip_id = excluded.trip_id,
    type = excluded.type,
    label = excluded.label,
    address = excluded.address,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    timezone = excluded.timezone,
    external_place_id = excluded.external_place_id,
    status = excluded.status,
    resolution_status = excluded.resolution_status,
    source = excluded.source,
    confirmation_status = excluded.confirmation_status,
    metadata = excluded.metadata;

commit;
