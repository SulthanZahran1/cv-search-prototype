#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Rebuilding frontend…"
(cd web && npm run build 2>&1 | tail -2)

echo "==> Rebuilding Docker image & redeploying…"
docker compose up -d --build

echo "==> Waiting for health check…"
sleep 3
curl -sf http://localhost:8095/api/health | python3 -m json.tool

echo ""
echo "✅ Deployed! https://cv-search.zahranm.cloud"
