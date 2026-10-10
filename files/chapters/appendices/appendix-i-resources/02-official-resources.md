## Official Resources

### Go Website (go.dev)

**URL**: https://go.dev

The official home of the Go programming language. This is your primary resource for:
- **Getting Started**: Installation guides for all platforms
- **Documentation Hub**: Links to all official documentation
- **Tour of Go**: Interactive introduction to Go's basics
- **Use Cases**: Real-world applications and case studies
- **Package Discovery**: Search for third-party packages

**Why It Matters**: Always start here for authoritative information. The site is maintained by the Go team and reflects current best practices.

### Go Documentation (pkg.go.dev)

**URL**: https://pkg.go.dev

The official package documentation portal:
- **Standard Library**: Complete documentation for all standard packages
- **Third-Party Packages**: Documentation for packages hosted on GitHub, GitLab, etc.
- **Version Support**: View documentation for different Go versions
- **Symbol Search**: Find specific functions, types, and methods
- **Import Graph**: Understand package dependencies
- **License Information**: Check package licensing

**Pro Tip**: Use the search bar to find packages by functionality, not just name. For example, searching "JSON" returns all relevant packages.

**Example Workflow**:
```
1. Search for "rate limiting" on pkg.go.dev
2. Compare golang.org/x/time/rate vs third-party options
3. Check import graph for dependencies
4. Review examples and documentation
5. Check version compatibility
```

### The Go Blog

**URL**: https://go.dev/blog

Official blog maintained by the Go team:
- **Release Announcements**: Details on new Go versions
- **Feature Deep Dives**: In-depth explanations of language features
- **Best Practices**: Official guidance on Go development
- **Community Stories**: How companies use Go in production
- **Proposals Discussion**: Background on language evolution

**Must-Read Articles**:
- "Go Concurrency Patterns" by Rob Pike
- "Error Handling in Go" series
- "The Laws of Reflection"
- "Go Slices: usage and internals"
- "Profiling Go Programs"
- "Share Memory By Communicating"

**Reading Strategy**: The blog archives go back to 2009. Start with recent posts for current best practices, then explore historical posts for foundational concepts.

### The Go Playground

**URL**: https://go.dev/play

Interactive environment for running Go code:
- **No Setup Required**: Write and run Go code in your browser
- **Shareable Links**: Create permanent links to code snippets
- **Version Selection**: Test code against different Go versions
- **Import Support**: Use standard library packages
- **Format on Save**: Automatic gofmt application

**Use Cases**:
1. **Quick Experiments**: Test language features without local setup
2. **Bug Reports**: Create minimal reproducible examples
3. **Learning**: Follow tutorials with interactive examples
4. **Sharing**: Send working code snippets to colleagues

**Limitations**:
- No network access (limited HTTP functionality)
- Execution time limits
- Memory restrictions
- Can't import third-party packages
- Fixed system time (for reproducibility)

**Example**: Share a concurrency pattern
```go
// https://go.dev/play/p/your-share-id
package main

import (
    "fmt"
    "time"
)

func worker(id int, jobs <-chan int, results chan<- int) {
    for j := range jobs {
        fmt.Printf("Worker %d processing job %d\n", id, j)
        time.Sleep(time.Second)
        results <- j * 2
    }
}

func main() {
    jobs := make(chan int, 100)
    results := make(chan int, 100)

    // Start 3 workers
    for w := 1; w <= 3; w++ {
        go worker(w, jobs, results)
    }

    // Send 5 jobs
    for j := 1; j <= 5; j++ {
        jobs <- j
    }
    close(jobs)

    // Collect results
    for a := 1; a <= 5; a++ {
        <-results
    }
}
```

### Go Wiki

**URL**: https://github.com/golang/go/wiki

Community-maintained wiki with practical guides:
- **IDEsAndTextEditorPlugins**: Setup guides for all editors
- **Modules**: Detailed module system documentation
- **CodeReviewComments**: Go code review best practices
- **CommonMistakes**: Pitfalls to avoid
- **Performance**: Optimization techniques
- **SliceTricks**: Advanced slice manipulation
- **TableDrivenTests**: Testing patterns

**Essential Pages**:
1. **CodeReviewComments**: Read this before your first PR
2. **CommonMistakes**: Learn from others' errors
3. **Modules**: Master dependency management
4. **Well-known-struct-tags**: Understand struct tags
5. **RateLimiting**: Implement rate limiting correctly

### Go Proposals

**URL**: https://github.com/golang/proposal

Where Go's future is shaped:
- **Active Proposals**: Features under consideration
- **Accepted Proposals**: Upcoming language changes
- **Design Documents**: In-depth technical specifications
- **Community Discussion**: Participate in language evolution

**How to Follow**:
1. Watch the golang/proposal repository
2. Read the "Proposal Process" documentation
3. Review accepted proposals for upcoming features
4. Participate in discussions respectfully

**Notable Historical Proposals**:
- Generics (Type Parameters) - Go 1.18
- Fuzzing - Go 1.18
- Structured Logging (slog) - Go 1.21
- Range over Functions - Go 1.23

### Go Dev (development resources)

**URL**: https://go.dev/doc/

Central documentation hub:
- **Effective Go**: Timeless guide to writing clear, idiomatic Go
- **Go FAQ**: Frequently asked questions
- **Specification**: Language specification (for reference)
- **Memory Model**: Understanding Go's memory guarantees
- **Diagnostics**: Profiling and tracing guide

**Effective Go Highlights**:
This document is essential reading. Key sections:
- **Formatting**: Why gofmt exists and matters
- **Commentary**: How to write good comments
- **Names**: Naming conventions and patterns
- **Control Structures**: If, for, switch idioms
- **Functions**: Multiple return values, named results
- **Data**: New vs make, constructors, methods
- **Interfaces**: Small interfaces, type assertions
- **Concurrency**: Goroutines, channels, parallelization
- **Errors**: Error handling patterns

**Reading Plan**:
1. Week 1: Read Effective Go completely
2. Week 2: Implement examples from Tour of Go
3. Week 3: Study the Memory Model
4. Ongoing: Reference FAQ and Diagnostics as needed

---
