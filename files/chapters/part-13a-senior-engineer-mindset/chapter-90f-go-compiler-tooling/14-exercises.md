## Exercises

### Exercise 1: Escape Analysis Investigation

**Task**: For each of the following functions, predict which allocations escape to heap, then verify with `-gcflags="-m"`:
1. `func sum(nums []int) int` - range over slice, accumulate sum
2. `func makeBuffer() []byte` - creates and returns a []byte
3. `func withCallback(fn func(int))` - calls fn with a value
4. `func counter() func() int` - returns a closure with an int counter
5. `func process(v any)` - does something with interface value

Then: write benchmark versions measuring ns/op and allocs/op to quantify the impact.

### Exercise 2: Custom go vet Linter

**Task**: Build a linter that detects goroutine variable capture bugs (pre-Go 1.22 style):
```go
// Bug: all goroutines capture same 'i'
func captureBug() {
    for i := 0; i < 10; i++ {
        go func() { fmt.Println(i) }() // Should warn: captures loop variable
    }
}
```
1. Implement as `go/analysis` Analyzer
2. Report diagnostic with suggested fix: add `i := i` inside the loop body
3. Integrate with `go vet`: `go vet -vettool=./myvet ./...`
4. Tests: use `analysistest.Run` to test analyzer against golden files

### Exercise 3: Repository Code Generator

**Task**: Build a code generator that reads struct definitions and generates repository methods:
1. Parse a file with structs annotated with `// @repository table:"users"`
2. For each annotated struct, generate: `GetByID`, `Create`, `Update`, `Delete`, `List`
3. Use `go/ast` and `go/types` to extract field names and types
4. Generate idiomatic Go code with proper error handling
5. Include `// Code generated... DO NOT EDIT` header
6. Write tests that compare generated output against golden files

### Exercise 4: Custom protoc Plugin

**Task**: Write a `protoc-gen-golog` plugin that generates structured logging for gRPC service methods:
1. Read service definitions from proto
2. For each method, generate a Go interceptor that logs: method name, request fields, response status, duration
3. Sensitive fields annotated with `// @sensitive` should be redacted in logs
4. Include trace ID from incoming context
5. Test by generating code from a sample `.proto` and verifying the generated interceptor compiles and produces correct log format

### Junior → FAANG: Exercises as Portfolio Building

Exercises 1 and 2 are achievable in a weekend and produce interview-ready artifacts. Do exercise 1 against a real service in your codebase: the escape analysis predictions are more interesting on real code than on toy functions. Exercise 2 produces a working `go vet` plugin you can show in a GitHub repository, which is a concrete differentiator in a Go engineering application.

### Senior @ FAANG: Exercises 3 and 4 as Platform Investment Prototypes

Exercises 3 and 4 are prototypes of real platform investments. The repository generator (exercise 3) maps directly to the kind of infrastructure automation that reduces onboarding friction in large Go codebases. The gRPC logging interceptor generator (exercise 4) maps directly to the observability standardization work that staff engineers lead at companies with large microservice fleets. If you implement exercise 4 and deploy it to your current org, you have a promotion-packet-quality contribution: a code generator that ensures every gRPC method in the fleet has consistent observability without requiring per-team implementation.

---
