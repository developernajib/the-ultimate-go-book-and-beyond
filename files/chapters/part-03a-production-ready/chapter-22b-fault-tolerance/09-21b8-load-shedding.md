## 22B.8 Load Shedding

When a service is overloaded, trying to process every request makes things worse. Each additional request competes for CPU, memory, and network bandwidth with the requests already in flight, driving up latency for all of them. Past a tipping point, the service spends more time context-switching and garbage collecting than doing useful work, and every request fails. **Load shedding** breaks this cycle by rejecting excess requests early, before they consume any significant resources, to protect the requests the service *can* handle.

The principle is counterintuitive: rejecting some requests improves overall success rate. A service processing 100% of 10,000 incoming requests at 0% success rate is worse than one rejecting 9,000 and successfully completing the remaining 1,000.

```
Without load shedding:           With load shedding:

Requests → [Queue: 10,000]      Requests → [Admit?] → [Queue: 100]
               ↓                               ↓              ↓
           [Server 💀]             [Reject 503]       [Server ✅]
```

### Adaptive LIFO: Why Queue Order Flips Under Overload

If you do have a queue, its ordering matters under sustained overload, for a reason tied to client behavior:

- **FIFO**: by the time an old request reaches the front, the client has often already timed out. The server does the work, sends the response, and nobody is listening. That is pure waste, and it is waste the server pays for while it is already struggling.
- **LIFO**: the newest request is the one most likely to still have a client waiting on the other end, so completing it produces an outcome someone actually receives.

Be precise about the claim, because "LIFO beats FIFO" on its own is wrong. Under **normal** load, LIFO is not better, and it is arguably worse: it reorders requests for no benefit and inflates tail latency for whoever is unlucky enough to be at the bottom of the stack. The technique that works is **adaptive LIFO**: serve FIFO normally, and switch to LIFO only once a queue actually starts to form. This is Ben Maurer's description of Facebook's approach in "Fail at Scale" (ACM Queue, volume 13, issue 8, 2015), where adaptive LIFO is paired with CoDel: CoDel keeps queues short by timing out requests that have waited too long, and adaptive LIFO makes sure the requests that do get served are the ones most likely to beat that deadline. Facebook's implementation ships in HHVM.

The shedder below deliberately has **no queue at all**, so LIFO and FIFO do not arise in it. That is the point: an admission controller decides at the door, and a request that is never admitted never queues. Reach for adaptive LIFO when you have a queue you cannot remove. Reach for admission control when you can avoid building one.

What the shedder does do is classify. Health checks bypass the limiter entirely, so that orchestrators such as Kubernetes or Consul do not mark a merely-busy server as dead and evict it, which would move its traffic onto its equally busy neighbours and turn a load spike into a cascading outage. Beyond that, each priority gets its own admission threshold, so anonymous traffic is shed first and premium traffic is shed last.

