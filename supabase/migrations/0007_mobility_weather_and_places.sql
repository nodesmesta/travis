-- TravelFlow Migration 0007: mobility, weather, traffic, recommendations, and nearby places (Task 08)
--
-- Every table is owned through trips.user_id. Evidence rows live in the shared
-- `sources` and `source_references` tables created by migration 0005.
-- `recommendations.conversation_id` has no foreign key: `conversations` is
-- created by migration 0008, which runs after this one.

-- Trip-scoped source key so Task 08 rows cannot point at another trip's source.
create unique index if not exists sources_trip_id_id_unique
  on public.sources (trip_id, id);

-- ---------------------------------------------------------------------------
-- Source references may now also point at Task 08 entities.
alter table public.source_references
  drop constraint if exists source_references_entity_type_check;
alter table public.source_references
  add constraint source_references_entity_type_check check (entity_type in (
    'event_discovery_run',
    'event_discovery_result',
    'place_discovery_run',
    'place_discovery_result',
    'route_option',
    'weather_snapshot',
    'traffic_snapshot',
    'recommendation'
  ));

-- ---------------------------------------------------------------------------
-- Nearby places: audited runs (also the persistent cache) and their results.
create table if not exists public.place_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  context_point_id uuid not null,
  category text not null,
  request_id text not null,
  request_fingerprint text not null,
  provider text not null,
  status text not null,
  retrieved_at timestamptz not null,
  expires_at timestamptz not null,
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint place_runs_category_check check (category in ('activity', 'restaurant')),
  constraint place_runs_provider_check check (provider in ('bright_data', 'here_places_v7')),
  constraint place_runs_provider_category_check check (
    (category = 'activity' and provider = 'bright_data')
    or (category = 'restaurant' and provider = 'here_places_v7')
  ),
  constraint place_runs_status_check check (status in ('ok', 'empty', 'invalid', 'unavailable')),
  constraint place_runs_expiry_check check (expires_at > retrieved_at),
  constraint place_runs_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint place_runs_context_same_trip_fk
    foreign key (trip_id, context_point_id)
    references public.context_points (trip_id, id)
);

create unique index if not exists place_runs_trip_id_id_unique
  on public.place_discovery_runs (trip_id, id);
create index if not exists place_runs_cache_lookup_idx
  on public.place_discovery_runs (trip_id, context_point_id, category, request_fingerprint, expires_at desc);
create index if not exists place_runs_trip_created_idx
  on public.place_discovery_runs (trip_id, created_at desc);

create table if not exists public.place_discovery_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  trip_id uuid not null references public.trips(id) on delete restrict,
  context_point_id uuid not null,
  source_id uuid not null,
  category text not null,
  name text not null,
  description text,
  address text,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  distance_meters integer,
  official_url text,
  provider_place_id text,
  activity_type text,
  indoor_outdoor text,
  recommended_duration_minutes integer,
  weather_sensitivity text,
  booking_required boolean,
  cuisines jsonb not null default '[]'::jsonb,
  opening_hours jsonb,
  evidence text,
  status text not null default 'suggested',
  retrieved_at timestamptz not null,
  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint place_results_run_fk
    foreign key (trip_id, run_id) references public.place_discovery_runs (trip_id, id) on delete cascade,
  constraint place_results_source_same_trip_fk
    foreign key (trip_id, source_id) references public.sources (trip_id, id),
  constraint place_results_context_same_trip_fk
    foreign key (trip_id, context_point_id) references public.context_points (trip_id, id),
  constraint place_results_category_check check (category in ('activity', 'restaurant')),
  constraint place_results_name_check check (char_length(trim(name)) > 0),
  constraint place_results_status_check check (status in ('suggested', 'selected', 'rejected', 'expired')),
  constraint place_results_latitude_check check (latitude is null or latitude between -90 and 90),
  constraint place_results_longitude_check check (longitude is null or longitude between -180 and 180),
  constraint place_results_distance_check check (distance_meters is null or distance_meters >= 0),
  constraint place_results_url_check check (
    official_url is null or left(official_url, 7) = 'http://' or left(official_url, 8) = 'https://'
  ),
  constraint place_results_indoor_outdoor_check check (
    indoor_outdoor is null or indoor_outdoor in ('indoor', 'outdoor', 'both', 'unknown')
  ),
  constraint place_results_weather_sensitivity_check check (
    weather_sensitivity is null or weather_sensitivity in ('low', 'medium', 'high', 'unknown')
  ),
  constraint place_results_duration_check check (
    recommended_duration_minutes is null or recommended_duration_minutes > 0
  ),
  constraint place_results_cuisines_array check (jsonb_typeof(cuisines) = 'array'),
  constraint place_results_opening_hours_shape check (
    opening_hours is null
    or (jsonb_typeof(opening_hours) = 'object' and jsonb_typeof(opening_hours -> 'text') = 'array')
  ),
  constraint place_results_expiry_check check (expires_at > retrieved_at),
  constraint place_results_metadata_object check (jsonb_typeof(metadata) = 'object'),
  -- Activity-only attributes stay empty for restaurants.
  constraint place_results_activity_fields_check check (
    category = 'activity'
    or (
      activity_type is null and indoor_outdoor is null
      and recommended_duration_minutes is null and weather_sensitivity is null
      and booking_required is null
    )
  ),
  -- A restaurant is only valid with provider coordinates and a distance to the context point.
  constraint place_results_restaurant_location_check check (
    category <> 'restaurant'
    or (latitude is not null and longitude is not null and distance_meters is not null)
  )
);

