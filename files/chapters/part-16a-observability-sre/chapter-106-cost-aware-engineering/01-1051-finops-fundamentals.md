## 106.1 FinOps Fundamentals

### Cost Optimization Framework

FinOps treats cloud spend as a shared engineering and finance concern, structuring work into three iterative phases: first gaining full cost visibility through tagging and allocation, then actively reducing waste through right-sizing and reserved capacity, and finally embedding cost governance into continuous delivery workflows. Go services have a structural cost advantage over JVM- or Node-based equivalents: goroutines consume roughly 2-8 KB of stack versus megabytes per OS thread, and statically linked binaries run on scratch or distroless container images that eliminate layers of OS overhead. Without a deliberate tagging strategy applied at resource creation time, the Inform phase breaks down and cost anomalies become impossible to attribute to specific services or teams.

```
┌──────────────────────────────────────────────────────────────────┐
│                    FINOPS FRAMEWORK                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  THREE PHASES:                                                   │
│                                                                  │
│  1. INFORM                                                       │
│     ├── Cost visibility and allocation                           │
│     ├── Tagging strategy                                         │
│     └── Showback/chargeback                                      │
│                                                                  │
│  2. OPTIMIZE                                                     │
│     ├── Right-sizing resources                                   │
│     ├── Reserved capacity                                        │
│     ├── Spot/preemptible instances                               │
│     └── Application efficiency                                   │
│                                                                  │
│  3. OPERATE                                                      │
│     ├── Budget alerts                                            │
│     ├── Anomaly detection                                        │
│     ├── Continuous optimization                                  │
│     └── Cost governance                                          │
│                                                                  │
│  GO-SPECIFIC ADVANTAGES:                                         │
│  • Low memory footprint compared to JVM/Node                     │
│  • Fast startup (no cold start penalty)                          │
│  • Efficient concurrency (goroutines vs threads)                 │
│  • Small container images (scratch/distroless)                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: What the FinOps Framework Means in Practice

The FinOps three-phase cycle is not a one-time project. "Inform, Optimize, Operate" repeats continuously because new features, traffic growth, and infrastructure changes constantly shift the cost baseline. A junior engineer's contribution to the Inform phase is adding cost-relevant labels to every Kubernetes resource they deploy: `team`, `service`, `environment`, and `cost-center`. Missing even one label means that resource's cost cannot be attributed, and it falls into an "unallocated" bucket that gives management no actionable information.

For the interview context, know that Go's cost advantage over JVM services is not automatic. A Go service that allocates heavily in hot paths, causing frequent GC cycles, can use more CPU than an equivalent JVM service with a well-tuned GC configuration. The advantage is structural (small images, fast startup, low per-goroutine overhead) but requires deliberate programming to realize.

### Senior @ FAANG: Tagging Governance as a Platform Requirement

At L6, cost allocation tagging is not a best practice guideline. It is a platform requirement enforced by an admission controller. A Kubernetes admission webhook that rejects any Deployment, StatefulSet, or Job missing the required tag set (team, service, environment, cost-center) prevents the unallocated spend problem at the source rather than requiring quarterly audits to find and fix untagged resources. The webhook configuration is part of the platform team's baseline, applied to every cluster, and the tag schema is versioned and change-controlled.

The showback versus chargeback distinction matters organizationally. Showback provides cost visibility without financial consequences: teams see their spend but are not billed internally. Chargeback allocates costs to internal budgets, creating financial accountability. Most organizations start with showback because chargeback requires finance system integration and creates organizational friction. The transition from showback to chargeback is an organizational decision that should follow a period of showback visibility during which teams develop the tooling and habits needed to manage their budgets. Moving directly to chargeback without a showback phase creates panic and political resistance without giving teams the tools to respond.

---
