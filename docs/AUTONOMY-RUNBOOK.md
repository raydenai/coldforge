# Autonomous Development Runbook

## Operating model

The Queen may autonomously inspect, design, edit, test, refactor, document, create local branches/worktrees, and commit bounded changes. It chooses the next unblocked highest-value task and continues without routine status approval.

## Mandatory approval gates

The Queen must stop before:

| Gate | Required input |
|---|---|
| Provider purchase/plan | Account owner approval and budget |
| OAuth/API credentials | User completes authorization or places secret in approved store |
| Production database write/migration | Backup evidence, migration plan, rollback and approval |
| Real email/SMS/call | Approved audience, content, channel policy, limits and kill switch |
| Production deployment/DNS cutover | Release evidence and explicit approval |
| Customer/regulated data | Data classification, retention and access decision |
| Legal/compliance interpretation | Qualified policy decision; code implements it |
| Destructive or irreversible action | Exact target, recovery plan and approval |
| Product pricing/positioning | Owner decision |

## Escalation format

Ask one concise question containing:

1. decision needed;
2. verified evidence;
3. recommended option;
4. alternatives and tradeoffs;
5. cost, security, compliance, and schedule effect;
6. exact smallest action the owner must take.

Continue all unrelated safe work while one task is gated.

## Sidecar lifecycle

1. Queen creates a task card and reserves exclusive paths.
2. Sidecar starts in a named worktree/branch.
3. Sidecar reproduces baseline and commits tests before/with behavior.
4. Sidecar reports contract questions immediately.
5. Sidecar runs task gates and produces an evidence report.
6. QA/security sidecar independently reviews high-risk work.
7. Queen accepts, requests rework, or records an ADR.
8. Integration happens serially; full affected gates run again.
9. Worktree is removed after accepted integration.

## Conflict prevention

- Shared schemas/interfaces are Queen-owned or assigned to one contract sidecar first.
- UI begins only after contracts stabilize or uses generated mocks from the contract.
- Migrations have one owner per wave and monotonically ordered IDs.
- Package/config files are platform-sidecar owned unless explicitly reassigned.
- A sidecar may read any path but writes only its reservation.

## Continuity

`docs/QUEEN-STATE.yaml` is the durable checkpoint. Update it after every merge, gate, incident, or changed assumption. Do not rely on chat memory for project status.

Use scheduled Claude Code routines/GitHub triggers for read-only triage, CI-failure diagnosis, dependency review, and backlog grooming. Do not allow scheduled jobs to deploy, purchase, contact leads, or merge high-risk changes.

## Recommended Claude Code controls

- Native agent team: Queen plus specialized teammates for coordination.
- Worktree-isolated subagents for writers.
- `TaskCompleted` hooks for quality gates.
- `Stop`/`TeammateIdle` hooks only after proving they do not create infinite loops.
- MCP for Winnr and Retell administration only with least-privilege test credentials.
- `auto` mode with safety checks for supervised local autonomy.
- `dontAsk` with allowlists for CI/non-interactive jobs.
- Never use `bypassPermissions` on a normal workstation.

Ruflo/Claude-Flow can be evaluated later as an optional orchestration layer. Native Claude Code teams, worktrees, hooks, skills, and checkpoint files are the initial control plane to reduce framework risk.
