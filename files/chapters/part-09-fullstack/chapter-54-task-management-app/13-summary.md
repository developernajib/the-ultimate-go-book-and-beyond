## Summary

This chapter built a task management application that integrates five major subsystems:

1. **Go Backend**: Chi router with JWT authentication middleware, structured JSON error responses, and a service layer that separates business logic from HTTP concerns.
2. **React Frontend**: Redux Toolkit for state management, RTK Query for declarative API data fetching and cache invalidation, and `@dnd-kit` for accessible drag-and-drop.
3. **Real-Time Updates**: A WebSocket hub in Go that routes events to room-scoped subscribers, paired with a React hook that invalidates RTK Query caches on incoming messages.
4. **Database**: PostgreSQL with parameterized queries, the repository pattern for testable data access, and optimistic locking via version columns to prevent lost updates.
5. **Docker Deployment**: Multi-stage builds for both Go and React, an Nginx reverse proxy that handles SPA routing and WebSocket upgrades, and Docker Compose for single-command startup.

The key architectural takeaway: clean layering (handler -> service -> repository) pays for itself when you need to add WebSocket broadcasts, swap databases for testing, or trace a bug from the HTTP response back to the SQL query that produced it.

### Junior -> FAANG: Building a Portfolio Story from This Chapter

This chapter is interview-ready material if you have actually built it. The five subsystems map to five interview dimensions: backend design (service layer, repository pattern), authentication (JWT, refresh flows), real-time systems (WebSocket hub, reconnection), frontend architecture (Redux, RTK Query, optimistic updates), and DevOps (multi-stage Docker, Nginx, Compose). Each dimension is a conversation thread in a FAANG loop.

After building the application, write a two-paragraph summary of one decision you made that differs from the chapter's implementation and why. "I chose X instead of Y because..." is the most compelling interview answer you can give, because it demonstrates that you have thought about the tradeoffs, not just followed a tutorial.

Pick the hardest bug you encountered during implementation and memorize the debugging story: what symptoms appeared, what you checked first, what the actual root cause was, and how you verified the fix. Debugging stories are the clearest signal that you have hands-on experience.

### Senior @ FAANG: Summing the Architectural Decisions

The five subsystems described in this summary are individually correct choices. The senior-level question is how they compose: where are the coupling points, where will the system strain under growth, and what is the one-way door decision that forecloses future options?

The most consequential one-way door in this architecture is the WebSocket hub's in-process broadcast. Once the application has users who expect real-time updates, removing the WebSocket layer is a product regression. Adding multi-instance support requires a pub/sub layer at the hub boundary. That is a non-trivial migration with a cutover window. The time to make this decision is before the first user sees real-time updates, not after.

The second one-way door is the JWT token format. Once clients are storing and sending tokens, changing the claims structure requires a dual-read period (accept old and new formats simultaneously) or a forced logout of all users. Document the token schema as a versioned API contract from day one.

The clean layering described as the key takeaway is necessary but not sufficient. The layer that disciplines a growing team is the service interface: if the service layer accepts and returns concrete structs from the repository package, adding a second implementation (a cache-backed repository, an event-sourced repository) requires changing the service code. If the service layer depends on repository interfaces, adding an implementation is additive. At the scale of this application, the distinction is minor. At the scale of a team of 20 engineers contributing to the same service package, it is the difference between a manageable codebase and a coordination nightmare.

---
