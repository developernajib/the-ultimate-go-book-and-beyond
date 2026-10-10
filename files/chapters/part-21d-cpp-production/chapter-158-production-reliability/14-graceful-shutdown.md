## Graceful Shutdown

A C++ service that exits abruptly on `SIGTERM` drops every in-flight request, hangs up every connection mid-byte, and corrupts whatever it was about to flush to disk. A graceful shutdown does the opposite: stops accepting new work, finishes in-flight work, flushes state, and exits cleanly. The difference between the two is fifty lines of code and the difference between an SLO breach and a clean deploy.

### The Lifecycle

A typical service lifecycle:

```
T+0:   SIGTERM arrives (deploy, pod eviction, scaling down)
T+0:   stop accepting new connections / RPCs
T+0:   notify load balancer that we are draining
T+1s:  load balancer routes new traffic away
T+5s:  in-flight requests start finishing
T+30s: most in-flight requests done
T+45s: deadline. Force-exit any remaining.
```

The numbers are tunable. For a request-response service with a 1-second p99 latency, 10 seconds is plenty. For a long-running streaming service, 60 seconds might be the floor.

### Catching SIGTERM

Signal handling in C++ is constrained: only async-signal-safe functions can run inside a handler, and atomicity is fragile. The standard pattern is the self-pipe trick (write to a pipe from the handler, read from a normal thread) or the `signalfd` approach.

A cleaner modern pattern is to mask signals on all threads except a dedicated signal-handling thread that uses `sigwait`:

```cpp
#include <pthread.h>
#include <signal.h>
#include <atomic>

class ShutdownManager {
public:
    void Start() {
        sigset_t mask;
        sigemptyset(&mask);
        sigaddset(&mask, SIGTERM);
        sigaddset(&mask, SIGINT);
        pthread_sigmask(SIG_BLOCK, &mask, nullptr);

        signal_thread_ = std::thread([this, mask]() {
            int sig;
            sigwait(&mask, &sig);
            LOG(INFO) << "received signal " << sig << ", initiating shutdown";
            shutting_down_.store(true);
            shutdown_cv_.notify_all();
        });
    }

    bool ShuttingDown() const {
        return shutting_down_.load(std::memory_order_acquire);
    }

    void Wait() {
        std::unique_lock<std::mutex> lock(mu_);
        shutdown_cv_.wait(lock, [this]() { return shutting_down_.load(); });
    }

private:
    std::atomic<bool> shutting_down_{false};
    std::condition_variable shutdown_cv_;
    std::mutex mu_;
    std::thread signal_thread_;
};
```

The signal mask must be set before any worker threads are spawned, because signal masks are inherited at thread creation. Set the mask in `main` before anything else.

### Stop Accepting New Connections

Once shutdown begins, the listener stops accepting. For a TCP server:

```cpp
void AcceptLoop() {
    while (!shutdown_->ShuttingDown()) {
        int fd = accept(listen_fd_, ...);
        if (fd < 0) {
            if (errno == EINTR) continue;
            // Otherwise, accept failed, log and break
            break;
        }
        worker_pool_.Submit(fd);
    }
    close(listen_fd_);
}
```

For an HTTP/gRPC server, the framework usually has a `Shutdown()` method that does this:

```cpp
grpc::Server* server;  // populated at startup
shutdown_->Wait();
server->Shutdown(std::chrono::system_clock::now() + std::chrono::seconds(30));
server->Wait();
```

`grpc::Server::Shutdown` stops accepting and gives existing RPCs the configured deadline to finish.

### Notify the Load Balancer

In Kubernetes with a `Service`, the kubelet sends `SIGTERM` and then waits `terminationGracePeriodSeconds`. During that window, the pod is removed from the service endpoints, but the removal is eventually consistent: the load balancer might still send traffic for several seconds.

The bridge is the readiness probe. Once shutdown begins, the readiness probe returns failure, and the kube-proxy stops sending new traffic.

```cpp
class HealthHandler {
public:
    void Handle(Request* req, Response* resp) {
        if (shutdown_->ShuttingDown()) {
            resp->status = 503;
            resp->body = "shutting down";
            return;
        }
        resp->status = 200;
        resp->body = "ok";
    }
};
```

The Kubernetes `preStop` hook gives an additional way: a small script that executes before `SIGTERM`, typically to mark the pod unhealthy and sleep long enough for the load balancer to stop routing.

```yaml
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "kill -USR1 1 && sleep 5"]
```

The `SIGUSR1` signals the binary to start failing readiness while still serving in-flight requests. The 5-second sleep gives the LB time to update.

### Drain In-Flight Requests

The worker threads continue processing in-flight requests even after the shutdown signal. The pattern: each worker checks `ShuttingDown()` only when looking for new work, not while serving an existing request.

