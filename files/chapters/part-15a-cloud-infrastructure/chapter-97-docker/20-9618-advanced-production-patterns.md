## 97.20 Advanced Production Patterns

### Blue-Green Deployment with Docker

Blue-green deployment maintains two identical environments, blue (current production) and green (the new release), and switches traffic between them atomically via a load balancer configuration swap. This approach eliminates downtime during deployments and provides an instant rollback path: if the green release exhibits problems, the load balancer simply points back at the already-running blue environment without any container restarts.

```yaml
# docker-compose.blue-green.yml
services:
  # Blue environment (current production)
  app-blue:
    image: myapp:${BLUE_VERSION:-1.0.0}
    deploy:
      replicas: 2
    networks:
      - backend
    environment:
      - DEPLOYMENT=blue

  # Green environment (new version)
  app-green:
    image: myapp:${GREEN_VERSION:-1.1.0}
    deploy:
      replicas: 2
    networks:
      - backend
    environment:
      - DEPLOYMENT=green

  # Load balancer switches between blue and green
  nginx:
    image: nginx:1.29-alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx-${ACTIVE:-blue}.conf:/etc/nginx/nginx.conf:ro
    networks:
      - backend
    depends_on:
      - app-blue
      - app-green

networks:
  backend:
```

```bash
#!/bin/bash
# deploy.sh - Blue-green deployment script

CURRENT=$(docker compose ps --format json | jq -r '.[] | select(.Service=="nginx") | .Config.Volumes[0]' | grep -o 'blue\|green')
NEXT=$([[ "$CURRENT" == "blue" ]] && echo "green" || echo "blue")

echo "Current: $CURRENT, Next: $NEXT"

# Deploy new version to inactive environment
export ${NEXT^^}_VERSION=$NEW_VERSION
docker compose up -d app-$NEXT

# Wait for health checks
echo "Waiting for $NEXT to be healthy..."
sleep 30

# Switch traffic
export ACTIVE=$NEXT
docker compose up -d nginx

echo "Traffic switched to $NEXT"

# Optional: scale down old environment after verification
# docker compose scale app-$CURRENT=0
```

### Canary Releases

A canary release routes a small percentage of real traffic, typically 5-10%, to the new version while the stable version continues to serve the majority. Docker Compose implements this with weighted replica counts: nine stable replicas and one canary replica produce a natural 9:1 split through nginx's weighted round-robin upstream. Once confidence grows, the canary replica count increases incrementally until it fully replaces stable.

```yaml
# docker-compose.canary.yml
services:
  app-stable:
    image: myapp:stable
    deploy:
      replicas: 9  # 90% of traffic
    networks:
      - backend

  app-canary:
    image: myapp:canary
    deploy:
      replicas: 1  # 10% of traffic
    networks:
      - backend

  nginx:
    image: nginx:1.29-alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx-canary.conf:/etc/nginx/nginx.conf:ro
    networks:
      - backend
```

```nginx
# nginx-canary.conf
upstream backend {
    # Weighted round-robin for canary
    server app-stable:8080 weight=9;
    server app-canary:8080 weight=1;
}

server {
    listen 80;

    location / {
        proxy_pass http://backend;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }
}
```

### Circuit Breaker Pattern in Containers

In a containerized microservices architecture, a slow or failing downstream dependency can cascade into system-wide outages by exhausting the caller's goroutine pool or connection budget. The circuit breaker pattern addresses this by tracking consecutive failures and, once a threshold is crossed, short-circuiting calls immediately, returning an error without touching the dependency, until a reset timeout expires and a half-open probe confirms recovery.

