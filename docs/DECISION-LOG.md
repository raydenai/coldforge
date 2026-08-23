# Decision Log

The Queen appends decisions here and creates a full ADR when a decision changes architecture, data ownership, security, compliance, deployment, or a provider contract.

| Date | Decision | Reason | Evidence/ADR | Revisit |
|---|---|---|---|---|
| 2026-08-22 | Use Winnr for email infrastructure | Removes domain/DNS/mailbox/warmup work from the critical path | Product architecture and research notes | After Release A pilot |
| 2026-08-22 | Build the native Upmax sequencer; keep Smartlead as parity/fallback | Goal is to replace Instantly without duplicating infrastructure | Product architecture | After parity tests |
| 2026-08-22 | GHL owns CRM, conversations, pipeline, and appointments | Strong API/webhook surface and CloseBot integration | Product architecture | After GHL POC |
| 2026-08-22 | CloseBot owns qualified text conversation/booking | Accelerates reply-to-appointment loop | Product architecture | After controlled E2E evaluation |
| 2026-08-22 | Restrict Retell to inbound/warm/consented/policy-approved use | Voice outreach has materially higher legal and reputational risk | Compliance research | Legal/policy approval |
| 2026-08-22 | TypeScript/Node 24 LTS control plane; measured Go/Rust extraction | Fastest safe path without sacrificing future performance | ADR-001 | Staging load test |
| 2026-08-22 | Native Claude Code Queen Protocol first; Ruflo optional later | Reduces orchestration-framework risk while retaining teams/worktrees/hooks | Autonomy runbook | After Foundation |
