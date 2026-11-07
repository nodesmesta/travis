-- TravelFlow Migration 0008: assistant conversations, messages, and confirmation tokens
--
-- Decision (Task 09): confirmation tokens live in a dedicated table, not in
-- conversation_messages. Only the SHA-256 hash of a token is stored. A token is
-- consumed by one atomic UPDATE ... WHERE consumed_at IS NULL AND expires_at > now(),
-- so a replayed token, an expired token, or a token owned by another user matches
-- zero rows and is rejected.
--
-- This migration does not create `recommendations` (Task 08, migration 0007).

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  active_context_point_id uuid,
  title text,
  status text not null default 'active',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint conversations_status_check check (status in ('active', 'archived')),
  constraint conversations_title_length check (title is null or char_length(title) between 1 and 160),
  constraint conversations_context_same_trip_fk
    foreign key (trip_id, active_context_point_id)
    references public.context_points (trip_id, id)
);

create unique index if not exists conversations_trip_id_id_unique
  on public.conversations (trip_id, id);
create index if not exists conversations_trip_updated_idx
  on public.conversations (trip_id, updated_at desc);

drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at
before update on public.conversations
for each row execute procedure public.set_updated_at();

create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  trip_id uuid not null,
  role text not null,
  content text not null,
  status text not null,
  intent text,
  error_code text,
  request_id text,
  execution_id uuid,
  client_request_key text,
  response jsonb,
  tool_call_metadata jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', clock_timestamp()),
  constraint conversation_messages_conversation_same_trip_fk
    foreign key (trip_id, conversation_id)
    references public.conversations (trip_id, id),
  constraint conversation_messages_role_check check (role in ('user', 'assistant')),
  constraint conversation_messages_status_check check (
    (role = 'user' and status = 'received')
    or (role = 'assistant' and status in ('completed', 'clarification', 'failed'))
  ),
  constraint conversation_messages_content_length check (char_length(content) between 1 and 8000),
  constraint conversation_messages_response_object check (response is null or jsonb_typeof(response) = 'object'),
  constraint conversation_messages_tool_metadata_array check (jsonb_typeof(tool_call_metadata) = 'array'),
  constraint conversation_messages_key_length check (
    client_request_key is null or char_length(client_request_key) between 16 and 200
  )
);

create index if not exists conversation_messages_conversation_created_idx
  on public.conversation_messages (conversation_id, created_at);
create unique index if not exists conversation_messages_user_request_key_unique
  on public.conversation_messages (conversation_id, client_request_key)
  where role = 'user' and client_request_key is not null;

create table if not exists public.assistant_confirmations (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  conversation_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  token_hash text not null,
  payload_hash text not null,
  summary text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint assistant_confirmations_action_check check (action in (
    'save_event_result', 'expire_event_result',
    'save_recommendation', 'apply_recommendation', 'dismiss_recommendation'
  )),
  constraint assistant_confirmations_entity_type_check check (
    entity_type in ('event_discovery_result', 'recommendation')
  ),
  constraint assistant_confirmations_token_hash_length check (char_length(token_hash) = 64),
  constraint assistant_confirmations_payload_hash_length check (char_length(payload_hash) = 64),
  constraint assistant_confirmations_summary_length check (char_length(summary) between 1 and 500),
  constraint assistant_confirmations_expiry_order check (expires_at > created_at),
  constraint assistant_confirmations_conversation_same_trip_fk
    foreign key (trip_id, conversation_id)
    references public.conversations (trip_id, id)
);

create unique index if not exists assistant_confirmations_token_hash_unique
  on public.assistant_confirmations (token_hash);
create index if not exists assistant_confirmations_user_trip_idx
  on public.assistant_confirmations (user_id, trip_id, created_at desc);
create index if not exists assistant_confirmations_entity_idx
  on public.assistant_confirmations (entity_type, entity_id)
  where consumed_at is null;

alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.assistant_confirmations enable row level security;

grant select, insert, update on table public.conversations to authenticated;
grant select, insert on table public.conversation_messages to authenticated;
grant select, insert on table public.assistant_confirmations to authenticated;
grant update (consumed_at) on table public.assistant_confirmations to authenticated;

drop policy if exists conversations_select_own_trip on public.conversations;
create policy conversations_select_own_trip
on public.conversations for select
to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = conversations.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists conversations_insert_own_trip on public.conversations;
create policy conversations_insert_own_trip
on public.conversations for insert
to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = conversations.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists conversations_update_own_trip on public.conversations;
create policy conversations_update_own_trip
on public.conversations for update
to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = conversations.trip_id
    and trips.user_id = (select auth.uid())
))
with check (exists (
  select 1 from public.trips
  where trips.id = conversations.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists conversation_messages_select_own_trip on public.conversation_messages;
create policy conversation_messages_select_own_trip
on public.conversation_messages for select
to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = conversation_messages.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists conversation_messages_insert_own_trip on public.conversation_messages;
create policy conversation_messages_insert_own_trip
on public.conversation_messages for insert
to authenticated
with check (exists (
  select 1 from public.trips
  where trips.id = conversation_messages.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists assistant_confirmations_select_own on public.assistant_confirmations;
create policy assistant_confirmations_select_own
on public.assistant_confirmations for select
to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.trips
    where trips.id = assistant_confirmations.trip_id
      and trips.user_id = (select auth.uid())
  )
);

drop policy if exists assistant_confirmations_insert_own on public.assistant_confirmations;
create policy assistant_confirmations_insert_own
on public.assistant_confirmations for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.trips
    where trips.id = assistant_confirmations.trip_id
      and trips.user_id = (select auth.uid())
  )
);

