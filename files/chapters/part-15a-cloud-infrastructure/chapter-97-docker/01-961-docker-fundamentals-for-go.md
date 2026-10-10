## 97.1 Docker Fundamentals for Go

### Why Docker for Go?

Docker is a platform that packages your application and all its dependencies into a lightweight, portable unit called a container. Think of it as a shipping container for software: no matter what machine it runs on, the application behaves exactly the same way. For Go developers, Docker is especially powerful because Go compiles to a single binary with zero runtime dependencies, meaning your final container can be extraordinarily small and fast to deploy.

```
┌──────────────────────────────────────────────────────────────────┐
│                  GO + DOCKER ADVANTAGES                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  GO'S CONTAINER-FRIENDLY PROPERTIES:                             │
│  ├── Static binaries (no runtime dependencies)                   │
│  ├── Small binary size (typically 5-20MB)                        │
│  ├── Fast compilation                                            │
│  ├── Cross-compilation support                                   │
│  └── Single binary deployment                                    │
│                                                                  │
│  DOCKER BENEFITS:                                                │
│  ├── Consistent environments (dev = prod)                        │
│  ├── Isolated dependencies                                       │
│  ├── Easy scaling and orchestration                              │
│  ├── Reproducible builds                                         │
│  └── Simplified deployment                                       │
│                                                                  │
│  RESULT: Go + Docker = Minimal, Fast, Secure Containers          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: Docker Concepts That Trip Up New Go Developers

The most common junior mistake is not understanding layer caching. Engineers add `COPY . .` before `RUN go mod download`, then wonder why every single build re-downloads all dependencies. The fix is one line change: copy `go.mod` and `go.sum` first, download, then copy the rest of the source. Understanding why this works requires understanding that each `RUN`/`COPY` instruction creates a new layer and Docker reuses cached layers only when the inputs have not changed.

The second gap is `CGO_ENABLED=0`. Many tutorials omit it, and the resulting binary silently depends on glibc. That binary will not run in a scratch or distroless image, and the error message ("no such file or directory") is confusing because the binary exists. A first-job habit: always include `CGO_ENABLED=0 GOOS=linux` in your build command unless you have a specific reason to link against C.

In entry-level interviews, be ready to draw the relationship between a Dockerfile, an image, and a running container. Interviewers at product companies often ask candidates to trace what happens step by step when you run `docker run`, from image pull through process start. Knowing that a container is a running instance of an image with a writable layer on top is a basic requirement.

### Senior @ FAANG: Container Runtime Internals and Platform Implications

Senior engineers need to understand what Docker is actually doing at the kernel level: namespaces (pid, net, mnt, uts, ipc, user) for isolation and cgroups (v1 or v2) for resource accounting. This matters because a container is not a VM. Kernel vulnerabilities affect all containers on the host, and a container with excessive capabilities or a host-mounted socket can escape isolation entirely. The `--privileged` flag and mounting `/var/run/docker.sock` are red flags that belong in an architecture review, not a routine PR.

The runtime choice is increasingly relevant. containerd is the de facto standard in Kubernetes environments. Docker Engine uses containerd underneath. gVisor (runsc) provides an additional kernel isolation boundary at the cost of syscall overhead, which is the right trade-off for multi-tenant or untrusted workload scenarios. Kata Containers provides VM-level isolation with container ergonomics. Choosing among these is a platform decision with security, performance, and operational implications that need to be documented.

At L6/L7, the question is not "how does Docker work" but "what is the container platform strategy for this organization." That includes image build infrastructure (centralized CI builders versus developer local builds with remote cache push), the artifact registry (ECR, GCR, Artifact Registry) and its replication and retention policies, the image promotion workflow from dev to staging to prod, and the runtime enforcement layer (admission controllers, security policies). Each of these is a governance surface, and staff engineers own the shape of that governance even when they delegate the implementation.
