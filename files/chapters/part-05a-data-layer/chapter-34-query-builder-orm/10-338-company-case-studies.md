## 34.8 Company Case Studies

### Stripe-Style Type Safety: Idempotent Payment Queries with sqlc

Payment processing demands that every query is correct and that schema changes are caught before deployment, not in production. A Stripe-style approach uses sqlc to generate idempotent insert queries with `ON CONFLICT`, ensuring that retried payment requests do not create duplicate records. The generated Go code enforces that every required field is provided at compile time.

```go
// Stripe-style sqlc queries for payment processing
// -- name: CreatePaymentIntent :one
// INSERT INTO payment_intents (
//     idempotency_key, amount_cents, currency, customer_id, status, metadata
// ) VALUES ($1, $2, $3, $4, 'requires_payment_method', $5)
// ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()
// RETURNING *;
type PaymentService struct {
	queries *db.Queries
}

func (s *PaymentService) CreatePaymentIntent(ctx context.Context, req CreatePaymentRequest) (*PaymentIntent, error) {
	// Idempotent by design
	result, err := s.queries.CreatePaymentIntent(ctx, db.CreatePaymentIntentParams{
		IdempotencyKey: req.IdempotencyKey,
		AmountCents:    req.AmountCents,
		Currency:       req.Currency,
		CustomerID:     req.CustomerID,
		Metadata:       req.Metadata,
	})

	if err != nil {
		return nil, fmt.Errorf("creating payment intent: %w", err)
	}

	return toPaymentIntent(result), nil
}
```

### The Repository Factory for Multi-Backend Platforms

Large platforms often need different database backends for different deployment environments, PostgreSQL in production, MySQL in legacy services, and in-memory stores for tests. A repository factory selects the concrete implementation at startup based on configuration, while the service layer programs against the interface only.

```go
// Shopify-style repository factory
type RepositoryFactory struct {
	config *Config
}

func (f *RepositoryFactory) NewUserRepository() UserRepository {
	switch f.config.DatabaseType {
	case "postgresql":
		return NewSQLCUserRepository(f.config.PGPool)
	case "mysql":
		return NewGORMUserRepository(f.config.GormDB)
	default:
		return NewInMemoryUserRepository() // For testing
	}
}

// Service doesn't know which implementation is used
type UserService struct {
	repo UserRepository
}

func NewUserService(repo UserRepository) *UserService {
	return &UserService{repo: repo}
}

func (s *UserService) GetUser(ctx context.Context, id int64) (*User, error) {
	return s.repo.GetByID(ctx, id)
}
```

### Query Builders for Dynamic Filters at Ride-Hailing Scale

Ride-hailing platforms filter trips by driver, rider, geographic proximity, time range, and status, all optional and combinable. A query builder handles this cleanly because each filter is a conditional `.Where` call. The geospatial filter below uses PostGIS's `ST_DWithin` to find trips within a given radius, passed as a raw SQL fragment with parameterized coordinates.

```go
// Uber-style trip search with dynamic filters
func (r *TripRepository) SearchTrips(ctx context.Context, filter TripFilter) ([]Trip, error) {
	query := sq.StatementBuilder.PlaceholderFormat(sq.Dollar).
		Select("t.*", "d.name as driver_name", "r.name as rider_name").
		From("trips t").
		LeftJoin("users d ON t.driver_id = d.id").
		LeftJoin("users r ON t.rider_id = r.id")

	// Dynamic filters based on user role
	if filter.DriverID != nil {
		query = query.Where(sq.Eq{"t.driver_id": *filter.DriverID})
	}
	if filter.RiderID != nil {
		query = query.Where(sq.Eq{"t.rider_id": *filter.RiderID})
	}

	// Geospatial filter
	if filter.NearLocation != nil {
		query = query.Where(`
			ST_DWithin(
				t.pickup_location::geography,
				ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
				?
			)
		`, filter.NearLocation.Lng, filter.NearLocation.Lat, filter.RadiusMeters)
	}

	// Time range
	if filter.StartAfter != nil {
		query = query.Where(sq.GtOrEq{"t.started_at": *filter.StartAfter})
	}
	if filter.EndBefore != nil {
		query = query.Where(sq.Lt{"t.ended_at": *filter.EndBefore})
	}

	// Status filter (multiple values)
	if len(filter.Statuses) > 0 {
		query = query.Where(sq.Eq{"t.status": filter.Statuses})
	}

	return r.executeQuery(ctx, query)
}
```

