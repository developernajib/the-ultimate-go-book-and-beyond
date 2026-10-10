## 25 Golden Production Rules & Runtime Idioms

This quick reference summarizes the 25 most critical engineering rules, performance idioms, and reliability practices for building enterprise Go services.

---

### Concurrency & Lifecycle
1. **Never fire-and-forget a goroutine**: Every goroutine must have an explicit owner, a cancellation mechanism (`context.Context`), and a completion tracker (`sync.WaitGroup` or channel).
2. **Close channels from the sender**: Never close a channel from a receiver, and never close a channel from multiple concurrent goroutines. Closing a closed channel panics immediately.
3. **Use channel directionality in signatures**: Restrict function parameters to receive-only (`<-chan T`) or send-only (`chan<- T`) to enforce dataflow at compile time.
4. **Never copy a `sync.Mutex` by value**: Passing a mutex or a struct containing a mutex by value duplicates its internal state, breaking synchronization. Always pass by pointer.
5. **Beware of timer leaks in `select` loops**: Avoid calling `time.After()` inside a repeated `select` loop; each call allocates a new `time.Timer` that persists until expiry. Use an explicit, reusable `time.NewTimer` and reset it.

### Memory & Performance
6. **Zero values should be immediately operational**: Design structs so their zero value is ready to use without calling an initializer (e.g., `sync.Mutex`, `bytes.Buffer`, `sync.WaitGroup`).
7. **Pre-allocate slices and maps when capacity is known**: Use `make([]T, 0, count)` and `make(map[K]V, count)` to eliminate repeated heap reallocations and hash table rehashing.
8. **Align struct fields by size to eliminate padding**: Order struct fields from largest (64-bit pointers/ints) to smallest (bools/bytes). Poorly ordered structs can waste 30%–50% of their memory footprint on alignment padding.
9. **Avoid interface boxing on hot paths**: Passing concrete types to `any` or `interface{}` parameters forces the compiler to allocate an `itab` and box the value onto the heap.
10. **Reset slices before returning them to `sync.Pool`**: Slice headers must be resliced to zero length (`buf = buf[:0]`) before returning them to a pool to avoid leaking stale memory buffers across tenants.

### Network, I/O, & HTTP
11. **Never use `http.DefaultClient` in production**: The standard client has a zero timeout (`Timeout: 0`), meaning hung upstream connections block caller goroutines indefinitely. Always configure custom dial, TLS, and request deadlines.
12. **Always drain and close HTTP response bodies**: If `resp.Body` is not drained before closing (`io.Copy(io.Discard, resp.Body)`), the underlying TCP socket cannot be reused for keep-alive, leading to socket exhaustion.
13. **Wrap incoming HTTP bodies with `http.MaxBytesReader`**: Prevent malicious or runaway payloads from triggering Out-Of-Memory (OOM) kills on your server pods.
14. **Use `bufio` for streaming network and disk I/O**: Direct unbuffered `os.File.Write()` or `net.Conn.Write()` calls make a separate OS kernel syscall for every tiny byte slice. Buffer with `bufio.Writer`.

### Error Handling & Observability
15. **Wrap errors with `%w` and inspect with `errors.Is` / `errors.As`**: Never compare error messages using string matching (`err.Error() == "not found"`). String comparisons break silently when error messages are refined.
16. **Never discard errors silently with `_` in production**: If an error is genuinely safe to ignore, document the explicit reasoning with a code comment.
17. **Use `errors.Join` to collect multi-step validation errors**: Combine multiple validation errors into a single composable error without losing individual error trees.
18. **Prefer structured logging with `log/slog`**: Structured key-value logs with typed attributes (`slog.String`, `slog.Int`) avoid reflection overhead and format cleanly for centralized log aggregators.
19. **Export Prometheus metrics with bounded cardinality**: Never use user IDs, email addresses, or arbitrary URL paths as Prometheus metric label values; doing so triggers metric cardinality explosions.

### Architecture & APIs
20. **Accept interfaces, return structs**: Functions should declare interface parameters to maximize caller flexibility, but return concrete struct types so callers can access all fields without type assertions.
21. **Keep interfaces small**: Single-method interfaces (`io.Reader`, `io.Writer`, `fmt.Stringer`) are vastly more composable and reusable than large, multi-method monolithic interfaces.
22. **Enforce compile-time interface satisfaction checks**: Declare `var _ MyInterface = (*MyStruct)(nil)` to catch missing interface methods at build time rather than runtime.
23. **Pass `context.Context` as the first parameter**: Never store a `context.Context` inside a struct. Propagate it down the call graph explicitly.
24. **Configure `GOMEMLIMIT` in containerized workloads**: In Kubernetes, set `GOMEMLIMIT` to 80%–90% of the container's hard memory limit to prevent abrupt kernel OOM-killer evictions.
25. **Calibrate `GOMAXPROCS` to container CPU limits**: Use `uber-go/automaxprocs` in Kubernetes to prevent the Linux CFS bandwidth controller from throttling Go runtimes scheduled across large nodes.

---
