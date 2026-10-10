## 83F.16 Project-Based Learning Checkpoints

Theory without practice is forgettable. After each major part of this book, build something. These projects are designed to reinforce what you just learned while producing portfolio-worthy work for your GitHub profile.

### After Part I (Go Mastery): CLI Task Manager

**Build:** A command-line task manager with persistent storage (JSON file).

**What it tests:**
- Structs and methods (Task, TaskList)
- Slices and maps (storing, filtering, searching)
- Error handling (file I/O, invalid input)
- Package organization (separate `cmd`, `internal/task`, `internal/storage` packages)

**Stretch:** Add due dates with `time.Time`, priorities, and colored terminal output.

### After Part II (Concurrency): Concurrent Web Scraper

**Build:** A web scraper that fetches 50+ URLs concurrently and extracts specific data (titles, links, prices).

**What it tests:**
- Goroutines and WaitGroups (parallel fetching)
- Channels (collecting results)
- Context for cancellation and timeouts
- Rate limiting with `time.Ticker`
- Error handling across concurrent workers

**Stretch:** Add a worker pool pattern, retry logic with exponential backoff, and progress reporting.

### After Part V (Data Layer): URL Shortener

**Build:** A URL shortener service with PostgreSQL storage and Redis caching.

**What it tests:**
- Database migrations and schema design
- Repository pattern for data access
- Redis for caching hot URLs
- Connection pooling and graceful shutdown
- Input validation (valid URLs, collision handling)

**Stretch:** Add click analytics, URL expiration, and custom short codes.

### After Part VI-VII (REST + gRPC): Task API with Dual Interface

**Build:** A task management API that exposes both REST (JSON over HTTP) and gRPC interfaces, backed by the same service layer.

**What it tests:**
- Clean architecture (handlers → service → repository)
- REST endpoint design (proper status codes, pagination, filtering)
- gRPC proto definitions and code generation
- Authentication middleware (JWT)
- Integration tests for both interfaces

**Stretch:** Add WebSocket support for real-time task updates.

### After Part VIII (Microservices): Mini E-Commerce System

**Build:** A simplified e-commerce backend with 3 microservices:
1. **Product Service** , CRUD for products, inventory tracking
2. **Order Service** , Order placement, payment simulation
3. **Notification Service** , Email/webhook notifications on order events

**What it tests:**
- Service-to-service communication (gRPC or HTTP)
- Event-driven architecture (order events trigger notifications)
- Distributed transactions (saga pattern for order → payment → inventory)
- Docker Compose for local development
- Health checks and service discovery

**Stretch:** Add a message queue (NATS or RabbitMQ) between services.

### After Part X (System Design): Design Document Portfolio

**Build:** Write 3 complete system design documents for systems you've studied:

1. A real-time chat system (like the one in the System Design chapter)
2. A system from your own work experience
3. A system you'd build if you had unlimited resources

**Each document should include:**
- Requirements and constraints
- Capacity estimation
- Architecture diagram (ASCII is fine)
- Database schema
- API design
- Key trade-offs and decisions

**Why:** System design interviews test your ability to *communicate* designs, not just think them. Writing forces clarity. These documents also become excellent blog posts and portfolio pieces.

### After Part XI (DSA): LeetCode Tracker Dashboard

**Build:** A web dashboard that tracks your LeetCode progress, showing:
- Problems solved by category and difficulty
- Weekly/monthly solve rate
- Weakest categories (fewest solves)
- Time per problem trending

**What it tests:**
- Everything from the data structures chapter (graphs for category relationships, heaps for rankings)
- Full-stack Go (backend API + simple HTML/JS frontend)
- Data visualization
- File-based or SQLite storage

**How to Use These Checkpoints**

1. **Don't skip them.** Reading without building is like watching cooking videos without cooking. You'll understand the concepts but won't be able to execute under pressure
2. **Push to GitHub.** Each project should have a README, tests, and clean commits. This IS your portfolio
3. **Time-box.** Spend 2-4 days per project, not 2 weeks. These are meant to be practical, not perfect
4. **Use what you learned, not what you Googled.** The point is to verify your understanding, not to copy Stack Overflow answers


### Junior → FAANG: Project-Based Learning Checkpoints

Project-based learning checkpoints are concrete deliverables that verify you have internalized the preparation material rather than just read it. Examples: implement an LRU cache in Go with unit tests and benchmark. Design a URL shortener from scratch on paper (no reference) and then compare against a reference design. Write out the STAR stories for your top 5 behavioral themes without notes. These deliverables are more reliable preparation signals than the subjective feeling of having understood something.

### Senior @ FAANG: Project Checkpoints as Portfolio Building

Senior candidates should treat project-based checkpoints as portfolio artifacts that demonstrate technical depth beyond what an interview can assess. A well-designed LRU cache implementation with extensive benchmarks, a distributed systems design doc with trade-off analysis and failure mode assessment, or an open source contribution that demonstrates Go internals knowledge are artifacts that can be referenced in interviews ('let me walk you through the rate limiter I implemented last month') and that provide concrete evidence of skill rather than just verbal claims. Building these artifacts during preparation creates a productive feedback loop: the project reveals gaps in your understanding that solo reading does not, and the artifact itself becomes an interview talking point.
