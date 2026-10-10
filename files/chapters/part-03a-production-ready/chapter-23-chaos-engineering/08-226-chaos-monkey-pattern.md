## 23.6 Chaos Monkey Pattern

The Chaos Monkey pattern, popularized by Netflix, takes a simple but powerful approach: randomly terminate services or containers at regular intervals to ensure your system can survive any single instance dying. The name comes from the idea of a mischievous monkey loose in your data center, pulling cables and pressing power buttons at random. If your architecture truly supports high availability, then killing any individual service instance should have no user-visible impact.

**Chaos Monkey 2.0 is a Go program**, which makes it an unusually direct reference for this chapter. Netflix rewrote it in Go and announced the rewrite in October 2016, and the source is public at `github.com/Netflix/chaosmonkey`. Three of its design decisions are worth stealing before you write a line of your own:

- **It is not a daemon.** Chaos Monkey 2.0 is triggered by a cron job. A long-lived process that kills things on a ticker keeps killing things when you stop paying attention. A cron-triggered binary has a natural, externally controlled stopping point, and "how do I turn it off" has an answer that does not involve finding a goroutine.
- **Schedules are expressed as mean time between terminations**, not as a probability rolled on some arbitrary interval. Service owners can reason about "one instance a week". Nobody can reason about "8% chance every 10 minutes", and the two are easy to confuse by an order of magnitude.
- **It terminates through Spinnaker**, the same deployment system that owns the instances, rather than through SSH. SSH support was deliberately removed. Going through the system of record means the monkey inherits its knowledge of what is deployed where, and cannot act on a stale picture of the world.

The implementations below show the pattern for both Docker containers and Kubernetes pods.

### Random Service Termination

The `ChaosMonkey` struct runs a background goroutine that wakes on a configurable interval and kills a randomly selected target from its registry. Targets are Docker container names or IDs. The kill is issued via `docker kill`, which sends `SIGKILL` by default. The mutex protects the target list so containers can be added or removed while the monkey is running.

Read the version below as a starting skeleton, then read the section immediately after it, because **as written this is not a chaos experiment, it is a slow outage.** It kills a target every interval forever. It never checks whether the last victim came back, never checks whether the system is still healthy, and never stops. Point it at a five-instance service with an interval shorter than the time to reschedule, and it will methodically kill all five.

```go
package chaos

import (
    "context"
    "fmt"
    "log/slog"
    "math/rand/v2"
    "os"
    "os/exec"
    "sync"
    "time"
)

type ChaosMonkey struct {
    mu        sync.Mutex
    logger    *slog.Logger
    targets   []string // Service names or container IDs
    enabled   bool
    interval  time.Duration
    stopChan  chan struct{}
}

func NewChaosMonkey(logger *slog.Logger, interval time.Duration) *ChaosMonkey {
    return &ChaosMonkey{
        logger:   logger,
        interval: interval,
        targets:  make([]string, 0),
    }
}

func (c *ChaosMonkey) AddTarget(target string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.targets = append(c.targets, target)
}

func (c *ChaosMonkey) Start(ctx context.Context) {
    c.mu.Lock()
    if c.enabled {
        c.mu.Unlock()
        return
    }
    c.enabled = true
    c.stopChan = make(chan struct{})
    c.mu.Unlock()

    go func() {
        ticker := time.NewTicker(c.interval)
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case <-c.stopChan:
                return
            case <-ticker.C:
                c.killRandomTarget()
            }
        }
    }()
}

func (c *ChaosMonkey) Stop() {
    c.mu.Lock()
    defer c.mu.Unlock()

    if !c.enabled {
        return
    }

    c.enabled = false
    close(c.stopChan)
}

func (c *ChaosMonkey) killRandomTarget() {
    c.mu.Lock()
    if len(c.targets) == 0 {
        c.mu.Unlock()
        return
    }

    target := c.targets[rand.IntN(len(c.targets))]
    c.mu.Unlock()

    c.logger.Warn("chaos monkey killing target", "target", target)

    // Kill Docker container
    cmd := exec.Command("docker", "kill", target)
    if err := cmd.Run(); err != nil {
        c.logger.Error("failed to kill target", "target", target, "error", err)
    }
}
```

