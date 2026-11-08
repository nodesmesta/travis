#!/usr/bin/env bash
# Backup and restore verification (Task 12). Local only.
#
# 1. Writes a marker row into the local database (a trip note via a labelled trip).
# 2. pg_dump (custom format) of the `postgres` database from the Supabase container.
# 3. Restores the dump into a NEW scratch database (never over the source).
# 4. Compares: table list, row counts of every application table, RLS flags, policies,
#    functions, and the marker row. Drops the scratch database and the marker.
#
# It does not use regular expressions (case globs and grep -F only).

set -u -o pipefail
CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_vultr}"
SCRATCH="tf_restore_check"
DUMP_DIR="$(mktemp -d)"
DUMP="/tmp/tf_backup_check.dump"
MARKER="00000000-0000-0000-0000-00000000bacc"
pass=0
fail=0

ok() { printf 'PASS: %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; fail=$((fail + 1)); }

psql_main() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At "$@"; }
psql_scratch() { docker exec -i "$CONTAINER" psql -U postgres -d "$SCRATCH" -v ON_ERROR_STOP=1 -At "$@"; }

cleanup() {
  docker exec -i "$CONTAINER" psql -U postgres -d postgres -c "drop database if exists $SCRATCH" >/dev/null 2>&1
  docker exec -i "$CONTAINER" rm -f "$DUMP" >/dev/null 2>&1
  psql_main -c "delete from public.trips where id = '$MARKER'" >/dev/null 2>&1
  rm -rf "$DUMP_DIR"
}
trap cleanup EXIT

docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "FAIL: container $CONTAINER not found"; exit 1; }

# Marker: one trip owned by the demo user, removed at the end.
demo_id="$(psql_main -c "select id from auth.users where email = 'demo@travelflow.local' limit 1")"
[[ -n "$demo_id" ]] || { echo "FAIL: demo user not found; run npm run bootstrap:local"; exit 1; }
psql_main -c "insert into public.trips (id, user_id, name, timezone, status, source) values ('$MARKER', '$demo_id', 'backup-restore marker', 'Asia/Jakarta', 'draft', 'internal') on conflict (id) do nothing" >/dev/null
ok "marker trip written to the source database"

# Backup. The auth schema is included because every application table points at auth.users.
docker exec -i "$CONTAINER" pg_dump -U postgres -d postgres -Fc -f "$DUMP" \
  --schema=auth --schema=public --schema=storage --no-owner >"$DUMP_DIR/dump.out" 2>"$DUMP_DIR/dump.err"
dump_status=$?
if [[ "$dump_status" == "0" ]]; then
  size="$(docker exec -i "$CONTAINER" stat -c %s "$DUMP")"
  [[ "$size" -gt 10000 ]] && ok "pg_dump (exit 0) wrote a $size byte custom-format backup" || bad "backup is suspiciously small ($size bytes)"
else
  bad "pg_dump exited $dump_status: $(head -c 300 "$DUMP_DIR/dump.err")"
fi
list_count="$(docker exec -i "$CONTAINER" pg_restore --list "$DUMP" | wc -l)"
[[ "$list_count" -gt 100 ]] && ok "pg_restore --list reads the backup ($list_count entries)" || bad "backup catalog has only $list_count entries"

# Restore into a NEW scratch database, never over the source. A fresh database starts
# with an empty public schema and without the extensions the dump relies on.
docker exec -i "$CONTAINER" psql -U postgres -d postgres -c "drop database if exists $SCRATCH" >/dev/null 2>&1
docker exec -i "$CONTAINER" psql -U postgres -d postgres -c "create database $SCRATCH template template0" >/dev/null
psql_scratch -c "drop schema public cascade; create schema extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists \"uuid-ossp\" with schema extensions;" >/dev/null 2>&1
restore_log="$DUMP_DIR/restore.log"
docker exec -i "$CONTAINER" pg_restore -U "${RESTORE_ROLE:-supabase_admin}" -d "$SCRATCH" --no-owner --exit-on-error "$DUMP" >"$restore_log" 2>&1
restore_status=$?
if [[ "$restore_status" == "0" ]]; then
  ok "pg_restore into the scratch database exited 0 (--exit-on-error: any failed statement would have stopped it)"
else
  bad "pg_restore exited $restore_status:"
  head -8 "$restore_log"
fi

# Compare.
tables_src="$(psql_main -c "select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'public'")"
tables_dst="$(psql_scratch -c "select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'public'")"
if [[ "$tables_src" == "$tables_dst" && -n "$tables_src" ]]; then
  ok "restored database has the same $(printf '%s' "$tables_src" | tr ',' '\n' | wc -l) public tables"
else
  bad "table lists differ"
fi

mismatch=""
for table in $(printf '%s' "$tables_src" | tr ',' ' '); do
  a="$(psql_main -c "select count(*) from public.\"$table\"")"
  b="$(psql_scratch -c "select count(*) from public.\"$table\"" 2>/dev/null)"
  [[ "$a" == "$b" ]] || mismatch="$mismatch $table($a!=$b)"
done
[[ -z "$mismatch" ]] && ok "row counts match in every public table" || bad "row counts differ:$mismatch"

rls_src="$(psql_main -c "select string_agg(c.relname || ':' || c.relrowsecurity::text, ',' order by c.relname) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'")"
rls_dst="$(psql_scratch -c "select string_agg(c.relname || ':' || c.relrowsecurity::text, ',' order by c.relname) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'")"
[[ "$rls_src" == "$rls_dst" ]] && ok "row level security flags match on every table" || bad "RLS flags differ after restore"
case "$rls_dst" in *":false"*) bad "a restored table has RLS disabled" ;; *) ok "no restored public table has RLS disabled" ;; esac

pol_src="$(psql_main -c "select count(*) from pg_policies where schemaname = 'public'")"
pol_dst="$(psql_scratch -c "select count(*) from pg_policies where schemaname = 'public'")"
[[ "$pol_src" == "$pol_dst" && "$pol_src" -gt 0 ]] && ok "all $pol_src RLS policies were restored" || bad "policy counts differ ($pol_src vs $pol_dst)"

fn_src="$(psql_main -c "select string_agg(proname, ',' order by proname) from pg_proc where pronamespace = 'public'::regnamespace")"
fn_dst="$(psql_scratch -c "select string_agg(proname, ',' order by proname) from pg_proc where pronamespace = 'public'::regnamespace")"
[[ "$fn_src" == "$fn_dst" && -n "$fn_src" ]] && ok "all public functions were restored" || bad "function lists differ"

marker_dst="$(psql_scratch -c "select name from public.trips where id = '$MARKER'")"
[[ "$marker_dst" == "backup-restore marker" ]] && ok "the marker row written before the backup is present after the restore" || bad "marker row missing after restore"

bucket_dst="$(psql_scratch -c "select id || ':' || public::text from storage.buckets where id = 'invoices'" 2>/dev/null)"
[[ "$bucket_dst" == "invoices:false" ]] && ok "the private invoices bucket definition was restored (public=false)" || bad "invoices bucket missing or public after restore ($bucket_dst)"

printf '\nSummary: %d PASS, %d FAIL\n' "$pass" "$fail"
printf 'Note: this restores the auth, public, and storage schemas into a scratch database. The Storage object FILES (the invoice PDFs) are not in a database dump and are not checked here; copy the Storage volume as well (see deploy/README.md).\n'
[[ "$fail" == "0" ]]
