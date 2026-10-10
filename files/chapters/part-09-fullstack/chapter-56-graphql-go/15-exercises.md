## Exercises

1. **Add Complexity Analysis**: Implement a custom complexity calculation function that assigns cost 1 to scalar fields and multiplies child complexity by the `first` argument on connection fields. Register it with `extension.FixedComplexityLimit` and write a test that verifies a deeply nested query is rejected before any resolver executes.

2. **Implement Federation**: Split the e-commerce schema into two services - one owning `User` and `Order` types, the other owning `Product` and `Category`. Use the `_entities` query pattern to resolve cross-service references and verify that a single client query spanning both services returns the correct merged result.

3. **Add Persisted Queries**: Implement automatic persisted queries (APQ) using SHA-256 hashing. On the first request, the client sends only the hash. If the server does not recognize it, the client retries with the full query and the server stores the mapping. Write tests covering both the cache-miss and cache-hit paths.

4. **Real-Time Inventory**: Add a `productStockUpdated` subscription that pushes updates when stock levels change. Use a buffered channel with non-blocking sends so a slow consumer does not block the publisher. Verify the subscription receives events by writing a test that triggers a stock change and asserts the event arrives within a timeout.

5. **File Uploads**: Implement multipart file upload for product images using `gqlgen`'s `Upload` scalar and the `transport.MultipartForm` transport. Validate file type and size server-side before persisting. Return the uploaded image URL in the mutation response.

6. **Rate Limiting**: Add per-user rate limiting to mutations using a sliding window counter stored in Redis. Track complexity points rather than raw request counts - a simple `updateUser` mutation costs 1 point, while `createOrder` costs 10. Return the remaining quota and reset time in the response `extensions` field.

### Junior -> FAANG: How to Use These Exercises Effectively

Do not just implement the feature and move on. Each exercise has a "make it testable" component that is as important as the implementation. For exercise 1 (complexity analysis), write a table-driven test with at least five query shapes: a flat scalar query, a single-level pagination query, a two-level nested pagination query, a query at exactly the complexity limit, and a query one point over the limit. Verify that the last two produce different outcomes (accepted vs rejected). This table-driven approach is exactly what FAANG interviewers expect in a coding screen.

For exercise 4 (real-time inventory), the subscription test is the hardest part. The pattern: start the subscription in a goroutine, send a mutation that triggers a stock change in the main goroutine, then use a channel with a timeout to receive the subscription event and assert on it. If the event does not arrive within the timeout, the test fails with a clear message. This pattern is reusable across all subscription tests.

### Senior @ FAANG: Extending These Exercises to Platform Problems

Exercise 2 (federation) is the exercise most relevant to staff-level interviews. Extend it beyond the basic implementation: add schema composition validation that detects when a subgraph's entity key does not match the gateway's expectation, implement the `_entities` query pattern correctly (batched, not per-entity), and add a schema health check endpoint that the gateway polls to detect when a subgraph's schema has changed. Then add a CI gate that runs composition validation on every subgraph pull request before merging.

Exercise 6 (rate limiting) becomes more interesting at staff level when you consider the fairness dimension: a single expensive query should consume more of the rate limit budget than many cheap queries. Design a token bucket where each request is charged its actual query complexity score (computed at the gateway before execution) rather than a flat cost. The remaining budget and reset time belong in the response `extensions` field so compliant clients can implement adaptive backoff. Document the algorithm choice (token bucket vs sliding window) as an ADR, including why the alternative was rejected.

---
