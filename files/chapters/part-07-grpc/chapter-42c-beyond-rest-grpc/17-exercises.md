## Exercises

1. **gRPC vs REST Benchmark**: Build the same `GetUser` endpoint in both a REST (net/http + JSON) and a gRPC (protobuf) server. Use `ghz` or `wrk` to benchmark both under 1,000 RPS. Record payload size and p99 latency. Document which protocol wins and why, paying attention to serialization overhead and connection reuse.

2. **DataLoader for GraphQL N+1**: Implement a minimal GraphQL server using `graph-gophers/graphql-go` that exposes `orders` and their associated `products`. First implement it without DataLoader and log the number of DB queries per request. Then add a DataLoader that batches all product IDs into a single query. Verify that a page of 20 orders drops from 21+ queries to 2.

3. **gRPC Deadline Propagation**: Write a gRPC client that calls a `SlowService` with a 200ms deadline. Implement the server to simulate a 500ms processing delay. Capture the `codes.DeadlineExceeded` error on the client side and ensure the server also detects `ctx.Err()` and aborts early. Add a test asserting the total elapsed time is less than 300ms.

4. **gRPC Status Code Mapping**: Create a `ProductService` with a `GetProduct` RPC. Map the following domain errors to correct gRPC status codes: product not found → `codes.NotFound`, invalid UUID format → `codes.InvalidArgument`, database unavailable → `codes.Unavailable`, caller lacks permission → `codes.PermissionDenied`. Write a table-driven test that invokes each error scenario and asserts the returned `status.Code`.

5. **Bidirectional Streaming Pipeline**: Implement a bidirectional streaming RPC `TransformStream` that receives integers from the client, doubles each value on the server, and streams the results back in real time. The client must send 10 integers concurrently using a goroutine and collect all responses. Assert all 10 doubled values are received in a `bufconn`-based integration test.

6. **Rich Error Details**: Extend your `ProductService` to return `google.rpc.BadRequest` details when validation fails (e.g., `field: "quantity", description: "must be > 0"`). On the client, extract the field violations via `status.Convert(err).Details()` and render them as a map. Verify with a table-driven test.

7. **Connect-Go Triple Protocol**: Using the connect-go library (import path `connectrpc.com/connect`), stand up a single handler that serves native Connect, gRPC, and gRPC-Web on port 8080. Exercise all three from test code: a native Connect client, a gRPC client (`grpc.NewClient`), and a browser `fetch()` call (captured via Playwright or `curl -H 'Content-Type: application/json'`). Confirm responses round-trip identically.

8. **gRPC Reflection Security Audit**: Start a gRPC server with reflection enabled (`reflection.Register(s)`). Use `grpcurl` to list all services and methods. Then disable reflection and confirm the same `grpcurl` commands fail with `codes.Unimplemented`. Document in code comments why reflection should be disabled in production and what information an attacker could extract.

9. **mTLS with SPIFFE**: Using `github.com/spiffe/go-spiffe/v2` against a local SPIRE agent (or minted self-signed URI-SAN certs), implement a gRPC server interceptor that permits calls only from a specific SPIFFE ID (e.g., `spiffe://local/ns/orders/sa/order-client`). Assert that a client with the wrong ID is rejected with `codes.PermissionDenied`.

10. **Graceful Drain Simulation**: Run your gRPC service under load with `ghz`. In a second terminal, send SIGTERM. Verify that the health server flips to `NOT_SERVING`, all in-flight RPCs complete, and no new RPCs are accepted. Measure the drain time and confirm no client sees `Unavailable` after the shutdown signal.

### Junior → FAANG: Making the Most of These Exercises

These exercises are structured to mirror real FAANG coding and system design interview scenarios. Each one has a clear setup, a concrete measurable outcome, and at least one design decision that requires trade-off reasoning rather than just coding.

The exercises most directly relevant to interview preparation are 3 (deadline propagation), 4 (status code mapping), 5 (bidirectional streaming), and 6 (rich error details). These topics appear in nearly every mid-level backend interview at FAANG companies that uses Go and gRPC. Exercise 3 in particular tests a concept that is very difficult to understand from reading alone: the behavior of a server when the client's deadline expires mid-RPC. Running it and observing the server-side `ctx.Err()` return is the kind of concrete experience that makes interview answers credible.

For the benchmarking exercise (exercise 1), do not stop at measuring the numbers. Try to explain why gRPC wins on p99 latency even if the average latency is similar to REST. The answer involves HTTP/2 head-of-line blocking elimination and connection reuse, which are the mechanisms behind the headline "gRPC is faster than REST."

First-job habit from these exercises: write the test first, then the implementation. Exercise 4 specifies a table-driven test. Write that test with all the error scenarios defined before implementing `ToGRPCStatus`. This forces you to think through the full mapping before any code exists and catches edge cases (what does "context canceled" map to? what about "nil error"?) before they become bugs.

### Senior @ FAANG: Extending the Exercises to System-Level Concerns

At senior level, each exercise has a natural extension that shifts it from an implementation task to a system design task. These extensions are not listed in the exercise descriptions, but working through them is how you build the experience that FAANG staff interviews test.

Exercise 1 (benchmark): extend it to measure behavior under concurrent clients. Does gRPC's advantage grow or shrink as the number of concurrent callers increases? Why? (Answer: gRPC's HTTP/2 multiplexing means connection establishment overhead is paid once across many concurrent streams. REST's HTTP/1.1 connection pool becomes the bottleneck at high concurrency.) This is a production systems insight that interviewers test indirectly.

Exercise 7 (Connect triple protocol): extend it to add a load test that demonstrates all three protocol variants can call the same handler under load and produce identical results. Then add an interceptor to the Connect server and verify it applies to all three protocol paths. This tests your understanding of where Connect's interceptors sit relative to the protocol negotiation layer.

Exercise 10 (graceful drain): extend it to measure the race window between SIGTERM and endpoint removal. Deploy the service to a local Kubernetes cluster with `kind` or `minikube`, send SIGTERM, and measure the time between SIGTERM delivery and the pod being removed from the service endpoints. Compare this to the drain timeout in `server.GracefulStop()`. This concrete measurement is the data that justifies the `preStop` sleep in the Kubernetes manifest. Making operational decisions from measurements rather than convention is a bar-raiser behavior in staff-level interviews.
