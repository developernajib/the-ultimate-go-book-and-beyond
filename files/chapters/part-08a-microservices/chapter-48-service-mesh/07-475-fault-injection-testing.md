## 48.5 Fault Injection Testing

### Testing with Istio Fault Injection

Istio can inject faults at the proxy level without any changes to application code. The `fault.delay` field adds artificial latency to a percentage of requests, simulating a slow dependency. The `fault.abort` field returns an HTTP error code for a percentage of requests, simulating a downstream outage. Both are configured via `VirtualService` resources (or `HTTPRoute` filter extensions in Gateway API deployments) and removed by deleting or updating the resource, with no redeployment required.

> **Do this in staging, not production.** Fault injection against real traffic almost always fails an SLO even when it catches a bug, because the percentage-based abort also hits users who are not part of any chaos experiment. Restrict the `match` clause to a header your load-generator sets (e.g. `x-chaos-experiment: enabled`), or run the experiment in a dedicated pre-prod environment with synthetic traffic that mirrors production patterns. Chaos engineering at FAANG scale (Netflix Chaos Monkey, Google DiRT) enforces this via scheduled windows and explicit service-owner opt-in. uncontrolled injection in production is how companies learn on-call's phone number by heart. In ambient mode, the waypoint proxy for the target namespace is what actually injects the fault - if no waypoint exists, L7 fault rules are silently ignored and you must add one.

```yaml
# istio/fault-injection.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: user-service-fault-test
spec:
  hosts:
  - user-service
  http:
  # Inject delays for 10% of requests
  - fault:
      delay:
        percentage:
          value: 10.0
        fixedDelay: 5s
    route:
    - destination:
        host: user-service
---
# Inject 503 errors for 5% of requests
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: user-service-error-test
spec:
  hosts:
  - user-service
  http:
  - fault:
      abort:
        percentage:
          value: 5.0
        httpStatus: 503
    route:
    - destination:
        host: user-service
```

### Chaos Testing in Go

For environments without Istio, or for finer-grained control over fault parameters at runtime, you can implement chaos injection directly in Go as HTTP middleware. The `ChaosMiddleware` below introduces random delays and error responses based on configurable percentages. A companion `ChaosController` exposes a JSON API to enable, disable, and tune fault parameters without restarting the service, which is useful in staging environments where you want operators to trigger chaos experiments on demand.

```go
package chaos

import (
    "encoding/json"
    "math/rand/v2"
    "net/http"
    "sync"
    "time"
)

// ChaosMiddleware injects faults for testing. The mutex matters: the
// controller mutates these fields at runtime while Handler reads them on
// every request, which is a data race without synchronization.
type ChaosMiddleware struct {
    mu           sync.RWMutex
    delayPercent float64
    delayMin     time.Duration
    delayMax     time.Duration
    errorPercent float64
    errorCode    int
    enabled      bool
}

func NewChaosMiddleware() *ChaosMiddleware {
    return &ChaosMiddleware{
        delayPercent: 0,
        delayMin:     100 * time.Millisecond,
        delayMax:     5 * time.Second,
        errorPercent: 0,
        errorCode:    503,
        enabled:      false,
    }
}

func (c *ChaosMiddleware) SetDelayFault(percent float64, min, max time.Duration) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.delayPercent = percent
    c.delayMin = min
    c.delayMax = max
}

func (c *ChaosMiddleware) SetErrorFault(percent float64, code int) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.errorPercent = percent
    c.errorCode = code
}

func (c *ChaosMiddleware) Enable() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.enabled = true
}

func (c *ChaosMiddleware) Disable() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.enabled = false
}

func (c *ChaosMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Snapshot the config under the read lock so a concurrent config
        // update cannot race with this request's decisions.
        c.mu.RLock()
        enabled := c.enabled
        delayPercent := c.delayPercent
        delayMin, delayMax := c.delayMin, c.delayMax
        errorPercent := c.errorPercent
        errorCode := c.errorCode
        c.mu.RUnlock()

        if !enabled {
            next.ServeHTTP(w, r)
            return
        }

        // Inject delay
        if rand.Float64()*100 < delayPercent {
            delay := delayMin + time.Duration(rand.Int64N(int64(delayMax-delayMin)))
            time.Sleep(delay)
        }

        // Inject error
        if rand.Float64()*100 < errorPercent {
            http.Error(w, "Chaos error injection", errorCode)
            return
        }

        next.ServeHTTP(w, r)
    })
}

// ChaosController for runtime control
type ChaosController struct {
    middleware *ChaosMiddleware
}

func (cc *ChaosController) ConfigHandler(w http.ResponseWriter, r *http.Request) {
    switch r.Method {
    case http.MethodPost:
        var config struct {
            Enabled      bool    `json:"enabled"`
            DelayPercent float64 `json:"delay_percent"`
            ErrorPercent float64 `json:"error_percent"`
        }
        json.NewDecoder(r.Body).Decode(&config)

        cc.middleware.SetDelayFault(config.DelayPercent, 100*time.Millisecond, 5*time.Second)
        cc.middleware.SetErrorFault(config.ErrorPercent, 503)

        if config.Enabled {
            cc.middleware.Enable()
        } else {
            cc.middleware.Disable()
        }

        w.WriteHeader(http.StatusOK)

    case http.MethodGet:
        cc.middleware.mu.RLock()
        resp := map[string]any{
            "enabled":       cc.middleware.enabled,
            "delay_percent": cc.middleware.delayPercent,
            "error_percent": cc.middleware.errorPercent,
        }
        cc.middleware.mu.RUnlock()
        json.NewEncoder(w).Encode(resp)
    }
}
```