create unique index if not exists place_results_trip_id_id_unique
  on public.place_discovery_results (trip_id, id);
create index if not exists place_results_run_idx
  on public.place_discovery_results (run_id);
create index if not exists place_results_context_category_idx
  on public.place_discovery_results (trip_id, context_point_id, category, expires_at desc);

-- ---------------------------------------------------------------------------
-- Weather and traffic snapshots. Task 10 reads these tables directly.
create table if not exists public.weather_snapshots (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  context_point_id uuid not null,
  provider text not null default 'openweather_free_2_5',
  source_id uuid not null,
  request_fingerprint text not null,
  latitude numeric(9, 6) not null,
  longitude numeric(9, 6) not null,
  timezone text not null,
  observed_at timestamptz,
  valid_from timestamptz not null,
  valid_to timestamptz not null,
  current_condition text,
  current_temperature_c numeric(5, 2),
  max_precipitation_probability numeric(4, 3),
  payload jsonb not null,
  retrieved_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint weather_provider_check check (provider = 'openweather_free_2_5'),
  constraint weather_valid_order check (valid_to >= valid_from),
  constraint weather_expiry_check check (expires_at > retrieved_at),
  constraint weather_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint weather_probability_check check (
    max_precipitation_probability is null or max_precipitation_probability between 0 and 1
  ),
  constraint weather_context_same_trip_fk
    foreign key (trip_id, context_point_id) references public.context_points (trip_id, id),
  constraint weather_source_same_trip_fk
    foreign key (trip_id, source_id) references public.sources (trip_id, id)
);

create unique index if not exists weather_trip_id_id_unique
  on public.weather_snapshots (trip_id, id);
create index if not exists weather_context_validity_idx
  on public.weather_snapshots (context_point_id, valid_from);
create index if not exists weather_cache_lookup_idx
  on public.weather_snapshots (trip_id, context_point_id, expires_at desc);

create table if not exists public.traffic_snapshots (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  journey_leg_id uuid,
  origin_context_point_id uuid not null,
  destination_context_point_id uuid not null,
  provider text not null default 'here_traffic_v7',
  source_id uuid not null,
  request_fingerprint text not null,
  policy_version text not null,
  traffic_level text not null,
  center_latitude numeric(9, 6) not null,
  center_longitude numeric(9, 6) not null,
  radius_meters integer not null,
  observed_at timestamptz,
  valid_from timestamptz not null,
  valid_to timestamptz not null,
  payload jsonb not null,
  retrieved_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint traffic_provider_check check (provider = 'here_traffic_v7'),
  constraint traffic_level_check check (traffic_level in ('low', 'medium', 'high', 'unknown')),
  constraint traffic_radius_check check (radius_meters > 0),
  constraint traffic_valid_order check (valid_to >= valid_from),
  constraint traffic_expiry_check check (expires_at > retrieved_at),
  constraint traffic_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint traffic_leg_same_trip_fk
    foreign key (trip_id, journey_leg_id) references public.journey_legs (trip_id, id),
  constraint traffic_origin_same_trip_fk
    foreign key (trip_id, origin_context_point_id) references public.context_points (trip_id, id),
  constraint traffic_destination_same_trip_fk
    foreign key (trip_id, destination_context_point_id) references public.context_points (trip_id, id),
  constraint traffic_source_same_trip_fk
    foreign key (trip_id, source_id) references public.sources (trip_id, id)
);

