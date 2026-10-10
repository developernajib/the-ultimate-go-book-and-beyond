## Exercises

### Exercise 1: Custom Exception Hierarchy

Design an exception hierarchy for a REST API framework. Include:
- Base `ApiException` with HTTP status code and request ID
- `ValidationException` with a map of field-level errors
- `AuthenticationException` with expiry information
- `RateLimitException` with retry-after duration

Write a request handler that catches these exceptions and formats appropriate HTTP responses.

### Exercise 2: Exception-Safe Container

Implement a `FixedStack<T, N>` (stack with compile-time max size) that provides:
- Basic guarantee for `push()` and `pop()`
- Strong guarantee for `push_strong()` using copy-and-swap
- Nothrow guarantee for `top()`, `size()`, `empty()`, and `swap()`

Write tests that verify each guarantee level by using a type whose copy constructor throws on the Nth invocation.

### Exercise 3: `std::expected` Pipeline

Build a configuration loading pipeline using `std::expected`:
1. `read_file(path)` returns `expected<string, ConfigError>`
2. `parse_toml(content)` returns `expected<TomlTable, ConfigError>`
3. `validate_config(table)` returns `expected<AppConfig, ConfigError>`
4. `apply_overrides(config, env)` returns `expected<AppConfig, ConfigError>`

Chain these using monadic operations (`and_then`, `transform`). Implement a `ConfigError` type that preserves context at each stage.

### Exercise 4: Scope Guard Transaction

Implement a multi-step "saga" pattern for an e-commerce checkout:
1. Reserve inventory (with rollback: release inventory)
2. Charge payment (with rollback: refund payment)
3. Create shipping label (with rollback: cancel label)
4. Send confirmation email (no rollback needed)

Use scope guards so that any failure at any step rolls back all previously completed steps in reverse order. Test with simulated failures at each step.

### Exercise 5: Go-to-C++ Translation

Take this Go code and write three C++ versions: (a) using exceptions, (b) using `std::expected`, (c) using `absl::StatusOr`:

```go
func processTransaction(ctx context.Context, txID string) (*Receipt, error) {
    tx, err := db.FindTransaction(ctx, txID)
    if err != nil {
        return nil, fmt.Errorf("finding transaction %s: %w", txID, err)
    }
    if tx.Status != "pending" {
        return nil, fmt.Errorf("transaction %s is %s, expected pending", txID, tx.Status)
    }
    result, err := paymentGateway.Charge(ctx, tx.Amount, tx.Currency)
    if err != nil {
        return nil, fmt.Errorf("charging %s %s: %w", tx.Amount, tx.Currency, err)
    }
    receipt := &Receipt{
        TransactionID: txID,
        ChargeID:      result.ID,
        Amount:        tx.Amount,
        Timestamp:     time.Now(),
    }
    if err := db.SaveReceipt(ctx, receipt); err != nil {
        // Attempt refund on save failure
        _ = paymentGateway.Refund(ctx, result.ID)
        return nil, fmt.Errorf("saving receipt: %w", err)
    }
    return receipt, nil
}
```

Compare the three versions in terms of lines of code, error visibility, and resource safety.

### Exercise 6: Performance Measurement

Write a benchmark that measures:
1. The cost of `throw` + `catch` for a single-level call stack
2. The cost of `throw` + `catch` for a 10-level call stack
3. The cost of `throw` + `catch` for a 50-level call stack
4. The equivalent cost using `std::expected` return at each level
5. The equivalent cost using C-style error code returns

Plot the results as a function of call stack depth. At what depth and failure rate does `std::expected` become faster than exceptions?

---

### Junior → FAANG: Error Handling Exercises as Production Simulation

The performance benchmarking exercise (exceptions vs. `std::expected` at different failure rates and call stack depths) is not academic. It gives you the data to answer "when would you use `std::expected` over exceptions for performance?" with measured numbers rather than guesses. In a FAANG interview, "I benchmarked this at different failure rates and found X% overhead at Y% failure rate" is a significantly stronger answer than "I heard exceptions are slow."

### Senior @ FAANG: Benchmarking Error Handling as a Team Investment

At the staff level, having measured error handling performance benchmarks for your team's specific workload patterns is a competitive advantage. When a new engineer proposes switching from exceptions to `std::expected` "for performance," a staff engineer who has the benchmark can answer with data, not opinion. Commission and maintain a benchmark suite for each error handling mechanism the team uses, run it on each major compiler upgrade, and track the results as CI metrics. The investment in measurement pays dividends in every future error handling design discussion.

