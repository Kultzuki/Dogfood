#!/bin/sh
set -eu

# ── Session secret (fail-closed, quick-start friendly) ────────────────
# Production refuses a missing/short/default secret (see session.ts).
# For `docker compose up` to work out of the box, generate a persistent
# per-deployment secret on first boot and reuse it afterwards.
SECRET_FILE="/app/data/.session_secret"
if [ -z "${SESSION_SECRET:-}" ]; then
  if [ -f "$SECRET_FILE" ]; then
    SESSION_SECRET="$(cat "$SECRET_FILE")"
    export SESSION_SECRET
    echo "🔑 Loaded persistent SESSION_SECRET."
  elif [ -w "/app/data" ]; then
    SESSION_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    export SESSION_SECRET
    printf '%s' "$SESSION_SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
    echo "🔑 Generated persistent SESSION_SECRET (first boot)."
  else
    echo "❌ SESSION_SECRET is not set and /app/data is not writable — refusing to boot."
    exit 1
  fi
fi

# ── Wait for PostgreSQL ──────────────────────────────────────────────
echo "⏳ Waiting for database..."
ATTEMPTS=0
MAX_ATTEMPTS=60
until pg_isready -U dogfood -d dogfood -h db -p 5432 >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    echo "❌ Database not ready after ${MAX_ATTEMPTS}s — exiting."
    exit 1
  fi
  sleep 1
done
echo "✅ Database is ready."

# ── Run migrations (advisory-locked) ────────────────────────────────
echo "🔄 Running migrations..."
node dist/db/migrate.js
echo "✅ Migrations complete."

# ── Seed (idempotent — skips if data exists) ────────────────────────
echo "🌱 Seeding database..."
node dist/db/seed.js
echo "✅ Seed complete."

# ── Seed acceptance fixtures (idempotent — converges fixture event) ──
echo "🌱 Seeding acceptance fixtures..."
node /app/docker/seed-fixtures.mjs || echo "⚠️ Fixture seed failed (continuing without fixtures)."
echo "✅ Fixture seed step complete."

# ── Official fixtures (idempotent — skips + reprints headers on reboot) ─
echo "🌱 Seeding official fixtures..."
node dist/db/seed-fixtures.js
echo "✅ Fixture seed complete."

# ── Local/demo test accounts (no-op unless DOGFOOD_DEMO_ACCOUNTS=1) ────
# Creates four password-loginable demo identities for manual browser QA.
# They are NOT the acceptance fixture identities and are never referenced by
# .dogfood.toml. Set DOGFOOD_DEMO_ACCOUNTS=0 (or omit) on any real deployment.
echo "🧪 Seeding demo test accounts (gated by DOGFOOD_DEMO_ACCOUNTS)..."
node dist/db/seed-demo.js
echo "✅ Demo account seed step complete."

# ── Start application ───────────────────────────────────────────────
echo "🚀 Starting application..."
exec node dist/server.js