### The Two Things the Skeleton Is Missing

A monkey that only knows how to kill is a scheduled outage generator. Two controls turn it into an experiment, and neither is optional.

**An abort condition.** Before each kill the monkey must ask whether the system is currently healthy, and after each kill it must keep asking. If the steady state is already broken, it must not add a second failure to a system that is already failing, which is exactly when a random termination does the most damage and teaches the least. A chaos experiment with no abort condition is not an experiment, it is an incident you scheduled in advance.

**A blast radius.** Cap what a single run may destroy: how many instances, what fraction of the fleet, and never the last healthy one. `minHealthy` is what stops the monkey from taking a degraded service to zero.

```go
// SafeChaosMonkey adds the controls that make termination an experiment.
type SafeChaosMonkey struct {
    mu      sync.Mutex
    targets []string
    logger  *slog.Logger

    // Health reports whether the steady state currently holds. Returning an
    // error aborts the run. This is the single most important field here.
    Health func(ctx context.Context) error

    // MaxKills caps one run's blast radius.
    MaxKills int

    // MinHealthy is the number of targets that must survive. The monkey
    // stops rather than take the fleet below this.
    MinHealthy int

    // MeanTimeBetweenKills follows Chaos Monkey 2.0's scheduling model.
    // "One instance an hour" is reviewable; "5% chance per tick" is not.
    MeanTimeBetweenKills time.Duration

    killed int
}

// Run performs at most one experiment pass and returns why it stopped.
func (c *SafeChaosMonkey) Run(ctx context.Context) error {
    // Verify the steady state BEFORE touching anything. If the system is
    // already unhealthy, there is nothing to learn and plenty to break.
    if err := c.Health(ctx); err != nil {
        return fmt.Errorf("aborting before start, steady state not held: %w", err)
    }

    for c.killed < c.MaxKills {
        c.mu.Lock()
        remaining := len(c.targets) - c.killed
        if remaining <= c.MinHealthy {
            c.mu.Unlock()
            c.logger.Info("blast radius reached, stopping",
                "remaining", remaining, "min_healthy", c.MinHealthy)
            return nil
        }
        target := c.targets[rand.IntN(len(c.targets))]
        c.mu.Unlock()

        c.logger.Warn("chaos monkey killing target", "target", target)
        if err := kill(ctx, target); err != nil {
            return fmt.Errorf("kill %s: %w", target, err)
        }
        c.killed++

        // Give the system its contractual time to recover, then re-check.
        select {
        case <-time.After(c.MeanTimeBetweenKills):
        case <-ctx.Done():
            return ctx.Err()
        }

        // The abort condition. A failed steady state check here means the
        // experiment found something: stop, restore, and go read the graphs.
        // Continuing would turn a finding into an outage.
        if err := c.Health(ctx); err != nil {
            return fmt.Errorf("ABORT after %d kills, steady state broken: %w", c.killed, err)
        }
    }
    return nil
}
```

Note that the abort path returns an error and stops. It does not log and carry on. The most common way teams get burned is a monkey whose health check exists but whose failure is only logged, which is indistinguishable from having no health check at all except that it looks responsible in code review.

### Kubernetes Pod Termination

In Kubernetes, pods are the correct termination target rather than containers, because Kubernetes will automatically reschedule a deleted pod according to its `ReplicaSet` or `Deployment` spec, making it a clean test of self-healing behavior. The label selector scopes the blast radius to a specific workload, such as `app=payment-service`, so the monkey does not reach infrastructure pods like `coredns`.

That last sentence is only true if the selector is actually non-empty, and this is a trap worth pausing on. `metav1.ListOptions{LabelSelector: ""}` does not match *nothing*, it matches **everything in the namespace**. A selector that arrives empty through a missing environment variable or an unset config field does not fail, it silently escalates the monkey from one workload to the entire namespace, and if that namespace happens to be `kube-system` the experiment eats the cluster's control-plane add-ons. The blast radius is a safety control, so it has to be validated at construction and refuse to run without one, rather than documented and hoped for.

