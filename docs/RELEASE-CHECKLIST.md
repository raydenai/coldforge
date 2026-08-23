# Release Checklist

## Code and build

- [ ] Clean checkout installs with the pinned runtime and lockfile.
- [ ] Lint passes with zero errors.
- [ ] Typecheck passes without suppression.
- [ ] Unit and contract tests pass.
- [ ] Disposable-service integration tests pass.
- [ ] Critical browser/API E2E scenarios pass.
- [ ] Production image/build completes reproducibly.
- [ ] Dependency and secret scans have no unresolved P0/P1 finding.

## Data and security

- [ ] Migrations validated from empty and previous production schema.
- [ ] Backup/restore rehearsal completed.
- [ ] Tenant isolation and RLS negative tests pass.
- [ ] All provider callbacks verify signatures and replay windows.
- [ ] Missing verification configuration fails closed.
- [ ] Secrets are externalized, scoped, encrypted, rotated, and redacted.
- [ ] AI tools are allowlisted and prompt-injection scenarios tested.

## Outreach safety

- [ ] Working single-step opt-out and List-Unsubscribe headers.
- [ ] Global suppression checked atomically immediately before execution.
- [ ] Bounce, complaint, reply, booking, and human-takeover stop rules tested.
- [ ] Postal identity, sender identity, and approved content are configured.
- [ ] Audience provenance and channel eligibility are recorded.
- [ ] DNC, consent, timezone, quiet-hour, and frequency rules pass policy tests.
- [ ] Kill switch tested for tenant, campaign, mailbox, provider, and global scopes.

## Operations

- [ ] Dashboards cover event lag, errors, sends, replies, provider health, and bookings.
- [ ] Alerts have owners, severity, and tested destinations.
- [ ] DLQ replay and reconciliation runbooks tested.
- [ ] Provider outage and rate-limit simulations pass.
- [ ] Deploy and rollback drills meet the target.
- [ ] Support and incident escalation are documented.

## Pilot authorization

- [ ] Test providers/accounts and approved limits selected.
- [ ] Seed/internal test completed.
- [ ] Limited real audience, content, schedule, and stop criteria explicitly approved.
- [ ] No unresolved P0/P1 finding.
- [ ] Human owner signs the pilot gate.
