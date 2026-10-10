## 90J.15 The Failed Migrations Playbook

Every migration disaster in this chapter - TSB, Hershey, Healthcare.gov - shares common patterns. This
playbook distills those patterns into actionable guidance for any migration, whether you are moving a
database, replacing an ERP system, or migrating millions of user accounts.

### Phase 1: Assessment (4-8 weeks before migration)

**1.1: Data Inventory**

Before migrating anything, create a complete inventory of what is being migrated:

- How many records/entities exist?
- What are the data formats and schemas in source and target?
- What are the referential integrity constraints?
- What data is time-sensitive (e.g., pending transactions, scheduled payments)?
- What data has external dependencies (e.g., third-party API references)?

**1.2: Dependency Mapping**

Map every integration point:

- What systems read from the data being migrated?
- What systems write to the data being migrated?
- What external systems depend on specific data formats or identifiers?
- What are the timing dependencies (e.g., batch jobs that run at specific times)?

**1.3: Rollback Planning**

Define the rollback plan before starting:

- Can you roll back to the original system? How long would it take?
- What data would be lost during rollback?
- What is the point of no return - after which rollback becomes impossible?
- Who has the authority to make the rollback decision?

**1.4: Risk Assessment**

For each risk, define:

- Probability (low/medium/high)
- Impact (low/medium/high/catastrophic)
- Detection method (how will we know this has happened?)
- Mitigation (how do we prevent it?)
- Response plan (what do we do if it happens?)

### Phase 2: Preparation (2-4 weeks before migration)

**2.1: Parallel Running**

Set up both systems to run in parallel:

- Write to both systems simultaneously
- Compare outputs continuously
- Measure discrepancy rates
- Do not cut over until discrepancy rate is below threshold

**2.2: Staged Migration**

Never migrate everything at once. Define migration waves:

- Wave 1: Low-risk, low-volume entities (test accounts, internal accounts)
- Wave 2: Low-risk, medium-volume entities
- Wave 3: Medium-risk entities with known good data quality
- Wave 4: High-volume entities
- Wave 5: High-risk entities (complex products, edge cases)

Between each wave:
- Validate every migrated record
- Run integration tests
- Check downstream systems
- Get sign-off before proceeding

**2.3: Communication Planning**

- Notify all stakeholders (internal and external)
- Prepare customer communication for success and failure scenarios
- Set up a dedicated war room with escalation paths
- Ensure 24/7 coverage during the migration window

### Phase 3: Execution

**3.1: Go/No-Go Checklist**

Before starting migration:

- [ ] All backups verified and tested
- [ ] Rollback procedure tested
- [ ] Monitoring and alerting configured
- [ ] Communication channels open
- [ ] War room staffed
- [ ] Downstream systems prepared
- [ ] Previous wave validated (if not Wave 1)
- [ ] Business sign-off obtained

**3.2: Migration Execution**

During migration:

- Monitor error rates in real-time
- Validate each batch before proceeding to the next
- Pause at predefined checkpoints for validation
- Maintain a running log of issues and decisions
- Have a clear threshold for triggering rollback

**3.3: Validation Checklist**

After each wave:

- [ ] Record counts match between source and target
- [ ] Critical fields validated for all records
- [ ] Referential integrity checks pass
- [ ] Integration tests pass for downstream systems
- [ ] Performance benchmarks met
- [ ] User acceptance testing complete

### Phase 4: Post-Migration

**4.1: Parallel Verification**

Run both systems in parallel for a defined period:

- Compare all outputs
- Monitor for discrepancies
- Do not decommission the old system until the parallel period passes

**4.2: Monitoring**

For at least 30 days post-migration:

- Monitor error rates, performance metrics, and user reports
- Compare KPIs against pre-migration baselines
- Watch for edge cases that were not covered in testing

**4.3: Lessons Learned**

Within two weeks of migration completion:

- Conduct a thorough retrospective
- Document what went well and what went wrong
- Update the playbook for the next migration

### Key Rules That Are Not Negotiable

1. **Never do a big bang migration** - always phase it.
2. **Always have a rollback plan** - if you cannot roll back, you cannot recover.
3. **Test with production data volumes** - small test datasets do not reveal scale issues.
4. **Validate every record** - sampling is not sufficient for critical data.
5. **Do not migrate during peak business periods** - Hershey learned this the hard way.
6. **Someone must own the integration** - Healthcare.gov's 55 contractors with no integrator is a recipe
   for disaster.

---

### Junior → FAANG: Using the Playbook as a Migration Interview Framework

The five-rule playbook in this section is a structured answer to the FAANG system design question "walk me through how you would migrate a production database with 100 million records." A complete answer hits every rule: no big bang (describe how you would phase by user cohort or region), rollback plan at every milestone (describe the specific rollback mechanism for each phase), production data volume testing (describe the load test environment and how you would validate performance), record-level validation (describe the reconciliation job that compares source and target), and no peak-season launches (describe how you would select the migration window). Behavioral questions about past migrations follow the same structure: describe the phase plan, the rollback gates, the validation approach, and what you would do differently if you encountered a failure at each phase. The playbook provides the complete vocabulary for these answers.

### Senior @ FAANG: Migration Governance as an Organizational Capability

At L6, the failed migrations playbook is not a team-level checklist, it is an organizational capability that must be consistently enforced across every migration in the company. The staff engineer's contribution is institutionalizing the playbook as a required artifact for any migration above a defined risk threshold (for example, any migration affecting more than 100,000 users or more than 10 GB of data). The institutionalization process has three parts. First, the playbook becomes a production readiness review gate: no migration proceeds without a completed playbook document reviewed by a senior engineer who was not involved in writing it. The reviewer's job is specifically to challenge the rollback plan ("have you actually tested this rollback?"), the validation approach ("what is your expected false-positive rate for the reconciliation job?"), and the launch window ("what is the traffic profile for that week, and why is this the lowest-risk week?"). Second, every completed migration produces a postmortem that evaluates actual performance against playbook predictions: did the migration complete within the estimated window, did any phase require rollback, were the reconciliation results within expected bounds? These postmortems are aggregated quarterly to identify which playbook rules are most frequently violated and to refine the playbook based on real migration experience. Third, the rollback plan must be tested before the migration executes. A rollback plan that has never been exercised is an untested backup, subject to the same failure modes as GitLab's five backup strategies. For any migration above the risk threshold, require a rollback drill in a staging environment as a precondition for production deployment.

---