create unique index if not exists traffic_trip_id_id_unique
  on public.traffic_snapshots (trip_id, id);
create index if not exists traffic_pair_observed_idx
  on public.traffic_snapshots (origin_context_point_id, destination_context_point_id, observed_at);
create index if not exists traffic_cache_lookup_idx
  on public.traffic_snapshots (trip_id, origin_context_point_id, destination_context_point_id, expires_at desc);

-- ---------------------------------------------------------------------------
-- Route requests and options.
create table if not exists public.route_requests (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  journey_leg_id uuid not null,
  origin_context_point_id uuid not null,
  destination_context_point_id uuid not null,
  request_id text not null,
  request_fingerprint text not null,
  departure_at timestamptz not null,
  arrival_deadline timestamptz,
  preferences jsonb not null,
  required_facts jsonb not null,
  modes jsonb not null,
  status text not null,
  error_code text,
  policy_version text not null,
  weather_snapshot_id uuid,
  traffic_snapshot_id uuid,
  selected_option_id uuid,
  facts jsonb not null default '[]'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  departure_recommendation jsonb,
  retrieved_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint route_requests_status_check check (status in ('completed', 'failed')),
  constraint route_requests_failed_has_error check (status = 'completed' or error_code is not null),
  constraint route_requests_deadline_check check (arrival_deadline is null or arrival_deadline > departure_at),
  constraint route_requests_expiry_check check (expires_at >= retrieved_at),
  constraint route_requests_preferences_object check (jsonb_typeof(preferences) = 'object'),
  constraint route_requests_required_facts_array check (jsonb_typeof(required_facts) = 'array'),
  constraint route_requests_modes_array check (jsonb_typeof(modes) = 'array'),
  constraint route_requests_facts_array check (jsonb_typeof(facts) = 'array'),
  constraint route_requests_limitations_array check (jsonb_typeof(limitations) = 'array'),
  constraint route_requests_leg_same_trip_fk
    foreign key (trip_id, journey_leg_id) references public.journey_legs (trip_id, id),
  constraint route_requests_origin_same_trip_fk
    foreign key (trip_id, origin_context_point_id) references public.context_points (trip_id, id),
  constraint route_requests_destination_same_trip_fk
    foreign key (trip_id, destination_context_point_id) references public.context_points (trip_id, id),
  constraint route_requests_weather_same_trip_fk
    foreign key (trip_id, weather_snapshot_id) references public.weather_snapshots (trip_id, id),
  constraint route_requests_traffic_same_trip_fk
    foreign key (trip_id, traffic_snapshot_id) references public.traffic_snapshots (trip_id, id)
);

create unique index if not exists route_requests_trip_id_id_unique
  on public.route_requests (trip_id, id);
create index if not exists route_requests_leg_created_idx
  on public.route_requests (journey_leg_id, created_at desc);

-- A route request must describe exactly the journey leg it names.
create or replace function public.route_requests_validate_leg()
returns trigger
language plpgsql
as $$
declare
  leg public.journey_legs%rowtype;
begin
  select * into leg
  from public.journey_legs
  where id = new.journey_leg_id and trip_id = new.trip_id;
  if leg.id is null then
    raise exception 'ROUTE_LEG_NOT_IN_TRIP';
  end if;
  if leg.origin_context_point_id <> new.origin_context_point_id
     or leg.destination_context_point_id <> new.destination_context_point_id then
    raise exception 'ROUTE_LEG_ENDPOINT_MISMATCH';
  end if;
  return new;
end;
$$;

drop trigger if exists route_requests_validate_leg_trigger on public.route_requests;
create trigger route_requests_validate_leg_trigger
before insert on public.route_requests
for each row execute procedure public.route_requests_validate_leg();

