## Section 13: Integrated DR System - Putting It Together

This section assembles the backup engine, chaos framework, circuit breakers, bulkheads, runbook automation, and game day harness from the previous sections into a cohesive disaster recovery system that can be deployed and tested as a unit. Understanding how these components compose (particularly the sequencing of failover decisions and the priority of competing recovery actions) is the key takeaway from this chapter.

```go
// file: cmd/dr-controller/main.go
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/app/internal/dr/failover"
	"github.com/example/app/internal/dr/sla"
	"github.com/example/app/internal/resilience"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Register SLA contracts.
	registry := sla.NewSLARegistry(logger)
	_ = registry.Register(sla.SLAContract{
		ServiceName:  "payment-service",
		ServiceTier:  sla.TierCritical,
		RTO:          1 * time.Minute,
		RPO:          0,
		Availability: 0.9999,
		Owner:        "payments-team",
	})
	_ = registry.Register(sla.SLAContract{
		ServiceName:  "order-service",
		ServiceTier:  sla.TierHigh,
		RTO:          15 * time.Minute,
		RPO:          5 * time.Minute,
		Availability: 0.999,
		Owner:        "orders-team",
	})

	// Circuit breaker for payment service downstream.
	paymentCB := resilience.NewCircuitBreaker[[]byte](
		resilience.CircuitBreakerConfig{
			Name:             "payment-processor",
			FailureThreshold: 5,
			SuccessThreshold: 2,
			Timeout:          30 * time.Second,
			MaxHalfOpenCalls: 3,
		},
		logger,
	)
	_ = paymentCB // wire into HTTP client

	// Bulkhead for database connections.
	dbBulkhead := resilience.NewBulkhead(
		resilience.BulkheadConfig{
			Name:          "postgres-primary",
			MaxConcurrent: 50,
			MaxQueueSize:  100,
			QueueTimeout:  5 * time.Second,
		},
		logger,
	)
	_ = dbBulkhead // wire into DB layer

	// Failover orchestrator.
	orchCfg := failover.FailoverConfig{
		PrimaryRegion:     "us-east-1",
		StandbyRegions:    []failover.Region{"us-west-2", "eu-west-1"},
		CheckInterval:     10 * time.Second,
		FailureThreshold:  3,
		MaxReplicationLag: 30 * time.Second,
	}

	// In production: wire real health checker, DNS updater, promoter, lag checker.
	// Here we show the wiring pattern.
	logger.Info("DR controller starting",
		"primary_region", orchCfg.PrimaryRegion,
		"standby_regions", orchCfg.StandbyRegions,
	)

	<-ctx.Done()
	logger.Info("DR controller shutdown complete")
}
```

---

### Junior -> FAANG: Reading Integration Code as a System Map

The integrated DR system bootstrap is the same type of reading exercise as `main.go` in the multi-region architecture chapter: it is a compressed dependency graph of the entire DR capability. Reading it teaches which components must be started before which others, which ones run as background goroutines, and which ones are connected to which.

The key observation for your first role: the DR system is not a separate application deployed alongside your service. It is a set of components (backup engine, circuit breakers, failover orchestrator, runbook engine) that are wired into your service's own lifecycle. When you write a new service, you are responsible for integrating these DR components, not leaving them as "platform concerns" that someone else handles.

A practical takeaway: the next time you create a new service, add a `/dr/status` endpoint that returns the current state of all DR components (backup age, circuit breaker states, health scores). This endpoint is the first thing an on-call engineer will query during an incident involving your service.

### Senior @ FAANG: Integrated DR as an Architecture Audit Framework

**Component integration sequencing is a correctness requirement.** The DR system bootstrap starts the backup engine before the failover controller, and starts the circuit breakers before the runbook engine. This ordering is not arbitrary: the failover controller needs valid backup metadata to choose a promotion target, and the runbook engine needs circuit breaker state to make decisions. A principal engineer documents the initialization dependency graph alongside the startup code.

**The "putting it together" section is the integration test specification.** Every component in the integrated system should have an integration test that uses the wired-up system, not mocks. The integration test starts the full DR system (using in-memory stubs for external dependencies), injects a specific failure scenario, and verifies that the correct DR actions are triggered in the correct order. These tests are slower than unit tests but provide confidence that the components actually compose correctly when wired together in production.

**Configuration management for the integrated system.** Each component has its own configuration parameters (backup interval, circuit breaker threshold, health check interval). In the integrated system, some of these parameters have dependencies: the runbook engine's detection timeout must be shorter than the circuit breaker's open threshold, or the runbook might fire before the circuit breaker protects the downstream. A staff engineer documents the parameter dependencies between components and implements validation at startup that checks these cross-component constraints.

**Graceful shutdown ordering and data safety.** The integrated system shutdown sequence must preserve data safety. The backup engine should complete its current backup before shutting down. The replication engine should flush its pending events before closing. The failover controller should not trigger new failovers during shutdown. The shutdown sequence in the integrated system should be the reverse of the startup sequence, with each component given a configurable timeout to drain cleanly. If a component does not drain within its timeout, it is force-stopped with a log entry explaining the forced stop.

**Platform versus application responsibilities.** Some DR components (the SLA registry, the observability correlator, the GameDay framework) are platform concerns that are maintained by a central team and consumed by all services. Some components (the backup engine for a specific data source, the circuit breakers for specific downstreams) are service-specific and maintained by the service team. A principal engineer defines this boundary clearly in the team's service ownership documentation so that there is no ambiguity about who is responsible for each component during an incident.

