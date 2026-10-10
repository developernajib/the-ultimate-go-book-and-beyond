## Problem Understanding (30 seconds)
"Given activities with start and end times, select maximum
non-overlapping activities. This is a classic greedy problem."

### Junior → FAANG: Why the 30-Second Frame Matters

Spending 30 seconds on problem understanding is not wasted time. It prevents 10 minutes of coding the wrong problem. In FAANG interviews, the problem statement is often deliberately ambiguous on key points: does "non-overlapping" mean start strictly after end, or can they be equal? Can an activity appear more than once? Is the input guaranteed sorted?

State your understanding explicitly and confirm it with the interviewer. "I understand the problem as: given n activities each with a start and end time, find the largest subset where no two activities overlap, meaning one must end before or when the other starts. Is that correct?" This 15-second confirmation prevents a wrong solution and demonstrates structured communication.

For activity selection specifically, confirming the overlap definition (strict or non-strict) determines whether the condition is `activities[i][0] >= lastEnd` or `activities[i][0] > lastEnd`. Getting this wrong produces a subtly incorrect solution.

### Senior @ FAANG: Problem Framing as a Leadership Signal

At the staff level, problem understanding is not about clarifying the constraints of a 45-minute interview problem. It is about ensuring that the engineering problem being solved matches the business problem that was intended. This is the most common source of technically correct but strategically wrong solutions in production.

In system design interviews, the first 5 minutes should be spent on clarifying the problem scope, the traffic patterns, the consistency requirements, and the failure modes the system must handle. Candidates who skip directly to "I'll use a distributed cache" without understanding whether consistency or availability is the priority are demonstrating L4 thinking. L6 candidates ask: "What is the acceptable error rate? What does the system do when it fails? Who are the users and what is their latency tolerance?" These questions reframe the entire design.

The discipline of investing time in problem understanding before generating solutions is a senior engineering habit that transfers directly from interview preparation to production engineering. Staff engineers who build this habit save their teams weeks of rework by catching requirement mismatches before they become implementation bugs.
