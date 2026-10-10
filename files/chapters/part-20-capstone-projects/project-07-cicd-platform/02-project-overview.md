## Project Overview

### What We're Building

We're building a production-grade CI/CD platform similar to GitHub Actions, Jenkins, or CircleCI. This platform will:

- Accept Git webhooks and trigger pipeline executions
- Parse YAML pipeline definitions
- Execute jobs in isolated Docker containers
- Stream logs in real-time via WebSockets
- Store and serve build artifacts
- Manage a pool of workers for parallel execution
- Provide a web dashboard for monitoring builds

This is a **staff engineer-level project** that demonstrates:

- Complex distributed systems architecture
- Container orchestration
- Real-time event streaming
- High-concurrency job scheduling
- Database design for CI/CD workloads
- Production-grade error handling and observability

### Real-World Complexity

Unlike toy examples, this project handles:

- **Race conditions** in job scheduling
- **Resource limits** and cleanup
- **Network failures** during Git operations
- **Container crashes** mid-execution
- **Log volume** at scale
- **Webhook verification** for security
- **Concurrent pipeline** executions
- **Artifact retention** policies

### Tech Stack

Each technology in this stack was chosen for a specific production reason rather than convenience. PostgreSQL provides the ACID guarantees needed for job state transitions, a job must never appear both "running" and "queued" simultaneously. Redis Streams replace a heavyweight broker for log tailing and inter-service events because they support consumer groups and at-least-once delivery without requiring a separate Kafka cluster. The Docker API is used directly instead of Kubernetes to keep the local development story simple while still demonstrating real container lifecycle management.

```
Language:      Go 1.27+
Database:      PostgreSQL 15+
Cache:         Redis 7+
Message Queue: Redis Streams (or RabbitMQ/NATS)
Container:     Docker API
Frontend:      HTMX + Tailwind CSS
Log Storage:   S3-compatible (MinIO for local dev)
Metrics:       Prometheus
Tracing:       OpenTelemetry
```

### System Scale Targets This platform is designed to handle:
- **100+ concurrent pipeline executions**
- **1000+ jobs per minute**
- **10GB+ logs per day**
- **50+ worker nodes**
- **Sub-second webhook response times**
- **99.9% uptime SLA**

---

### Junior → FAANG: Reading Scale Numbers Critically

The numbers in this overview (1000 jobs/minute, 50 workers) are not arbitrary. As a junior engineer, practice deriving them: 1000 jobs/minute means roughly 17 jobs/second. If each job averages 3 minutes of wall-clock time and each worker can run one job at a time, you need at least 51 workers to keep up at steady state. Interviewers ask exactly this capacity math. The first-job habit is to attach a capacity model to every system you build, even a rough one.

### Senior @ FAANG: Defining and Owning the SLA

A 99.9% uptime SLA (roughly 8.7 hours of downtime per year) sounds specific but is often underspecified. Staff-level questions to resolve before publishing this SLA: what counts as "down" (total unavailability vs. elevated error rate vs. P99 latency breach)? Does the SLA cover the entire platform or just the API gateway? How are planned maintenance windows handled? At L6/L7, you draft the SLA document and align with the on-call rotation, incident commanders, and legal (who may have customer contract obligations). The ADR for this project should record why 99.9% was chosen over 99.5% or 99.95%, including the cost difference in redundancy and the business impact of each tier.

---
