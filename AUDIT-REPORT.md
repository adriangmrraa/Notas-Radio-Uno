# Audit Report - PeriodistApp live-creator-platform

## Scope and method

Audited the read-only kanban export against `docs/PRODUCT-VISION.md` and all SDD artifacts in `sdd/live-creator-platform/`. The audit itself changed no application source, Drizzle artifact, kanban export, remote, merge, or deployment.

## Corrections made

| Finding | Evidence | Correction |
|---|---|---|
| B-1 and B-2 were still described as blocking questions and B-1 mitigation still promised YouTube "best-effort". | `proposal.md` former Open Questions and R-1; owner decision in kanban B-1/B-2 cards | Replaced questions with binding resolved decisions: YouTube FULL via VPS/proxies from T1, and N:M memberships plus active tenant from v1. |
| The proposal deferred multi-brand users despite B-6. | `proposal.md` former OUT scope multi-brand item | Removed the contradictory OUT item and documented the plan limits for brands. |
| Product backlog names diverged from the SDD data model. | `PRODUCT-VISION.md` PA-01/PB-01/PC-01/PC-02/PE-03/PF-09 | Updated the tickets to `user_tenants`, `tenant_quotas`/`quota_operations`, and `persons` vocabulary. |
| Schema violated its own tenant-domain convention for `person_transmission`; plan limits used by invites/Zernio were absent. | `design/schema.md` lines 3, 56-58, 137 | Added `tenant_id`, tenant indexes and same-tenant validation to `person_transmission`; added `max_team_members`, `max_tenants`, and `max_connected_platforms` to plans. |
| The original SDD had 21 specs, but two kanban capabilities had no explicit spec/task. | `design.md` line 3; `tasks.md` former T-60 and PE mapping | Added `analysis-provider-registry` (PE-01) and `platform-ux` (PH) specs, corrected the count to 23, and added T-63 through T-67. |
| PE-01 was incorrectly mapped to the image registry/prompt builder. | `tasks.md` former mapping row PE | Mapped PE-01 to a dedicated provider-registry task with deterministic fallback and cost telemetry. |
| PA-12, PB-08, PC-05, PF-06, PF-07 and PF-09 had no complete implementation task. | Kanban checklists versus `tasks.md` mapping | Added T-64 security hardening, T-65 billing page/email contract, T-66 editorial profile UI, and T-67 content factory. |
| The plan exposed T1/T2/T3 as execution order, conflicting with the owner-selected A-to-I epic order. | `proposal.md` summary and mapping; kanban instructions | Made PA -> PI the binding product sequence; preserve gates/migrations only as dependency-only early work. |

## Execution-state drift

The kanban export still has every checklist item unchecked, while `tasks.md` now marks T-01 through T-05 complete (commits `ee548cb` and `7f685f8`). This is a separate status inconsistency from the planning audit: the kanban owner should verify the stated gates and then mark only the corresponding PB-04, PA-12, and PD-03 work as evidenced. It must not bulk-close their parent epics.

## Kanban changes recommended (do not edit the export)

1. After validating the gates for T-01..T-05, reflect their verified sub-item progress in the kanban; keep unrelated items open.
2. Replace B-1 and B-2 "question" card bodies with immutable decision records, or archive them. Their status is `done` but their copy still asks for a decision.
2. Update PA-01 to the final N:M/auth schema and PB-01 to `tenant_quotas` + `quota_operations`; do not create the obsolete `admin_users` or `usage_cycles` merely to satisfy old card text.
3. Add explicit checklist items: PA security hardening, PB billing page, PC editorial-profile UI, PE provider registry, PF content factory, and PI request/transmission observability. They correspond to T-64, T-65, T-66, T-63, T-67, and T-68.
4. Keep A -> I as the product order, but permit GATE-1 before PC and GATE-2 before PG. These are risk decisions, not epic delivery reordering.
5. Amend PD-07 wording: YouTube is a v1 production requirement through dedicated VPS/proxy infrastructure; upload is a continuity fallback, not a substitute.

## Final recommended execution order

1. **PA Foundation:** tenancy/auth, roles, audit, flags, security, then admin surfaces.
2. **PB Billing:** quota model/enforcement, plans, webhooks/state machine, billing UX and emails.
3. **PC Context:** persons, facial enrollment, editorial profile and its UI, agenda/onboarding prerequisites.
4. **PD Ingest:** VPS/proxy-backed YouTube capture, transmission lifecycle, scheduling, raw retention.
5. **PE Analysis:** provider registry, transcription/analysis pipeline, attribution and live alerts.
6. **PF Factory:** footage clips first, then notes/flyers/variants as unified assets.
7. **PG Publishing:** only after GATE-2 validates Zernio connect/upload/webhook.
8. **PH Experience:** shared UX system plus remaining dashboard/navigation/tablet work.
9. **PI Operations:** runbooks, backup/retention verification, staging checklist and controlled pilot.

This sequence respects the owner priority while retaining only true technical prerequisites. It avoids building user-facing video/content workflows before tenant isolation, billing enforcement, and their operating controls exist.

## Coverage result

All existing kanban IDs PA-01..PA-12, PB-01..PB-09, PC-01..PC-10, PD-01..PD-07, PE-01..PE-07, PF-01..PF-10, PG-01..PG-07, PH-01..PH-07, and PI-01..PI-07 now have one or more explicit tasks in `tasks.md`. The two new specs make the spec set complete for the provider boundary and transversal UX; no proposal capability remains unowned.
