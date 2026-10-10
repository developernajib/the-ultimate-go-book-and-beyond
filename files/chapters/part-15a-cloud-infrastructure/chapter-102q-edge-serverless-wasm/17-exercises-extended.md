## Exercises

**Exercise 9: Build a Go Lambda function that processes S3 events with <50ms cold start**

Goal: Write a Lambda function that triggers on S3 `ObjectCreated` events, reads the uploaded file, computes a SHA-256 checksum, and writes the result to a DynamoDB table - with a measured cold start under 50ms.

Requirements:
1. Use `GOOS=linux GOARCH=arm64 CGO_ENABLED=0` with `-ldflags="-s -w" -trimpath`.
2. Lazy-initialize the DynamoDB client using `sync.Once` (not in `init()`).
3. Use the AWS SDK v2 (`github.com/aws/aws-sdk-go-v2`) with `config.LoadDefaultConfig`.
4. Handle partial batch failures if the trigger is SQS-wrapped S3 events.
5. Measure the cold start with `aws lambda invoke --log-type Tail` and parse `Init Duration`.
6. Write a unit test for the checksum logic using a `bytes.Reader` instead of a real S3 client (mock the S3 interface).

```go
// Skeleton
type S3Client interface {
    GetObject(ctx context.Context, input *s3.GetObjectInput, opts ...func(*s3.Options)) (*s3.GetObjectOutput, error)
}

type DDBClient interface {
    PutItem(ctx context.Context, input *dynamodb.PutItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
}

type Handler struct {
    s3  S3Client
    ddb DDBClient
}

func (h *Handler) Handle(ctx context.Context, event events.S3Event) error {
    for _, record := range event.Records {
        if err := h.processRecord(ctx, record); err != nil {
            return err
        }
    }
    return nil
}
```

Expected cold start result on arm64 128MB: 18-45ms Init Duration.

---

**Exercise 10: Compile a Go HTTP handler to WebAssembly using TinyGo**

Goal: Write an HTTP request router in Go, compile it to WASM with TinyGo, and run it server-side using wazero as the embedded WASM runtime inside a host Go application.

Part A - The WASM module (TinyGo, `GOOS=wasip1 GOARCH=wasm`):

```go
// wasm/router/main.go
package main

import (
    "fmt"
    "os"
)

// route reads a path from stdin and writes the matched handler name to stdout.
// WASI stdio is the simplest ABI for host-to-guest communication.
func main() {
    buf := make([]byte, 256)
    n, _ := os.Stdin.Read(buf)
    path := string(buf[:n])

    switch {
    case path == "/health":
        fmt.Print("health_handler")
    case len(path) > 5 && path[:5] == "/user":
        fmt.Print("user_handler")
    case len(path) > 4 && path[:4] == "/api":
        fmt.Print("api_handler")
    default:
        fmt.Print("not_found_handler")
    }
}
```

```bash
tinygo build \
  -target=wasip1 \
  -o router.wasm \
  -no-debug \
  ./wasm/router/
```

Part B - The host (standard Go, wazero):

```go
// host/main.go
package main

import (
    "bytes"
    "context"
    "fmt"
    "os"

    "github.com/tetratelabs/wazero"
    "github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

func route(ctx context.Context, rt wazero.Runtime, compiledMod wazero.CompiledModule, path string) (string, error) {
    var stdout bytes.Buffer
    stdin := bytes.NewBufferString(path)

    cfg := wazero.NewModuleConfig().
        WithStdin(stdin).
        WithStdout(&stdout).
        WithStderr(os.Stderr).
        WithName("router")

    mod, err := rt.InstantiateModule(ctx, compiledMod, cfg)
    if err != nil {
        return "", fmt.Errorf("instantiate: %w", err)
    }
    defer mod.Close(ctx)

    return stdout.String(), nil
}

func main() {
    ctx := context.Background()

    rt := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().
        WithCompilationCache(wazero.NewCompilationCache()))
    defer rt.Close(ctx)

    wasi_snapshot_preview1.MustInstantiate(ctx, rt)

    wasmBytes, err := os.ReadFile("router.wasm")
    if err != nil {
        panic(err)
    }

    compiled, err := rt.CompileModule(ctx, wasmBytes)
    if err != nil {
        panic(err)
    }

    // The compiled module is reused across calls - only instantiation is per-request.
    paths := []string{"/health", "/user/123", "/api/v1/items", "/unknown"}
    for _, p := range paths {
        handler, err := route(ctx, rt, compiled, p)
        if err != nil {
            fmt.Fprintf(os.Stderr, "route error: %v\n", err)
            continue
        }
        fmt.Printf("%-20s → %s\n", p, handler)
    }
}
```

