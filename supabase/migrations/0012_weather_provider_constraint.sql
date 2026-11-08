-- The weather snapshot provider name lives in one place in the code
-- (`OPENWEATHER_SNAPSHOT_PROVIDER`) but the check written with the first draft of
-- 0007 pinned the older name, so every weather refresh was rejected by the database
-- and no forecast ever reached a trip. Accept both names the code has used: the row
-- records which provider answered, it does not need to guess.
alter table public.weather_snapshots
  drop constraint if exists weather_provider_check;

alter table public.weather_snapshots
  add constraint weather_provider_check
  check (provider in ('openweather_free_2_5', 'openweather_onecall_3'));
