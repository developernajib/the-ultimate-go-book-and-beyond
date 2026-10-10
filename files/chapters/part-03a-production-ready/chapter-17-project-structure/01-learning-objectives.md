## Learning Objectives

By the end of this chapter, you will be able to:

1. **Choose a defensible project layout** and scale it up only as the project earns the complexity
2. **Organize packages by feature** rather than by layer for better cohesion
3. **Implement dependency injection** without complex frameworks
4. **Structure configuration** for different environments
5. **Design error handling** that maps cleanly to HTTP responses
6. **Set up testing infrastructure** for unit, integration, and e2e tests
7. **Create production-ready build systems** with Makefiles and Docker
8. **Apply patterns from industry leaders** to your own projects

### Detailed Outcomes

**Mid-level engineer**

- Bootstrap a new Go service with a defensible layout in under an hour.
- Organize code by feature, not by technical layer.
- Use `internal/` to enforce private boundaries.
- Wire dependencies explicitly at the composition root rather than globally.

**Senior engineer**

- Push back in review on god packages, layer-based directories, and unnecessary `pkg/` usage.
- Recognize when a project's complexity has outgrown a flat layout and propose the layered evolution.
- Design clean boundaries between domain, application, and infrastructure layers.

**Staff or Principal**

- Drive the org-wide layout standard: socialize it, document it, enforce it.
- Evolve the standard as Go and the business change, retiring outdated conventions (`pkg/` is one).
- Measure consistency across services and investigate outliers.
- Own the onboarding artifact that teaches the standard to new engineers in day one.

---
