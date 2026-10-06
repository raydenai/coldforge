---
name: queen-protocol
description: Run a governed, queen-led development wave with isolated parallel sidecars and deterministic quality gates.
disable-model-invocation: false
---

# Queen Protocol

Use this workflow for every epic spanning more than one bounded context.

## 1. Incubate

- Read Queen state, ADRs, architecture, roadmap, backlog, and recent git history.
- Reproduce the current behavior and record the baseline.
- Define the user outcome, invariants, out-of-scope items, dependencies, and evidence required.

## 2. Specify

Create task cards containing:

- stable task ID and one owner;
- exclusive files/bounded context;
- inputs and approved contracts;
- acceptance and negative criteria;
- exact verification commands;
- dependencies and downstream consumers;
- risk level and human gates.

Prefix task subjects so completion hooks select the right gate: `[DOCS]`, `[LINT]`, `[TEST]`, or `[RELEASE]`. Untagged implementation tasks run both lint and unit tests.

## 3. Delegate

- Use at most four concurrent writers.
- Put every writer in a worktree.
- Prefer one platform, one integration, one domain, and one UI task per wave.
- Spawn independent QA/security review as soon as a testable contract exists.

## 4. Synchronize

- Sidecars report blockers and contract changes immediately.
- The Queen owns shared types and resolves conflicting assumptions.
- Workers do not merge, push, deploy, purchase, or use production credentials.
- Rebase or merge only after sidecar tests pass.

## 5. Verify

Verify in layers:

1. unit tests for domain behavior;
2. provider contract tests using captured/synthetic fixtures;
3. disposable-service integration tests;
4. browser/API end-to-end tests;
5. security and compliance invariant tests;
6. production build and deployment smoke tests.

## 6. Decide

The Queen chooses one:

- **accept** — evidence satisfies the gate;
- **rework** — bounded defects return to the same owner;
- **redesign** — contract/architecture is invalid; record an ADR;
- **escalate** — a human gate is truly required.

## 7. Consolidate

- Integrate accepted work.
- Update Queen state, roadmap, backlog, ADRs, runbooks, and readiness metrics.
- Select the next unblocked highest-value tasks.
- Continue without waiting for routine confirmation.
