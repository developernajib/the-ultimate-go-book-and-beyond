## Learning Objectives

By the end of this chapter, you will be able to:

- **Architect a full-stack application** with clear separation between backend API and frontend SPA
- **Implement JWT authentication** with secure token management and refresh flows
- **Build real-time WebSocket updates** for collaborative task management
- **Create a Kanban board interface** with drag-and-drop functionality using React DnD
- **Design a RESTful API** that integrates with RTK Query for cache management
- **Structure a Go backend** using clean architecture with handlers, services, and repositories
- **Deploy the full stack** using Docker, nginx reverse proxy, and docker-compose
- **Apply production patterns** from Asana, Monday.com, and Linear

### Junior -> FAANG: Using Learning Objectives as Interview Checkboxes

Each bullet in this list is a topic a FAANG interviewer can probe at the coding, design, or behavioral level. Before your interview, map each objective to a concrete example from your own experience. "Implement JWT authentication" should connect to a real token refresh edge case you debugged, not just to reading about JWT. "Deploy with Docker" should connect to a specific misconfiguration you found and fixed.

Candidates who can speak to the tradeoffs inside each objective ("I chose HttpOnly cookies over localStorage because...") outperform candidates who can only demonstrate that they have done the thing. Prepare one sentence on the why for every objective on this list.

### Senior @ FAANG: Reading Learning Objectives as Design Scope Signals

A staff-level engineer reads a list like this and immediately identifies the omissions. JWT authentication is listed, but token revocation is not. WebSocket updates are listed, but fan-out across multiple backend replicas is not. Docker deployment is listed, but secret rotation, zero-downtime migration, and distributed tracing are not.

This is intentional scope control for a learning chapter. At the bar-raiser level, you are expected to articulate what is in scope and what is deliberately deferred, and to write that down as an ADR. A senior candidate who sees "JWT with refresh flows" on a design brief should immediately ask: "Are we designing for logout-all-devices, short-lived access tokens, or a long-lived session model? What is the token revocation strategy when a user is compromised?" The answer shapes every subsequent decision. The learning objective is the starting point, not the ending point.

---
