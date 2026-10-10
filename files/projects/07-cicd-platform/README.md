# Project 07: CI/CD Pipeline Platform

A self-hosted CI/CD pipeline runner built in Go - similar in concept to GitHub Actions or GitLab CI. It parses pipeline YAML definitions, executes jobs inside Docker containers, streams logs over WebSocket, stores artifacts in S3-compatible storage, and exposes a REST API for pipeline management.

## Architecture Overview

```
Webhook (GitHub/GitLab)
        |
   [API Server]  ──── WebSocket (live logs)
        |
   [Redis Queue]
        |
   [Worker Pool]
        |
  [Docker Executor]
        |
  [PostgreSQL]  +  [MinIO / S3]
```

**Binaries:**
- `cmd/apiserver` - HTTP API + webhook ingestion + WebSocket hub
- `cmd/worker` - job executor (pulls from Redis queue, runs Docker containers)
- `cmd/cli` - operator CLI for manual triggers

**Key packages:**
- `internal/parser` - YAML pipeline definition parser and validator
- `internal/domain` - core types (Pipeline, PipelineRun, Job, JobRun, Artifact, Secret, Worker)
- `internal/executor` - Docker container executor and service orchestration
- `internal/storage` - PostgreSQL persistence layer
- `internal/storage/s3.go` - artifact upload/download via MinIO
- `internal/queue` - Redis-backed job queue
- `internal/git` - Git clone helpers and webhook payload parsing
- `internal/api` - HTTP handlers and chi router
- `internal/websocket` - WebSocket hub for real-time log streaming
- `internal/crypto` - AES-GCM secret encryption

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Go | 1.27+ | Build toolchain |
| Docker | 24+ | Container executor + local infra |
| Docker Compose | 2.x | Spin up PostgreSQL, Redis, MinIO |
| Make | any | Convenience targets |
| Git | 2.x | Repository cloning |

---

## Step-by-Step Build Guide

### Step 1 - Understand the Pipeline YAML Parser

**Files:** `internal/parser/types.go`, `internal/parser/parser.go`, `internal/parser/validator.go`

The parser reads `.pipeline.yaml` files (similar to `.github/workflows/*.yml`). A pipeline has named jobs, each with a Docker image, environment variables, and shell steps.

Example pipeline definition:
```yaml
name: Build and Test
on:
  push:
    branches: [main]

jobs:
  test:
    image: golang:1.27
    steps:
      - run: go test ./...
  build:
    image: golang:1.27
    needs: [test]
    steps:
      - run: go build -o bin/app ./cmd/...
```

**What to test:** Parse a valid YAML and assert job names, image, steps are populated. Parse an invalid YAML and assert an error is returned.

### Step 2 - Understand the Domain Models

**File:** `internal/domain/types.go`

All core business entities live here:
- `Pipeline` - the definition loaded from YAML and stored in PostgreSQL
- `PipelineRun` - one execution of a pipeline (has a status, commit SHA, trigger type)
- `JobRun` - one execution of a single job within a run (tracks start/end time, exit code, log path)
- `Artifact` - file produced by a job, stored in MinIO
- `Secret` - AES-GCM encrypted value scoped to a repository
- `Worker` - the executor process that picks up jobs from the Redis queue

**What to test:** Verify status constant values. Ensure UUID fields are populated correctly when creating new domain objects.

### Step 3 - Understand the Docker Executor

**Files:** `internal/executor/docker.go`, `internal/executor/executor.go`, `internal/executor/services.go`

The executor:
1. Pulls the Docker image specified in the job definition
2. Creates a container with environment variables and secret injection
3. Mounts a shared workspace volume
4. Streams stdout/stderr back to the WebSocket hub
5. Waits for container exit, captures the exit code
6. Uploads log output to MinIO as an artifact

`services.go` handles service containers (e.g., a PostgreSQL sidecar for integration tests) using Docker networks.

**What to test:** Mock the Docker client interface. Assert that a successful container run returns exit code 0. Assert that a non-zero exit code marks the job as failed.

### Step 4 - Understand Service Orchestration

**File:** `internal/executor/services.go`

Service containers (databases, caches) are started before job containers and linked via a Docker bridge network. They are torn down after the job completes regardless of success or failure.

**What to test:** Verify that service containers are removed even when the job fails (deferred cleanup).

### Step 5 - Understand Artifact Storage

**File:** `internal/storage/s3.go`

Artifacts are uploaded to MinIO (S3-compatible). The path convention is:
```
artifacts/{pipeline_run_id}/{job_run_id}/{filename}
```

Pre-signed URLs are generated for downloads so the API server does not need to proxy large files.

