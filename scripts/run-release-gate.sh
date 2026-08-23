#!/usr/bin/env bash
set -euo pipefail

node scripts/check-release-baseline.mjs
node scripts/acceptance/render-agent-live-matrix.mjs --check
node scripts/acceptance/render-connector-live-matrix.mjs --check
node scripts/render-release-report.mjs --check
npm run lint
npm run typecheck
node --import tsx --test --test-concurrency=1 $(rg --files tests -g '*.test.ts' | sort)
npm run build
npm pack --dry-run
node --import tsx --test --test-concurrency=1 tests/e2e/package-install.test.ts
