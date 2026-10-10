## 21.6 Kubernetes Graceful Shutdown

### SIGTERM Handling in Kubernetes

When Kubernetes terminates a pod it sends `SIGTERM` and then waits for the configured `terminationGracePeriodSeconds` (default 30 seconds) before sending `SIGKILL`. Setting the shutdown context timeout slightly below that grace period, 25 seconds here versus the 30-second Kubernetes default, ensures the application has time to drain connections and log a clean exit before the hard kill arrives.

```go
func main() {
    server := &http.Server{Addr: ":8080", Handler: router}

    go server.ListenAndServe()

    // Kubernetes sends SIGTERM before killing
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM)
    <-quit

    log.Println("SIGTERM received, starting graceful shutdown")

    // Kubernetes default grace period is 30s
    ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        log.Printf("Shutdown error: %v", err)
    }
}
```

### Pre-Stop Hook

Kubernetes executes the `preStop` hook synchronously before sending `SIGTERM`, so a short sleep here creates a deliberate buffer between the pod being removed from the endpoints list and the process receiving its shutdown signal. This is critical because kube-proxy and cloud load balancers do not instantly stop routing traffic the moment a pod begins terminating.

```yaml
# kubernetes deployment
spec:
  terminationGracePeriodSeconds: 40  # 5s preStop + 30s drain + headroom
  containers:
    - name: api
      lifecycle:
        preStop:
          exec:
            command: ["/bin/sh", "-c", "sleep 5"]
```

This gives load balancers time to remove the pod before it starts shutting down.

**The preStop sleep comes out of your grace budget, not on top of it.** `terminationGracePeriodSeconds` is a single clock covering the preStop hook *and* everything the process does after `SIGTERM`. It is not "5 seconds of hook, then a fresh 30 seconds to drain".

That makes the default combination a trap. A `sleep 5` preStop plus a 25-second shutdown timeout plus the 30-second default grace period leaves exactly zero headroom: 5 + 25 = 30, so a drain that actually uses its full budget gets `SIGKILL`ed at the moment it finishes, and the final cleanup and log lines never run. Budget it explicitly instead:

```
terminationGracePeriodSeconds  40
  ├── preStop sleep             5   (LB propagation)
  ├── Shutdown timeout         30   (in-flight drain)
  └── headroom                  5   (close deps, flush telemetry, exit)
```

The rule: `preStop + shutdownTimeout + cleanup < terminationGracePeriodSeconds`, with real headroom. If you keep the 30-second default grace period, your shutdown timeout must be nearer 20 seconds than 25.

### Readiness During Shutdown

Marking the pod as unhealthy before initiating the shutdown sequence gives kube-proxy and any upstream load balancers time to stop routing new traffic to the pod. Without this delay, requests can still arrive during the `server.Shutdown` drain window and receive connection reset errors.

Readiness and liveness are **not** the same signal here, and wiring them to the same handler is a genuine outage. Readiness must start failing as soon as shutdown begins, so the endpoints controller pulls you out of rotation. Liveness must keep succeeding for the whole drain: liveness answers "is this process wedged and in need of a restart?", and the answer during an orderly drain is no. A liveness probe that fails during shutdown tells the kubelet to restart the container out from under your in-flight requests.

Use a dedicated flag that only readiness consults:

```go
// draining is set once, at the start of shutdown, and only readiness reads it.
var draining atomic.Bool

// readyz: fails immediately on shutdown so K8s removes us from endpoints.
func readyzHandler(w http.ResponseWriter, r *http.Request) {
    if draining.Load() {
        http.Error(w, "draining", http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusOK)
}

// healthz (liveness): stays OK while draining. The process is not wedged,
// it is doing exactly what it was asked to do.
func healthzHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
}

func shutdown(server *http.Server) error {
    // 1. Fail readiness FIRST, before touching the server.
    draining.Store(true)

    // 2. Give kube-proxy and the LB time to observe it and stop routing.
    //    This is the endpoint-propagation gap. Without it, Shutdown closes
    //    the listener while traffic is still being sent here.
    time.Sleep(5 * time.Second)

    // 3. Now drain, with a bounded deadline.
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    return server.Shutdown(ctx)
}
```

`context.Background()` is the right *parent* for that shutdown context: the signal context is already canceled by the time you get here, so deriving from it would make `Shutdown` return instantly and abandon every in-flight request. But `context.Background()` on its own, passed straight to `Shutdown`, has no deadline at all. `Shutdown` would then block until the last handler returns, which for a wedged handler means "until `SIGKILL`", and you lose the cleanup that was supposed to follow. Always wrap it in `WithTimeout`.

A note on the `atomic.Bool`: the earlier `sync.RWMutex` around a plain bool works too, but a single flag written once and read by every probe is exactly what `atomic.Bool` is for. It is not just cheaper, it is harder to get wrong.

### Kubernetes Shutdown Timeline

The ordering here matters, and it is not the intuitive one. `SIGTERM` is not the first event. The pod is marked for deletion first, and that single act kicks off **two independent chains that race each other**:

1. The API server records a deletion timestamp. The pod goes `Terminating` and the `terminationGracePeriodSeconds` clock starts **now**.
2. **Chain A (control plane, asynchronous).** The endpoints controller removes the pod from the Service's `EndpointSlice`, that removal propagates to every kube-proxy on every node, and each one rewrites its iptables/IPVS rules. Cloud load balancers and Ingress controllers with their own dataplanes take longer still. Typically 1-5 seconds, sometimes much worse on a large or busy cluster.
3. **Chain B (kubelet, local).** The kubelet runs the `preStop` hook, and only when it returns does it send `SIGTERM` to PID 1 in the container.
4. When the grace period expires, `SIGKILL`, regardless of what either chain is doing.

**Nothing synchronizes Chain A with Chain B.** Kubernetes does not wait for endpoint removal to propagate before signalling your process. That is the entire bug, and it is why a correct-looking server still emits 502s during a routine rollout: without a `preStop` sleep, Chain B finishes in milliseconds and your process closes its listener while Chain A is still in flight, so kube-proxy rules on other nodes are still happily forwarding new connections to a socket that is now refusing them.

The `preStop` sleep exists solely to stall Chain B until Chain A has caught up. It is a race you paper over with time, because Kubernetes gives you no event to wait on.

Key insight: the pod keeps receiving new connections for several seconds after `SIGTERM`, until endpoints propagate. Fail readiness first, sleep long enough for the dataplane to notice, and only then stop accepting.

### Staff Lens: preStop Hook Best Practices

The `preStop` hook runs before `SIGTERM`, and the useful thing to put in it is a sleep, sized to your dataplane's real propagation delay.

Two corrections to the folklore. First, do not bother trying to flip readiness from inside an `exec` preStop hook: by the time the hook runs the pod is already marked `Terminating`, and the endpoints controller has already begun removing it for that reason alone. The readiness flag in your process matters for the probe-driven path and for LBs that consult it, which is why the code above sets it at the top of `shutdown()`, but it is not what the hook is for. Second, `sleep 5` is a starting guess, not a fact. Measure the gap between deletion and the last request your pod actually receives, and size the sleep from that. On large clusters with cloud LBs it is routinely 10 to 15 seconds, and the grace period has to grow to match.

Done right, this yields genuinely zero-downtime rollouts. Done as "add `sleep 5` because a blog said so", it just moves the 502s around.

---
