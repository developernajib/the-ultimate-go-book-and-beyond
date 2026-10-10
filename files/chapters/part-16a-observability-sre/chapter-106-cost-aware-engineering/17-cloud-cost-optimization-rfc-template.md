## Production RFC: Cloud Cost Optimization and FinOps Architecture

A complete, production-grade Architecture Request for Comments (RFC) ready to present to engineering leadership, directors, and finance stakeholders.

---

### Executive summary


Current monthly cloud spend: $50,000
Identified savings opportunity: $15,000 (30%)
Implementation effort: 2 sprints (4 weeks)
Expected ROI: $180,000/year savings with $20,000 implementation cost

### Junior → FAANG: The Executive Summary Format Is the Entire Point

When writing to leadership, the format above (current state, identified opportunity, implementation cost, ROI) is the correct structure. Executives do not need implementation details in the summary. They need the business case. Put technical details in appendices. Practice writing cost proposals in this format even for small optimizations: it builds the communication habit that becomes essential at senior levels.

### Senior @ FAANG: The ROI Calculation Must Include Opportunity Cost

At L6, the implementation cost in a cost proposal includes not just engineering labor but opportunity cost: two sprints of two engineers is not just $20K in labor but two sprints of feature work that was not delivered. The proposal must acknowledge this trade-off explicitly and justify the prioritization: "Accepting this opportunity cost is rational because the $180K annual savings exceed the expected revenue value of two sprints of feature work at our current growth stage." When leadership approves this proposal, they are making an explicit prioritization decision, not just approving engineering work.


---

### Current state analysis


| Category | Monthly Cost | % of Total |
|----------|-------------|------------|
| Compute (EC2/GKE) | $25,000 | 50% |
| Database (RDS/Cloud SQL) | $12,000 | 24% |
| Storage (S3/GCS) | $5,000 | 10% |
| Network (Egress) | $4,000 | 8% |
| Other | $4,000 | 8% |

Key Findings:
- Average compute utilization: 28%
- 40% of instances are oversized
- No autoscaling on 60% of services
- Zero reserved capacity purchased
- Development environments run 24/7

### Junior → FAANG: The Cost Breakdown Table Is the Inform Phase Deliverable

The table above is the output of the Inform phase in the FinOps framework. Without this breakdown, optimization efforts are directionless. With it, the priority is clear: compute at 50% of spend with 28% average utilization is the dominant optimization opportunity. Knowing that 60% of services have no autoscaling explains the low utilization: services are sized for peak traffic and pay for that capacity 24/7.

### Senior @ FAANG: Dev Environment Cost Is Often the Easiest Win

Development environments that run 24/7 are a common source of waste that is easy to address. Schedule-based scaling (scale dev environments to 0 replicas outside business hours using Kubernetes CronJobs) typically reduces dev environment cost by 60-70% with no impact on development velocity. At $50K/month total spend, dev environments often represent 15-20% of total cost, making this a high-priority quick win that requires zero code changes and minimal risk.


---

### Proposed optimizations


### Phase 1: Quick Wins (Week 1-2), $7,000/month savings

| Action | Savings | Risk | Effort |
|--------|---------|------|--------|
| Shut down dev envs overnight | $2,000 | Low | 2 days |
| Delete unused resources | $1,500 | Low | 1 day |
| Right-size oversized instances | $2,500 | Low | 3 days |
| Enable autoscaling | $1,000 | Low | 2 days |

### Phase 2: Infrastructure Changes (Week 3-4), $5,000/month savings

| Action | Savings | Risk | Effort |
|--------|---------|------|--------|
| Reserved capacity (1-year) | $3,500 | Low | 1 day |
| Spot instances for stateless | $1,000 | Medium | 3 days |
| Database right-sizing | $500 | Medium | 2 days |

### Phase 3: Architecture (Future), $3,000/month savings

| Action | Savings | Risk | Effort |
|--------|---------|------|--------|
| Serverless for batch jobs | $1,500 | Medium | 2 weeks |
| CDN for static content | $1,000 | Low | 1 week |
| Data archival to cold storage | $500 | Low | 1 week |

### Junior → FAANG: The Phased Approach Reduces Risk and Builds Confidence

The three-phase optimization structure (quick wins, infrastructure changes, architecture) is the correct sequencing for risk management. Phase 1 actions are reversible and low-risk: if shutting down dev environments overnight breaks a nightly integration test run, the fix is to add an exception for the test environment. Phase 2 reserved capacity is a financial commitment that should be made only after Phase 1 confirms the service's steady-state resource consumption, because right-sizing before committing prevents over-purchasing reserved capacity. Phase 3 architecture changes are highest-risk because they change service behavior and require more extensive testing.

### Senior @ FAANG: Phased Optimization Programs Need a Governance Owner

At L6, a phased optimization program requires a named owner who is accountable for delivering each phase on schedule and reporting progress to leadership. Without a named owner, optimization initiatives stall after Phase 1 quick wins because the urgency dissipates once the most visible waste is eliminated. The owner's responsibilities include: tracking actual savings against projected savings week-over-week, escalating blockers (e.g., a team that resists having their dev environment scaled down), and updating the proposal if actual savings deviate significantly from projections. This governance role is distinct from the engineering execution role and is often overlooked in cost optimization planning.


---

### Risk mitigation


- All changes will be tested in staging first
- Rollback procedures documented for each change
- Monitoring alerts for performance impact
- Gradual rollout (10% → 50% → 100%)

