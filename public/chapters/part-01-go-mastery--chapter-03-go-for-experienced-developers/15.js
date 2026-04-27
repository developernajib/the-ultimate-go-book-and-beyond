export default `## Further Reading

### Style and Idioms
- [Effective Go](https://go.dev/doc/effective_go) - the canonical idioms guide
- [Go Code Review Comments](https://github.com/golang/go/wiki/CodeReviewComments) - rejections you will see in review
- [Uber Go Style Guide](https://github.com/uber-go/guide/blob/master/style.md) - production-hardened rules from a Go-first shop
- [Google Go Style Guide](https://google.github.io/styleguide/go/) - the style at Go's birthplace
- [Go Proverbs](https://go-proverbs.github.io/) - Rob Pike's one-liners, each worth an essay
- [100 Go Mistakes](https://github.com/teivah/100-go-mistakes) - companion repo for Harsanyi's book with runnable examples

### Modules and Dependency Management
- [Go Modules Reference](https://go.dev/ref/mod) - the authoritative spec
- [Using Go Modules (Go Blog)](https://go.dev/blog/using-go-modules) - the original walkthrough, still accurate for the basics
- [Go 1.24 Release Notes: tool directive](https://go.dev/doc/go1.24) - modern tooling workflow
- [Go 1.24 Release Notes: GOAUTH](https://go.dev/doc/go1.24) - authenticated proxy support
- [Semantic Import Versioning](https://research.swtch.com/vgo-import) - Russ Cox's long-form design rationale

### Migration Case Studies
- [Dropbox: Open Sourcing Our Go Libraries](https://dropbox.tech/infrastructure/open-sourcing-our-go-libraries) - Python-to-Go migration lessons
- [Uber Engineering: Why Go](https://www.uber.com/en-US/blog/go-geofence-highest-query-per-second-service/) - the geofence service case study
- [Monzo: Building a Modern Bank Backend](https://monzo.com/blog/we-built-network-isolation-for-1-500-services) - microservices at a Go-first bank
- [Twitch: Service Platform](https://blog.twitch.tv/en/2019/04/10/live-streaming-at-scale-1b57fc4b5a6e/) - moving from Go 1.x monolith to services
- [Cloudflare: Go Tooling Stories](https://blog.cloudflare.com/tag/go/) - tag with migration and performance stories

### Company Engineering Blogs (Migration-Relevant)
- [Ardan Labs: Going Go](https://www.ardanlabs.com/blog/) - deep Go for ex-C++ and ex-Java engineers
- [Dave Cheney](https://dave.cheney.net/) - essays on idiomatic Go for experienced engineers
- [The Bytesize Go Blog](https://www.bytesizego.com/blog/) - 2026 roadmap and migration content

### Senior-Track Resources
- [Go Design Documents](https://go.googlesource.com/proposal) - read proposals to understand why Go looks the way it does
- [Go Wiki: Common Mistakes](https://github.com/golang/go/wiki/CommonMistakes) - the mistakes experienced engineers import from other languages
- [Russ Cox: Codebase Refactoring](https://research.swtch.com/refactor) - how to move a large Go codebase without breaking callers
- [Austin Clements on Go Runtime](https://speakerdeck.com/aclements) - runtime internals from a lead engineer
- [Go Modules Reference](https://go.dev/ref/mod) - the authoritative spec, worth a re-read once your team has multiple modules in flight
- [Go Blog: Worker Pools and the Pool Pattern](https://go.dev/blog/) - search for the worker pool posts when you reach for \`sync.Pool\` or a goroutine pool

### Architecture and Org-Design Resources
- [Standard Go Project Layout](https://github.com/golang-standards/project-layout) - the unofficial-but-widely-followed convention for \`cmd/\`, \`internal/\`, \`pkg/\`, and friends. Read the README's caveat about it being a description, not a prescription.
- [Mat Ryer: How I Write HTTP Services in Go](https://grafana.com/blog/2024/02/09/how-i-write-http-services-in-go-after-13-years/) - the canonical "how I structure a Go service" post, updated for 2024 and still the right starting point in 2026
- [Peter Bourgon: Go for Industrial Programming](https://peter.bourgon.org/go-for-industrial-programming/) - the senior-track essay on writing Go that survives team turnover
- [Ardan Labs: Service Architecture](https://www.ardanlabs.com/blog/) - Bill Kennedy's service-architecture posts, calibrated for production teams

### Migration-Specific Reading
- [Migrating Python Services to Go: Lessons Learned](https://stripe.com/blog) - search Stripe's engineering blog for the migration posts. The discipline they describe is the discipline this chapter has been arguing for.
- [The Twelve-Factor App](https://12factor.net/) - language-agnostic, but the configuration and process-model rules map directly to idiomatic Go service shapes
- [Site Reliability Engineering (Google book)](https://sre.google/books/) - the operational chapters apply to Go services and are the framing senior engineers use when defending Go-adoption decisions on operational grounds

### Linters and Tooling Worth Wiring Into CI Day One
- [golangci-lint](https://golangci-lint.run/) - meta-linter that aggregates the others, and the 2026 default
- [staticcheck](https://staticcheck.dev/) - the most accurate and least noisy of the standalone analysers
- [errcheck](https://github.com/kisielk/errcheck) - catches discarded errors
- [errorlint](https://github.com/polyfloyd/go-errorlint) - catches \`==\` comparisons against errors and recommends \`errors.Is\`
- [exhaustive](https://github.com/nishanths/exhaustive) - catches non-exhaustive switches on enum-shaped types
- [revive](https://github.com/mgechev/revive) - the modern replacement for \`golint\`, with configurable rules
- [govulncheck](https://go.dev/blog/vuln) - checks the dependency tree against the Go vulnerability database. Run it on every CI build.
`;