**What to test:** Mock the MinIO client. Assert upload stores the correct object key. Assert the pre-signed URL contains the expected path.

### Step 6 - Understand Webhook Handlers

**Files:** `internal/git/webhook.go`, `internal/git/clone.go`

`webhook.go` validates HMAC-SHA256 signatures on incoming GitHub/GitLab payloads, then extracts the repository URL, branch ref, and commit SHA. This data triggers a new `PipelineRun`.

`clone.go` provides a helper that shells out to `git clone` with a deploy key or token, checking out the specific commit SHA.

**What to test:** Feed a known payload with a valid HMAC signature - assert parsing succeeds. Feed a tampered payload - assert an error is returned.

### Step 7 - Understand the API Routes

**Files:** `internal/api/handlers.go`, `internal/api/routes.go`

The chi router exposes:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check |
| POST | `/api/v1/webhooks/{provider}` | Receive GitHub or GitLab webhook |
| GET | `/api/v1/pipelines/{pipelineId}/runs` | List runs for a pipeline |
| GET | `/api/v1/runs/{runId}` | Get a single pipeline run |
| GET | `/api/v1/jobs/{jobRunId}/logs` | Stream or fetch job logs |

All handlers use `chi.URLParam` for path parameters. Errors are returned as JSON `{"error": "..."}`.

**What to test:** Use `net/http/httptest` to call each handler. Assert status codes and response shapes.

### Step 8 - Understand the Job Queue and Scheduler

**File:** `internal/queue/queue.go`

Jobs are pushed onto a Redis list (LPUSH) by the API server when a pipeline run is created. Workers block on BRPOP to pull jobs. The queue payload includes the job run ID, image, steps, and secrets.

The worker (`cmd/worker/main.go`) runs a pool of goroutines, each blocking on the queue.

**What to test:** Push a job onto a test Redis instance (or mock). Assert the worker receives and parses the payload correctly.

### Step 9 - Wire Everything in main.go

**File:** `cmd/apiserver/main.go`

`main.go` reads environment variables, connects to PostgreSQL, starts the WebSocket hub, wires the handler, and starts the HTTP server with graceful shutdown on `SIGTERM`.

**What to test:** Run `go build ./...` with no errors. Start the server with `make run` and hit `GET /health`.

---

## Running the Project

### 1. Start infrastructure

```bash
make infra-up
```

This starts PostgreSQL (port 5432), Redis (port 6379), and MinIO (port 9000) via Docker Compose.

### 2. Copy environment file

```bash
cp .env.example .env
```

Edit `.env` if you need to change any defaults.

### 3. Run the API server

```bash
make run
```

### 4. Run a worker (separate terminal)

```bash
make run-worker
```

### 5. Run tests

```bash
make test
```

### 6. Build binaries

```bash
make build
```

Produces `bin/apiserver`, `bin/worker`, `bin/cli`.

### 7. Docker build

```bash
make docker-build
```

---

## API Endpoints

### Health

```
GET /health
→ 200 OK
```

### Receive Webhook

```
POST /api/v1/webhooks/{provider}
provider: github | gitlab
Headers:
  X-Hub-Signature-256: sha256=<hmac>   (GitHub)
  X-Gitlab-Token: <token>               (GitLab)
Body: GitHub/GitLab push payload JSON
→ 200 {"status": "accepted"}
```

### List Pipeline Runs

```
GET /api/v1/pipelines/{pipelineId}/runs
→ 200 [{"id": "...", "status": "success", "commit": "abc123", ...}]
```

### Get Pipeline Run

```
GET /api/v1/runs/{runId}
→ 200 {"id": "...", "status": "running", "jobs": [...]}
```

### Get Job Logs

```
GET /api/v1/jobs/{jobRunId}/logs
→ 200 plain text log output
```

---

## Environment Variables

See `.env.example` for the full list with descriptions.

---

## Project Structure

```
07-cicd-platform/
├── cmd/
│   ├── apiserver/main.go   # HTTP server entrypoint
│   ├── worker/main.go      # Job executor entrypoint
│   └── cli/main.go         # CLI entrypoint
├── internal/
│   ├── api/                # HTTP handlers and router
│   ├── crypto/             # AES-GCM secret encryption
│   ├── domain/             # Core business types
│   ├── executor/           # Docker execution engine
│   ├── git/                # Webhook parsing and git clone
│   ├── parser/             # Pipeline YAML parser
│   ├── queue/              # Redis job queue
│   ├── storage/            # PostgreSQL + S3 storage
│   ├── websocket/          # Real-time log streaming
│   └── worker/             # Worker pool logic
├── migrations/             # SQL migration files
├── docker-compose.yml
├── Makefile
└── .env.example
```
