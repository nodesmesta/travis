// Removes the test trips created by scripts/validate-task-trips.mjs and
// scripts/ui-smoke-trips.mjs, with everything stored under them.
//
// A trip is a test trip when its name starts with one of `prefixes` and it was
// created at or after `sinceIso`. Rows are removed in dependency order and only
// for those trips; no other data is touched.

import { sql } from "./validation.mjs";

export const VALIDATOR_PREFIX = "[trips-validator] ";
export const UI_SMOKE_PREFIX = "[ui-smoke trips] ";

function literal(text) {
  if (text.includes("'")) throw new Error("quote in cleanup literal");
  return `'${text}'`;
}

const TEST_TRIPS = (prefixes, sinceIso) => `
  create temporary table cleanup_trips as
    select id from public.trips
    where created_at >= ${literal(sinceIso)}
      and (${prefixes.map((prefix) => `position(${literal(prefix)} in name) = 1`).join(" or ")});
  create temporary table cleanup_ids as
    select id from cleanup_trips
    union select id from public.context_points where trip_id in (select id from cleanup_trips)
    union select id from public.agenda_items where trip_id in (select id from cleanup_trips)
    union select id from public.journey_legs where trip_id in (select id from cleanup_trips);`;

/** Number of test trips that still exist. */
export async function countTestTrips(prefixes, sinceIso) {
  const out = await sql(`
    select count(*) from public.trips
    where created_at >= ${literal(sinceIso)}
      and (${prefixes.map((prefix) => `position(${literal(prefix)} in name) = 1`).join(" or ")});`);
  return Number(out.split("\n").pop());
}

/** Deletes the test trips and their data. Returns the number of trips removed. */
export async function cleanupTestTrips(prefixes, sinceIso) {
  const before = await countTestTrips(prefixes, sinceIso);
  await sql(`${TEST_TRIPS(prefixes, sinceIso)}
    delete from public.alerts where trip_id in (select id from cleanup_trips);
    delete from public.background_jobs where trip_id in (select id from cleanup_trips);
    delete from public.journey_legs where trip_id in (select id from cleanup_trips);
    delete from public.agenda_items where trip_id in (select id from cleanup_trips);
    delete from public.context_points where trip_id in (select id from cleanup_trips);
    delete from public.activity_logs
      where resource_id::text in (select id::text from cleanup_ids)
         or metadata->>'trip_id' in (select id::text from cleanup_trips);
    delete from public.idempotency_records
      where response_body->>'id' in (select id::text from cleanup_ids)
         or response_body->'context_point'->>'id' in (select id::text from cleanup_ids)
         or exists (select 1 from cleanup_ids c where position(c.id::text in scope) > 0);
    delete from public.trips where id in (select id from cleanup_trips);`);
  const after = await countTestTrips(prefixes, sinceIso);
  if (after !== 0)
    throw new Error(`${after} test trips are still in the database`);
  return before;
}