```go
package circuitbreaker

import (
    "context"
    "errors"
    "sync"
    "time"
)

type State int

const (
    StateClosed State = iota
    StateOpen
    StateHalfOpen
)

type CircuitBreaker struct {
    mu              sync.RWMutex
    state           State
    failures        int
    successes       int
    lastFailure     time.Time

    // Configuration
    maxFailures     int
    resetTimeout    time.Duration
    halfOpenMax     int
}

func NewCircuitBreaker(maxFailures int, resetTimeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        state:        StateClosed,
        maxFailures:  maxFailures,
        resetTimeout: resetTimeout,
        halfOpenMax:  3,
    }
}

func (cb *CircuitBreaker) Execute(ctx context.Context, fn func(context.Context) error) error {
    if !cb.canExecute() {
        return errors.New("circuit breaker is open")
    }

    err := fn(ctx)
    cb.recordResult(err)
    return err
}

func (cb *CircuitBreaker) canExecute() bool {
    cb.mu.RLock()
    defer cb.mu.RUnlock()

    switch cb.state {
    case StateClosed:
        return true
    case StateOpen:
        if time.Since(cb.lastFailure) > cb.resetTimeout {
            cb.mu.RUnlock()
            cb.mu.Lock()
            cb.state = StateHalfOpen
            cb.mu.Unlock()
            cb.mu.RLock()
            return true
        }
        return false
    case StateHalfOpen:
        return cb.successes < cb.halfOpenMax
    }
    return false
}

func (cb *CircuitBreaker) recordResult(err error) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    if err != nil {
        cb.failures++
        cb.lastFailure = time.Now()

        if cb.failures >= cb.maxFailures {
            cb.state = StateOpen
        }
    } else {
        if cb.state == StateHalfOpen {
            cb.successes++
            if cb.successes >= cb.halfOpenMax {
                cb.state = StateClosed
                cb.failures = 0
                cb.successes = 0
            }
        }
    }
}

func (cb *CircuitBreaker) State() State {
    cb.mu.RLock()
    defer cb.mu.RUnlock()
    return cb.state
}
```

---

### Junior → FAANG: Production Patterns as Design Vocabulary

Blue-green deployments, circuit breakers, and health-check-driven traffic management are design patterns with specific use cases and tradeoffs. For junior engineers, the priority is understanding the problem each pattern solves before attempting to implement it.

Blue-green deployment solves the problem of instant rollback: you have two complete environments, traffic switches between them, and rollback is a traffic redirect rather than a redeploy. The cost is doubled infrastructure during the switch window. This trade-off is worth it for services where deployment risk is high and rollback time from a bad deployment is measured in minutes with traditional approaches.

Circuit breakers solve the problem of cascading failures. When a downstream service is slow or failing, requests pile up in the caller, its thread pool (goroutine pool) exhausts, and the failure propagates upstream. A circuit breaker stops calling a failing downstream service after a threshold of failures, returns an error immediately, and retries periodically to detect recovery. The key parameter to set correctly is the error threshold and the recovery probe interval.

### Senior @ FAANG: Production Resilience as a Platform Responsibility

At staff level, production resilience patterns are not implemented per service. They are built into the platform and enabled by default. A circuit breaker library that every team implements independently will have different parameters, different failure modes, and different observability. A platform-provided circuit breaker with standard configuration, standard metrics, and standard alerting is the correct solution.

The same principle applies to blue-green and canary deployments. In a Kubernetes environment, progressive delivery is implemented via Argo Rollouts, Flagger, or a similar platform-level controller that manages the traffic split, monitors SLO metrics, and triggers automatic rollback. The service team declares their rollout strategy in their deployment manifest. The platform controller implements it. This separates the concern of "how does progressive delivery work" (platform problem, solved once) from "what rollout strategy does my service use" (service team problem, configured per service).

The L6/L7 contribution to production resilience is designing the failure taxonomy. What failure modes exist for services in this platform? Which are handled automatically by the platform (node failure, pod crash)? Which require application-level handling (downstream service timeouts, database connection exhaustion)? Which require runbook-driven human intervention (data corruption, split-brain)? Answering these questions for the platform's service tier defines the resilience contract between the platform and the services that run on it.