### Junior → FAANG: Risk Mitigation Must Be Specific, Not Generic

Generic risk mitigation statements ("tested in staging, rollback documented") are not credible to experienced engineers without specifics. For right-sizing: what metric indicates a problem (CPU throttling alerts, latency p99 increase above threshold)? What is the rollback procedure (revert the resource request PR)? What is the observation period before declaring success (one full traffic cycle, typically one week)? Specific risk mitigations demonstrate that you have thought through the failure modes.

### Senior @ FAANG: Cost Change Rollouts Require Reliability Checkpoints

At L6, every infrastructure change that affects resource allocation (right-sizing, autoscaling configuration, Spot instance migration) requires a reliability checkpoint after each phase. The checkpoint criteria are: no increase in error rate (SLO fast-burn alert did not fire), no increase in p99 latency above the SLO threshold, and no increase in OOMKill events. If any checkpoint fails, the rollout pauses and the team investigates before proceeding. This checkpoint process is part of the written rollout plan, not an informal check by the engineer who made the change.


---

### Implementation plan


Week 1:
- Audit all resources, document unused
- Implement dev environment scheduling
- Right-size 5 highest-cost services

Week 2:
- Enable autoscaling on remaining services
- Delete confirmed unused resources

Week 3-4:
- Purchase reserved capacity for stable workloads
- Implement spot instances with fallback
- Database optimization
- Set up ongoing cost monitoring

### Junior → FAANG: Implementation Plans Are Communication Documents

An implementation plan is not a personal task list. It is a communication document that tells stakeholders when they will see results and who is responsible for each action. Absent from the plan above: named owners for each action, acceptance criteria for "done," and the cost monitoring dashboard URL where leadership can track progress. Add these before presenting any implementation plan to leadership.

### Senior @ FAANG: The Monitoring Setup Is the Most Important Week

Week 3-4's "set up ongoing cost monitoring" is the most important item in the implementation plan, despite appearing last. Without ongoing monitoring, the cost savings achieved in weeks 1-2 will erode as new features are deployed, traffic grows, and engineering teams revert to their default behaviors (over-provisioning, no autoscaling). The monitoring system is what converts a one-time cleanup into a sustained FinOps practice. At L6, the monitoring setup should be the first deliverable, not the last: deploy the cost dashboards in week 1 so the team can see the current baseline, track the week-over-week savings from each optimization action, and have a dashboard ready to show leadership before the first sprint review.


---

### Success metrics


- Monthly cloud spend reduced to $35,000
- No increase in error rates or latency
- Cost alerts and dashboards operational
- Unit economics tracked per service

### Junior → FAANG: Success Metrics Must Be Measurable Before the Project Starts

Each success metric above needs a measurement method specified before the project begins. "Monthly cloud spend reduced to $35,000" requires agreement on which billing dashboard or API will be used to measure. "No increase in error rates or latency" requires a baseline measurement of current p99 latency and error rate, and a definition of "increase" (more than 5% above baseline for more than 1 hour). Without pre-specified measurement methods, success is debatable at the end of the project.

### Senior @ FAANG: Success Metrics Drive the Go/No-Go Decision at Each Phase

At L6, success metrics are the go/no-go criteria for each phase of the implementation plan. Before advancing from Phase 1 (quick wins) to Phase 2 (infrastructure changes), verify: actual savings from Phase 1 are within 20% of projected savings, no reliability regressions have been observed, and cost dashboards are operational. This gate prevents the common failure mode where Phase 1 savings are lower than projected but the team proceeds to Phase 2 anyway, compounding the estimation error and eroding leadership trust in the initiative.


---

### Resource request


- 2 engineers for 4 weeks (50% allocation)
- Platform team support for reserved capacity purchase
- Finance approval for 1-year commitments

### Junior → FAANG: Resource Requests Must Justify the Return

The ROI from the executive summary ($180K annual savings, $20K implementation cost) is the justification for the resource request. Always connect the resource request to the ROI explicitly: "We are requesting 2 engineers for 4 weeks at 50% allocation (approximately 160 engineer-hours) to deliver $180K in annual savings, which represents a 9x return on the engineering investment in the first year alone."

### Senior @ FAANG: Reserved Capacity Requires Financial Governance Coordination

At L6, the finance approval for 1-year reserved capacity commitments is not just a sign-off. It requires coordination with the company's annual budget cycle, cash flow planning, and accounting treatment (reserved instances may be capitalized as prepaid assets rather than expensed monthly). The senior engineer who understands these financial mechanics can navigate the approval process faster and build stronger relationships with finance partners than one who treats "get finance approval" as a black box step.


---

### Appendix detailed cost breakdown


[Include detailed service-by-service analysis]

### Junior → FAANG: The Appendix Is for Engineers, the Summary Is for Leadership

The appendix pattern (high-level executive summary at the top, detailed analysis available for those who want it) is the correct structure for any technical document written for a mixed audience. Leadership reads the summary. Engineers read the appendix. Writing a document that leads with detailed analysis loses leadership attention in the first paragraph.

### Senior @ FAANG: The Appendix Data Must Be Kept Current

At L6, the appendix data in a cost proposal becomes stale within weeks as traffic changes, new services are deployed, and optimization actions are implemented. The appendix should reference a live dashboard rather than static data wherever possible: "See the Kubecost dashboard at [link] for the current service-by-service cost breakdown." Static data in appendices leads to proposals being rejected because the numbers no longer match what leadership sees in the billing console.

---
