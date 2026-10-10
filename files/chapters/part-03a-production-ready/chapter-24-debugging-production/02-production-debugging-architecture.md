## Production Debugging Architecture

Debugging a production Go service requires correlating three distinct signal types, logs, traces, and profiles, because any one in isolation gives an incomplete picture. A slow request might be visible in Jaeger traces but only a CPU profile from pprof reveals whether the bottleneck is a hot lock, a GC pause, or an inefficient algorithm. The architecture below separates the observability layer (signal collection) from the application layer (instrumentation), so each concern can be scaled and replaced independently, for instance, swapping Jaeger for Tempo without touching the OpenTelemetry instrumentation code. The debugging workflow column on the right shows how these layers map to investigation phases: metrics for triage, logs for scoping, traces for isolating the faulty service, pprof for diagnosing root cause, and Delve for inspecting live state.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                        PRODUCTION DEBUGGING ARCHITECTURE                         │
└──────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────┐
│                              OBSERVABILITY LAYER                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                   │
│  │   Structured    │  │   Distributed   │  │   Continuous    │                   │
│  │     Logs        │  │     Traces      │  │    Profiling    │                   │
│  │   (JSON/OTLP)   │  │  (OpenTelemetry)│  │     (pprof)     │                   │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘                   │
│           │                    │                    │                            │
│           └────────────────────┼────────────────────┘                            │
│                                ▼                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                     CENTRALIZED DEBUGGING PLATFORM                      │     │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │     │
│  │  │    Log      │  │    Trace    │  │   Profile   │  │   Alert     │     │     │
│  │  │ Aggregation │  │   Analysis  │  │  Comparison │  │   Routing   │     │     │
│  │  │  (Loki)     │  │  (Jaeger)   │  │ (Pyroscope) │  │(PagerDuty)  │     │     │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘     │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────┐
│                           APPLICATION LAYER                                      │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │                         GO SERVICE                                       │    │
│  │                                                                          │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐           │    │
│  │  │  Debug Server   │  │   Runtime       │  │   Health        │           │    │
│  │  │  (:6060/debug)  │  │   Monitors      │  │   Checks        │           │    │
│  │  │                 │  │                 │  │                 │           │    │
│  │  │  • /pprof/*     │  │  • Goroutine    │  │  • Liveness     │           │    │
│  │  │  • /vars        │  │  • Memory       │  │  • Readiness    │           │    │
│  │  │  • /debug/info  │  │  • Deadlock     │  │  • Startup      │           │    │
│  │  │  • /goroutines  │  │  • Connection   │  │                 │           │    │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘           │    │
│  │                                                                          │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐ │    │
│  │  │                      INSTRUMENTATION                                │ │    │
│  │  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐         │ │    │
│  │  │  │  Tracing  │  │  Metrics  │  │  Logging  │  │ Profiling │         │ │    │
│  │  │  │Middleware │  │Middleware │  │Middleware │  │  Hooks    │         │ │    │
│  │  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘         │ │    │
│  │  └─────────────────────────────────────────────────────────────────────┘ │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────┐
│                          DEBUGGING WORKFLOW                                      │
│                                                                                  │
│    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐       │
│    │  Alert  │───►│ Triage  │───►│ Isolate │───►│Diagnose │───►│  Fix    │       │
│    │         │    │         │    │         │    │         │    │         │       │
│    │PagerDuty│    │ Symptoms│    │  Scope  │    │RootCause│    │ Deploy  │       │
│    │ Slack   │    │ Impact  │    │ Service │    │ Evidence│    │ Verify  │       │
│    └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘       │
│         │              │              │              │              │            │
│         ▼              ▼              ▼              ▼              ▼            │
│    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐       │
│    │ Metrics │    │  Logs   │    │ Traces  │    │ pprof   │    │ Delve   │       │
│    │Dashboard│    │ Query   │    │ Analysis│    │ Profile │    │ Debug   │       │
│    └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘       │
└──────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────┐
│                         DEBUG DATA FLOW                                          │
│                                                                                  │
│   Application                    Collectors                   Analysis           │
│                                                                                  │
│  ┌──────────┐     stdout      ┌───────────┐    push      ┌───────────┐           │
│  │   Log    │────────────────►│  Fluentd  │─────────────►│   Loki    │           │
│  │Statements│                 │  /Vector  │              │           │           │
│  └──────────┘                 └───────────┘              └───────────┘           │
│                                                                                  │
│  ┌──────────┐   OTLP/gRPC    ┌───────────┐    query     ┌───────────┐            │
│  │  Trace   │────────────────►│  OTEL     │─────────────►│  Jaeger   │           │
│  │  Spans   │                 │ Collector │              │  /Tempo   │           │
│  └──────────┘                 └───────────┘              └───────────┘           │
│                                                                                  │
│  ┌──────────┐    HTTP pull   ┌───────────┐    query     ┌───────────┐            │
│  │  pprof   │◄────────────────│ Pyroscope │◄────────────│  Grafana  │            │
│  │ Endpoints│                 │  Server   │              │           │           │
│  └──────────┘                 └───────────┘              └───────────┘           │
│                                                                                  │
│  ┌──────────┐   debug attach ┌───────────┐   connect    ┌───────────┐            │
│  │  Core    │────────────────►│  Delve    │◄────────────│ IDE/CLI   │            │
│  │  Dumps   │                 │  Server   │              │           │           │
│  └──────────┘                 └───────────┘              └───────────┘           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Staff Lens: Debugging Stack as Infrastructure

Every service should expose logs, metrics, traces, and pprof. This is infrastructure, not per-service choice. Standardize via shared library. Document the endpoints in runbooks.

---
