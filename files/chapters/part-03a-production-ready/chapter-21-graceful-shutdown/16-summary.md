## Summary

A correct graceful shutdown follows eight steps in a fixed order. Reversing any two steps or skipping one introduces dropped requests, leaked connections, or processes that hang past their termination deadline.

1. **Catch signals**: Use `signal.NotifyContext` (Go 1.16+), which folds the signal into the context tree. The older `signal.Notify` with a buffered channel is still correct, and the buffer of 1 is mandatory there, since an unbuffered channel drops signals delivered while no one is receiving.
2. **Fail readiness**: Return 503 from the readiness probe immediately so load balancers begin removing the pod from rotation. Leave the **liveness** probe green: it answers "is this process wedged?", and a pod that is draining on purpose is not wedged. Failing liveness here gets the container restarted mid-drain.
3. **Drain delay**: Sleep 3-5 seconds (measure it, do not guess) to let kube-proxy and cloud load balancers propagate the endpoint removal. Keep serving normally throughout: traffic is still arriving, which is the entire reason for the pause. Rejecting it here manufactures the errors the delay exists to prevent.
4. **Stop accepting work**: Close the TCP listener (`http.Server.Shutdown` does this internally) so no new connections are established.
5. **Drain connections**: Wait for all in-flight HTTP requests, gRPC streams, and message handler invocations to complete. `http.Server.Shutdown` handles HTTP connections, with one exception worth memorising: it does **not** track hijacked connections, so WebSockets are neither interrupted nor waited for. Custom `sync.WaitGroup` tracking handles those and everything else. Root the drain deadline at `context.Background()`, never at the already-canceled signal context, or `Shutdown` returns instantly and abandons the requests you meant to save.
6. **Cancel background work**: Cancel the root `context.Context` to propagate shutdown to all goroutines. Workers watching `ctx.Done()` exit their loops.
7. **Close resources**: Flush metric buffers, close database connection pools, release file locks, and disconnect from message brokers. Close resources in reverse dependency order, database connections last, since workers may still be committing transactions.
8. **Exit cleanly**: Enforce a hard deadline (`context.WithTimeout`) so a stuck downstream call cannot prevent the process from ever exiting. If the deadline fires, log which components did not finish and exit with a non-zero status code. Every step above has to fit inside `terminationGracePeriodSeconds`, and the `preStop` hook spends that same budget rather than adding to it. The default 30 seconds does not stretch.

Key patterns:
- `sync.WaitGroup` tracks active work and blocks shutdown until all goroutines complete
- `context.Context` propagates cancellation from the signal handler to every goroutine in the process
- `atomic.Bool` provides lock-free shutdown state that health probes and request middleware can check without contention
- `sync.Once` guarantees the shutdown sequence runs exactly once, even if multiple signals arrive
- `errgroup.WithContext` ties multiple components together so a failure in any one cancels the others

The difference between a well-implemented shutdown and a missing one is invisible during normal operation but becomes the difference between zero-downtime deployments and cascading 502 errors under load.

### For the Senior-at-FAANG Track

What actually matters is enforcement: every new service must demonstrate correct graceful shutdown before launch. Production readiness gate. No exceptions.

### For the Staff and Principal Track

The deliverable is the shared service-manager library plus the shutdown-in-template discipline. Every new service gets graceful shutdown by default. Every existing service that lacks it is a remediation item.

### Mental Model to Take Away

Graceful shutdown is a correctness property, not an optimization. Services without it drop requests, lose data, and behave unpredictably during deployments. Build it in from day one, validate it regularly, and treat shutdown bugs as production incidents when found.

---
