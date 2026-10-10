## 98.16 Kubernetes Client-Go Usage

### Building a Kubernetes Client

The `client-go` library supports both in-cluster authentication (using the pod's mounted service account token) and local kubeconfig-based access for development. The `NewClient` constructor tries the in-cluster config first and falls back to the default kubeconfig path, making the same binary work in both environments. Once the `Clientset` is created, typed API methods for pods, services, and config maps become available, along with a watch interface for reacting to resource changes in real time.

```go
// internal/k8s/client.go
package k8s

import (
    "context"
    "fmt"
    "os"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
    "k8s.io/client-go/tools/clientcmd"
)

type Client struct {
    clientset *kubernetes.Clientset
    namespace string
}

func NewClient() (*Client, error) {
    var config *rest.Config
    var err error

    // Try in-cluster config first
    config, err = rest.InClusterConfig()
    if err != nil {
        // Fall back to kubeconfig for local development
        kubeconfig := clientcmd.NewDefaultClientConfigLoadingRules().GetDefaultFilename()
        config, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
        if err != nil {
            return nil, fmt.Errorf("failed to create config: %w", err)
        }
    }

    clientset, err := kubernetes.NewForConfig(config)
    if err != nil {
        return nil, fmt.Errorf("failed to create clientset: %w", err)
    }

    return &Client{
        clientset: clientset,
        namespace: getNamespace(),
    }, nil
}

func getNamespace() string {
    // Read namespace from service account
    if ns, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace"); err == nil {
        return string(ns)
    }
    return "default"
}

// Clientset returns the underlying Kubernetes clientset
func (c *Client) Clientset() *kubernetes.Clientset {
    return c.clientset
}

// ListPods lists all pods in namespace
func (c *Client) ListPods(ctx context.Context, labelSelector string) ([]corev1.Pod, error) {
    pods, err := c.clientset.CoreV1().Pods(c.namespace).List(ctx, metav1.ListOptions{
        LabelSelector: labelSelector,
    })
    if err != nil {
        return nil, err
    }
    return pods.Items, nil
}

// GetConfigMap retrieves a ConfigMap
func (c *Client) GetConfigMap(ctx context.Context, name string) (*corev1.ConfigMap, error) {
    return c.clientset.CoreV1().ConfigMaps(c.namespace).Get(ctx, name, metav1.GetOptions{})
}

// WatchConfigMap watches for ConfigMap changes
func (c *Client) WatchConfigMap(ctx context.Context, name string, callback func(*corev1.ConfigMap)) error {
    watcher, err := c.clientset.CoreV1().ConfigMaps(c.namespace).Watch(ctx, metav1.ListOptions{
        FieldSelector: fmt.Sprintf("metadata.name=%s", name),
    })
    if err != nil {
        return err
    }
    defer watcher.Stop()

    for {
        select {
        case event := <-watcher.ResultChan():
            if cm, ok := event.Object.(*corev1.ConfigMap); ok {
                callback(cm)
            }
        case <-ctx.Done():
            return ctx.Err()
        }
    }
}

// CreateService creates a Service
func (c *Client) CreateService(ctx context.Context, service *corev1.Service) (*corev1.Service, error) {
    return c.clientset.CoreV1().Services(c.namespace).Create(ctx, service, metav1.CreateOptions{})
}
```

### Leader Election

In a multi-replica deployment, only one pod should run singleton workloads such as scheduled jobs or queue processors. The `client-go` leader election package uses a Kubernetes `Lease` resource as a distributed lock, with configurable `LeaseDuration`, `RenewDeadline`, and `RetryPeriod` to balance responsiveness against API server load. The `Election` struct exposes `OnStartedLeading` and `OnStoppedLeading` callbacks so the application can start or gracefully drain work whenever leadership changes.

```go
// internal/leader/election.go
package leader

import (
    "context"
    "log"
    "os"
    "time"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/leaderelection"
    "k8s.io/client-go/tools/leaderelection/resourcelock"
)

type Election struct {
    clientset   *kubernetes.Clientset
    namespace   string
    lockName    string
    identity    string
    onStarted   func(context.Context)
    onStopped   func()
}

func NewElection(clientset *kubernetes.Clientset, namespace, lockName string) *Election {
    hostname, _ := os.Hostname()
    return &Election{
        clientset: clientset,
        namespace: namespace,
        lockName:  lockName,
        identity:  hostname,
    }
}

func (e *Election) OnStartedLeading(f func(context.Context)) *Election {
    e.onStarted = f
    return e
}

func (e *Election) OnStoppedLeading(f func()) *Election {
    e.onStopped = f
    return e
}

func (e *Election) Run(ctx context.Context) error {
    lock := &resourcelock.LeaseLock{
        LeaseMeta: metav1.ObjectMeta{
            Name:      e.lockName,
            Namespace: e.namespace,
        },
        Client: e.clientset.CoordinationV1(),
        LockConfig: resourcelock.ResourceLockConfig{
            Identity: e.identity,
        },
    }

    leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
        Lock:            lock,
        ReleaseOnCancel: true,
        LeaseDuration:   15 * time.Second,
        RenewDeadline:   10 * time.Second,
        RetryPeriod:     2 * time.Second,
        Callbacks: leaderelection.LeaderCallbacks{
            OnStartedLeading: e.onStarted,
            OnStoppedLeading: e.onStopped,
            OnNewLeader: func(identity string) {
                if identity != e.identity {
                    log.Printf("New leader elected: %s", identity)
                }
            },
        },
    })

    return nil
}
```

### Using Leader Election

Wiring the `Election` type into a real application requires a context that respects OS signals so that SIGTERM from Kubernetes triggers a clean leadership release before the pod exits. The example below creates a cancellable root context, hooks it to `SIGTERM`/`SIGINT`, and then delegates actual work to `runWorker`, which only runs while the current pod holds the lease. This pattern ensures the work loop stops immediately when the pod loses leadership or is asked to shut down.

```go
// cmd/worker/main.go
package main

import (
    "context"
    "log"
    "os"
    "os/signal"
    "syscall"

    "myapp/internal/k8s"
    "myapp/internal/leader"
)

func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Handle shutdown
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    go func() {
        <-sigCh
        cancel()
    }()

    client, err := k8s.NewClient()
    if err != nil {
        log.Fatal(err)
    }

    election := leader.NewElection(client.Clientset(), "default", "worker-leader").
        OnStartedLeading(func(ctx context.Context) {
            log.Println("Became leader, starting worker...")
            runWorker(ctx)
        }).
        OnStoppedLeading(func() {
            log.Println("Lost leadership, stopping worker...")
        })

    if err := election.Run(ctx); err != nil {
        log.Fatal(err)
    }
}

func runWorker(ctx context.Context) {
    // Only runs when this pod is the leader
    for {
        select {
        case <-ctx.Done():
            return
        default:
            // Do work...
        }
    }
}
```

---

### Junior → FAANG: When and Why to Use client-go

Most Go applications running in Kubernetes do not need client-go. They run as regular containerized processes and interact with Kubernetes only indirectly (through health check endpoints, environment variables for configuration, and graceful shutdown handling). Client-go is needed when the application itself needs to interact with the Kubernetes API: reading pod metadata, creating or modifying Kubernetes objects, or implementing a custom controller or operator.

The two client-go usage patterns to understand: the simple client (creates Kubernetes objects, reads resource state) and the informer pattern (watches for changes to resources and maintains a local in-memory cache, avoiding repeated API server polling). For any use case that needs to respond to Kubernetes resource changes, the informer pattern is the correct approach. Polling the API server in a loop is an anti-pattern that increases API server load and has poor latency characteristics.

First-job habit: always use the informer pattern when you need to watch for changes. Never implement a polling loop against the Kubernetes API. The informer handles reconnection, caching, and rate limiting automatically.

### Senior @ FAANG: client-go at Scale and the Shared Informer Factory

At staff level, using client-go correctly in a production operator or controller requires understanding the shared informer factory. If each controller creates its own informer for the same resource type, you get N API watch connections for N controllers watching the same resource. The shared informer factory maintains a single watch connection per resource type and multiplexes events to all consumers. This is not an optimization. It is a correctness concern for the API server's watch connection budget.

The work queue pattern (informer triggers event, event is added to a rate-limited work queue, worker goroutines drain the queue and run reconcile) is the foundation of every production-grade controller. The rate limiting in the work queue is what prevents reconcile storm when a resource flaps (changes state rapidly). Getting the rate limit parameters right requires understanding the expected reconcile frequency and the maximum acceptable lag between resource change and reconcile completion.

The client-go fake client for testing is the mechanism that enables unit testing of controller logic without a real cluster. Using envtest (which runs a real API server and etcd in-process) for integration tests covers the cases that the fake client cannot (admission webhooks, finalizer behavior). The testing strategy for client-go code is: fake client for unit tests of reconcile logic, envtest for integration tests of the full controller including CRD installation, real cluster for e2e tests. This three-level strategy is the production standard for operator development at FAANG.
