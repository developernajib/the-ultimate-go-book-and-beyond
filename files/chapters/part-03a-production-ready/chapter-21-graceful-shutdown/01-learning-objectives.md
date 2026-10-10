## Learning Objectives

By the end of this chapter, you will be able to:

1. **Handle Unix signals**: catch SIGINT, SIGTERM, and other signals appropriately
2. **Implement HTTP server shutdown**: use http.Server.Shutdown correctly
3. **Coordinate component shutdown**: manage shutdown order across multiple components
4. **Drain connections gracefully**: wait for in-flight requests to complete
5. **Handle Kubernetes termination**: integrate with pod lifecycle hooks
6. **Clean up resources**: close database connections, files, and caches
7. **Implement shutdown timeouts**: handle forced termination when needed
8. **Test shutdown behavior**: verify graceful shutdown works correctly
9. **Debug shutdown issues**: identify and fix common shutdown problems
10. **Build production-ready services**: implement complete shutdown patterns

The following diagram shows the four-phase shutdown sequence and the Kubernetes timeline that drives it. Each phase has a time budget, and exceeding the total `terminationGracePeriodSeconds` triggers a `SIGKILL` that terminates the process without cleanup.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    GRACEFUL SHUTDOWN SEQUENCE                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                        NORMAL OPERATION                                  │   │
│  │  • Accepting new connections                                             │   │
│  │  • Processing requests                                                   │   │
│  │  • Running background jobs                                               │   │
│  └────────────────────────────────┬─────────────────────────────────────────┘   │
│                                   │                                             │
│                          SIGTERM/SIGINT                                         │
│                                   │                                             │
│                                   ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 1: MARK UNHEALTHY (0-5s)                                           │   │
│  │  • Fail readiness probes                                                 │   │
│  │  • Load balancer removes pod from rotation                               │   │
│  │  • Stop accepting NEW connections                                        │   │
│  └────────────────────────────────┬─────────────────────────────────────────┘   │
│                                   │                                             │
│                                   ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 2: DRAIN CONNECTIONS (5-25s)                                       │   │
│  │  • Complete in-flight HTTP requests                                      │   │
│  │  • Finish processing current jobs                                        │   │
│  │  • Wait for database transactions to complete                            │   │
│  └────────────────────────────────┬─────────────────────────────────────────┘   │
│                                   │                                             │
│                                   ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 3: CLOSE RESOURCES (25-30s)                                        │   │
│  │  • Close database connections                                            │   │
│  │  • Flush metrics/logs                                                    │   │
│  │  • Close message queue connections                                       │   │
│  │  • Release file locks                                                    │   │
│  └────────────────────────────────┬─────────────────────────────────────────┘   │
│                                   │                                             │
│                                   ▼                                             │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 4: EXIT (30s)                                                      │   │
│  │  • Exit with code 0 (success)                                            │   │
│  │  • Or exit with error code if issues                                     │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  KUBERNETES TIMELINE:                                                           │
│  ├── T+0s:  SIGTERM received                                                    │
│  ├── T+0s:  Pod marked for termination                                          │
│  ├── T+0s:  Endpoints updated (async)                                           │
│  ├── T+5s:  Most LBs have removed pod                                           │
│  ├── T+30s: terminationGracePeriodSeconds expires                               │
│  └── T+30s: SIGKILL sent (forced termination)                                   │
│                                                                                 │
│  DEFAULT GRACE PERIODS:                                                         │
│  ├── Kubernetes: 30 seconds                                                     │
│  ├── Docker: 10 seconds                                                         │
│  └── Systemd: 90 seconds                                                        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Outcomes

**Mid-level engineer**

- Write a main function that handles SIGTERM, drains HTTP, exits cleanly.
- Use `signal.NotifyContext` for signal handling.
- Call `http.Server.Shutdown` with a bounded deadline.

**Senior engineer**

- Coordinate shutdown across multiple components in the correct order.
- Tune Kubernetes `terminationGracePeriodSeconds` to match the service's drain time.
- Test shutdown with real signals and verify no requests are dropped.

**Staff or Principal**

- Build the org's shutdown template and shared library.
- Enforce readiness gating during shutdown (service deregisters before shutting down).
- Own the graceful-shutdown production readiness check.

---