Expected output:
```
/health              → health_handler
/user/123            → user_handler
/api/v1/items        → api_handler
/unknown             → not_found_handler
```

Extension challenges:
- Replace stdin/stdout ABI with exported WASM memory functions for zero-copy communication.
- Add a benchmark comparing wazero instantiation time vs direct Go function call.
- Swap the TinyGo router for a Rust router component without changing the host code (only the `.wasm` file changes).

---

### Junior → FAANG: Extended Exercises as Portfolio Projects

The exercises in this section produce portfolio artifacts that demonstrate skills beyond what a resume bullet point can convey. Exercise 9 (Lambda S3 event processing with a 50ms cold start budget) demonstrates that you can build to a performance specification, not just to functionality. Exercise 11 (WASM plugin system with wazero) demonstrates that you understand the WASM execution model well enough to build infrastructure that uses it, not just consume it.

The most valuable exercise for interview preparation: build exercise 9 (Lambda S3 processing) and document your cold start measurements at different memory settings and binary sizes. A blog post or GitHub repository with measured cold start data at 128MB/256MB/512MB and binary sizes with/without stripping is a concrete artifact that demonstrates the optimization process, not just the outcome. Interviewers at cloud-native companies will ask about this kind of measurement experience directly.

For the wazero exercise, the extension challenge (swap the TinyGo router for a Rust router without changing host code) is the most instructive part. If you can do this cleanly, you have understood the abstraction boundary that the WASM module boundary provides, which is the conceptual foundation for the Component Model.

### Senior @ FAANG: Extended Exercises as Platform Prototype Validation

At staff level, these exercises are platform prototype validation runs, not individual skill-building. Exercise 9 (Lambda performance tuning) produces the measurement data for the organization's Lambda memory tier recommendations. Run it with the organization's actual handler logic (not a synthetic example), measure at six memory tiers (128MB, 256MB, 512MB, 1GB, 2GB, 3GB), and use Lambda Power Tuning's cost/performance plot to identify the optimal tier for the organization's standard handler class. Publish the results as the organization's official Lambda memory tier policy.

Exercise 11 (WASM plugin system) is a prototype for any organizational use case that requires sandboxed execution of untrusted or third-party code. Before committing to a production implementation, the prototype should measure three things: instantiation time (how long does it take to load and compile a WASM module from bytes?), execution overhead compared to a native Go function call for the same logic, and memory isolation guarantees (verify that a buggy WASM module cannot read or write host Go memory). These three measurements determine whether wazero is appropriate for the organization's specific use case, because the answers depend on the module size, the computation complexity, and the security requirements of the use case rather than on synthetic benchmarks.

---

## Summary

In this chapter, we explored the triad of modern lightweight compute:
- **Serverless functions**: AWS Lambda and Google Cloud Run for event-driven scaling, with cold-start reduction via stripped binaries (`-ldflags="-s -w" -trimpath`), `sync.Once` lazy initialization, and arm64 Graviton execution environments.
- **Edge computing**: Cloudflare Workers, Fastly Compute, and Lambda@Edge for sub-10ms global routing, edge caching, and A/B traffic shaping.
- **WebAssembly & WASI**: Browser WASM, server-side WASI runtimes (`wasip1` / `wasip2`), embedded engines (`wazero`), and TinyGo compilation yielding ultra-small binaries under 100 KB.

With Part XVA (Cloud Infrastructure) complete, you now possess comprehensive mastery spanning Docker internals, Kubernetes operations, AWS/GCP/Azure multi-cloud architecture, high-throughput cloud networking, FinOps cost governance, and edge serverless execution. Next, we transition to **Part XVB: DevOps & Platform Engineering**, beginning with Infrastructure as Code in [Chapter 102C: Terraform & IaC Deep Dive](../../part-15b-devops-platform/00-part-intro.md).