create table if not exists public.route_options (
  id uuid primary key default gen_random_uuid(),
  route_request_id uuid not null,
  trip_id uuid not null references public.trips(id) on delete restrict,
  provider text not null,
  provider_route_id text not null,
  transport_mode text not null,
  source_id uuid not null,
  weather_snapshot_id uuid,
  traffic_snapshot_id uuid,
  provider_facts jsonb not null,
  derived_metrics jsonb not null,
  cost jsonb not null,
  risk jsonb not null,
  score jsonb,
  traffic_risk text not null,
  weather_risk text not null,
  overall_risk text not null,
  duration_seconds integer not null,
  total_duration_seconds integer not null,
  walking_minutes integer not null,
  transfer_count integer not null,
  departure_at timestamptz not null,
  arrive_at timestamptz not null,
  feasible boolean,
  rank integer,
  status text not null,
  exclusion_reasons jsonb not null default '[]'::jsonb,
  recommended boolean not null default false,
  policy_version text not null,
  retrieved_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint route_options_request_fk
    foreign key (trip_id, route_request_id)
    references public.route_requests (trip_id, id) on delete cascade,
  constraint route_options_source_same_trip_fk
    foreign key (trip_id, source_id) references public.sources (trip_id, id),
  constraint route_options_weather_same_trip_fk
    foreign key (trip_id, weather_snapshot_id) references public.weather_snapshots (trip_id, id),
  constraint route_options_traffic_same_trip_fk
    foreign key (trip_id, traffic_snapshot_id) references public.traffic_snapshots (trip_id, id),
  constraint route_options_provider_check check (provider in ('here_routing_v8', 'here_intermodal_v8')),
  constraint route_options_mode_check check (transport_mode in ('car', 'taxi', 'pedestrian', 'transit')),
  constraint route_options_status_check check (status in ('valid', 'excluded', 'expired', 'invalid')),
  constraint route_options_traffic_risk_check check (traffic_risk in ('low', 'medium', 'high', 'unknown')),
  constraint route_options_weather_risk_check check (weather_risk in ('low', 'medium', 'high', 'unknown')),
  constraint route_options_overall_risk_check check (overall_risk in ('low', 'medium', 'high', 'unknown')),
  constraint route_options_numbers_check check (
    duration_seconds >= 0 and total_duration_seconds >= 0
    and walking_minutes >= 0 and transfer_count >= 0
  ),
  constraint route_options_time_order check (arrive_at >= departure_at),
  constraint route_options_expiry_check check (expires_at > retrieved_at),
  constraint route_options_json_shapes check (
    jsonb_typeof(provider_facts) = 'object'
    and jsonb_typeof(derived_metrics) = 'object'
    and jsonb_typeof(cost) = 'object'
    and jsonb_typeof(risk) = 'object'
    and jsonb_typeof(exclusion_reasons) = 'array'
    and (score is null or jsonb_typeof(score) = 'object')
  ),
  -- Only a valid option can be recommended or ranked. An option that misses
  -- the deadline is stored as excluded and can never be recommended.
  constraint route_options_recommended_valid check (not recommended or status = 'valid'),
  constraint route_options_recommended_feasible check (not recommended or feasible is not false),
  constraint route_options_rank_valid check (rank is null or status = 'valid')
);

create unique index if not exists route_options_id_request_unique
  on public.route_options (id, route_request_id);
create unique index if not exists route_options_one_recommended_idx
  on public.route_options (route_request_id) where recommended;
create index if not exists route_options_request_traffic_idx
  on public.route_options (route_request_id, traffic_risk);

alter table public.route_requests
  drop constraint if exists route_requests_selected_option_fk;
alter table public.route_requests
  add constraint route_requests_selected_option_fk
  foreign key (selected_option_id, id)
  references public.route_options (id, route_request_id);

-- ---------------------------------------------------------------------------
-- Recommendations produced by the mobility engine (Task 09 reads and changes status).
create table if not exists public.recommendations (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  conversation_id uuid,
  context_point_id uuid,
  recommendation_type text not null,
  route_request_id uuid,
  route_option_id uuid,
  context_snapshot jsonb not null default '{}'::jsonb,
  payload jsonb not null,
  reason text,
  status text not null default 'suggested',
  policy_version text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  constraint recommendations_type_check check (recommendation_type in ('route')),
  constraint recommendations_status_check check (status in ('suggested', 'saved', 'applied', 'dismissed', 'expired')),
  constraint recommendations_expiry_check check (expires_at > created_at),
  constraint recommendations_json_shapes check (
    jsonb_typeof(context_snapshot) = 'object' and jsonb_typeof(payload) = 'object'
  ),
  constraint recommendations_route_refs check (
    recommendation_type <> 'route'
    or (route_request_id is not null and route_option_id is not null)
  ),
  constraint recommendations_context_same_trip_fk
    foreign key (trip_id, context_point_id) references public.context_points (trip_id, id),
  constraint recommendations_request_same_trip_fk
    foreign key (trip_id, route_request_id) references public.route_requests (trip_id, id),
  constraint recommendations_option_fk
    foreign key (route_option_id, route_request_id) references public.route_options (id, route_request_id)
);