### Junior → FAANG: Reading Case Studies Without Cargo-Culting

The easy mistake when reading company case studies is "Stripe uses sqlc, therefore I must use sqlc." Case studies are data points, not commands. The first-job skill is reading the constraints behind the choice, not just the choice. Stripe picked sqlc because payment correctness demands handwritten, reviewable SQL and type-safe generated code. If your domain is a blog, those constraints do not apply and sqlc's overhead is not justified. If your domain is any financial ledger, audit system, or regulated workflow, those constraints do apply exactly and you should take the hint.

First-job reading technique. For each case study, answer four questions before adopting anything. What was the company's constraint (correctness, throughput, team size, audit requirements). What was the alternative they rejected (ActiveRecord, GORM, raw SQL). Why did that alternative fail for them specifically. Does my team share that constraint. If you cannot answer the fourth question with "yes, exactly," the case study is reference material, not a recipe.

Worked example. "You read that Uber uses custom DB tooling including M3DB for metrics. Should our 20-engineer startup build custom DB tooling." No. Uber's constraint is billions of rows per day of time-series data at p99 latency under 10ms. Your constraint is probably "ship features fast and do not lose data." The useful lesson from the Uber case is not "build your own DB," it is "choose a storage engine that matches your access pattern," which for you probably means Postgres with good indexing, not M3DB.

Interview signal. When an interviewer asks "how would you design this," a strong candidate cites one relevant case study with its constraint context and a weak candidate lists three unrelated ones as name-dropping. "Stripe's sqlc pattern fits because our ledger has the same idempotency requirement" is strong. "FAANGs use sqlc so we should too" is weak.

### Senior @ FAANG: The Real Case Studies, What They Chose, and Why

Staff engineers read case studies for the ADR inputs, not the outputs. The section above covers Stripe, Shopify, and Uber at code-sample depth. The real senior material is what the engineering blogs of the last three years actually say about data-layer choices, and what you can defend in a design review.

Type safety on the payment hot path. For payment-grade services the argument for a codegen approach like sqlc is concrete: every query must be reviewed by a human, every generated type must be checked by the compiler, and no reflection runs on the hot path. The pattern that pays off just as much is CI discipline around the tool: a custom query-plan checker that runs `EXPLAIN` against a snapshot of production schema statistics and fails the build if a query regresses to a seq scan. That CI check is the hidden lesson. Tool choice is half the value, CI discipline around the tool is the other half. Build the check, not just adopt the tool.

Migrating off a Rails monolith. The well-documented industry pattern for teams that ran Ruby on Rails for a decade and hit N+1 storms and cold-cache latency walls is to peel off latency-sensitive services one bounded context at a time. The pattern is strangler-fig: new features in the new stack, legacy features stay in Ruby, a thin gateway (often GraphQL) merges results. The senior lesson is not "rewrite everything," it is "migrate by bounded context, never by line of code, and never big-bang." Any staff engineer proposing a full data-layer rewrite without a bounded-context plan should be pushed back hard.

