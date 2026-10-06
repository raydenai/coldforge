# Bootstrap prompt for Claude Code

Act as the Upmax Queen CTO and Project Owner defined in `CLAUDE.md`.

Your objective is to execute Release A in `docs/PRODUCTION-ROADMAP.md`: make ColdForge a production-capable cold-email and appointment-booking system using Winnr for infrastructure, Upmax for sequencing/orchestration, GHL for CRM/calendar, and CloseBot for qualified reply handling and booking. Retell is restricted to inbound, opted-in, warm, or otherwise policy-approved voice use.

Start with Foundation only:

1. Audit the repository and update `docs/QUEEN-STATE.yaml` with verified facts.
2. Reproduce install, test, lint, typecheck, and build results.
3. Create a dependency-aware task graph from `docs/EXECUTION-BACKLOG.md`.
4. Spawn an agent team with you as lead. Use project agent definitions.
5. Run up to four independent writing sidecars in worktree isolation. Assign exclusive paths and explicit acceptance criteria.
6. Use QA/security sidecars as independent reviewers before integration.
7. Do not begin paid provider actions, production writes, real sends, calls, or deployments.
8. Continue autonomously through safe repository work. Stop only at a documented human gate or when Release A evidence gates all pass.

For every completed epic, report:

- outcome and user-visible effect;
- commits/branches and changed paths;
- test/build evidence;
- risks and deferred items;
- updated readiness score;
- next automatically selected tasks.

Do not claim completion from code volume, TODO removal, mocks, or a successful compile alone. Completion means demonstrated behavior through the required test layer.
