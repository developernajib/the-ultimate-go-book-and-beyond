## 105.1 SRE Fundamentals

### The SRE Approach

SRE reframes operations as a software engineering discipline, replacing vague uptime goals with mathematically defined SLOs that directly govern release velocity through error budgets. The deliberate acceptance of a non-zero error rate, rather than chasing 100% availability, allows teams to balance reliability investments against feature work using objective data. SLIs are the raw measurements (latency, error rate, throughput), SLOs are the targets applied to those measurements, and SLAs are the contractual consequences that sit above both. Conflating them leads to misaligned incentives and incorrect alerting thresholds.

```
┌──────────────────────────────────────────────────────────────────┐
│                     SRE FUNDAMENTALS                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  CORE PRINCIPLES:                                                │
│  ├── Embrace risk (100% reliability is wrong target)             │
│  ├── Service Level Objectives (SLOs) drive decisions             │
│  ├── Eliminate toil through automation                           │
│  ├── Monitor for symptoms, not causes                            │
│  └── Practice blameless post-mortems                             │
│                                                                  │
│  THE RELIABILITY HIERARCHY:                                      │
│                                                                  │
│              ┌─────────────────┐                                 │
│              │   Reliability   │                                 │
│              └────────┬────────┘                                 │
│                       │                                          │
│         ┌─────────────┼─────────────┐                            │
│         ▼             ▼             ▼                            │
│    ┌─────────┐  ┌─────────┐  ┌─────────┐                         │
│    │  SLAs   │  │  SLOs   │  │  SLIs   │                         │
│    │(promise)│  │(target) │  │(measure)│                         │
│    └─────────┘  └─────────┘  └─────────┘                         │
│                                                                  │
│  SLI: Service Level Indicator (measurement)                      │
│       "What we measure: request latency, error rate"             │
│                                                                  │
│  SLO: Service Level Objective (target)                           │
│       "99.9% of requests complete in < 200ms"                    │
│                                                                  │
│  SLA: Service Level Agreement (contract)                         │
│       "If we breach, customer gets credits"                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: SLI, SLO, SLA Hierarchy in Interviews

The SLI/SLO/SLA hierarchy is the most commonly tested SRE concept in FAANG interviews. Understand the direction of the contract: SLI is the measurement, SLO is the internal target, SLA is the external commitment. The SLO must be stricter than the SLA to give engineering a buffer: if the SLA is 99.9%, the SLO should be 99.95%, so the team has early warning before breaching the customer commitment.

Interview entry point: "If your service has a 99.9% SLA, what SLO would you set and why?" Answer: 99.95%, because this gives a 50% safety margin. If the SLO fires at 99.95%, engineering has time to remediate before the SLA at 99.9% is breached. Setting SLO = SLA means the first SLO alert is also a contractual breach.

### Senior @ FAANG: SLO as a Product Requirement, Not Just an Engineering Constraint

At L6, SLOs are negotiated with product managers and business stakeholders, not set unilaterally by engineering. The SLO negotiation process requires three inputs: the historical reliability data (what has the service actually achieved), the cost of improving reliability by one nine (what engineering investment is required), and the business impact of reliability at each target (what is the revenue impact of 99.9% vs. 99.99% availability).

An L6 engineer comes to the SLO negotiation with all three inputs and a recommendation. The recommendation is not always "maximize availability": for an internal service with no customer SLA, a 99.5% SLO may be entirely appropriate and significantly cheaper to operate than 99.9%. The ability to make this case with data is what distinguishes a senior engineer's SLO work from a junior engineer's.

---
