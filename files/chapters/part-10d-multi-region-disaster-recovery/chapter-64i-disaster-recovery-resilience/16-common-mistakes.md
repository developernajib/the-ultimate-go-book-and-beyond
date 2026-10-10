## Common Mistakes and How to Avoid Them

| Mistake | Why It's Dangerous | Correct Approach |
|---|---|---|
| Untested backups | A backup you've never restored from is not a backup | Run automated restore tests weekly and verify checksums |
| RTO/RPO set by engineers, not business | Technical aspirations ≠ business requirements | SLA contracts negotiated with product, legal, finance |
| Chaos in production without steady state baseline | You can't know if chaos caused the anomaly | Always measure and confirm steady state before injecting |
| Circuit breaker with too-short timeout | Opens under transient load, causes self-DDOS | Calibrate timeout to p99 of downstream recovery |
| Synchronous failover without lag check | Promotes a stale replica, causing data loss beyond RPO | Always check replication lag before promotion |
| Runbooks as PDFs / Confluence pages | Out of date within weeks and not executable | Encode runbooks as testable Go programs |
| Game days in staging only | Staging doesn't reflect production failure modes | Mix staging tests with limited blast-radius production tests |
| Single-region backup storage | Region loss = backup loss | Cross-region backup replication mandatory |
| Missing rollback in chaos experiments | Latency injection left on overnight | Always defer Rollback(), and verify with an integration test |
| MTTR measured from alert, not from user impact | Masks delayed detection | MTTR = time from first user impact, not first alert |
| Split-brain in automated failover | Both regions accept writes, data divergence | Use fencing tokens or distributed locks before promotion |
| No blameless culture | Engineers hide near-misses | Postmortems explicitly forbid naming individuals as root cause |

---

### Junior -> FAANG: Internalizing the Common Mistakes as Interview Talking Points

Each row in this table is a story: a team made a reasonable-seeming choice, that choice failed in a specific way, and a corrected approach exists. For interview preparation, pick three rows that resonate with systems you have worked with and practice explaining the full story: what the mistake was, why it seemed reasonable at the time, and what the correct approach achieves.

The most frequently cited mistakes in FAANG reliability interviews are untested backups and RTO/RPO set by engineers. Both expose a fundamental confusion: having a capability is not the same as having a tested, validated, business-aligned capability. An untested backup looks like a backup until you try to restore from it. An RTO set by an engineer looks like a business commitment until a real incident asks the business whether 4 hours of downtime is acceptable for a checkout service.

For your first job: pick one mistake from this table and audit whether your team makes it. "Runbooks as PDFs" is a good starting audit because it is easy to verify (are your team's runbooks executable or are they documents?) and the path to improvement is concrete (pick one runbook and convert one step to an automated check).

### Senior @ FAANG: Mistakes as a Risk Register and Organizational Debt

**The mistakes table is a risk register template.** At L6+, you maintain a risk register for your service that maps each known risk to a probability, an impact, and a mitigation status. The twelve mistakes in this table are the seed for a DR risk register. Assign each an assessment: is this mistake being made in our system? If yes, what is the likelihood this causes an incident in the next quarter? What is the user impact if it does?

**Untested backups are a governance failure.** The "correct approach" column says "run automated restore tests weekly." At a governance level, this means weekly restore tests must be tracked as a program requirement, not a team preference. Teams that do not run restore tests should be flagged in the DR compliance audit. The platform team provides the restore test framework, and each service team runs it against their own data source. At L7, you build the compliance dashboard that shows which services have passed their most recent restore test and which have not.

**Circuit breaker timeout calibration is an ongoing operational task.** The mistake says "calibrate timeout to p99 of downstream recovery." But P99 recovery time is not a static number: it changes as the downstream is scaled, refactored, or deployed with new dependencies. Circuit breaker timeouts that were correctly calibrated a year ago may now be wrong. At L6, you include circuit breaker recalibration as part of the quarterly reliability review: pull the P99 downstream recovery time from the last 90 days of incident data and verify that current timeouts remain appropriate.

**Blameless culture requires leadership modeling.** The last row says "postmortems explicitly forbid naming individuals as root cause." But a written policy is not sufficient. If a senior leader reacts to an incident postmortem by asking "who is responsible for this?", the policy is overridden by culture. At L7, blameless postmortem culture starts with you and other senior leaders visibly modeling the behavior in every postmortem you participate in. When a postmortem draft names an individual as root cause, you revise it to a systemic cause before distribution. Your public behavior sets the standard more effectively than any written policy.

**MTTR from first user impact requires synthetic monitoring.** The last mistake notes that MTTR should be measured from first user impact, not first alert. But you can only measure first user impact if you have synthetic monitors that simulate user behavior (synthetic transactions, healthcheck probes from external locations) that fire before users report problems. This requires investment in external monitoring infrastructure. At L6, you propose this investment by quantifying the benefit: "our current MTTD is 8 minutes from alert, but user impact typically starts 3-5 minutes before the alert. Reducing MTTD to 90 seconds via synthetic monitoring would save 4-5 minutes per incident, which at our incident frequency reduces annual MTTR by X hours."
