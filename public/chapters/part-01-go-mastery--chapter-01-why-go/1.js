export default `## Learning Objectives

By the end of this chapter, you will be able to:

**Core objectives (all readers):**
- Explain Go's origin story and the specific engineering problems at Google (C++ compile times, Python scale limits, Java operational complexity) that motivated its creation
- Identify use cases where Go provides significant advantages over Python, Java, Rust, Node.js, and C++, and the narrower set of cases where it does not
- Compare Go against those five languages on concrete axes: compile time, startup latency, steady-state throughput, memory footprint, concurrency model, and team onboarding cost, using 2026-current benchmark data
- Articulate the Go philosophy (simplicity, explicit error handling, composition over inheritance, one idiomatic way) and explain how each design choice reduces long-term maintenance cost
- Set up a complete Go 1.26 development environment with \`gopls\`, \`golangci-lint\`, \`delve\`, and a working VS Code or JetBrains configuration, validated by running the test suite of a real open-source project
- Recognize how Google, Uber, Netflix, Stripe, Cloudflare, Dropbox, and CockroachDB use Go in production, including which subsystems they chose Go for and which they deliberately did not
- Answer the most common Go interview questions (goroutines vs threads, channels vs mutexes, why no exceptions, why no inheritance) at a level that satisfies both a bar-raiser at a FAANG phone screen and a staff-level system-design loop

**Junior → FAANG track objectives.** If you are preparing for Google, Meta, Uber, Stripe, Cloudflare, or similar backend-heavy interviews, by the end of this chapter you should additionally be able to:
- Reproduce the "why Go?" 90-second pitch that opens most Go-role phone screens, citing at least three concrete industry data points (for example: Kubernetes is written in Go, Cloudflare handles ~81M RPS steady-state in Go, Stripe runs critical payment paths in Go)
- Write, build, and run a single-file Go program from a blank terminal in under two minutes, including \`go mod init\`, \`go run\`, and \`go test\`, without consulting notes: this is a silent prerequisite for on-site coding rounds at every Go-using company
- Explain the *one* difference between a goroutine and an OS thread that interviewers most care about (the runtime-managed M:N scheduler and sub-KB starting stack) without drifting into the twenty other correct-but-irrelevant facts that waste interview time
- Spot the three most common Go red flags a junior candidate drops in an interview (ignoring errors with \`_\`, using \`interface{}\` where a concrete type would work, and treating goroutines as "just threads") and articulate the correct framing

**Senior / Staff / Principal track objectives.** If you already ship Go in production and are reading this book for leverage at the staff-plus level, by the end of this chapter you should additionally be able to:
- Write the first two paragraphs of a Go-adoption ADR for your org (the business case, the risks, and the alternatives considered) using the industry data in Section 1.3 and the honest comparisons in Section 1.4, without the "Go is popular" hand-wave that junior authors default to
- Defend, in a design review, the specific engineering-restraint arguments that justify Go's deliberate omissions (no inheritance, no exceptions, no generics until 1.18, no implicit conversions) against a teammate pushing to add those patterns via third-party libraries, code generation, or reflection
- Frame the Go-vs-Rust decision for your org as a portfolio allocation problem: where does the marginal Rust-trained engineer produce more value than the marginal Go-trained engineer, and where is Go the boring-and-correct choice, rather than a language preference
- Explain to a VP or director the operational TCO differences between a Go fleet and a JVM fleet (no heap tuning, no warm-up, statically linked binaries, built-in pprof, crash-only semantics) in language that translates to headcount, incident frequency, and cloud bill
- Use the case studies in Section 1.3 to calibrate your own org's Go adoption against Uber, Stripe, and Cloudflare, identifying which of their choices apply to your scale and which are specific to theirs

**Deliverable by the end of this chapter.** Regardless of track: a working Go 1.26 environment on your machine, a compiled Hello World binary, your first \`go test\` pass, and the ability to explain in one paragraph to a non-technical stakeholder why your next green-field backend service should or should not be written in Go.

---
`;
