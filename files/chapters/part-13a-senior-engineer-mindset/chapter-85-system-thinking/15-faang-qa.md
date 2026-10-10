## FAANG Interview Q&A: Systems Thinking

These questions target the Senior / Staff bar where the interviewer is assessing whether you can reason about second-order effects, feedback loops, and emergent behavior in production systems.

### 1. Describe a time when fixing one problem in a system created a worse problem elsewhere.

A strong answer names the feedback loop explicitly: what you changed, what downstream behavior changed in response, and how long it took to detect the regression. Uber and Amazon interviewers look for evidence that you now consciously model second-order effects before shipping changes. Include the monitoring you added afterward to catch the class of problem early.

### 2. Tell me about a production incident where the root cause was an emergent interaction between two services that were each behaving correctly in isolation.

This probes for distributed-systems intuition. Describe the two services, the protocol between them, the conditions under which their individually correct behaviors combined into a failure mode, and how you restored service. Meta and Google weigh heavily on whether your post-incident action items addressed the interaction itself rather than just tuning one side.

### 3. How have you used feedback loops deliberately to improve a system?

Examples include autoscaling targets tied to p99 latency rather than CPU, adaptive rate limiting based on downstream error rates, and circuit breakers that modulate their thresholds based on observed traffic. Stripe and Google look for answers that show you understand loop delay and oscillation: a loop with too short a sensing window will flap.

### 4. Design a retry and backoff strategy for a Go client calling a downstream service that occasionally returns 503.

Cover exponential backoff with full jitter, a retry budget capped as a percentage of successful requests, and a circuit breaker that opens after a sustained error rate. Discuss the thundering-herd risk when many clients retry simultaneously, and explain how jitter decorrelates retries. Go-specific details include using `context.Context` for deadline propagation and `time.AfterFunc` for scheduled retries.

### 5. Walk through how you would detect a gray failure in a Go service before it becomes a full outage.

Binary up/down health checks miss gray failures by definition. A staff-level answer describes percentile latency tracking (p95 and p99 separately), a baseline-relative threshold (fire when p99 is 3x baseline for more than 5 minutes), and correlating the degradation signal with downstream error rates and retry amplification. Reference the Stripe 2022 gray failure pattern and explain why a simple "error rate > 1%" alert would have missed it.

### Junior → FAANG: Using the Q&A to Calibrate Your Current Level

Read each Q&A entry and estimate what percentage of the staff-level answer you could produce spontaneously in an interview. Be honest. If you could produce 30% of question 5 (gray failure detection), the gap is significant and should drive targeted practice. If you could produce 80% of question 2 (feedback loops), you are close to the L5 bar on that topic.

This calibration exercise is more useful than generic "systems thinking practice" because it identifies specific knowledge gaps. For each gap, identify one concrete experience you could build in the next 30 days: instrument a real service with percentile latency tracking, run a chaos engineering exercise, or do a failure mode analysis on a dependency your team has never formally analyzed.

### Senior @ FAANG: What Bar-Raisers Notice Beyond the Technical Answer

At L6+ evaluation, the technical content of systems thinking answers matters less than how the candidate navigates uncertainty. A bar-raiser for a staff role will deliberately probe the edge of the candidate's knowledge: "and what if the p99 spike is happening only for a specific user segment?" The candidate who says "I don't know, but here is how I would investigate" and then describes a principled investigation approach is presenting better than the candidate who guesses confidently.

The systems thinking bar at staff level is not about knowing all the answers. It is about having a sound, generalizable reasoning process that produces good answers even for problems you have not seen before. Interviewers evaluate this by watching how you reason under uncertainty, not just how you answer the prepared questions. Build and practice the reasoning process, not just the answer library.

---
