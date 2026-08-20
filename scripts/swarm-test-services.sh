#!/bin/sh
# Ephemeral local Postgres and Redis for replicating a repository's CI environment
# inside the worker container. No Docker required.
#
#   eval "$(swarm-test-services start [database-name])"
#   swarm-test-services stop
#
# `start` prints export lines for DATABASE_URL and REDIS_URL on stdout; eval them in
# the caller shell. The database name defaults to `swarmloom`; pass the name from the
# repository's CI DATABASE_URL when it differs.
set -eu

STATE="${TMPDIR:-/tmp}/swarm-test-services"
PG_BIN=$(ls -d /usr/lib/postgresql/*/bin | head -n1)
DB_NAME=${2:-swarmloom}

find_free_port() {
  base=$1
  port=$base
  while [ "$port" -lt $((base + 20)) ]; do
    if ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
  done
  echo "no free port near $base" >&2
  return 1
}

start_postgres() {
  port=$(find_free_port 5432)
  data=$(mktemp -d "$STATE/pgdata.XXXXXX")
  "$PG_BIN/initdb" -D "$data" -U postgres --auth=trust --no-sync >/dev/null
  "$PG_BIN/pg_ctl" -D "$data" -l "$data/server.log" \
    -o "-p $port -h 127.0.0.1 -k $data -c listen_addresses=127.0.0.1" -w start >/dev/null
  "$PG_BIN/createdb" -h 127.0.0.1 -p "$port" -U postgres "$DB_NAME"
  echo "$data $port" > "$STATE/pg.state"
  echo "export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:$port/$DB_NAME"
}

start_redis() {
  port=$(find_free_port 6379)
  redis-server --port "$port" --bind 127.0.0.1 --daemonize yes \
    --pidfile "$STATE/redis.pid" --logfile "$STATE/redis.log" \
    --dir "$STATE" --save '' >/dev/null
  echo "$port" > "$STATE/redis.state"
  echo "export REDIS_URL=redis://127.0.0.1:$port"
}

stop_services() {
  if [ -f "$STATE/pg.state" ]; then
    read -r data port < "$STATE/pg.state"
    "$PG_BIN/pg_ctl" -D "$data" -m fast -w stop >/dev/null 2>&1 || true
    rm -rf "$data"
  fi
  if [ -f "$STATE/redis.state" ]; then
    read -r port < "$STATE/redis.state"
    redis-cli -p "$port" shutdown nosave >/dev/null 2>&1 || true
  fi
  rm -f "$STATE/pg.state" "$STATE/redis.state" "$STATE/redis.pid" "$STATE/redis.log"
}

start_services() {
  mkdir -p "$STATE"
  stop_services
  start_postgres
  start_redis
}

case "${1:-start}" in
  start) start_services ;;
  stop) stop_services ;;
  *) echo "usage: $0 start|stop [database-name]" >&2; exit 2 ;;
esac
