## 52B.13 Common Mistakes

**1. Putting domain logic in application services.**

Application services should orchestrate, not implement business rules. If you find yourself writing `if order.Status == "pending" && time.Since(order.PlacedAt) < 30*time.Minute` in an application service, move that logic into the domain.

**2. Anemic aggregates with getters and setters.**

If your aggregate exposes `SetStatus(s string)` instead of `Cancel()`, `Fulfill()`, `Confirm()`, you have an anemic model. Replace setters with intention-revealing domain operations.

**3. Giant aggregates.**

The most common tactical DDD mistake. If your aggregate spans 10 entities and loading it requires 15 database joins, it is too large. Question every entity - does it truly need transactional consistency with the root, or can it be eventually consistent?

**4. Referencing entities across aggregate boundaries.**

Do not put an `Inventory` entity inside an `Order` aggregate. Cross-aggregate references use IDs only. An order line holds a `ProductSKU`, not a `*Product`.

**5. Too many bounded contexts too early.**

Extracting bounded contexts prematurely, before the domain boundaries are clear, creates distributed monolith problems. Start with a modular monolith - well-defined packages with clear interfaces - and extract to separate services only when the boundaries are validated.

**6. Ignoring the ubiquitous language in code.**

Naming things `Manager`, `Handler`, `Processor`, `Service` generically erases the ubiquitous language. Name things after domain concepts: `PricingService`, `FulfillmentCoordinator`, `PaymentProcessor` (only if "processor" is the domain term).

**7. Using domain events for synchronous validation.**

Domain events are for facts that already happened. They are not commands. If you emit an `OrderPlacing` event (present tense) and an event handler validates and rejects it, you have confused events with commands. Use a command + validation pattern for synchronous flows.

### Junior → FAANG: Building the Habit of Catching These Mistakes Early

Most of these mistakes are invisible until the system is large enough for the debt to compound. The way to catch them early is to ask the right questions during design and code review.

For the anemic aggregate mistake: in every pull request that adds behavior to a service class, ask "could this logic live in the aggregate method instead?" If the answer is yes and the logic is a domain rule (not orchestration or infrastructure), the PR is placing logic in the wrong layer.

For the giant aggregate mistake: when writing a new repository implementation, count the number of SQL joins required to load the aggregate. More than three to four joins is a warning sign. More than eight is a strong signal to reconsider the boundary.

For the present-tense event naming mistake: set up a linter or naming convention check in CI. Event types that end in `-ing` (present participle) are commands or queries. Events that ended in `-ed` (past participle) are correct. This is a rule simple enough to enforce automatically.

For first-job engineers, the most impactful habit is the simplest: before adding a new method to a service class, check whether it belongs on a domain object. If the method's body reads "check if the domain object's state allows this, then update the state," it belongs on the domain object.

### Senior @ FAANG: Systemic Prevention and Architectural Enforcement

Common mistakes in DDD do not happen once. They are systemic patterns that emerge when the codebase grows beyond the span of control of the engineers who designed it. Senior engineers prevent them systemically, not by catching them in code review one at a time.

**Linting for layering violations.** The most valuable custom lint rule in a DDD Go codebase is an import graph check: the domain package must not import any infrastructure package. This is automatable with `golang.org/x/tools/go/analysis` or with a simpler tool like `depguard` or `go-cleanarch`. The rule is declared once in a CI check and catches violations before they merge. Without this, layering violations accumulate silently: one engineer imports a logging library into the domain package because it is convenient, and six months later the domain package has fifteen infrastructure dependencies.

**Architecture tests as executable design documents.** Beyond import graph checks, architecture tests can assert that every concrete struct in the infrastructure package implements the interface declared in the domain package (`_ domain.OrderRepository = (*PostgresOrderRepository)(nil)`). These compile-time checks ensure that the interface-implementation contract is maintained as both evolve. They are the Go equivalent of the interface segregation principle enforced at the language level.

**Preventing premature context extraction through team process.** The "too many bounded contexts too early" mistake is a process problem as much as a technical one. Teams that create new microservices for every new feature are often operating under an incentive structure that rewards creating services (it looks like progress) over getting the boundaries right. The governance remedy is an architecture review board that requires a documented justification for every new bounded context, including: the linguistic boundary evidence, the team ownership plan, the integration pattern with adjacent contexts, and an estimate of the operational cost (new CI pipeline, new deployment, new on-call rotation). This overhead is not bureaucracy. It is the cost of preventing distributed monolith accumulation.

**Remediation strategy for existing anemic models.** When you inherit a codebase with an anemic domain model, the remediation is incremental: identify the most complex service method, move its business logic into the aggregate, write tests at the aggregate level, and delete the service method. Repeat for each rule. Do not attempt to rewrite the entire domain layer at once. The Strangler Fig pattern applied to anemic service methods: new business rules go into the aggregate from day one, and existing service methods are migrated opportunistically during feature work. This produces a measurable improvement in the defect rate for the migrated domain objects within one to two quarters.

---