```go
type PriorityLoadShedder struct {
    inFlight  atomic.Int64
    maxFlight int64
    rejected  *prometheus.CounterVec
    admitted  *prometheus.CounterVec
}

type Priority int

const (
    PriorityHealth    Priority = 0 // Bypasses the limiter entirely.
    PriorityPremium   Priority = 1
    PriorityAuth      Priority = 2
    PriorityAnonymous Priority = 3
)

func (p Priority) String() string {
    switch p {
    case PriorityHealth:
        return "health"
    case PriorityPremium:
        return "premium"
    case PriorityAuth:
        return "auth"
    default:
        return "anonymous"
    }
}

// NewPriorityLoadShedder builds a shedder with its metrics registered.
//
// The counters must be constructed here. Leaving them as zero-value fields
// makes them nil interfaces, and the first rejected request then panics on
// rejected.Inc(), crashing the process at the exact moment overload
// protection was supposed to save it.
func NewPriorityLoadShedder(max int64, reg prometheus.Registerer) *PriorityLoadShedder {
    if reg == nil {
        reg = prometheus.DefaultRegisterer
    }
    factory := promauto.With(reg)
    return &PriorityLoadShedder{
        maxFlight: max,
        rejected: factory.NewCounterVec(prometheus.CounterOpts{
            Name: "shedder_rejected_total",
            Help: "Requests rejected by the load shedder.",
        }, []string{"priority"}),
        admitted: factory.NewCounterVec(prometheus.CounterOpts{
            Name: "shedder_admitted_total",
            Help: "Requests admitted by the load shedder.",
        }, []string{"priority"}),
    }
}

// threshold is the in-flight level at which this priority starts being shed.
// Cheaper traffic is cut off earlier, which is what reserves the remaining
// headroom for the traffic that matters.
func (s *PriorityLoadShedder) threshold(p Priority) int64 {
    switch p {
    case PriorityPremium:
        return s.maxFlight // Shed last, at 100% of capacity.
    case PriorityAuth:
        return s.maxFlight * 80 / 100
    default:
        return s.maxFlight * 50 / 100 // Anonymous traffic is shed first.
    }
}

// Admit reports whether the request may proceed. A caller that gets true MUST
// call Done exactly once, and a caller that gets false must NOT.
func (s *PriorityLoadShedder) Admit(p Priority) bool {
    // Health checks bypass the limiter and are deliberately not counted in
    // inFlight. See Done for why that pairing matters.
    if p == PriorityHealth {
        return true
    }

    limit := s.threshold(p)

    // CompareAndSwap, not Load followed by Add. Load-then-Add is a
    // check-then-act race: between the two, any number of goroutines observe
    // the same under-limit value and every one of them proceeds, so the
    // limit is quietly exceeded under exactly the concurrency it exists to
    // control.
    for {
        cur := s.inFlight.Load()
        if cur >= limit {
            s.rejected.WithLabelValues(p.String()).Inc()
            return false
        }
        if s.inFlight.CompareAndSwap(cur, cur+1) {
            s.admitted.WithLabelValues(p.String()).Inc()
            return true
        }
        // Lost the race, so re-read and try again.
    }
}

// Done releases a slot acquired by a successful Admit.
func (s *PriorityLoadShedder) Done() { s.inFlight.Add(-1) }

func LoadSheddingMiddleware(shedder *PriorityLoadShedder) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            p := priorityFromRequest(r)

            // Shed BEFORE any real work. The whole value of shedding is that
            // a rejected request costs almost nothing, so admission control
            // belongs at the outermost layer, ahead of decoding, auth
            // lookups, and database calls.
            if !shedder.Admit(p) {
                w.Header().Set("Retry-After", "5")
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusServiceUnavailable)
                w.Write([]byte(`{"error":"overloaded"}`))
                return
            }

            // Release only what was actually acquired. An unconditional
            // `defer shedder.Done()` also fires for health checks, which
            // Admit never counted, so every probe drives inFlight one lower.
            // A Kubernetes liveness probe every 10s reaches -360 in an hour,
            // inFlight >= limit stops ever being true, and the shedder
            // silently admits everything forever. The failure is invisible:
            // no panic, no error, just no protection when it is needed.
            if p != PriorityHealth {
                defer shedder.Done()
            }

            next.ServeHTTP(w, r)
        })
    }
}

func priorityFromRequest(r *http.Request) Priority {
    if r.URL.Path == "/health" || r.URL.Path == "/ready" {
        return PriorityHealth
    }
    // A header any client can set is a placeholder, not an authorization
    // check. Derive the real tier from the authenticated principal, or you
    // have shipped a header that upgrades anyone to premium during a spike.
    if r.Header.Get("X-Premium-User") == "true" {
        return PriorityPremium
    }
    if r.Header.Get("Authorization") != "" {
        return PriorityAuth
    }
    return PriorityAnonymous
}
```

### Staff Lens: Shed Early, Not Late

Load shedding works when activated early enough to preserve capacity. Activated too late, the server is already overloaded and sheds only add overhead. Trigger based on latency trends, not exhaustion metrics. Latency climbing past SLO is the earliest signal.

---
