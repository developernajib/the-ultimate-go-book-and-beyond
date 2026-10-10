## 89.5 Coordinating Across Teams

### Multi-Team Refactoring

When a refactor spans multiple teams, the coordination overhead becomes the dominant cost. Each team has its own priorities, sprint cadence, and on-call rotation, and none of them signed up to do your migration work. Success depends on identifying every stakeholder upfront, creating a shared understanding of the goal and timeline, and establishing communication channels that keep everyone aligned without drowning them in meetings. The framework below outlines the five steps that consistently produce successful multi-team migrations.

```
┌──────────────────────────────────────────────────────────────────┐
│           MULTI-TEAM REFACTOR COORDINATION                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. IDENTIFY STAKEHOLDERS                                        │
│     ├── Teams directly affected                                  │
│     ├── Teams with dependencies                                  │
│     ├── Platform/infra teams                                     │
│     └── Product managers                                         │
│                                                                  │
│  2. CREATE SHARED UNDERSTANDING                                  │
│     ├── Write RFC with broad review                              │
│     ├── Hold kick-off meeting                                    │
│     ├── Define success criteria together                         │
│     └── Agree on timeline and milestones                         │
│                                                                  │
│  3. ESTABLISH COMMUNICATION                                      │
│     ├── Dedicated Slack channel                                  │
│     ├── Weekly sync meeting                                      │
│     ├── Shared tracking document                                 │
│     └── Escalation path for blockers                             │
│                                                                  │
│  4. DIVIDE WORK                                                  │
│     ├── Clear ownership per component                            │
│     ├── Defined interfaces between teams                         │
│     ├── Integration test points                                  │
│     └── Dependencies documented                                  │
│                                                                  │
│  5. TRACK PROGRESS                                               │
│     ├── Shared Kanban/project board                              │
│     ├── Regular status updates                                   │
│     ├── Blockers visible to all                                  │
│     └── Celebrate milestones                                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Working Agreement Template

A working agreement is a living document that every team involved in the migration signs off on. It defines who owns what, when milestones are due, how teams communicate, what "done" looks like, and under what conditions you roll back. Without this document, each team will have a different mental model of the migration, leading to missed deadlines, duplicated work, and blame when things go wrong. Create this document during the kickoff meeting and keep it updated as the migration progresses.

```markdown
# Migration Working Agreement

## Scope
[What we're changing]

## Teams Involved
| Team | Owner | Responsibility |
|------|-------|----------------|
| Payments | Alice | Legacy API migration |
| Platform | Bob | New service setup |
| Data | Carol | Schema migration |

## Timeline
| Milestone | Date | Criteria |
|-----------|------|----------|
| M1: Shadow mode | Feb 15 | New system running in shadow |
| M2: 10% rollout | Mar 1 | 10% traffic to new |
| M3: 100% rollout | Apr 1 | All traffic to new |
| M4: Cleanup | Apr 15 | Old system decommissioned |

## Communication
- **Slack**: #project-payments-migration
- **Sync**: Tuesdays 10am (30 min)
- **Escalation**: Alice → VP Eng

## Definition of Done
- [ ] All traffic on new system
- [ ] Error rate equal or lower
- [ ] Latency equal or lower
- [ ] Old code deleted
- [ ] Runbooks updated
- [ ] Team trained

## Rollback Criteria
Rollback if:
- Error rate increases by >5%
- P99 latency increases by >20%
- Data mismatches detected

## Risks & Mitigations
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Data loss | Low | Critical | Dual-write + backups |
| Extended rollout | Medium | Medium | Feature flags |
```

### Junior → FAANG: Cross-Team Coordination as a Leadership Signal

Entry-level candidates are not expected to have led migrations across multiple teams, but they are expected to show awareness that such coordination exists and is hard. In an interview, frame any cross-team dependency you navigated as a coordination problem: who needed to be informed, what artifact did you create to communicate, and how did you handle the team that was slow to respond? Even a small example becomes a strong signal when you describe the coordination mechanics explicitly.

### Senior @ FAANG: Cross-Team Coordination at Scale

At staff level, coordinating a migration across teams that do not report to you is the default operating mode. The key insight is that coordination at scale is an information architecture problem: if every team needs a separate conversation with you to understand the migration status, your coordination approach does not scale. The answer is a shared artifact (a migration dashboard, an adoption percentage tracker, a deprecation countdown visible in CI output) that allows each team to self-serve their coordination needs.

Staff engineers at Google routinely use automated adoption tracking for large-scale changes. The pattern is: the codemod makes the mechanical change, the CI gate enforces it on new code, and the dashboard shows the org-wide adoption percentage. You close the loop not through repeated one-on-one conversations but by designing the system so that non-adoption creates visible friction. This is influence at organizational scale rather than individual scale, and it is what L7 thinking looks like in practice.

---