create unique index if not exists recommendations_trip_id_id_unique
  on public.recommendations (trip_id, id);
create index if not exists recommendations_trip_status_idx
  on public.recommendations (trip_id, status, created_at desc);

drop trigger if exists recommendations_set_updated_at on public.recommendations;
create trigger recommendations_set_updated_at
before update on public.recommendations
for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security: every table follows trip ownership.
alter table public.place_discovery_runs enable row level security;
alter table public.place_discovery_results enable row level security;
alter table public.weather_snapshots enable row level security;
alter table public.traffic_snapshots enable row level security;
alter table public.route_requests enable row level security;
alter table public.route_options enable row level security;
alter table public.recommendations enable row level security;

grant select, insert on table public.place_discovery_runs to authenticated;
grant select, insert on table public.place_discovery_results to authenticated;
grant select, insert on table public.weather_snapshots to authenticated;
grant select, insert on table public.traffic_snapshots to authenticated;
grant select, insert on table public.route_requests to authenticated;
grant update (selected_option_id) on table public.route_requests to authenticated;
grant select, insert on table public.route_options to authenticated;
grant select, insert on table public.recommendations to authenticated;
grant update (status) on table public.recommendations to authenticated;

drop policy if exists place_runs_select_own_trip on public.place_discovery_runs;
create policy place_runs_select_own_trip
on public.place_discovery_runs for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = place_discovery_runs.trip_id and trips.user_id = (select auth.uid())
));
drop policy if exists place_runs_insert_own_trip on public.place_discovery_runs;
create policy place_runs_insert_own_trip
on public.place_discovery_runs for insert to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = place_discovery_runs.trip_id and trips.user_id = (select auth.uid())
));

drop policy if exists place_results_select_own_trip on public.place_discovery_results;
create policy place_results_select_own_trip
on public.place_discovery_results for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = place_discovery_results.trip_id and trips.user_id = (select auth.uid())
));
drop policy if exists place_results_insert_own_trip on public.place_discovery_results;
create policy place_results_insert_own_trip
on public.place_discovery_results for insert to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = place_discovery_results.trip_id and trips.user_id = (select auth.uid())
));

drop policy if exists weather_select_own_trip on public.weather_snapshots;
create policy weather_select_own_trip
on public.weather_snapshots for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = weather_snapshots.trip_id and trips.user_id = (select auth.uid())
));
drop policy if exists weather_insert_own_trip on public.weather_snapshots;
create policy weather_insert_own_trip
on public.weather_snapshots for insert to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = weather_snapshots.trip_id and trips.user_id = (select auth.uid())
));

drop policy if exists traffic_select_own_trip on public.traffic_snapshots;
create policy traffic_select_own_trip
on public.traffic_snapshots for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = traffic_snapshots.trip_id and trips.user_id = (select auth.uid())
));
drop policy if exists traffic_insert_own_trip on public.traffic_snapshots;
create policy traffic_insert_own_trip
on public.traffic_snapshots for insert to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = traffic_snapshots.trip_id and trips.user_id = (select auth.uid())
));

drop policy if exists route_requests_select_own_trip on public.route_requests;
create policy route_requests_select_own_trip
on public.route_requests for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = route_requests.trip_id and trips.user_id = (select auth.uid())
));
drop policy if exists route_requests_insert_own_trip on public.route_requests;
create policy route_requests_insert_own_trip
on public.route_requests for insert to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = route_requests.trip_id and trips.user_id = (select auth.uid())
));
drop policy if exists route_requests_update_own_trip on public.route_requests;
create policy route_requests_update_own_trip
on public.route_requests for update to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = route_requests.trip_id and trips.user_id = (select auth.uid())
))
with check (exists (
  select 1 from public.trips
  where trips.id = route_requests.trip_id and trips.user_id = (select auth.uid())
));