### Junior → FAANG: Safe Fault Injection Habits from Day One

The most important rule for fault injection is also the simplest: never run an unscoped experiment. An unscoped experiment is one where you apply a fault to all traffic for a service, rather than to a specific subset identified by a header or a caller identity.

When you apply a `VirtualService` with `fault.delay` at 10% to all traffic for `user-service` in production, you are injecting that delay into real user requests. Even at 10%, if `user-service` handles ten thousand requests per second, one thousand users per second experience an artificial five-second delay. This fails SLOs, triggers alerts, and wakes up on-call.

The correct habit is to always scope fault injection to a synthetic header that only your load generator sets. The VirtualService `match` clause limits the fault to requests carrying `x-chaos-enabled: true`. Your load generator (k6, Gatling, wrk) sets this header. Real user traffic never sets it because your API gateway strips it at ingress.

For the Go-based `ChaosMiddleware`: in staging environments where you control all traffic, this middleware is a useful development tool because it lets you trigger faults without redeploying any Kubernetes resources. In production, prefer the Istio `VirtualService` approach because it is externally auditable, version-controlled, and can be reverted in under a second by a `kubectl apply` or `kubectl delete`.

First-job interview question: "How would you test that your service handles a slow dependency correctly?" The answer has three parts: write a unit test that mocks the dependency with an artificial delay and verifies the timeout behavior, deploy a staging environment with fault injection against the real dependency, and define a success criterion before starting the test (for example, error rate stays below 1% when dependency p99 is 5 seconds).

### Senior @ FAANG: Chaos Engineering Programs, Blast Radius Control, and Production Fault Injection Governance

**Chaos engineering as a program, not a feature.** At FAANG scale, fault injection is not something individual engineers do ad hoc. It is a governed program with service-owner opt-in, scheduled maintenance windows, defined blast radius, automated abort criteria, and post-experiment reports that feed into resilience planning. Netflix's Chaos Monkey, Google's DiRT (Disaster Recovery Testing), and AWS's GameDay exercises all share this structure. The key governance elements are:

- Service owner consent: no experiment runs against a service without explicit opt-in from the team that carries the pager.
- Blast radius definition: the experiment scope (which traffic percentage, which user cohort, which geographic region) is defined before the experiment, not discovered during it.
- Automated abort: the experiment controller monitors error rate and latency against pre-defined thresholds and terminates the experiment automatically if they are exceeded. Human approval is not in the critical path for abort.
- Blameless post-mortem: every experiment that causes an unexpected outcome feeds a resilience finding into the engineering backlog.

**Waypoint proxy requirement for L7 faults in ambient mode.** When a cluster runs Istio ambient mode and a team tries to apply a VirtualService with `fault.delay`, the fault is silently ignored if no waypoint proxy exists for the target namespace. This is a common gotcha during ambient mode adoption. The `istioctl analyze` command reports this as a warning: "VirtualService has L7 rules but no waypoint proxy is configured." The fix is either to deploy a waypoint or to accept that L7 fault injection is not available in ambient mode without it.

**Testing non-idempotent endpoints under fault conditions.** A critical resilience scenario that fault injection exposes: your service has a retry policy, and the downstream call is a database write that is not idempotent. Under normal conditions this is not a problem because the first call succeeds. Under fault conditions (connection failure mid-request), the mesh retries the call and the database receives the write twice. At FAANG scale, this produces duplicate orders, double charges, or inventory errors. The correct design is: either mark non-idempotent write endpoints as `retryOn: connect-failure` only (not `5xx`), or implement idempotency keys in the request so the downstream can detect and deduplicate retries. Fault injection testing in staging is the fastest way to surface this class of bug before it reaches production.

**Chaos experiments as confidence evidence for canary rollouts.** At the highest maturity level, fault injection and canary deployments are linked: before promoting a canary from 10% to 50%, run a fault injection experiment against the canary subset (scoped by the canary header) and verify that the canary handles the fault correctly. This proves that the new version is not just correct under normal load but also resilient under degraded conditions. Flagger supports this via pre-promotion analysis hooks that can trigger an external chaos experiment and gate promotion on the result.

---