There is a second subtlety in `Delete()`. Going through the API server triggers graceful shutdown: the pod gets `SIGTERM`, its `preStop` hooks run, and it drains in-flight requests. That is a fine test of **graceful shutdown**, and it is *not* a test of a machine dying. Real instances lose power, real kernels panic, and neither sends `SIGTERM` first. If you only ever run the graceful version you are validating the path that already works and building confidence about a failure mode you never actually exercised. Use `GracePeriodSeconds: 0` when you mean to simulate a crash, and be explicit about which of the two you are testing.

```go
package chaos

import (
    "context"
    "errors"
    "fmt"
    "math/rand/v2"
    "strings"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
)

type K8sChaosMonkey struct {
    // kubernetes.Interface, not *kubernetes.Clientset. The concrete type
    // cannot be substituted, so a monkey that depends on it cannot be unit
    // tested against k8s.io/client-go/kubernetes/fake. Of all the code in a
    // system, the code whose job is deleting production pods is the code you
    // least want to be untestable.
    client    kubernetes.Interface
    namespace string
    selector  string

    // MinHealthy pods must survive. The monkey refuses to take a workload
    // below this, so a already-degraded Deployment is not driven to zero.
    minHealthy int

    // Hard, when true, deletes with GracePeriodSeconds=0 to simulate a crash
    // rather than a clean shutdown.
    hard bool
}

// NewK8sChaosMonkey validates its blast radius up front and refuses to build
// a monkey that could roam.
func NewK8sChaosMonkey(client kubernetes.Interface, namespace, selector string, minHealthy int, hard bool) (*K8sChaosMonkey, error) {
    // An empty selector matches EVERY pod in the namespace. Refuse it. This
    // is a safety control, so it fails closed rather than defaulting to the
    // most destructive possible behaviour.
    if strings.TrimSpace(selector) == "" {
        return nil, errors.New("k8s chaos monkey: empty selector would target every pod in the namespace")
    }
    if strings.TrimSpace(namespace) == "" {
        return nil, errors.New("k8s chaos monkey: namespace must be explicit, never the default")
    }
    if namespace == "kube-system" {
        return nil, errors.New("k8s chaos monkey: refusing to target kube-system")
    }
    if minHealthy < 1 {
        return nil, errors.New("k8s chaos monkey: minHealthy must be at least 1")
    }

    return &K8sChaosMonkey{
        client:     client,
        namespace:  namespace,
        selector:   selector,
        minHealthy: minHealthy,
        hard:       hard,
    }, nil
}

func (k *K8sChaosMonkey) KillRandomPod(ctx context.Context) error {
    pods, err := k.client.CoreV1().Pods(k.namespace).List(ctx, metav1.ListOptions{
        LabelSelector: k.selector,
    })
    if err != nil {
        return fmt.Errorf("list pods: %w", err)
    }

    // Count only pods that are actually Running. Deleting one of three pods
    // sounds safe until the other two are already CrashLooping, at which
    // point the "safe" kill is the one that takes the service to zero.
    running := make([]corev1.Pod, 0, len(pods.Items))
    for _, p := range pods.Items {
        if p.Status.Phase == corev1.PodRunning && p.DeletionTimestamp == nil {
            running = append(running, p)
        }
    }

    if len(running) <= k.minHealthy {
        return fmt.Errorf("blast radius: %d running pods, minHealthy=%d, refusing to kill",
            len(running), k.minHealthy)
    }

    pod := running[rand.IntN(len(running))]

    opts := metav1.DeleteOptions{}
    if k.hard {
        // GracePeriodSeconds=0 skips SIGTERM and preStop hooks, which is what
        // actually simulates a machine dying. Without it you are testing
        // graceful shutdown and calling it a crash test.
        zero := int64(0)
        opts.GracePeriodSeconds = &zero
    }

    if err := k.client.CoreV1().Pods(k.namespace).Delete(ctx, pod.Name, opts); err != nil {
        return fmt.Errorf("delete pod %s: %w", pod.Name, err)
    }
    return nil
}
```

### Staff Lens: Chaos Monkey Is the Starting Point, Not the End

Chaos Monkey kills instances. That is the simplest chaos experiment. Advanced chaos tests network partitions, slow dependencies, clock skew, correlated failures. Start with Chaos Monkey. Graduate to advanced experiments as the team matures.

---
