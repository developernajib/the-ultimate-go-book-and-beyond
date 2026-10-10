## 17.2 Package Organization

### Organizing by Feature (Recommended)

Feature-based organization places all code for a single domain concept, its handlers, service logic, data access, and models, under one directory. This layout mirrors how the team thinks about the product, keeps related changes co-located, and makes it easy for individual teams to own discrete slices of the codebase without needing to touch shared layer directories.

```
internal/
├── user/
│   ├── handler.go      # HTTP handlers
│   ├── service.go      # Business logic
│   ├── repository.go   # Data access
│   └── model.go        # Domain models
├── order/
│   ├── handler.go
│   ├── service.go
│   ├── repository.go
│   └── model.go
└── payment/
    └── ...
```

This approach:
- Groups related code together, so a feature change touches one directory
- Makes dependencies between features explicit, because they become real imports
- Simplifies finding code
- Enables team ownership along package lines

The cost is the flip side of that second point. Once `user` and `order` are separate packages, a mutual reference is an import cycle and the build fails outright:

```
package feat/internal/order
    imports feat/internal/user from order.go
    imports feat/internal/order from user.go: import cycle not allowed
```

This is a feature, not a bug. The compiler is refusing to let two features quietly fuse into one. The fix is to break the cycle deliberately: hoist the shared type into a third package that both import, define the interface in the consumer rather than the producer, or accept that the two concepts are really one. What you must not do is dissolve the boundary by merging the packages just to silence the error.

### Organizing by Layer (Avoid for Large Projects)

Layer-based organization groups all HTTP handlers together, all services together, and all repositories together, regardless of which domain feature they belong to. It is intuitive for small projects, and it is what most people reach for first.

```
internal/
├── handlers/
│   ├── user.go
│   └── order.go
├── services/
│   ├── user.go
│   └── order.go
├── repositories/
│   ├── user.go
│   └── order.go
└── models/
    ├── user.go
    └── order.go
```

Problems with layered organization:

- **Every feature change is shotgun surgery.** Adding a field to an order means edits in four directories. Nothing is co-located.
- **Packages become god packages.** `services` accumulates every service in the product. It has no coherent purpose you can state in one sentence, which is the classic sign that a package is not a package.
- **The separation is artificial.** `handlers` is not a concept in your business domain. Nobody has ever filed a bug against "the services layer".
- **Ownership cannot follow the code.** Two teams editing `services/` fight over the same directory forever.

Note what is *not* on that list: import cycles. Layer-based layouts are actually resistant to cycles, for an unflattering reason. If `user.go` and `order.go` both live in package `services`, they can reference each other freely, because Go's cycle rule operates between packages and there is only one package here. The structure does not prevent the tangle, it just hides it below the granularity the compiler checks. Feature-based layouts surface that same tangle as a build error. That is the trade: layers give you silence, features give you a compiler that tells you when your domain boundaries are wrong.

### Hybrid Approach for Complex Domains

The hybrid approach borrows from Domain-Driven Design by separating the pure business domain from the use-case orchestration layer and the infrastructure adapters that connect to external systems. This structure keeps core domain logic free of framework and persistence concerns, making it highly testable, while still providing clear extension points in `infrastructure/` and `interfaces/` as the application grows.

```
internal/
├── domain/           # Core business logic
│   ├── user/
│   └── order/
├── application/      # Use cases
│   ├── createorder/
│   └── processrefund/
├── infrastructure/   # External services
│   ├── postgres/
│   └── stripe/
└── interfaces/       # Entry points
    ├── http/
    └── grpc/
```

### Staff Lens: Layered Structure Is for Complex Projects

The hybrid approach is correct for projects with genuinely complex domain logic. For simpler services (CRUD API, small microservice), it is over-engineering. The staff-level rule: start with feature-based organization. Graduate to the hybrid domain/application/infrastructure split only when the service has rich business rules independent of frameworks.

Most Go services never need the full Clean Architecture treatment. The services that do benefit substantially from it. Know which class your service belongs to.

---
