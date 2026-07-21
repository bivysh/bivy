#!/usr/bin/env bash
# Dev-mode billing smoke: proves the control plane's money loop end-to-end
# (account -> checkout endpoint -> webhook -> plan/entitlement flip -> downgrade)
# WITHOUT real Stripe keys. Real Stripe test-mode run (with test keys) is still B3.
set -uo pipefail
BASE="http://127.0.0.1:4400"
PASS=0; FAIL=0
check() { # desc, expected_substr, actual
  if echo "$3" | grep -q "$2"; then echo "  PASS: $1"; PASS=$((PASS+1));
  else echo "  FAIL: $1 — expected '$2' in: $3"; FAIL=$((FAIL+1)); fi
}

echo "== boot control plane (dev, in-memory, no Stripe) =="
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
( cd "$REPO_ROOT/services/control-plane" && PORT=4400 NODE_ENV=development npx tsx src/index.ts ) >/tmp/cp.log 2>&1 &
CP_PID=$!
trap 'kill $CP_PID 2>/dev/null' EXIT
for i in $(seq 1 60); do
  code=$(curl -s -m1 "$BASE/me" -o /dev/null -w "%{http_code}" 2>/dev/null)
  [ "$code" != "000" ] && break
  sleep 0.5
done
echo "  control plane responding (http $code)"

echo "== 1. dev-login creates a free account =="
LOGIN=$(curl -s -X POST "$BASE/auth/dev-login" -H 'content-type: application/json' -d '{"email":"launch-smoke@bivy.sh"}')
TOKEN=$(echo "$LOGIN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
ACCT=$(echo "$LOGIN" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
check "login returns a token" '.' "$TOKEN"
echo "  account=$ACCT"

echo "== 2. new account starts free: 1 node, push OFF =="
ME1=$(curl -s "$BASE/me" -H "authorization: Bearer $TOKEN")
check "plan is free" '"plan":"free"' "$ME1"
check "maxNodes = 1" '"maxNodes":1' "$ME1"
check "pushEnabled = false" '"pushEnabled":false' "$ME1"

echo "== 3. checkout endpoint returns a URL (dev stub) =="
CO=$(curl -s -X POST "$BASE/billing/checkout" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"plan":"individual"}')
check "checkout returns a url" 'checkoutUrl' "$CO"

echo "== 4. webhook flips account to Pro (individual) =="
curl -s -X POST "$BASE/billing/webhook" -H 'content-type: application/json' \
  -d "{\"accountId\":\"$ACCT\",\"plan\":\"individual\"}" >/dev/null
ME2=$(curl -s "$BASE/me" -H "authorization: Bearer $TOKEN")
check "plan is individual (Pro)" '"plan":"individual"' "$ME2"
check "maxNodes = 3" '"maxNodes":3' "$ME2"
check "pushEnabled = true" '"pushEnabled":true' "$ME2"

echo "== 5. cancel/downgrade webhook returns account to free =="
curl -s -X POST "$BASE/billing/webhook" -H 'content-type: application/json' \
  -d "{\"accountId\":\"$ACCT\",\"plan\":\"free\"}" >/dev/null
ME3=$(curl -s "$BASE/me" -H "authorization: Bearer $TOKEN")
check "plan back to free" '"plan":"free"' "$ME3"
check "maxNodes back to 1" '"maxNodes":1' "$ME3"
check "pushEnabled back to false" '"pushEnabled":false' "$ME3"

echo "== 6. billing portal endpoint responds =="
PORTAL=$(curl -s -X POST "$BASE/billing/portal" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}')
check "portal returns a url" 'portalUrl' "$PORTAL"

echo
echo "==== RESULT: $PASS passed, $FAIL failed ===="
[ "$FAIL" -eq 0 ]
