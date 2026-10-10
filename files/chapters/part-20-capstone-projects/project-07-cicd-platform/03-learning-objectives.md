## Learning Objectives

By completing this project, you'll master:

### 1. Distributed Systems
- Job queue design and implementation
- Worker pool management
- Distributed locking for resource coordination
- Graceful shutdown in distributed contexts

### 2. Container Orchestration
- Docker API programmatic usage
- Container lifecycle management
- Resource limits (CPU, memory, network)
- Volume mounts and cleanup

### 3. Real-Time Communication
- WebSocket connection management
- Server-Sent Events (SSE) for log streaming
- Fan-out messaging patterns
- Connection pooling and cleanup

### 4. Database Design
- Time-series data (logs, metrics)
- Job state machines
- Indexing for query performance
- Data retention policies

### 5. API Design
- RESTful API best practices
- Webhook signature verification
- Rate limiting
- API versioning

### 6. Production Operations
- Structured logging
- Distributed tracing
- Metrics and alerting
- Health checks and readiness probes

### 7. Security
- Secret management
- Sandboxing untrusted code
- Authentication and authorization
- Input validation and sanitization

---

### Junior → FAANG: Mapping Objectives to Interview Topics

Each objective in this list maps to a class of interview question. "Job queue design" maps to "design a task scheduler." "Container isolation" maps to "how do you prevent one tenant's job from reading another's files?" "Distributed locking" maps to "what happens if two workers claim the same job simultaneously?" Before starting implementation, write one interview question per objective. That habit forces you to understand why you are building each component, not just how.

### Senior @ FAANG: Using Learning Objectives as a Platform Capability Matrix

Staff engineers use learning objectives as a capability matrix when evaluating whether to build, buy, or adopt an open-source solution. Map each objective to a feature in GitHub Actions, Tekton, and Argo Workflows. Where open-source already excels (container isolation via Kubernetes, artifact storage via OCI registries), the build decision needs a strong justification. Differentiated capabilities, such as custom pipeline scheduling policies or deep integration with internal secret stores, are the only valid reasons to build. Document this analysis in the project's ADR before writing code, and use it to scope the initial MVP rather than building all objectives in phase one.
