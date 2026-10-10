## 106.14 FinOps Implementation Frameworks

### Cost Optimization Checklist

This expanded checklist consolidates every cost lever covered in the chapter into a single actionable reference. The DATABASE section is new here: serverless databases (e.g., Aurora Serverless, Neon) can cut idle costs dramatically for variable-traffic workloads, while archiving cold data to object storage like S3 directly reduces both storage bills and query costs. Run through this checklist at each quarterly architecture review and treat unresolved items as technical debt with a measurable dollar value attached.

```
┌──────────────────────────────────────────────────────────────────┐
│              COST OPTIMIZATION CHECKLIST                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  INFRASTRUCTURE:                                                 │
│  □ Right-size pods based on actual usage                         │
│  □ Use Vertical Pod Autoscaler recommendations                   │
│  □ Implement Horizontal Pod Autoscaler                           │
│  □ Use spot/preemptible for non-critical workloads               │
│  □ Reserve capacity for predictable workloads                    │
│                                                                  │
│  GO APPLICATION:                                                 │
│  □ Use sync.Pool for frequent allocations                        │
│  □ Pre-allocate slices when size known                           │
│  □ Order struct fields for minimal padding                       │
│  □ Tune GOGC and GOMEMLIMIT based on workload                    │
│  □ Use connection pooling                                        │
│                                                                  │
│  DATABASE:                                                       │
│  □ Right-size database instances                                 │
│  □ Use connection pooling                                        │
│  □ Optimize queries (avoid N+1, use batching)                    │
│  □ Consider serverless for variable workloads                    │
│  □ Archive old data to cheaper storage                           │
│                                                                  │
│  MONITORING:                                                     │
│  □ Tag resources for cost allocation                             │
│  □ Track cost metrics per service                                │
│  □ Monitor external API costs                                    │
│  □ Set budget alerts at 50%, 80%, 100%                           │
│  □ Review unused resources weekly                                │
│                                                                  │
│  GOVERNANCE:                                                     │
│  □ Establish cost budgets per team                               │
│  □ Review resource requests in PRs                               │
│  □ Automate cost reporting                                       │
│  □ Include cost in architectural decisions                       │
│  □ Track unit economics (cost per transaction)                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Takeaways

1. **Measure before optimizing**: know your actual usage before making changes
2. **Go is already efficient**: use Go's low memory footprint and fast startup
3. **Right-size resources**: start small, scale up based on data
4. **Track unit economics**: understand cost per business transaction
5. **Automate governance**: budget alerts, regular reviews, cost in PRs
6. **Consider total cost**: include engineering time, not just cloud spend
7. **Balance trade-offs**: cost vs performance vs reliability is a triangle

### Junior → FAANG: The Seven Principles as Interview Preparation

Each principle above maps to a category of FAANG interview questions. "Measure before optimizing" maps to diagnostic and root-cause analysis questions. "Track unit economics" maps to system design questions that ask about cost modeling. "Automate governance" maps to platform engineering and DevOps questions. "Balance trade-offs" maps to the most common design question pattern: "This design is cheaper but slower. How do you decide?" Practice answering one interview question per principle before any observability or platform engineering interview.

### Senior @ FAANG: Cost-Aware Engineering as a Maturity Model

At L6, these seven principles define a cost maturity model for engineering organizations. A team at maturity level 1 practices "measure before optimizing" inconsistently. A team at maturity level 4 has automated governance and tracks unit economics as a first-class metric. A team at maturity level 7 considers total cost (including engineering time) in every architectural decision and treats the cost-performance-reliability triangle as a design constraint that must be explicitly documented in every ADR.

The senior engineer's role is to advance the team from their current maturity level to the next one, systematically. The progression from level 1 to level 7 typically takes 12-24 months for a team of 10-20 engineers and requires sustained investment in tooling, process, and cultural change. An L6 engineer who can articulate this progression, identify the current level, and drive the next step is demonstrating the strategic and organizational skill required for promotion to staff.

---

**Next Chapter: Application Security** covers the OWASP Top 10, secure coding practices, and Go security best practices.
