# Chapter 54: Full-Stack Project - Task Management App

Reading about architecture patterns is one thing - wiring them together into a working application is another. The gap between understanding JWT authentication in isolation and implementing a secure token refresh flow that works across browser tabs and background workers is where integration-level thinking matters most. This chapter builds a complete task management application from scratch: a Go backend, a React frontend, a PostgreSQL database, and a WebSocket real-time layer.

Task management works well as a full-stack learning project because it touches every layer of a production system. Authentication requires session management and token security. Collaborative editing requires real-time WebSocket infrastructure. A Kanban board requires careful API design to support drag-and-drop state transitions without race conditions. Multi-user workspaces require row-level authorization that cannot be bypassed by crafted API requests.

The architecture follows clean layering: HTTP handlers delegate to service interfaces, services orchestrate repositories, and repositories abstract the database. This separation makes the authentication middleware testable in isolation, the WebSocket hub replaceable without touching business logic, and the repository layer swappable between PostgreSQL and an in-memory test double. By the end of this chapter you will have a deployable, Docker-composed application.

**What you'll learn in this chapter:**
- Architecting a full-stack application with clean separation between Go backend API, React SPA, and the contracts that connect them
- Implementing JWT authentication with secure HttpOnly cookie storage, silent token refresh flows, and logout-all-devices functionality
- Building a WebSocket hub in Go with room-based message routing, connection lifecycle management, and collaborative presence indicators
- Designing and implementing a Kanban board REST API that handles concurrent card moves without race conditions or lost updates
- Structuring a Go backend using clean architecture - handlers, service interfaces, repository pattern, and dependency injection with wire
- Creating a React frontend with RTK Query for API data fetching, optimistic updates on drag-and-drop, and real-time state reconciliation
- Writing integration tests that cover the full HTTP request lifecycle including authentication middleware and database state verification
- Deploying the complete stack with Docker multi-stage builds, nginx reverse proxy, and docker-compose for local and production environments

**Why this matters at scale:**
High-concurrency collaborative backends frequently rely on Go because its lightweight concurrency model handles real-time synchronization, WebSocket multiplexing, and presence tracking for thousands of simultaneous users with predictable memory overhead. Engineering publications from platforms like Linear (on local-first sync engines) and Asana (on recursive hierarchy data models and service boundaries) demonstrate how disciplined domain modeling and repository abstraction make collaborative data access paths auditable, testable, and resilient under load.

**Prerequisites:** Chapter 53 (frontend integration fundamentals), Chapter 33 (PostgreSQL and Go), Chapter 11 (Go concurrency), Chapter 39 (middleware and authentication)

### Junior -> FAANG: Why Full-Stack Projects Are Interview Proving Grounds

Full-stack projects reveal gaps that isolated exercises hide. If you have only built the backend or only the frontend, integration interviews will expose that boundary. Practice the handoff: know what your API contract looks like from the React side, and know what the network tab shows when the Go handler returns a 422.

Start by building this exact application end to end at least once without shortcuts. Understand why the CORS middleware must run before the JWT middleware. Know why HttpOnly cookies break the `Authorization` header pattern. Understand the difference between a WebSocket upgrade failure and a connection drop. These are the questions that separate candidates who have integrated from candidates who have read about integration.

Common first-job habits to build: always test authentication failure paths, not just the happy path. Read the browser network tab while your Go server logs are open. Write at least one integration test that boots the real HTTP server and makes a real HTTP request with an auth token before claiming a feature is done.

### Senior @ FAANG: Architectural Governance for Collaborative Real-Time Systems

At L6 and above, the question is not "can you build this" but "which decisions will you regret in eighteen months, and how do you prevent the team from making them."

**API contract governance.** Clean layering (handler, service, repository) is table stakes. The harder question is how you govern the contract between backend and frontend across independent deployments. At Linear's scale, a backend deploy that changes a JSON field name can silently break the client for users who have the old JavaScript bundle cached. The answer is an explicit contract layer: typed API schemas (OpenAPI, protobuf, or tRPC) with breaking-change detection in CI, not runtime discovery of incompatibilities.

**Real-time system maturity model.** The WebSocket hub described in this chapter is Level 1: a single-process, in-memory broadcast bus. It works until you deploy two backend instances. Level 2 requires a pub/sub layer (Redis Streams, NATS, or Kafka) so any backend instance can fan out to clients connected to any other instance. Level 3 adds ordered delivery guarantees, at-least-once or exactly-once semantics, and client-side resume tokens so reconnection does not cause missed events. Staff engineers are expected to name which level is appropriate for the current scale and to write the ADR that defers Level 3 complexity until the metrics justify it.

**Authorization surface.** The introduction mentions row-level authorization. At FAANG scale this means: does every repository method verify project membership before returning data, or do handlers check authorization and then call repositories that trust the caller? The repository-trusts-caller pattern is fast to write and fast to audit incorrectly. The correct model is defense in depth: the middleware checks token validity, the handler checks resource ownership, and the repository enforces tenant scoping in the WHERE clause so a misconfigured caller cannot accidentally cross tenant boundaries. A bar-raiser will ask: "if someone exploits a logic bug in the authorization middleware, what is the blast radius?" The answer should be "one tenant's data is accessible to the attacker, not all tenants."

**Platform thinking for task management systems.** Asana and Linear did not build one task management tool. They built a platform that other features are composed on top of: automations, integrations, reporting, mobile sync. The architectural choices made in Chapter 1 of the codebase either enable or foreclose that future. Specifically: if task mutations are only expressed as direct repository calls, adding an automation engine later requires touching every mutation site. If mutations are expressed as domain events (task created, task moved, task completed), the automation engine subscribes to the event stream without any mutation code changing. This is the difference between a senior engineer's first design and a staff engineer's design: the staff engineer asks "what will the next three teams need to build on top of this, and does my design require their cooperation to remain coherent?"

---