Uber and M3DB. Uber built M3DB because no off-the-shelf time-series DB handled their metric cardinality at their latency. They also built custom sharded storage tooling: Schemaless was the MySQL-backed previous generation, and modern Docstore is a sharded MySQL datastore with their own transaction and proxy layers (Uber migrated its core OLTP off Postgres to MySQL in 2016). The senior lesson: at some scale the DB itself becomes a platform team problem and application Go code talks to an internal RPC, not to Postgres directly. If you are under 100 engineers you will never hit this. If you are at 1000+, you will, and the architecture bifurcates into "app teams" and "data platform teams" whose only contract is a gRPC interface. Design your repository layer so that swap is feasible even if you never do it.

Shopify, Rails, Vitess. Shopify runs Rails on sharded MySQL with Vitess (the sharding middleware that originated at YouTube for MySQL). Their Go services use GORM historically and are migrating select components to sqlc, but the center of gravity remains Rails. The lesson for Go shops: Shopify's scale with Rails proves that "Rails does not scale" is wrong, what does not scale is "Rails without discipline." The same is true of GORM. GORM at 300 engineers without review discipline is chaos. GORM with a repository pattern, a linter banning raw `.Where("...")` concat, and a slow-query CI gate is fine.

Meta's MySQL and TAO. Meta runs MySQL under a graph layer called TAO. Application code does not speak SQL, it speaks graph operations (get node, get edge, traverse). The SQL-level design is hidden. Go services at Meta-adjacent companies that replicate this pattern (LinkedIn's Espresso, Pinterest's internal equivalents) use a repository layer whose methods are graph verbs, not CRUD verbs. The senior lesson is that the right repository abstraction matches your domain's natural verbs. A social graph repository with `GetFriendsOfFriends(ctx, userID)` is a better abstraction than a generic `Query(ctx, filter)` that the service has to compose from scratch each call.

Google's Spanner client libraries. Google's Go client for Spanner is the reference design for distributed-transaction-aware clients. It surfaces read-write transactions, read-only transactions with bounded staleness, and partitioned reads for batch jobs, each with distinct types in the API. You cannot accidentally do a read-write tx when you needed a stale read, because the types do not compose. The lesson for non-Google code is "model transaction intent in the type system, not in runtime configuration." If your repository has a single `Query` method that sometimes runs in a tx and sometimes does not based on context, you have conflated intents that should be separate method names.

Notion's sharded Postgres. Notion published (in 2021 and again in 2023) on their migration from a single Postgres to 480 logical shards across 32 (later 96) physical instances, fronted by roughly 100 PgBouncer instances and a custom shard router. Their application repository layer had to be rewritten to route queries by workspace ID to the correct shard. The senior lesson: if you anticipate sharding, bake a "shard key" concept into your repository interface today, even if the current implementation ignores it. Adding a shard key after the fact is a six-month migration. Leaving a `shardKey` field on filter structs that the implementation currently treats as a no-op is a one-hour retrofit that pays off forever.

Synthesizing the case studies into an ADR checklist. When you are choosing a data layer for a new FAANG-tier Go service, the questions the case studies suggest are these. Do we have an idempotency requirement (Stripe). Do we have a migration-from-legacy constraint (Airbnb). Do we have a time-series or metric hot path (Uber). Do we need multi-tenant sharding (Notion). Do we speak a graph natively (Meta). Do we have distributed transactions (Google/Spanner). Do we ship Rails-plus-Go polyglot (Shopify). Each yes adds a specific pattern to your design. Each no lets you simplify.

The final staff note. Case studies from FAANG are written by the winners of decade-long architecture decisions, and survivorship bias is real. For every published "we rewrote in Go with sqlc and p99 dropped 40%" post, there are unpublished post-mortems of rewrites that missed deadlines and were reverted. Treat the publications as existence proofs (it can be done) not as prescriptions (you should do it). The correct ADR citation form is "published strangler-fig migrations from Rails monoliths to service architectures show the approach is feasible at large scale - we believe our scale is within one order of magnitude so the same approach is viable, contingent on bounded-context boundaries we will define in a follow-up ADR." That is how a staff engineer cites a case study. Not "a big company did it, so we will."

---
