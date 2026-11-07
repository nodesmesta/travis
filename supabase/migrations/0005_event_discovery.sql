-- TravelFlow Migration 0005: external event discovery, sources, and persistent cache

create table if not exists public.event_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  context_point_id uuid not null,
  request_id text not null,
  request_fingerprint text not null,
  category text not null,
  observed_from timestamptz not null,
  observed_to timestamptz not null,
  timezone text not null,
  status text not null,
  retrieved_at timestamptz not null,
  expires_at timestamptz not null,
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint event_runs_time_order check (observed_to > observed_from),
  constraint event_runs_status_check check (status in ('ok', 'empty', 'invalid', 'unavailable')),
  constraint event_runs_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint event_runs_context_same_trip_fk
    foreign key (trip_id, context_point_id)
    references public.context_points (trip_id, id)
);

create index if not exists event_runs_cache_lookup_idx
  on public.event_discovery_runs (trip_id, context_point_id, request_fingerprint, expires_at desc);
create index if not exists event_runs_trip_created_idx
  on public.event_discovery_runs (trip_id, created_at desc);

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  kind text not null,
  provider text not null,
  url text,
  title text,
  retrieved_at timestamptz not null,
  freshness text not null,
  expires_at timestamptz,
  observed_for jsonb,
  content_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint sources_kind_check check (kind in ('provider', 'official_page', 'search_result', 'user_input', 'internal')),
  constraint sources_freshness_check check (freshness in ('fresh', 'expired', 'unavailable')),
  constraint sources_url_check check (url is null or left(url, 7) = 'http://' or left(url, 8) = 'https://'),
  constraint sources_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint sources_observed_for_object check (observed_for is null or jsonb_typeof(observed_for) = 'object')
);

create index if not exists sources_trip_retrieved_idx
  on public.sources (trip_id, retrieved_at desc);

create table if not exists public.event_discovery_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.event_discovery_runs(id) on delete cascade,
  trip_id uuid not null references public.trips(id) on delete restrict,
  context_point_id uuid not null,
  source_id uuid not null references public.sources(id) on delete restrict,
  title text not null,
  description text,
  venue_name text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  category text,
  status text not null default 'suggested',
  retrieved_at timestamptz not null,
  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint event_results_status_check check (status in ('suggested', 'selected', 'rejected', 'expired')),
  constraint event_results_time_order check (ends_at is null or ends_at > starts_at),
  constraint event_results_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint event_results_context_same_trip_fk
    foreign key (trip_id, context_point_id)
    references public.context_points (trip_id, id)
);

create index if not exists event_results_trip_start_idx
  on public.event_discovery_results (trip_id, starts_at);
create index if not exists event_results_context_start_idx
  on public.event_discovery_results (context_point_id, starts_at);
create index if not exists event_results_run_idx
  on public.event_discovery_results (run_id);

create table if not exists public.source_references (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  source_id uuid not null references public.sources(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  relationship_type text not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint source_references_entity_type_check check (entity_type in ('event_discovery_run', 'event_discovery_result'))
);

create unique index if not exists source_references_unique_idx
  on public.source_references (source_id, entity_type, entity_id, relationship_type);
create index if not exists source_references_entity_idx
  on public.source_references (trip_id, entity_type, entity_id);

alter table public.event_discovery_runs enable row level security;
alter table public.sources enable row level security;
alter table public.event_discovery_results enable row level security;
alter table public.source_references enable row level security;

grant select, insert on table public.event_discovery_runs to authenticated;
grant select, insert on table public.sources to authenticated;
grant select, insert on table public.event_discovery_results to authenticated;
grant select, insert on table public.source_references to authenticated;

drop policy if exists event_runs_select_own_trip on public.event_discovery_runs;
create policy event_runs_select_own_trip
on public.event_discovery_runs for select
to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = event_discovery_runs.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists event_runs_insert_own_trip on public.event_discovery_runs;
create policy event_runs_insert_own_trip
on public.event_discovery_runs for insert
to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = event_discovery_runs.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists sources_select_own_trip on public.sources;
create policy sources_select_own_trip
on public.sources for select
to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = sources.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists sources_insert_own_trip on public.sources;
create policy sources_insert_own_trip
on public.sources for insert
to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = sources.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists event_results_select_own_trip on public.event_discovery_results;
create policy event_results_select_own_trip
on public.event_discovery_results for select
to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = event_discovery_results.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists event_results_insert_own_trip on public.event_discovery_results;
create policy event_results_insert_own_trip
on public.event_discovery_results for insert
to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = event_discovery_results.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists source_references_select_own_trip on public.source_references;
create policy source_references_select_own_trip
on public.source_references for select
to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = source_references.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists source_references_insert_own_trip on public.source_references;
create policy source_references_insert_own_trip
on public.source_references for insert
to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = source_references.trip_id
    and trips.user_id = (select auth.uid())
));

comment on table public.event_discovery_runs is 'Audited event discovery requests and persistent cache entries.';
comment on table public.event_discovery_results is 'Normalized event candidates from external discovery.';
comment on table public.sources is 'Source and freshness metadata for externally discovered facts.';
