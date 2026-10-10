## Architecture Overview

The following architecture diagram shows how the disaster recovery components (backup engine, chaos framework, circuit breakers, and runbook automation) relate to each other and to the primary production system. Reading the diagram before studying each component prevents confusion about which layer owns recovery decisions and which layer executes them.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     DISASTER RECOVERY SYSTEM ARCHITECTURE                   │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                        PRIMARY REGION (us-east-1)                    │   │
│  │                                                                      │   │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────────────┐   │   │
│  │  │ Service A│   │ Service B│   │ Service C│   │   PostgreSQL     │   │   │
│  │  │ (active) │   │ (active) │   │ (active) │   │   Primary        │   │   │
│  │  └────┬─────┘   └────┬─────┘   └────┬─────┘   └────────┬─────────┘   │   │
│  │       │              │              │                   │ WAL Stream │   │
│  │  ┌────▼──────────────▼──────────────▼───────────────────▼─────────┐  │   │
│  │  │                    Internal Load Balancer                         ││  │
│  │  │              Circuit Breakers  │  Bulkheads                       ││  │
│  │  └──────────────────────────────┬──────────────────────────────────┘ │   │
│  └─────────────────────────────────┼────────────────────────────────────┘   │
│                                    │                                        │
│              ┌─────────────────────▼──────────────────────┐                 │
│              │           CHAOS ENGINEERING LAYER           │                │
│              │                                             │                │
│              │  ┌─────────────┐  ┌──────────────────────┐ │                 │
│              │  │  Chaos      │  │  Fault Injection:    │ │                 │
│              │  │  Scheduler  │  │  - Latency (p99)     │ │                 │
│              │  │             │  │  - Packet Drop       │ │                 │
│              │  │  Game Days  │  │  - Service Kill      │ │                 │
│              │  │  DR Tests   │  │  - CPU Spike         │ │                 │
│              │  └─────────────┘  └──────────────────────┘ │                 │
│              └──────────────────────────────────────────────┘               │
│                                    │                                        │
│              ┌─────────────────────▼──────────────────────┐                 │
│              │              REPLICATION PIPELINE           │                │
│              │                                             │                │
│              │  Full Backup → Incremental → WAL Shipping   │                │
│              │  RPO: 15min   RTO: 30min                    │                │
│              └──────────────────────────────────────────────┘               │
│                                    │                                        │
│  ┌─────────────────────────────────▼────────────────────────────────────┐   │
│  │                       DR REGION (us-west-2)                          │   │
│  │                                                                      │   │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────────────┐  │    │
│  │  │ Service A│   │ Service B│   │ Service C│   │   PostgreSQL     │   │   │
│  │  │ (standby)│   │ (standby)│   │ (standby)│   │   Replica        │  │    │
│  │  └──────────┘   └──────────┘   └──────────┘   └──────────────────┘  │    │
│  │                                                                      │   │
│  │  ┌────────────────────────────────────────────────────────────────┐  │   │
│  │  │              AUTOMATED FAILOVER ORCHESTRATOR                   │  │   │
│  │  │  Health Check → Decision → DNS Update → Service Promotion      │  │   │
│  │  └────────────────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    OBSERVABILITY & RUNBOOK ENGINE                    │   │
│  │                                                                      │   │
│  │  Alerts → Correlation → Runbook Lookup → Automated Remediation       │   │
│  │                       → Postmortem Generator                         │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Junior -> FAANG: Understanding DR Architecture as Layered Concerns

The DR system diagram shows four distinct layers: the primary region running the production services, a chaos engineering layer that injects faults, a replication pipeline that maintains the DR copy, and a DR region with an automated failover orchestrator. These layers must be understood independently before you can reason about how they interact during an actual incident.

The most important observation for interview preparation: the chaos engineering layer sits between the primary region and the replication pipeline. This means chaos experiments can affect both the primary services and the replication lag simultaneously. A chaos experiment that kills the primary's database not only stops serving requests but also stops WAL shipping to the DR region, widening the recovery point gap. Knowing this interaction is what separates a candidate who has thought through DR architecture from one who has only read about individual components.

For your first role: understand which layer of this diagram your team's on-call rotation covers. Many teams are responsible only for the primary region services and rely on a platform team for the replication pipeline and DR orchestrator. Knowing where your responsibility ends and another team's begins is essential for correct incident escalation.

### Senior @ FAANG: DR Architecture as a Multi-Team Governance Problem

**Layer ownership must be explicit.** The four layers in this diagram often have different owners. Platform/SRE owns the chaos engineering framework and the automated failover orchestrator. Database team owns the replication pipeline (WAL shipping, backup engine). Product engineering teams own the primary region services. When an incident crosses layer boundaries (primary service writes are failing, causing replication lag to grow, causing the DR orchestrator to trigger failover), it is unclear who leads the incident response. A staff engineer ensures each layer boundary has a documented owner and an escalation path before the incident happens, not during it.

**The observability and runbook engine is the integration layer.** The bottom of the diagram shows an observability and runbook engine that receives alerts from all other layers and correlates them into actionable remediations. This component is the most organizationally complex because it must understand the failure modes of all upstream layers to correlate alerts correctly. A false correlation (interpreting a replication lag spike as a primary failure) triggers an unnecessary failover, which is a form of user impact. A missed correlation (interpreting a primary failure as a temporary blip) delays failover beyond the RTO.

**DR region capacity planning.** The DR region must be sized to handle the primary region's full traffic load during failover, plus some headroom for the connection pool warm-up and cache miss period that follows promotion. At L6, you calculate this as: DR region capacity = primary region normal load * (1 + warmup_overhead_factor). The warmup overhead factor is empirically derived from DR test results and typically ranges from 15-40% for stateful services (due to cold caches and connection pool rebuilding). Without this calculation, DR failover causes a capacity-induced outage in the DR region immediately after promotion, defeating the purpose.

**The replication pipeline RPO budget.** The replication pipeline has an RPO budget: if WAL shipping is 10 seconds behind at the moment of primary failure, the DR region is 10 seconds behind in data. That 10 seconds is the RPO exposure. A principal engineer sizes the replication pipeline (throughput, network bandwidth, WAL retention) to keep the steady-state lag below the RPO budget with margin to spare. If the RPO budget is 5 seconds and steady-state lag is 4.5 seconds, a brief traffic spike can push lag above 5 seconds, violating the SLA. Size for the 99th percentile lag, not the average.