drop policy if exists assistant_confirmations_consume_own on public.assistant_confirmations;
create policy assistant_confirmations_consume_own
on public.assistant_confirmations for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

-- Atomic single-use consumption. Runs with the caller's rights, so another user's
-- token matches zero rows. Returns the confirmation id, or null when the token is
-- unknown, expired, already consumed, or bound to a different trip, action, entity,
-- or payload.
create or replace function public.assistant_consume_confirmation(
  p_token_hash text,
  p_trip_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_payload_hash text
)
returns uuid
language sql
security invoker
set search_path = public
as $$
  update public.assistant_confirmations
     set consumed_at = timezone('utc', now())
   where token_hash = p_token_hash
     and user_id = (select auth.uid())
     and trip_id = p_trip_id
     and action = p_action
     and entity_type = p_entity_type
     and entity_id = p_entity_id
     and payload_hash = p_payload_hash
     and consumed_at is null
     and expires_at > now()
  returning id;
$$;

-- Saves or expires a suggested event result in ONE transaction: the token is
-- consumed, the event status changes, a planned agenda item is added (save only),
-- and the audit entries are written. Any failure rolls the token back with the rest.
-- event_discovery_results has no UPDATE grant for users (migration 0005), so this
-- function runs as its owner and checks ownership itself.
create or replace function public.assistant_apply_event_result_action(
  p_token_hash text,
  p_payload_hash text,
  p_trip_id uuid,
  p_result_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_result public.event_discovery_results%rowtype;
  v_confirmation_id uuid;
  v_agenda_id uuid;
  v_timezone text;
  v_end timestamptz;
  v_end_estimated boolean := false;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if p_action not in ('save_event_result', 'expire_event_result') then
    raise exception 'ACTION_UNSUPPORTED' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.trips where id = p_trip_id and user_id = v_user
  ) then
    raise exception 'RESOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_result
    from public.event_discovery_results
   where id = p_result_id and trip_id = p_trip_id
   for update;
  if not found then
    raise exception 'RESOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_result.status <> 'suggested' then
    raise exception 'EVENT_RESULT_STATE_INVALID' using errcode = 'P0001';
  end if;
  if p_action = 'save_event_result' and v_result.expires_at <= now() then
    raise exception 'EVENT_RESULT_EXPIRED' using errcode = 'P0001';
  end if;

  update public.assistant_confirmations
     set consumed_at = timezone('utc', now())
   where token_hash = p_token_hash
     and user_id = v_user
     and trip_id = p_trip_id
     and action = p_action
     and entity_type = 'event_discovery_result'
     and entity_id = p_result_id
     and payload_hash = p_payload_hash
     and consumed_at is null
     and expires_at > now()
  returning id into v_confirmation_id;
  if v_confirmation_id is null then
    raise exception 'CONFIRMATION_REJECTED' using errcode = 'P0001';
  end if;

  if p_action = 'expire_event_result' then
    update public.event_discovery_results
       set status = 'expired'
     where id = p_result_id;
    insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
    values (v_user, 'assistant.event_result_expired', 'event_discovery_result', p_result_id,
            jsonb_build_object('trip_id', p_trip_id, 'confirmation_id', v_confirmation_id));
    return jsonb_build_object('event_result_id', p_result_id, 'status', 'expired', 'agenda_item_id', null);
  end if;

  select timezone into v_timezone
    from public.context_points
   where id = v_result.context_point_id and trip_id = p_trip_id;
  if v_timezone is null then
    raise exception 'RESOURCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_end := v_result.ends_at;
  if v_end is null then
    -- The provider gave no end time. The default one-hour block is labelled in
    -- the agenda metadata so no screen presents it as a provider fact.
    v_end := v_result.starts_at + interval '1 hour';
    v_end_estimated := true;
  end if;

  update public.event_discovery_results
     set status = 'selected'
   where id = p_result_id;

  insert into public.agenda_items (
    trip_id, context_point_id, title, type, start_at, end_at, timezone, status, source, metadata
  ) values (
    p_trip_id, v_result.context_point_id, v_result.title, 'event',
    v_result.starts_at, v_end, v_timezone, 'planned', 'event_discovery',
    jsonb_build_object(
      'event_discovery_result_id', p_result_id,
      'source_id', v_result.source_id,
      'venue_name', v_result.venue_name,
      'end_time_estimated', v_end_estimated,
      'saved_via', 'assistant_confirmation'
    )
  )
  returning id into v_agenda_id;

  insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
  values
    (v_user, 'assistant.event_result_saved', 'event_discovery_result', p_result_id,
     jsonb_build_object('trip_id', p_trip_id, 'agenda_item_id', v_agenda_id, 'confirmation_id', v_confirmation_id)),
    (v_user, 'agenda_item.created', 'agenda_item', v_agenda_id,
     jsonb_build_object('trip_id', p_trip_id, 'status', 'planned', 'source', 'event_discovery',
                        'event_discovery_result_id', p_result_id));

  return jsonb_build_object('event_result_id', p_result_id, 'status', 'selected', 'agenda_item_id', v_agenda_id);
end;
$$;

revoke all on function public.assistant_consume_confirmation(text, uuid, text, text, uuid, text) from public, anon;
revoke all on function public.assistant_apply_event_result_action(text, text, uuid, uuid, text) from public, anon;
grant execute on function public.assistant_consume_confirmation(text, uuid, text, text, uuid, text) to authenticated;
grant execute on function public.assistant_apply_event_result_action(text, text, uuid, uuid, text) to authenticated;

comment on table public.conversations is 'Assistant conversations scoped to one trip.';
comment on table public.conversation_messages is 'Insert-only assistant conversation history, including failed turns with their error code.';
comment on table public.assistant_confirmations is 'Single-use confirmation tokens stored as SHA-256 hashes.';
