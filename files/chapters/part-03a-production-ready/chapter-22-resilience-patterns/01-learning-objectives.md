## Learning Objectives

After completing this chapter, you will be able to:

1. **Implement circuit breakers** to prevent cascading failures across microservices
2. **Design retry strategies** with exponential backoff and jitter for transient failures
3. **Apply bulkhead patterns** to isolate failures and protect shared resources
4. **Build rate limiters** using token bucket and sliding window algorithms
5. **Create fallback mechanisms** for graceful degradation under failure conditions
6. **Combine multiple resilience patterns** into layered fault-tolerant systems
7. **Monitor and observe resilience patterns** with proper metrics and alerting

### Detailed Outcomes

**Mid-level engineer**

- Use `golang.org/x/time/rate` for rate limiting.
- Wrap external calls with a circuit breaker library like `sony/gobreaker`.
- Implement retry with exponential backoff and full jitter.
- Set timeouts on every external call.

**Senior engineer**

- Combine patterns (circuit breaker + retry + timeout) correctly.
- Tune thresholds based on downstream capacity and error patterns.
- Expose metrics (state transitions, retry counts, rejected requests).

**Staff or Principal**

- Decide whether resilience lives in application code or service mesh.
- Drive consistent configuration across services.
- Own incident response when resilience patterns fail.

---
