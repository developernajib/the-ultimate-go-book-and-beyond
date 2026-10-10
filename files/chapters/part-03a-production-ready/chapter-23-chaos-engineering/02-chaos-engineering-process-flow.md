## Chaos Engineering Process Flow

Every chaos experiment follows a structured lifecycle: you start by defining what "healthy" looks like, arm an abort condition that stops the run the moment health degrades, then inject a failure, observe how the system responds, and compare the result against your original hypothesis. Step 3 in the diagram is not optional. An experiment without a blast radius limit and an automatic rollback is not an experiment, it is an outage you scheduled yourself. The diagram also shows how the blast radius should expand gradually as you progress from development to production.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                    Chaos Engineering Experiment Lifecycle                        │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  1. HYPOTHESIS                 2. EXPERIMENT DESIGN                              │
│  ┌─────────────────┐          ┌─────────────────┐                                │
│  │ Define Steady   │          │ Choose Fault    │                                │
│  │ State Behavior  │─────────►│ Type to Inject  │                                │
│  │                 │          │                 │                                │
│  │ - Error rate    │          │ - Latency       │                                │
│  │ - Latency p99   │          │ - Errors        │                                │
│  │ - Throughput    │          │ - Partitions    │                                │
│  └─────────────────┘          │ - Resource      │                                │
│                               └────────┬────────┘                                │
│                                        │                                         │
│  3. SAFETY CONTROLS                    │     4. EXECUTE EXPERIMENT               │
│  ┌─────────────────┐                   │    ┌─────────────────┐                  │
│  │ Set Blast       │◄──────────────────┘    │ Inject Fault    │                  │
│  │ Radius Limits   │─────────────────────►  │ with Controls   │                  │
│  │                 │                        │                 │                  │
│  │ - % of traffic  │                        │ - Start small   │                  │
│  │ - Time limit    │                        │ - Monitor       │                  │
│  │ - Auto-rollback │                        │ - Scale up      │                  │
│  └─────────────────┘                        └────────┬────────┘                  │
│                                                      │                           │
│  5. OBSERVE                               6. VERIFY HYPOTHESIS                   │
│  ┌─────────────────┐                     ┌─────────────────┐                     │
│  │ Monitor System  │◄────────────────────│ Compare to      │                     │
│  │ Behavior        │                     │ Steady State    │                     │
│  │                 │                     │                 │                     │
│  │ - Dashboards    │─────────────────────►- Did system     │                     │
│  │ - Alerts        │                     │  maintain SLOs? │                     │
│  │ - Traces        │                     │- What degraded? │                     │
│  └─────────────────┘                     └────────┬────────┘                     │
│                                                   │                              │
│                              ┌────────────────────┴───────────────────┐          │
│                              ▼                                        ▼          │
│                    ┌─────────────────┐                     ┌─────────────────┐   │
│                    │    PASSED       │                     │    FAILED       │   │
│                    │ System resilient│                     │ Document issue  │   │
│                    │ as expected     │                     │ Create fix      │   │
│                    └─────────────────┘                     └─────────────────┘   │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘

Blast Radius Control:
┌───────────────────────────────────────────────────────────────────────────────┐
│                                                                               │
│    Development          Staging           Canary           Production         │
│   ┌──────────┐       ┌──────────┐      ┌──────────┐      ┌──────────┐         │
│   │ 100%     │       │ 100%     │      │ 1-5%     │      │ 10-25%   │         │
│   │ Traffic  │       │ Traffic  │      │ Traffic  │      │ Traffic  │         │
│   │ Full     │       │ Full     │      │ Gradual  │      │ Gradual  │         │
│   │ Faults   │       │ Faults   │      │ Rollout  │      │ Rollout  │         │
│   └──────────┘       └──────────┘      └──────────┘      └──────────┘         │
│        ▲                  ▲                 ▲                  ▲              │
│        │                  │                 │                  │              │
│   No impact          Limited impact    Monitored         Bounded impact       │
│   Fast iteration     Pre-production    Real traffic      Game Days            │
│                                                          Auto-abort armed     │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Staff Lens: Chaos Maturity Levels

Organizations progress from isolated dev chaos (level 1) to staging chaos (level 2) to limited production chaos (level 3) to full production chaos with auto-aborts (level 4). Most orgs plateau at level 2. Moving to 3 and 4 requires cultural buy-in plus safety infrastructure. Drive the progression deliberately.

---
