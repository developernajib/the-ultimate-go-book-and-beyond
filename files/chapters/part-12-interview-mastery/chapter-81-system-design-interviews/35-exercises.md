## Exercises

### Exercise 1: Design Twitter Timeline
Design the home timeline feature for Twitter:
- 300M monthly users
- 500M tweets/day
- Users follow up to 5000 accounts
- Timeline shows 200 most recent tweets

Consider: Fan-out on write vs read, caching strategy, celebrity problem.

### Exercise 2: Design a File Storage System
Design a system like Dropbox or Google Drive:
- File upload/download
- Sync across devices
- Sharing with permissions
- Version history

Consider: Chunking, deduplication, metadata storage.

### Exercise 3: Design a Real-Time Chat System
Design a chat application like Slack:
- 1:1 and group chat
- Real-time messages
- Message history
- Presence indicators

Consider: WebSocket connections, message ordering, offline support.


### Junior → FAANG: Getting Value from System Design Exercises

Exercises in a system design chapter are only useful if you treat them as timed simulations, not reading comprehension. Set a 45-minute timer, open a blank document, and sketch the full design before checking any reference material. The most common junior mistake is using exercises as confirmation that you already understand something rather than as stress tests. For each exercise, practice narrating your reasoning out loud: interviewers at Google and Meta are evaluating your thought process as much as the design itself. If you get stuck, note exactly where, because that is your study gap.

### Senior @ FAANG: Using Exercises to Build Bar-Raiser Readiness

At the senior level, exercises should be run in adversarial mode: after your initial design, actively attack it. Identify the three most likely failure modes, the component most likely to become a bottleneck at 10x load, and the data consistency guarantees you are implicitly assuming. Then redesign for one of those failure modes. This mirrors how a bar-raiser interviewer operates: they will push on exactly the assumptions you leave implicit. A second senior-level practice is to write a one-paragraph ADR for each major technology choice in your exercise solution, capturing the alternatives considered and the criteria for selection. This habit surfaces quickly in interviews as a signal of L6 thinking. Staff engineers should also consider the organizational fit of a design: which teams own which components, where the API contracts are, and how the design enables independent deployment across those ownership boundaries.

---
