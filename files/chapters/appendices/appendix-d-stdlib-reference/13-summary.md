## Summary

This appendix covered the essential Go standard library packages:

1. **fmt** - Formatting and I/O with custom formatters
2. **io** - Powerful I/O abstractions and streaming
3. **strings/bytes** - Efficient string and byte manipulation
4. **time** - Time operations, formatting, and timers
5. **context** - Cancellation and request-scoped values
6. **encoding/json** - JSON marshaling with custom types
7. **net/http** - HTTP servers, clients, and middleware
8. **sync** - Synchronization primitives for concurrency
9. **testing** - Built-in testing framework

**Key points:**

- Interface-based design enables powerful composition across packages
- Pass `context.Context` through your application for cancellation and deadlines
- Choose between `sync.Mutex`, `sync.RWMutex`, and `sync.Map` based on your read/write ratio
- Use table-driven tests and benchmarks to verify both correctness and performance

**Further reading:**

- Standard library documentation: https://pkg.go.dev/std
- Effective Go: https://go.dev/doc/effective_go
- Go Blog: https://go.dev/blog

---

| [◀ Appendix C: Tools Reference](../appendix-c-tools-reference/00-introduction.md) | [Appendix D: Standard Library Reference](00-introduction.md) | [Appendix E: Common Patterns & Idioms](../appendix-e-common-patterns/00-introduction.md) ▶ |
| :--- | :---: | ---: |

