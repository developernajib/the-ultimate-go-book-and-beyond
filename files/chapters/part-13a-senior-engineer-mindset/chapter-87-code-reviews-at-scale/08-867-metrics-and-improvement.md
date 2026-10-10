## 87.7 Metrics and Improvement

### Measuring Review Health

You cannot improve what you do not measure. Tracking review metrics gives you objective data about whether your review process is healthy or deteriorating. Time metrics tell you about velocity, quality metrics tell you about effectiveness, and culture metrics (gathered through surveys) tell you how engineers actually feel about the process. Together, these paint a complete picture of your review culture.

```
METRICS TO TRACK:

TIME METRICS:
- Time to first review
- Time to approval
- Review cycles (rounds of feedback)

QUALITY METRICS:
- Bugs found in review vs production
- Review comment categories
- Rejected/reverted PRs

VOLUME METRICS:
- PRs reviewed per person
- Review load balance
- PR size distribution

CULTURE METRICS (survey):
- "I learn from code reviews"
- "Code reviews feel constructive"
- "Reviews happen in reasonable time"
```

### Review Retrospectives

Just as you run retrospectives on sprints and incidents, you should periodically review the quality of your reviews themselves. A quarterly review-of-reviews helps you identify patterns like recurring issues that reviews miss, areas where feedback could be more constructive, or bottlenecks that slow down the process. Sampling a mix of successful and problematic PRs gives you balanced insight into what is working and what needs improvement.

```
QUARTERLY REVIEW OF REVIEWS:

1. SAMPLE PRs FROM LAST QUARTER
   - 10 random merged PRs
   - 5 reverted/problematic PRs

2. ANALYZE:
   - What was caught in review?
   - What was missed?
   - What caused delays?

3. DISCUSS:
   - What's working well?
   - What's frustrating?
   - What would help?

4. ACTION ITEMS:
   - Update guidelines
   - Improve tooling
   - Address patterns
```

### Junior → FAANG: Metrics Literacy as a Senior Engineer Signal

The ability to identify the right metrics for a process, as opposed to the metrics that are easy to collect, is a FAANG senior engineer signal. When an interviewer asks "how would you know if your team's code review culture is healthy?", the expected answer at L5 names specific metrics and explains why each metric predicts the outcome you care about.

"Time to first review" predicts developer satisfaction and velocity. "Review cycles per PR" predicts whether blocking feedback is well-calibrated. "Bugs found in review vs production" predicts review depth. A candidate who can explain these connections, not just list the metrics, is demonstrating the kind of causal thinking that senior engineers use to make process improvement decisions.

Culture metrics gathered through surveys are particularly important to mention in interviews because they demonstrate that you understand the difference between process health (measurable in tool data) and cultural health (measurable only by asking people). Teams that optimize for process metrics while the cultural experience deteriorates produce the same outcome as teams that feel good about their culture but have terrible velocity.

### Senior @ FAANG: Review Retrospectives as Engineering Effectiveness Governance

At L6 and above, the quarterly review-of-reviews is an engineering effectiveness ritual that belongs alongside sprint retrospectives and incident postmortems as a first-class process.

Staff engineers who run these retrospectives effectively use the sampled PR data to make causal arguments. "We sampled 15 PRs from last quarter and found that 8 of the production bugs from that period were detectable at review time by a reviewer who read the test file before the implementation file. Our review guidelines say to review tests first, but our review data shows that fewer than 30% of reviewers do this. The intervention is a pre-review checklist change." That is a data-driven process improvement argument, not an anecdote.

The review retrospective is also a forum for updating the automation layer. Linters should be expanded to catch patterns that human reviewers are consistently catching. When the same error handling pattern appears in five reviewed PRs from different authors, that is a signal that automated detection is cheaper than repeated human review. Staff engineers who close the loop between review observation and linter improvement are building compounding quality infrastructure.

At the organizational maturity model level, teams that run review retrospectives and act on the data are at a significantly higher process maturity than teams that have review guidelines but never measure adherence to them. Staff engineers who establish this practice early, before the team is large enough to have review dysfunction, make the investment when it is cheap and benefit from it when it would otherwise be expensive.

---
