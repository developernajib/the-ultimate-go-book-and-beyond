## System Architecture

### High-Level Architecture

The CI/CD platform consists of four main components: an API server that accepts pipeline triggers, a scheduler that dispatches jobs to workers, a worker pool that executes steps inside containers, and a dashboard that streams build logs in real time.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          CI/CD PLATFORM ARCHITECTURE                         │
└──────────────────────────────────────────────────────────────────────────────┘

                                   Internet
                                      │
                    ├─────────────────┼─────────────────┐
                    │                 │                 │
                    ▼                 ▼                 ▼
            ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
            │ Git Webhooks │  │ Web Browser  │  │   Git CLI    │
            │  (GitHub)    │  │  Dashboard   │  │   (trigger)  │
            └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
                   │                 │                  │
                   └────────┬────────┴──────────────────┘
                            │
                            ▼
                   ┌────────────────┐
                   │  Load Balancer │
                   │    (nginx)     │
                   └────────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             ▼             ▼
      ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
      │ API Server  │ │ API Server  │ │ API Server  │
      │   (Go)      │ │   (Go)      │ │   (Go)      │
      └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
             │               │               │
             └───────┬───────┴───────┬───────┘
                     │               │
         ┌───────────┼───────────────┼───────────────┐
         │           │               │               │
         ▼           ▼               ▼               ▼
    ┌─────────┐ ┌─────────┐  ┌─────────────┐  ┌──────────┐
    │ Postgres│ │  Redis  │  │ Redis Queue │  │   MinIO  │
    │   DB    │ │  Cache  │  │   (Jobs)    │  │ (S3 API) │
    └─────────┘ └─────────┘  └──────┬──────┘  └──────────┘
                                     │
                     ┌───────────────┼───────────────┐
                     │               │               │
                     ▼               ▼               ▼
              ┌───────────┐   ┌───────────┐   ┌───────────┐
              │  Worker 1 │   │  Worker 2 │   │  Worker N │
              │  (Go)     │   │  (Go)     │   │  (Go)     │
              └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
                    │               │               │
                    ▼               ▼               ▼
              ┌───────────┐   ┌───────────┐   ┌───────────┐
              │  Docker   │   │  Docker   │   │  Docker   │
              │  Runtime  │   │  Runtime  │   │  Runtime  │
              └───────────┘   └───────────┘   └───────────┘
```

### Component Breakdown

#### 1. API Server (`cmd/apiserver`)
- HTTP server handling webhooks and API requests
- Pipeline creation and management
- Artifact upload/download endpoints
- WebSocket server for log streaming
- Authentication and authorization

#### 2. Worker (`cmd/worker`)

- Job consumer from Redis queue
- Container executor (Docker API)
- Log collector and shipper
- Artifact uploader
- Health reporter

#### 3. Database (PostgreSQL)

PostgreSQL stores pipeline definitions, execution history, job metadata, build artifacts, and encrypted secrets. The core tables are:

```sql
-- Core tables
pipelines        -- Pipeline definitions
pipeline_runs    -- Execution instances
jobs             -- Individual job definitions
job_runs         -- Job execution instances
artifacts        -- Build artifacts metadata
repositories     -- Git repository configs
secrets          -- Encrypted secrets
```

#### 4. Job Queue (Redis Streams)

Redis Streams provide a durable, ordered job queue with consumer group support. Workers claim pending jobs atomically, and unacknowledged jobs are automatically reassigned after a timeout.

```
Stream: jobs:pending
Consumer Groups: workers
Messages: {job_id, priority, created_at}
```

#### 5. Object Storage (MinIO/S3)

File uploads are streamed directly from the multipart request body to S3 object storage without buffering the full payload in memory, keeping memory usage constant regardless of file size. Pre-signed URLs allow clients to download attachments directly from S3, bypassing the application server for large binary transfers.

```
Buckets:
  - artifacts/     -- Build outputs
  - logs/          -- Job execution logs
  - cache/         -- Dependency caches
```

### Data Flow

#### Pipeline Execution Flow

A pipeline execution follows this sequence from webhook receipt through artifact upload:

```
1. Webhook Received
   ┌─────────────────────┐
   │ GitHub Webhook      │
   │ POST /webhooks/git  │
   └──────────┬──────────┘
              │
              ▼
2. Validation & Parsing
   ┌─────────────────────┐
   │ Verify Signature    │
   │ Parse Payload       │
   │ Extract Repo/Commit │
   └──────────┬──────────┘
              │
              ▼
3. Pipeline Creation
   ┌─────────────────────┐
   │ Clone Repository    │
   │ Read .pipeline.yaml │
   │ Parse Pipeline Def  │
   └──────────┬──────────┘
              │
              ▼
4. Job Scheduling
   ┌─────────────────────┐
   │ Create PipelineRun  │
   │ Create JobRuns      │
   │ Enqueue Jobs        │
   └──────────┬──────────┘
              │
              ▼
5. Job Execution (Worker)
   ┌─────────────────────┐
   │ Dequeue Job         │
   │ Pull Docker Image   │
   │ Start Container     │
   │ Stream Logs         │
   │ Collect Artifacts   │
   │ Update Status       │
   └──────────┬──────────┘
              │
              ▼
6. Completion
   ┌─────────────────────┐
   │ Aggregate Results   │
   │ Send Notifications  │
   │ Update Git Status   │
   └─────────────────────┘
```

---

### Junior → FAANG: Reading Architecture Diagrams as Data Flow

Junior engineers read architecture diagrams as box-and-arrow pictures. The correct reading is as a data flow: follow one job from webhook receipt to artifact upload and ask at each arrow what the failure mode is. If the API server crashes after enqueuing the job but before acknowledging the webhook, does GitHub retry and create a duplicate job? That is an at-least-once vs. exactly-once question. Practice by annotating every arrow in this diagram with the guarantee it provides: "durable write," "at-most-once," or "best-effort."

### Senior @ FAANG: Architecture Review at the Component Boundary Level

Staff engineers reviewing this architecture ask boundary questions: what is the contract between the API server and the job queue? Is it synchronous (API blocks until job is enqueued and durable) or asynchronous (fire-and-forget to a non-durable channel)? Each boundary choice propagates a consistency model to the user. If the webhook acknowledgment is sent before the job is durably written to Postgres, users will see "pipeline triggered" in the UI but the pipeline may never run after a crash. The ADR must document the chosen consistency level per boundary, not just per component. At L6, you also audit the diagram for single points of failure: the API server, the queue, and the worker coordinator are all candidates. Each requires a failover story, not just replication.

---
