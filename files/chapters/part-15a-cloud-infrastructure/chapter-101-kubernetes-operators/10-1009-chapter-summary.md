## 101.10 Mid-Chapter Synthesis: Operator Development Review

### Operator Development Checklist

Building a production-ready operator requires discipline across four distinct phases: design, implementation, hardening, and testing. Each phase has failure modes that only manifest under real cluster conditions, missing finalizers cause resource leaks on deletion, absent RBAC rules cause silent permission errors, and skipped leader election causes split-brain reconciliation in multi-replica deployments. Use this checklist as a gate before promoting an operator to a production cluster.

```
┌──────────────────────────────────────────────────────────────────┐
│                 OPERATOR DEVELOPMENT CHECKLIST                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  DESIGN:                                                         │
│  □ Define CRD schema (spec and status)                           │
│  □ Identify managed resources                                    │
│  □ Plan reconciliation logic                                     │
│  □ Consider edge cases (deletions, updates)                      │
│                                                                  │
│  IMPLEMENTATION:                                                 │
│  □ Implement API types                                           │
│  □ Write reconciliation logic                                    │
│  □ Add finalizers for cleanup                                    │
│  □ Set owner references                                          │
│  □ Update status correctly                                       │
│                                                                  │
│  PRODUCTION:                                                     │
│  □ Add RBAC rules                                                │
│  □ Enable leader election                                        │
│  □ Add health checks                                             │
│  □ Export metrics                                                │
│  □ Handle errors gracefully                                      │
│                                                                  │
│  TESTING:                                                        │
│  □ Unit tests with envtest                                       │
│  □ Integration tests                                             │
│  □ E2E tests in real cluster                                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Takeaways

1. **Operators encode operational knowledge** - Automate day-2 operations
2. **Reconciliation is idempotent** - Can be called multiple times safely
3. **Use owner references** - Automatic garbage collection
4. **Add finalizers for cleanup** - Handle external resources
5. **Status subresource** - Separate spec from observed state

---

### Junior → FAANG: Operator Knowledge as a Career Differentiator

Kubernetes operator development is a niche skill that is in high demand and relatively rare. Engineers who can build, test, and operate custom controllers are sought after for platform engineering roles at companies that run Kubernetes at scale. The investment in learning this chapter deeply is justified by the career leverage it provides.

The practical starting point: build the WebApp operator in this chapter end-to-end, test it with envtest, deploy it to a kind cluster, and add status conditions, metrics, and a webhook. This hands-on experience is the foundation that makes operator knowledge operational rather than theoretical.

### Senior @ FAANG: Operators as the Platform Engineering Superpower

At L6/L7, operators are the mechanism that encodes organizational operational knowledge into automated systems. The best operators in production at FAANG companies encode years of operational experience: they know when a database is approaching its connection limit and proactively scale the connection pool, they know which configuration changes require a rolling restart and handle that automatically, they know the safe upgrade sequence for a complex stateful system and execute it without human intervention.

Building this kind of operational intelligence into an operator requires deep domain expertise, rigorous testing of failure scenarios, and a strong feedback loop from production incidents. The staff engineer who builds these operators is not just writing code: they are encoding institutional knowledge into software that runs reliably at 3 AM without human intervention. That is the highest-value contribution a platform engineer can make, and it directly maps to the L6/L7 impact criteria at FAANG companies.
