## Extended Scenarios: Threads and Content Moderation

These additional scenarios cover features that come up frequently in extended interviews or follow-up rounds. Tweet threads and content moderation both introduce complexity that touches multiple services simultaneously, making them excellent discussion points for demonstrating system-wide thinking.

### Handling Tweet Thread (Long-form Content)

When a user posts a thread of 20+ connected tweets:

1. **Atomic thread creation**: All tweets in the thread posted in a single API call
2. **Thread ID**: First tweet's ID serves as thread_id, subsequent tweets reference it via reply_to_id
3. **Thread view**: GET /api/v1/tweets/TWEET_ID/thread returns the entire chain
4. **Fan-out optimization**: Fan out only the first tweet in the thread to timelines, thread expansion happens on tap
5. **Numbered display**: Client renders "1/20", "2/20" labels from the reply chain order

### Content Moderation Pipeline

When a tweet contains potentially harmful content:

1. **Real-time ML classifier**: Every tweet runs through a toxicity model (< 50ms)
2. **Low confidence (0.3-0.7)**: Tweet published normally, queued for human review
3. **High confidence (0.7-0.95)**: Tweet published with "potentially sensitive" label
4. **Very high confidence (> 0.95)**: Tweet held for human review before publishing
5. **Appeals process**: Author can appeal automated decisions, routed to specialized review queue
6. **Feedback loop**: Human decisions retrain the ML model weekly


---
