-- TravelFlow Migration 0003: context lifecycle, agenda, and journey legs

-- Context point storage keeps lifecycle, resolution, and confirmation separate.
alter table public.context_points
  add column if not exists source text not null default 'user_input',
  add column if not exists confirmation_status text not null default 'unconfirmed',
  add column if not exists metadata jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'context_points_source_check'
  ) then
    alter table public.context_points
      add constraint context_points_source_check check (
        source in ('user_input', 'booking_import', 'assistant_suggestion', 'brightdata', 'external_provider')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'context_points_confirmation_status_check'
  ) then
    alter table public.context_points
      add constraint context_points_confirmation_status_check check (
        confirmation_status in ('unconfirmed', 'confirmed')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'context_points_metadata_object'
  ) then
    alter table public.context_points
      add constraint context_points_metadata_object check (jsonb_typeof(metadata) = 'object');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'context_points_trip_id_id_unique'
  ) then
    alter table public.context_points
      add constraint context_points_trip_id_id_unique unique (trip_id, id);
  end if;
end;
$$;

create table if not exists public.agenda_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  context_point_id uuid,
  title text not null,
  type text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text not null,
  status text not null default 'planned',
  source text not null default 'user_input',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint agenda_items_title_not_blank check (length(trim(title)) > 0),
  constraint agenda_items_type_check check (type in (
    'flight', 'train', 'meeting', 'conference', 'event', 'meal',
    'hotel_check_in', 'hotel_check_out', 'free_time', 'custom'
  )),
  constraint agenda_items_status_check check (
    status in ('suggested', 'planned', 'confirmed', 'completed', 'skipped', 'cancelled')
  ),
  constraint agenda_items_source_check check (
    source in ('user_input', 'booking_import', 'assistant_suggestion', 'event_discovery', 'external_provider')
  ),
  constraint agenda_items_time_order check (end_at > start_at),
  constraint agenda_items_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint agenda_items_context_same_trip_fk
    foreign key (trip_id, context_point_id)
    references public.context_points (trip_id, id)
);

create unique index if not exists agenda_items_trip_id_id_unique
  on public.agenda_items (trip_id, id);

create index if not exists agenda_items_trip_start_idx
  on public.agenda_items (trip_id, start_at);

create index if not exists agenda_items_context_start_idx
  on public.agenda_items (context_point_id, start_at);

drop trigger if exists agenda_items_set_updated_at on public.agenda_items;
create trigger agenda_items_set_updated_at
before update on public.agenda_items
for each row execute procedure public.set_updated_at();

create table if not exists public.journey_legs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  origin_context_point_id uuid not null,
  destination_context_point_id uuid not null,
  related_agenda_id uuid,
  departure_at timestamptz not null,
  arrival_deadline timestamptz,
  status text not null default 'planned',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint journey_legs_different_points check (origin_context_point_id <> destination_context_point_id),
  constraint journey_legs_status_check check (status in ('planned', 'in_progress', 'completed', 'cancelled')),
  constraint journey_legs_deadline_check check (arrival_deadline is null or arrival_deadline >= departure_at),
  constraint journey_legs_origin_same_trip_fk
    foreign key (trip_id, origin_context_point_id)
    references public.context_points (trip_id, id),
  constraint journey_legs_destination_same_trip_fk
    foreign key (trip_id, destination_context_point_id)
    references public.context_points (trip_id, id),
  constraint journey_legs_agenda_same_trip_fk
    foreign key (trip_id, related_agenda_id)
    references public.agenda_items (trip_id, id)
);

create unique index if not exists journey_legs_trip_id_id_unique
  on public.journey_legs (trip_id, id);

create index if not exists journey_legs_trip_departure_idx
  on public.journey_legs (trip_id, departure_at);

create index if not exists journey_legs_origin_destination_idx
  on public.journey_legs (origin_context_point_id, destination_context_point_id);

drop trigger if exists journey_legs_set_updated_at on public.journey_legs;
create trigger journey_legs_set_updated_at
before update on public.journey_legs
for each row execute procedure public.set_updated_at();

alter table public.agenda_items enable row level security;
alter table public.journey_legs enable row level security;

grant select, insert, update on table public.agenda_items to authenticated;
grant select, insert, update on table public.journey_legs to authenticated;

drop policy if exists agenda_items_select_own_trip on public.agenda_items;
create policy agenda_items_select_own_trip
on public.agenda_items for select
to authenticated
using (
  exists (
    select 1 from public.trips
    where trips.id = agenda_items.trip_id
      and trips.user_id = (select auth.uid())
  )
);

drop policy if exists agenda_items_insert_own_trip on public.agenda_items;
create policy agenda_items_insert_own_trip
on public.agenda_items for insert
to authenticated
with check (
  exists (
    select 1 from public.trips
    where trips.id = agenda_items.trip_id
      and trips.user_id = (select auth.uid())
  )
);

drop policy if exists agenda_items_update_own_trip on public.agenda_items;
create policy agenda_items_update_own_trip
on public.agenda_items for update
to authenticated
using (
  exists (
    select 1 from public.trips
    where trips.id = agenda_items.trip_id
      and trips.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.trips
    where trips.id = agenda_items.trip_id
      and trips.user_id = (select auth.uid())
  )
);

drop policy if exists journey_legs_select_own_trip on public.journey_legs;
create policy journey_legs_select_own_trip
on public.journey_legs for select
to authenticated
using (
  exists (
    select 1 from public.trips
    where trips.id = journey_legs.trip_id
      and trips.user_id = (select auth.uid())
  )
);

drop policy if exists journey_legs_insert_own_trip on public.journey_legs;
create policy journey_legs_insert_own_trip
on public.journey_legs for insert
to authenticated
with check (
  exists (
    select 1 from public.trips
    where trips.id = journey_legs.trip_id
      and trips.user_id = (select auth.uid())
  )
);

drop policy if exists journey_legs_update_own_trip on public.journey_legs;
create policy journey_legs_update_own_trip
on public.journey_legs for update
to authenticated
using (
  exists (
    select 1 from public.trips
    where trips.id = journey_legs.trip_id
      and trips.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.trips
    where trips.id = journey_legs.trip_id
      and trips.user_id = (select auth.uid())
  )
);

comment on table public.agenda_items is 'Time-bound activities belonging to a trip.';
comment on table public.journey_legs is 'Travel need between two context points in the same trip.';
