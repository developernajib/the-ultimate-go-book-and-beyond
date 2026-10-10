## Exercises

### Knowledge Check

1. **Compare Google and Amazon's interview processes.** What is the single biggest difference in how they evaluate candidates, and how should this change your preparation strategy?

2. **A candidate has 8 weeks to prepare for both Meta and Netflix interviews.** Design a preparation schedule that accounts for Meta's emphasis on coding speed and Netflix's emphasis on system design depth.

3. **Explain why the same system design answer would receive different scores at Google versus Amazon.** Use "Design a notification system" as your example.

4. **Map the following Go concurrency patterns to the companies most likely to ask about them:** goroutine pools, fan-out/fan-in, context cancellation, channel-based pub/sub, sync.Pool.

### Coding Challenges

5. **Google-style:** Implement a `WordFilter` that supports prefix and suffix search simultaneously. Given a list of words, `f(prefix, suffix)` returns the word with the highest index that matches both the prefix and suffix. Target: O(1) query time.

```go
// Your implementation here
type WordFilter struct {
    // Design your data structure
}
```

6. **Meta-style (speed round):** Solve both problems in 40 minutes:
 - a) Given a string of digits, return all possible letter combinations (phone keypad mapping)
 - b) Given an array of intervals, insert a new interval and merge if necessary

7. **Amazon-style:** Design and implement an order processing pipeline in Go that:
 - Accepts orders concurrently
 - Validates payment
 - Checks inventory
 - Sends confirmation
 - Handles failures with retry and dead-letter queue
 - Include STAR story: describe a time you built a similar system

8. **Netflix-style:** Implement a complete circuit breaker in Go with:
 - Configurable failure threshold
 - Half-open state with gradual recovery
 - Metrics collection (success rate, P99 latency)
 - Context-aware timeouts

### System Design Challenges

9. **Design YouTube's video processing pipeline** (Google focus): Handle upload, transcoding to multiple resolutions, thumbnail generation, CDN distribution, and adaptive bitrate streaming. Draw the architecture and identify all Go services.

10. **Design Instagram Stories** (Meta focus): Support 500M daily users creating and viewing ephemeral content. Address storage, distribution, analytics, and 24-hour expiration. Focus on the News Feed integration.

11. **Design Amazon's "Customers who bought this also bought" recommendation system** (Amazon focus): Process billions of purchase events to generate real-time recommendations. Include the data pipeline, ML model serving, and A/B testing framework.

### Behavioral Preparation

12. Prepare one STAR story for each of the following scenarios, tailored to the specified company's values:
 - **Google (Googleyness):** A time you navigated significant ambiguity in a project
 - **Amazon (Ownership):** A time you took responsibility for something outside your job description
 - **Netflix (Freedom & Responsibility):** A time you made a bold technical decision with minimal oversight
 - **Microsoft (Growth Mindset):** A time you were wrong about a technical approach and changed course


### Junior → FAANG: Company-Specific Preparation Exercises

The most effective company-specific exercises are simulations of the actual interview format. For Amazon: practice narrating an LP story in under 2 minutes with a metric in the result. For Google: practice a coding problem with think-aloud narration, aiming for an optimal solution in under 25 minutes. For Meta: practice a system design question for a social product at 100M DAU scale. For Apple: practice a practical coding problem with full attention to code quality, error handling, and naming.

### Senior @ FAANG: Exercises as a Closing-Gaps Protocol

Senior candidates should use exercises specifically to close the gap between their current level and the target bar, not to reinforce existing strengths. The principle is to practice where it is uncomfortable, not where it is easy. If system design at the L6 depth level is your weakest area, the exercise protocol is to do one timed system design session per day, review against a reference design, and identify one specific thing you missed or could have gone deeper on. This iteration model produces measurable improvement over a 4-week window. Track your exercise sessions in a log with date, topic, what you did well, and the specific improvement target for the next session.

---
