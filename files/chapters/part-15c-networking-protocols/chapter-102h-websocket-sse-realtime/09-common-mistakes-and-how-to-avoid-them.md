## 102H.7 Common Pitfalls and Mitigation Strategies

| Mistake | Impact | Fix |
|---------|--------|-----|
| No heartbeat/ping | Dead connections accumulate | Implement ping/pong with PongWait |
| Unbuffered send channel | Slow clients block the hub | Buffer send channel (256+ messages) |
| No client disconnect on slow consumer | Memory leak | Close connection on full send buffer |
| Writing to WebSocket from multiple goroutines | Race condition / panic | One write goroutine per connection (writePump) |
| No message size limit | OOM from malicious large messages | SetReadLimit() |
| Single hub without Redis | Multi-node: clients on different nodes can't communicate | Redis pub/sub for cross-node delivery |
| SSE without X-Accel-Buffering: no | nginx buffers stream, clients see delayed events | Set X-Accel-Buffering: no header |
| No reconnection backoff | Thundering herd on server restart | Exponential backoff with jitter |
| Storing session state in WebSocket handler | Lost on reconnect | Externalize session to Redis |
| No rate limiting on messages | DoS via message flood | Token bucket per client |

### Junior → FAANG: Using Common Mistakes Tables as a Code Review Checklist

Each row in this table is a code review comment waiting to happen. Before submitting any WebSocket implementation for review, check each row: is there a single writer goroutine per connection? Are ping/pong handlers registered? Is `SetReadLimit` called? Does the hub select on a done channel to avoid blocking forever? Are write deadlines set before each send?

Using a table like this as a personal checklist converts passive knowledge into active practice. The mistakes that appear most in code reviews at all levels are the ones engineers know about but forget to apply under deadline pressure. The checklist habit prevents that.

The rate limiting row deserves special attention because it is a security requirement, not just a performance concern. A malicious client that sends messages at maximum speed can consume a disproportionate share of the hub's processing time and starve other clients. A token bucket per client (allowing a burst of N messages and then throttling to M messages per second) is the correct pattern.

### Senior @ FAANG: Mistakes as Signals for Architecture Gaps

At senior level, recurring common mistakes indicate missing platform primitives rather than individual engineer errors. If multiple teams keep storing session state in-process and losing it on reconnect, the correct response is not better documentation, it is a platform SDK that externalizes session storage by default and makes the in-memory option require explicit opt-in with a warning. If multiple teams omit rate limiting, the correct response is a rate limiting middleware layer that is applied by default at the connection tier, not just recommended in documentation.

The pattern: when a "common mistake" appears in code review more than twice across different teams, it has graduated from a mistake to a missing abstraction. Platform engineers at L6 spend a significant portion of their time identifying these patterns and building the primitives that make the incorrect behavior harder to express than the correct behavior. This is what "shifting left" means at the platform level: not catching mistakes earlier in the same process, but redesigning the process so the mistake cannot be made.

---
