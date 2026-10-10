## 47.5 API Gateway

### The gateway's job (and what it is not)

An API gateway terminates external traffic at the edge of your system and handles strictly *cross-cutting* concerns: TLS termination, per-request authentication and authorization, rate limiting and quotas, request/response transformation, retries and timeouts, observability (access logs, metrics, traces), and routing to the correct internal service. It is explicitly *not* a place for business logic. The moment your gateway "enriches" responses by calling three services and merging the results, it has become a backend-for-frontend (BFF), which is a legitimate pattern but deserves its own repo, its own tests, and its own deploy cadence - do not smuggle BFF logic into a shared edge gateway.

**What to use in 2026.** For most teams the pragmatic answer is not "write your own" but "run Envoy, Kong, or Traefik and configure it":

- **Envoy Gateway** - the reference Kubernetes Gateway API implementation, xDS-native, the canonical choice when you are already on Envoy/Istio or want a future-proof mesh path. Dynamic configuration reloads with zero request drops.
- **Kong Gateway** - plugin ecosystem is unmatched (OIDC, mTLS, key-auth, quota, transformation, WAF). Good choice when you need many pre-built edge behaviors and don't want to write them.
- **Traefik** - easiest operator experience, excellent auto-discovery for Docker/Kubernetes, strong default for smaller fleets.
- **Cloud-managed** - AWS API Gateway, GCP API Gateway, Azure APIM - skip the operations tax if you're on one cloud and don't need portability.

Writing your own gateway in Go (as below) is justified for embedded use cases, niche protocol translation, or as a learning exercise. The implementation below is educational. For production, prefer the off-the-shelf options.

### Gateway Implementation

The API gateway is the single entry point for all external traffic, centralizing cross-cutting concerns (authentication, rate limiting, and request routing) so individual services remain unaware of them. In Go, the gateway is built as a composition of `http.Handler` middleware functions, making it straightforward to add or reorder concerns without modifying routing logic. Route configuration maps URL prefixes to upstream service addresses, and the reverse proxy strips the gateway prefix before forwarding, maintaining clean API contracts for both clients and backend services.

