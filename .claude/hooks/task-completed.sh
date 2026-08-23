#!/usr/bin/env bash
set -euo pipefail

input="$(cat)"
subject="$(printf '%s' "$input" | jq -r '.task_subject // ""' 2>/dev/null || true)"

if [[ "$subject" == \[DOCS\]* ]]; then
  exit 0
fi

if [[ "$subject" == \[LINT\]* ]]; then
  if ! npm run lint; then
    echo "Lint task cannot complete: lint is still failing." >&2
    exit 2
  fi
  exit 0
fi

if [[ "$subject" == \[TEST\]* ]]; then
  if ! npm run test:run; then
    echo "Test task cannot complete: the automated test suite is still failing." >&2
    exit 2
  fi
  exit 0
fi

if ! npm run lint; then
  echo "Task cannot complete: lint is failing. Fix the failures introduced or exposed by this task." >&2
  exit 2
fi

if ! npm run test:run; then
  echo "Task cannot complete: the automated test suite is failing." >&2
  exit 2
fi

if [[ "$subject" == \[RELEASE\]* ]]; then
  if ! npm run typecheck; then
    echo "Release task cannot complete: TypeScript validation is failing." >&2
    exit 2
  fi
  if ! npm run build; then
    echo "Release task cannot complete: the production build is failing." >&2
    exit 2
  fi
fi

exit 0
