## Learning Objectives

By the end of this chapter, you will:
- Understand the bulkhead pattern and how to size bulkhead limits correctly
- Implement timeout hierarchies and request deadline budgets
- Design services that degrade gracefully instead of failing completely
- Handle partial failures and return partial results safely
- Build fallback chains with multiple provider tiers
- Implement retry with full jitter to avoid thundering herd
- Apply load shedding under overload conditions
- Measure fault tolerance with error budgets and availability math

### Detailed Outcomes

**Senior engineer**

- Size bulkheads and timeouts with profile evidence.
- Design graceful degradation paths for every feature.
- Handle partial failures explicitly rather than propagating.
- Implement retry with full jitter and idempotency.

**Staff or Principal**

- Own the org's fault-tolerance standards across services.
- Drive chaos engineering as a regular practice.
- Measure and report availability metrics, aligned with business SLOs.
- Treat every production incident as a fault-tolerance improvement opportunity.

---