drop policy if exists route_options_select_own_trip on public.route_options;
create policy route_options_select_own_trip
on public.route_options for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = route_options.trip_id and trips.user_id = (select auth.uid())
));
drop policy if exists route_options_insert_own_trip on public.route_options;
create policy route_options_insert_own_trip
on public.route_options for insert to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = route_options.trip_id and trips.user_id = (select auth.uid())
));

drop policy if exists recommendations_select_own_trip on public.recommendations;
create policy recommendations_select_own_trip
on public.recommendations for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = recommendations.trip_id and trips.user_id = (select auth.uid())
));
drop policy if exists recommendations_insert_own_trip on public.recommendations;
create policy recommendations_insert_own_trip
on public.recommendations for insert to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = recommendations.trip_id and trips.user_id = (select auth.uid())
));
drop policy if exists recommendations_update_own_trip on public.recommendations;
create policy recommendations_update_own_trip
on public.recommendations for update to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = recommendations.trip_id and trips.user_id = (select auth.uid())
))
with check (exists (
  select 1 from public.trips
  where trips.id = recommendations.trip_id and trips.user_id = (select auth.uid())
));

-- ---------------------------------------------------------------------------
-- One transaction for a whole Task 08 result. The API builds complete rows
-- (ids and timestamps included) and this function inserts them in dependency
-- order, so a failure leaves nothing half written. It runs with the caller's
-- rights, so row level security applies to every insert.
create or replace function public.persist_mobility_batch(p_batch jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if jsonb_typeof(p_batch) <> 'object' then
    raise exception 'BATCH_INVALID';
  end if;
  if p_batch ? 'sources' then
    insert into public.sources
    select * from jsonb_populate_recordset(null::public.sources, p_batch -> 'sources');
  end if;
  if p_batch ? 'weather_snapshots' then
    insert into public.weather_snapshots
    select * from jsonb_populate_recordset(null::public.weather_snapshots, p_batch -> 'weather_snapshots');
  end if;
  if p_batch ? 'traffic_snapshots' then
    insert into public.traffic_snapshots
    select * from jsonb_populate_recordset(null::public.traffic_snapshots, p_batch -> 'traffic_snapshots');
  end if;
  if p_batch ? 'place_discovery_runs' then
    insert into public.place_discovery_runs
    select * from jsonb_populate_recordset(null::public.place_discovery_runs, p_batch -> 'place_discovery_runs');
  end if;
  if p_batch ? 'place_discovery_results' then
    insert into public.place_discovery_results
    select * from jsonb_populate_recordset(null::public.place_discovery_results, p_batch -> 'place_discovery_results');
  end if;
  if p_batch ? 'route_requests' then
    insert into public.route_requests
    select * from jsonb_populate_recordset(null::public.route_requests, p_batch -> 'route_requests');
  end if;
  if p_batch ? 'route_options' then
    insert into public.route_options
    select * from jsonb_populate_recordset(null::public.route_options, p_batch -> 'route_options');
  end if;
  if p_batch ? 'recommendations' then
    insert into public.recommendations
    select * from jsonb_populate_recordset(null::public.recommendations, p_batch -> 'recommendations');
  end if;
  if p_batch ? 'source_references' then
    insert into public.source_references
    select * from jsonb_populate_recordset(null::public.source_references, p_batch -> 'source_references');
  end if;
end;
$$;

grant execute on function public.persist_mobility_batch(jsonb) to authenticated;

comment on table public.place_discovery_runs is 'Audited nearby place requests and persistent cache entries (Task 08).';
comment on table public.place_discovery_results is 'Activities (Bright Data) and restaurants (HERE Browse) near a context point.';
comment on table public.weather_snapshots is 'Normalized OpenWeather facts per context point; read by mobility and alerts.';
comment on table public.traffic_snapshots is 'Normalized HERE traffic facts around a journey leg corridor; read by mobility and alerts.';
comment on table public.route_requests is 'Route comparison requests for one journey leg.';
comment on table public.route_options is 'Provider facts, derived metrics, cost, risk, and score per route option.';
comment on table public.recommendations is 'Recommendations computed by the mobility engine.';
