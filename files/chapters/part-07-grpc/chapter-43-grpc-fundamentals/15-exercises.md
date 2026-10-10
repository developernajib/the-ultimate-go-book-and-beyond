## Exercises

1. **Define a Versioned Proto Service**: Write a `.proto` file for a `BookService` with `GetBook`, `ListBooks`, and `CreateBook` RPCs using package `bookstore.v1`. Add proper field validation annotations using `buf` linting rules. Generate Go stubs with `protoc-gen-go` and `protoc-gen-go-grpc`. Confirm the generated code compiles and the package path matches your module.

2. **Implement with Field Masks**: Add a `UpdateBook` RPC that accepts a `google.protobuf.FieldMask` to allow partial updates (e.g., update only `title` without touching `author`). In the server implementation, iterate over `field_mask.paths` and apply only the specified fields to the stored record. Write a test that updates a single field and asserts the others remain unchanged.

3. **bufconn Integration Test**: Write a complete integration test for `BookService` using `google.golang.org/grpc/test/bufconn`. Start the gRPC server in-process, dial it through the `bufconn` listener, and exercise all four RPCs. Assert correct responses and verify that attempting to fetch a non-existent book returns `codes.NotFound`.

4. **Rich Error Details**: Implement a `DeleteBook` RPC that returns a `google.rpc.Status` with a `google.rpc.BadRequest` detail when the provided book ID is malformed. On the client side, extract the `BadRequest` field violation using `status.FromError` and `details`. Write a test that triggers the error and asserts the field name in the violation is `"book_id"`.

5. **Hedged Requests**: Implement client-side hedging for `GetBook`: if the first call does not respond within 50ms, fire a second identical request in parallel. Return whichever response arrives first and cancel the other. Measure the improvement in tail latency by running 1,000 calls against a server that introduces random 0-200ms jitter.

6. **Proto Evolution Without Breaking Changes**: Start with a `v1` `UserMessage` proto containing `string name = 1` and `string email = 2`. Evolve it to `v2` by adding `string phone = 3` and reserving field `2` with a new field `string email_address = 4`. Demonstrate that a `v1` client can still communicate with a `v2` server without errors. Write a test that serializes a `v1` message and deserializes it as `v2`, asserting `phone` defaults to empty string.

7. **gRPC Health Check Protocol**: Implement the standard gRPC health checking protocol (`grpc.health.v1`) for `BookService`. Add logic that marks the service `NOT_SERVING` when a simulated database connection is nil. Use `grpc-health-probe` (or a Go client) to query health status and assert the transition from `SERVING` to `NOT_SERVING` when the DB is disconnected.

### Junior → FAANG: Working Through the Exercises Strategically

Complete the seven exercises in order. Each builds on the previous and the sequence mirrors what you would do when creating a new gRPC service from scratch at a FAANG company.

**Exercise 1 (proto definition):** The most important output is not the generated Go code. It is the habit of running `buf lint` and fixing every warning before moving on. The `DEFAULT` ruleset enforces package naming, message naming, field naming, and RPC naming conventions that experienced reviewers will check immediately. Getting these right in exercise 1 means your code review feedback in interviews will be about design, not style.

**Exercise 2 (field masks):** Work through the edge cases before writing the server: what happens when `update_mask.paths` is empty? (treat as a full update, replacing all fields). What happens when a path in the mask names a field that does not exist in the proto? (return `codes.InvalidArgument` with a `BadRequest` detail naming the unknown path). These edge cases are interview questions waiting to happen.

**Exercise 3 (bufconn integration test):** After writing the happy-path test, add at least three unhappy-path tests: a `GetBook` for a non-existent ID, a `CreateBook` with a missing required field, and a `DeleteBook` followed by a `GetBook` to verify `codes.NotFound`. Table-driven tests are the Go convention for this.

**Exercise 5 (hedged requests):** Before implementing, write down your answer to: "Is `GetBook` idempotent?" (yes, reads do not mutate state). "What is the extra load introduced by hedging?" (at most double for the tail). "What is the correct cancellation behavior?" (cancel the losing request via its context). Then implement. The ability to answer design questions before writing code is a FAANG interview signal.

**Exercise 6 (proto evolution):** Do not skip this exercise. The wire-compatible vs JSON-compatible distinction is the most common proto mistake in production. After completing the exercise, also test JSON serialization of a v1 message and verify that the `email_address` field (which has a new field number) does not appear in the v1 JSON output. This reinforces why field names and numbers must both be treated as contract.

### Senior @ FAANG: Extending Exercises Into Platform Design Problems

The seven exercises can be extended into staff-level design problems. These extensions are suitable for system design interviews at the L6/L7 level.

**Exercise 1 extension: Multi-service proto repository.** You have defined `bookstore.v1` in a single module. Now design the repository structure for an organization with 50 services. Decisions: one repository for all protos vs. per-service proto repositories, how generated SDKs are published and consumed, how breaking-change detection works when a proto change affects multiple downstream services, and how the API review process is integrated into the PR workflow. Write an ADR for your chosen approach.

**Exercise 2 extension: Field mask enforcement at the API review layer.** Define a linting rule (using `buf`'s plugin system or a custom `go/analysis` pass) that detects `Update*` RPCs that do not have a `google.protobuf.FieldMask update_mask` field. Explain why this rule reduces the probability of "full-replacement update" bugs where a client that knows only a subset of fields accidentally clears fields it does not know about.

**Exercise 3 extension: CI test infrastructure.** The bufconn test starts a fresh server for each test function. At scale (500 gRPC services each with 20 integration tests), this is expensive. Design a test infrastructure that shares a server instance across tests in a package while guaranteeing test isolation (each test gets a fresh store state without restarting the server). Consider the trade-off between test isolation and setup time.

**Exercise 5 extension: Hedging policy as a platform configuration.** Design a service config format (either the gRPC built-in service config JSON or a higher-level abstraction) that lets a platform team configure hedging policy per-method for an entire fleet. Considerations: which methods are eligible for hedging (idempotent reads only), what the default hedge delay is, how the policy is pushed to clients without requiring a code change, and how a team overrides the policy for a specific method.

**Exercise 7 extension: Health check taxonomy.** The standard health check protocol has two states: `SERVING` and `NOT_SERVING`. Design a richer health taxonomy for your organization that distinguishes: degraded (the service is running but performance is degraded beyond SLO, readiness probe should return unhealthy), overloaded (the service is shedding load, readiness probe should return unhealthy for traffic routing but liveness should remain healthy), and draining (the service is in graceful shutdown, readiness probe returns unhealthy, liveness remains healthy). Implement each state and the transitions between them, and write tests that verify Kubernetes routing behavior changes correctly for each state.
