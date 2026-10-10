## Kubernetes & Cloud-Native Pitfalls

Running Go services inside Kubernetes containers requires understanding how the Go runtime interacts with Linux cgroups and kernel CPU/memory quotas.

---

### 1. CPU Throttling and CFS Quotas (`GOMAXPROCS`)

#### Root Cause Mechanics
By default, the Go runtime inspects the physical machine's CPU cores using `runtime.NumCPU()` to initialize `GOMAXPROCS`. On an AWS Kubernetes node with 64 vCPUs, if a pod is assigned a CPU limit of `2.0`, Go still launches 64 scheduler threads (`GOMAXPROCS=64`). The 64 threads exhaust the pod's 2.0-core quota in milliseconds, causing the Linux Completely Fair Scheduler (CFS) to throttle the container for the remainder of the period, spiking response latency from 5ms to 800ms.

#### Production-Grade Solution
Use Uber's `automaxprocs` library to automatically align `GOMAXPROCS` with the container's cgroup CPU quota:
```go
package main

import (
	_ "go.uber.org/automaxprocs" // Automatically sets GOMAXPROCS to cgroup quota
	"net/http"
)

func main() {
	// GOMAXPROCS is now correctly set to 2 instead of 64
	http.ListenAndServe(":8080", nil)
}
```

---

### 2. Container OOMKills and `GOMEMLIMIT`

#### Root Cause Mechanics
Go's garbage collector historically paced itself based on `GOGC` (percentage of heap growth). Inside a container with a 1GB memory limit, if heap size reached 600MB, Go would not trigger GC until heap grew to 1.2GB—causing the Linux kernel OOM Killer to abruptly terminate the container.

#### Production-Grade Solution
Since Go 1.19, set the `GOMEMLIMIT` environment variable to 85–90% of the container's memory ceiling in your Kubernetes deployment:
```yaml
env:
- name: GOMEMLIMIT
  value: "900MiB" # Leaves 100MiB headroom for OS and thread stacks in a 1GiB pod
```
