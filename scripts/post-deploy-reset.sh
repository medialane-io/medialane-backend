#!/usr/bin/env bash
set -e

API_URL="${1:-https://medialane-backend-production.up.railway.app}"
API_SECRET="060f0dd0c6707a93914b9f4ca6321d3c9ab68c359ad5f20c2d66f49cf0300549"
ADMIN_EMAIL="${MEDIALANE_ADMIN_EMAIL:-admin@medialane.xyz}"
ADMIN_NAME="${MEDIALANE_ADMIN_NAME:-Medialane Internal}"

echo "🚀 Medialane post-deploy reset"
echo "   URL: $API_URL"
echo ""

# Step 1: Wait for health
echo "⏳ Waiting for backend to be healthy..."
for i in $(seq 1 30); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/health" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    echo "   ✅ Backend is healthy"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "   ❌ Backend did not become healthy after 30 attempts"
    exit 1
  fi
  echo "   Attempt $i/30 — status $STATUS — retrying in 5s..."
  sleep 5
done

echo ""

# Step 2: Create admin tenant
echo "👤 Creating admin tenant ($ADMIN_EMAIL)..."
TENANT_RESPONSE=$(curl -s -X POST "$API_URL/admin/tenants" \
  -H "x-api-key: $API_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$ADMIN_NAME\",\"email\":\"$ADMIN_EMAIL\",\"plan\":\"PREMIUM\",\"keyLabel\":\"internal\"}")

echo "$TENANT_RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if 'error' in data:
    if 'already registered' in data['error']:
        print('   ℹ️  Admin tenant already exists — skipping')
    else:
        print(f'   ❌ Error: {data[\"error\"]}')
        sys.exit(1)
else:
    key = data['data']['apiKey']['plaintext']
    tenant_id = data['data']['tenant']['id']
    print(f'   ✅ Tenant created: {tenant_id}')
    print(f'')
    print(f'   ⚠️  SAVE THIS API KEY — shown only once:')
    print(f'   {key}')
    print(f'')
    print(f'   Update NEXT_PUBLIC_MEDIALANE_API_KEY in medialane-io .env.local')
    print(f'   Update MEDIALANE_API_KEY in Railway medialane-backend env vars if needed')
" 2>/dev/null || echo "$TENANT_RESPONSE"

echo ""

# Step 3: Run collection registry backfill
echo "🔗 Running collection registry backfill (scanning on-chain events)..."
BACKFILL_RESPONSE=$(curl -s -X POST "$API_URL/admin/collections/backfill-registry" \
  -H "x-api-key: $API_SECRET" \
  --max-time 120)

echo "$BACKFILL_RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if 'error' in data:
    print(f'   ❌ Backfill error: {data[\"error\"]}')
else:
    inserted = data['data']['inserted']
    skipped = data['data']['skipped']
    print(f'   ✅ Backfill complete: {inserted} inserted, {skipped} skipped')
" 2>/dev/null || echo "$BACKFILL_RESPONSE"

echo ""

# Step 4: Final health check
echo "🏥 Final health check..."
HEALTH=$(curl -s "$API_URL/health")
echo "$HEALTH" | python3 -c "
import sys, json
data = json.load(sys.stdin)
status = data.get('status', 'unknown')
db = data.get('db', 'unknown')
lag = data.get('indexerLag', '?')
print(f'   Status: {status} | DB: {db} | Indexer lag: {lag} blocks')
if status == 'ok':
    print('   ✅ Platform is up and running')
else:
    print('   ⚠️  Platform may need attention')
" 2>/dev/null || echo "$HEALTH"

echo ""
echo "🎉 Post-deploy reset complete!"
echo ""
echo "Next steps:"
echo "  1. Go to Railway dashboard and verify the service is running"
echo "  2. Update API keys in medialane-io and medialane-xyz if they changed"
echo "  3. The indexer will catch up automatically from the start block"
