## 80.8 Mock Interview Questions

### Junior/Mid-Level Questions

1. **What is the difference between `make` and `new`?**
2. **How do you handle panics in Go?**
3. **What is `defer` and in what order are deferred functions executed?**
4. **Explain the difference between goroutines and OS threads.**
5. **How do you prevent race conditions?**

### Senior Level Questions

1. **Design a rate limiter in Go. What data structures would you use?**
2. **How would you implement a connection pool?**
3. **Explain how you'd debug a memory leak in production.**
4. **What's your approach to graceful shutdown?**
5. **How do you handle distributed tracing across microservices?**

### Staff Level Questions

1. **How would you design Go's standard library from scratch today?**
2. **Explain trade-offs between sync primitives and channels.**
3. **How would you optimize a Go service handling 1M requests/second?**
4. **Describe how you'd migrate a monolith to microservices.**
5. **What observability patterns do you implement in production Go services?**

---

### Junior → FAANG: Using Mock Questions to Identify Gaps, Not Measure Performance

The most common mistake junior candidates make with mock interview questions is using them as performance tests ("did I get it right?") rather than diagnostic tools ("which category of gap does this expose?"). A wrong answer during mock preparation is valuable. A wrong answer during a real interview is not.

Organize the mock questions in this section into four buckets: questions you can answer fluently without hesitation, questions you can answer correctly but slowly, questions you get partially right, and questions you cannot answer. Spend 80% of your preparation time on buckets two and three. Bucket one needs maintenance, not study. Bucket four often indicates a prerequisite gap that requires going back to the relevant chapter rather than drilling more questions.

For junior-level questions specifically: practice answering in 60-90 seconds. If your answer runs to five minutes, you are over-explaining and will run out of time in real interviews where multiple questions need to fit in 45 minutes.

### Senior @ FAANG: Senior-Level Mock Questions as Opportunity for Judgment Demonstration

The five senior-level questions at the end of this section are not knowledge tests. They are judgment tests. "Optimize a Go service handling 1M requests/second" does not have a single correct answer. The L6 bar is the quality of your reasoning process: do you ask about the current bottleneck before proposing solutions, do you distinguish between latency optimization and throughput optimization, do you recognize that some optimizations require architectural changes while others are local?

Practice answering senior mock questions with a structured framework: situation (what is the current state), constraint (what is the binding limit), options (what are the candidate approaches), trade-offs (cost, complexity, risk, reversibility), and recommendation (what you would do and why). This framework is also how a senior engineer writes a design doc, which makes your interview answer a proxy for your actual design capability.

Bar-raiser signal: for the observability question specifically, a L6 answer connects implementation choices to operational outcomes. "I implement structured logging with correlation IDs, span-level tracing using OpenTelemetry, and RED metrics (rate, error, duration) per endpoint, because during an incident these three data sources together let on-call engineers identify whether a problem is a traffic spike, an error rate regression, or a latency increase, in under two minutes" is a specific, experience-grounded answer that demonstrates you have operated in production, not just read about observability.