For a thread pool with a queue:

```cpp
void Worker::Run() {
    while (true) {
        auto task = queue_.Dequeue();
        if (!task.has_value()) {
            // queue closed (signaled by shutdown)
            break;
        }
        task->Execute();
    }
}

void ThreadPool::Shutdown() {
    queue_.Close();   // future Dequeue returns nullopt
    for (auto& t : workers_) {
        t.join();
    }
}
```

For a connection-per-thread model, each connection's thread runs to natural completion. The shutdown manager just waits.

### Watchdog: Force-Exit on Deadline

A graceful shutdown can stall. A worker might be deadlocked. A connection might be infinitely slow. A flush to disk might be blocked on a hung NFS mount. The shutdown manager arms a watchdog that force-exits at a deadline.

```cpp
void ShutdownManager::Wait() {
    // ... wait for shutdown signal as before

    auto deadline = std::chrono::steady_clock::now()
                    + std::chrono::seconds(45);

    std::thread watchdog([deadline]() {
        std::this_thread::sleep_until(deadline);
        LOG(FATAL) << "graceful shutdown timed out, forcing exit";
        // LOG(FATAL) calls abort()
        std::_Exit(2);  // belt and suspenders
    });
    watchdog.detach();
}
```

The watchdog is non-negotiable. Without it, a stuck thread can prevent the process from ever exiting, and Kubernetes will eventually `SIGKILL` it after the grace period, with no logs and no postmortem signal. Better to log and exit yourself than to be killed.

### Flushing State

Some services hold state that must be flushed before exit:

- Buffered logs not yet written to disk.
- Metrics not yet pushed to the collector.
- Request traces not yet flushed to the tracing backend.
- In-memory queues of work to be persisted.

```cpp
void Flush() {
    LOG(INFO) << "flushing state";
    log_sink_.Flush();
    metric_pusher_.Flush();
    tracer_.Flush();
    queue_.Persist();
    LOG(INFO) << "flush complete";
}
```

Each flush has a timeout, smaller than the watchdog deadline. A blocked flush should not consume the whole grace period.

### A Real C++ Template

```cpp
int main(int argc, char** argv) {
    InitFlags(argc, argv);
    InitLogging();
    InitCrashpad();

    ShutdownManager shutdown;
    shutdown.Start();

    auto server = StartServer();
    auto pool   = StartWorkerPool();

    shutdown.Wait();
    LOG(INFO) << "shutdown signal received";

    // Stop accepting new work
    server->Shutdown(std::chrono::seconds(30));

    // Drain in-flight
    pool->DrainAndJoin(std::chrono::seconds(30));

    // Flush state
    Flush();

    LOG(INFO) << "shutdown complete";
    return 0;
}
```

Roughly fifty lines of code. The reliability return is enormous.

### Kubernetes Specifics

The default Kubernetes `terminationGracePeriodSeconds` is 30. For most C++ services, raise it to 60 or more.

The pod lifecycle:

```
1. Pod marked Terminating in API server.
2. Pod removed from service endpoints (eventually consistent, ~1s).
3. preStop hook runs.
4. SIGTERM sent to PID 1.
5. Wait terminationGracePeriodSeconds.
6. SIGKILL sent.
```

The order means PID 1 must be the main C++ binary, not a shell wrapper. A shell wrapper that is PID 1 receives SIGTERM and may or may not forward it to the binary. Use `tini` or `dumb-init` if you need a wrapper, or run your binary as PID 1 directly.

### systemd Specifics

For a systemd-managed C++ service:

```ini
[Service]
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=60
```

`KillMode=mixed` sends SIGTERM to the main process and SIGKILL to the others. `TimeoutStopSec=60` gives the process 60 seconds to exit. Past that, systemd sends SIGKILL.

### What Goes Wrong

- **No watchdog.** A blocked drain holds the process forever. SIGKILL finally arrives, logs are lost.
- **Worker checks shutdown mid-request.** A worker that aborts a half-finished request because shutdown started can leave inconsistent state. Workers should check shutdown only between requests.
- **Connection accept loop ignores shutdown.** A new connection arrives during the grace period and gets a half-functional server. Stop accepting first.
- **Readiness probe still healthy.** The LB keeps sending traffic. Solution: flip readiness as the first action of shutdown.
- **No flush.** A buffered log sink drops the last 10 seconds of logs, exactly the logs you need to debug whatever caused the deploy.

### Senior at FAANG: The Operational Detail

The senior contribution is treating shutdown as a real lifecycle phase, with a sequence of phases, deadlines, watchdogs, and metrics for each. A service that shuts down cleanly is a service that can be deployed many times per day without SLO impact. A service that shuts down poorly is a service that contributes a small error spike to every deploy, and over a year that is many points of error budget.

---