```go
package gateway

import (
    "context"
    "fmt"
    "net/http"
    "net/http/httputil"
    "net/url"
    "strings"
    "time"
)

// Gateway routes requests to backend services
type Gateway struct {
    registry ServiceRegistry
    routes   map[string]*Route
    lb       LoadBalancer
}

type Route struct {
    PathPrefix  string
    ServiceName string
    StripPrefix bool
    Middleware  []Middleware
}

type Middleware func(http.Handler) http.Handler

func NewGateway(registry ServiceRegistry) *Gateway {
    return &Gateway{
        registry: registry,
        routes:   make(map[string]*Route),
        lb:       NewRoundRobinLB(),
    }
}

func (g *Gateway) AddRoute(route *Route) {
    g.routes[route.PathPrefix] = route
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Find matching route
    var matchedRoute *Route
    for prefix, route := range g.routes {
        if strings.HasPrefix(r.URL.Path, prefix) {
            matchedRoute = route
            break
        }
    }

    if matchedRoute == nil {
        http.NotFound(w, r)
        return
    }

    // Get service instances
    instances, err := g.registry.GetInstances(matchedRoute.ServiceName)
    if err != nil || len(instances) == 0 {
        http.Error(w, "Service unavailable", http.StatusServiceUnavailable)
        return
    }

    // Select instance
    g.lb.Update(instances)
    instance := g.lb.Next()
    if instance == nil {
        http.Error(w, "No available instances", http.StatusServiceUnavailable)
        return
    }

    // Create reverse proxy
    target := &url.URL{
        Scheme: "http",
        Host:   fmt.Sprintf("%s:%d", instance.Address, instance.Port),
    }

    proxy := httputil.NewSingleHostReverseProxy(target)

    // Modify request
    originalDirector := proxy.Director
    proxy.Director = func(req *http.Request) {
        originalDirector(req)

        if matchedRoute.StripPrefix {
            req.URL.Path = strings.TrimPrefix(req.URL.Path, matchedRoute.PathPrefix)
            if req.URL.Path == "" {
                req.URL.Path = "/"
            }
        }

        // Add headers
        req.Header.Set("X-Forwarded-Host", r.Host)
        req.Header.Set("X-Origin-Host", target.Host)
    }

    // Apply middleware
    var handler http.Handler = proxy
    for i := len(matchedRoute.Middleware) - 1; i >= 0; i-- {
        handler = matchedRoute.Middleware[i](handler)
    }

    handler.ServeHTTP(w, r)
}

// Gateway middleware examples
func RateLimitMiddleware(limiter RateLimiter) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if !limiter.Allow(getClientIP(r)) {
                http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}

// userContextKey is an unexported struct type so no other package can
// collide with this context key. A plain string key is flagged by vet.
type userContextKey struct{}

func AuthMiddleware(validator TokenValidator) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            token := extractToken(r)
            if token == "" {
                http.Error(w, "Unauthorized", http.StatusUnauthorized)
                return
            }

            user, err := validator.Validate(r.Context(), token)
            if err != nil {
                http.Error(w, "Invalid token", http.StatusUnauthorized)
                return
            }

            ctx := context.WithValue(r.Context(), userContextKey{}, user)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

### Junior → FAANG: The Gateway in System Design Interviews

The API gateway is a component that interviewers expect you to place in system design diagrams and explain correctly. The two failure modes are: forgetting it entirely (all traffic goes straight to services, no auth enforcement, no rate limiting), and making it do too much (business logic, data enrichment, service orchestration).

The correct one-sentence definition for an interview: "The API gateway is the single entry point for external traffic. It handles authentication, rate limiting, TLS termination, and routing. It contains no business logic."

Rate limiting is the most commonly tested gateway feature. Know the difference between token bucket (allow bursts up to bucket size, refill at a constant rate) and sliding window (count requests in a rolling time window). Token bucket is the standard for API rate limiting. Sliding window is more accurate for strict per-second limits. In a Go interview coding exercise, token bucket is the simpler implementation.

Auth at the gateway: the gateway validates a JWT token using the JWKS endpoint of your identity provider. It does not call a user service to validate the token on every request, because that would create a dependency and add latency. The JWT contains the claims the downstream services need (user ID, roles). Downstream services trust the gateway's forwarded claims without re-validating the token.

BFF (Backend for Frontend) vs gateway: a BFF is a service that aggregates data from multiple backend services and formats it for a specific client type (mobile, web, partner). It is a service, not a gateway. Do not put BFF logic in the gateway. If you need to aggregate data for the mobile client, build a dedicated `mobile-bff` service that sits behind the gateway.

### Senior @ FAANG: Gateway Architecture, Kubernetes Gateway API, and Edge Governance

Staff engineers do not design a gateway in isolation. They design a gateway *platform* that multiple teams can use safely without stepping on each other.

**Kubernetes Gateway API as the 2026 standard.** The Kubernetes Gateway API (not the older Ingress API) separates concerns between the platform team and the application team. The platform team owns `GatewayClass` and `Gateway` objects, which define the infrastructure (which Envoy or Kong implementation, which TLS certificate provider, which rate limiting backend). Application teams own `HTTPRoute` objects, which define their routing rules (path prefix, host, backend service). This role separation means a team can deploy a new route without filing a ticket to the platform team, and the platform team can enforce security policies (mandatory auth, minimum TLS version) at the `Gateway` level without touching application configuration.

**Rate limiting architecture at scale.** Local in-process rate limiting (token bucket in Go) is fast but cannot enforce global limits across instances. If your service runs 100 pods and you want to allow 10,000 requests per minute across all pods, local limiting allows 10,000 per pod (1,000,000 total). The solution is a distributed rate limiter backed by Redis (sliding window with MULTI/EXEC), or a dedicated rate limit service (Envoy's `RateLimit` service, or the Envoy Gateway rate limit extension). The tradeoff: the distributed check adds a Redis round-trip per request (~1ms). For most services this is acceptable. For ultra-low-latency paths, use a hybrid: local token bucket for per-pod limits, distributed check only for global limits, checked asynchronously and enforced with a lag of one window.

**mTLS at the gateway and service mesh.** At scale, JWT auth at the gateway is necessary but not sufficient. Service-to-service calls inside the cluster also need auth. mTLS via a service mesh (Istio, Linkerd) provides workload identity (SPIFFE SVIDs) on every connection without application code changes. The gateway terminates external TLS and re-originates mTLS to the backend. This means the backend never accepts an unauthenticated connection, even from within the cluster. Staff engineers design the certificate rotation policy (short-lived certs of less than 24 hours via SPIRE or Istio's built-in CA), the SVID trust domain topology (single cluster, federated multi-cluster), and the rollout plan (mesh adoption is phased, starting with canary namespaces to validate sidecar injection compatibility).

**Gateway as an SPOF: the platform mitigation.** The gateway is a load balancer, and load balancers are hard to make truly HA. The mitigation is layered: multiple gateway replicas across AZs, Kubernetes HPA for traffic spikes, circuit breakers on the gateway's routing layer to drop traffic to degraded upstreams rather than queuing, and a bypass mechanism (documented in the runbook) for routing critical traffic directly to a service during a gateway incident. The bypass should be tested quarterly in a game day, not discovered for the first time during a production outage.

---
