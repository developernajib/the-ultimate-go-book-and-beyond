## The Two Faces of DDD

Domain-Driven Design operates at two levels:

**Strategic DDD** deals with the big picture. It asks: what are the major areas of the business? Where are the natural boundaries? Which parts of the system are core to competitive advantage, and which are generic support? Strategic DDD gives us tools - Bounded Contexts, Context Maps, the Core Domain, Generic Subdomains - that help large teams working on large systems avoid the chaos of a "Big Ball of Mud" that grows without structure until nobody can reason about it.

**Tactical DDD** deals with the implementation. It gives us concrete building blocks - Entities, Value Objects, Aggregates, Repositories, Domain Services, Domain Events, Application Services - that we use to build a rich, expressive domain model inside a single bounded context. Tactical DDD is where the code lives. It is where Go shines.

Both levels matter. A team that does tactical DDD without strategic DDD will build beautifully structured bounded contexts that are in completely the wrong places. A team that does strategic DDD without tactical DDD will draw excellent diagrams and then write anemic CRUD code that fails to capture domain logic.

---
