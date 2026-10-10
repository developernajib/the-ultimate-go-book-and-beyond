## 101.1 Operator Pattern Fundamentals

### What is an Operator?

An operator encodes the operational knowledge of a human administrator into software, letting Kubernetes manage stateful, complex applications the same way it manages stateless ones. The core insight is that the Kubernetes API is extensible: you register a new resource type (the Custom Resource) and a control loop (the Controller) that continuously drives the cluster toward the state declared in that resource. Unlike a plain Deployment, an operator can understand application-level semantics, it knows, for example, that a database replica must be initialized before it can accept traffic, or that a rolling upgrade requires a quorum of healthy nodes first.

```
┌──────────────────────────────────────────────────────────────────┐
│                   KUBERNETES OPERATOR PATTERN                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  DEFINITION:                                                     │
│  An operator is a method of packaging, deploying, and managing   │
│  a Kubernetes application using custom resources and custom      │
│  controllers.                                                    │
│                                                                  │
│  COMPONENTS:                                                     │
│  ┌────────────────┐    watches    ┌────────────────┐             │
│  │    Custom      │◄──────────────│   Controller   │             │
│  │   Resource     │               │                │             │
│  │    (CR)        │───────────────►│  Reconcile()  │             │
│  └────────────────┘    manages    └────────────────┘             │
│                                                                  │
│  THE RECONCILIATION LOOP:                                        │
│  1. Watch for changes to Custom Resources                        │
│  2. Compare desired state (spec) vs actual state (status)        │
│  3. Take action to reconcile the difference                      │
│  4. Update status to reflect current state                       │
│  5. Repeat                                                       │
│                                                                  │
│  USE CASES:                                                      │
│  ├── Database provisioning (MySQL, PostgreSQL operators)         │
│  ├── Application deployment (ArgoCD, Flux)                       │
│  ├── Certificate management (cert-manager)                       │
│  ├── Monitoring setup (Prometheus Operator)                      │
│  └── Backup management (Velero)                                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: The Reconcile Loop Pattern as the Core Mental Model

The reconcile loop is the only pattern in the operator framework. Every operator, regardless of complexity, implements the same structure: get the resource, check if the desired state matches the actual state, take action to reconcile the difference, return a result (done, requeue immediately, requeue after a delay). Internalizing this pattern makes all operator code predictable.

The idempotency requirement is the hardest constraint to satisfy correctly. The reconcile function can be called any number of times with the same input and must always produce the correct result. This means: use `CreateOrUpdate` instead of `Create` (which fails if the resource already exists), check before deleting (the resource may have already been deleted by another controller), and use conditions to track the reconcile state rather than assuming linear progression.

First-job habit: when debugging an operator that is not working as expected, add structured logging at the start and end of every significant code path in the reconcile function. The reconcile loop's behavior is only visible through logs when something goes wrong.

### Senior @ FAANG: Operator Maturity and the Capability Model

At staff level, the operator pattern is evaluated against a capability model. The Operator Framework defines capability levels from Level 1 (basic install) to Level 5 (auto-pilot). Each level adds capabilities: Level 2 adds upgrade management, Level 3 adds full lifecycle management (backup, recovery), Level 4 adds deep insights (metrics, alerts, log integration), Level 5 adds horizontal scaling, auto-tuning, and abnormality detection.

Most operators produced by engineering teams reach Level 2-3. The gap between Level 3 and Level 5 represents significant engineering investment in operational intelligence: the operator needs to understand when the resource it manages is underperforming and take corrective action autonomously. This is machine learning territory and requires both the ML capability and the deep domain knowledge of the managed resource's behavior. Very few operators in the wild reach Level 5.

The staff engineer's role in operator development is to define which capability level is required for the problem being solved, to make the case for the investment required to reach that level, and to set the standards for the operator's test coverage, observability, and upgrade procedures. An operator that is deployed to production without comprehensive tests, meaningful status conditions, and a documented upgrade process is technical debt that will cause incidents.
