## FAANG Interview Q&A: Real-World Incidents

These questions come up in SRE, Staff IC, and incident-response loops at Google, Meta, Amazon, Cloudflare, and Discord. Interviewers expect you to reason from public post-mortems to engineering principles.

### 1. Walk through an incident you led the response for. What did you learn?

Strong answers follow the actual incident structure: detection, diagnosis, mitigation, resolution, and post-mortem. Identify the moment you were wrong about the root cause and the signal that corrected you. Amazon and Meta look for blameless framing and concrete action items that prevented the class of incident, not just the specific one.

### 2. The CrowdStrike 2024 outage affected 8.5 million Windows machines. What would you have done differently as an SRE on that team?

Expected points: canary rollout for content updates, not just binary updates. automated rollback when telemetry shows crash loops. staged deployment by ring and region. And a kernel-driver-specific safety layer that rejects malformed rule files before loading them. The core engineering lesson is that any artifact shipped to production is a deployment, including content and configuration, and must traverse the same safety gates as code.

### 3. Describe how you would build a circuit breaker that would have prevented the Roblox 73-hour Consul outage.

Cover BoltDB write-amplification monitoring, a percentage-based health signal rather than binary up/down, a fallback to cached service-discovery endpoints when Consul latency exceeds a threshold, and a rate limiter on retries to prevent the thundering-herd amplification that turned a slow cluster into a dead one. Reference the fact that adding nodes made the situation worse because of replication overhead.

### 4. Design a deployment-safety system for a Go service fleet of 200 instances across 5 regions.

A Staff-level answer covers: progressive rollout through canary → 1% → 10% → 50% → 100%, automated health gates at each stage with minimum bake time, an emergency rollback path that does not depend on the service being deployed, telemetry for error rate and p99 latency with anomaly detection, and a kill-switch that bypasses the progressive rollout for security-critical fixes. Discuss how you would handle a canary that passes but a 10% stage that regresses.

### 5. How would you design observability for a Go service to detect the class of failure that caused the Fastly 2021 outage?

Fastly's outage was triggered by a latent configuration bug exposed by an unusual customer config. The observability answer: structured logs with configuration hash, distributed tracing carrying the config version through request paths, synthetic monitoring that exercises the configuration-edge cases, and alert rules that fire on error-rate delta after any configuration push regardless of absolute volume. The underlying principle is that latent bugs only surface when unusual inputs arrive, and your observability must make the input-to-output linkage visible in real time.

### Junior → FAANG: Translating Incident Knowledge into Behavioral and System Design Answers

The five questions above cover the two interview formats where incident knowledge is most directly tested. For behavioral questions (questions 1, 2), the structure is detection, diagnosis, mitigation, resolution, and post-mortem. When you describe an incident you led, use this structure explicitly: it shows the interviewer that you have a systematic mental model for incident response, not just a story about something that went wrong. For system design questions (questions 3, 4, 5), the incident grounds the answer: you are not describing circuit breakers abstractly, you are describing the specific circuit breaker design that would have prevented Roblox's Consul death spiral. Grounded answers are more credible, more specific, and more memorable than generic pattern descriptions. Pick the two incidents from this chapter most relevant to your work history and build detailed, rehearsed answers around them before your interviews.

### Senior @ FAANG: Bar-Raiser Framing for Staff and Principal IC Rounds

At the bar-raiser level, every question above has a second dimension beyond the technical answer: how do you make the correct behavior systematic across an engineering organization? Question 2 (CrowdStrike): the bar-raiser answer does not stop at "use canary rollout." It specifies who owns the canary policy, how compliance is measured and enforced, what the exception process is, and how you would detect a team that is silently bypassing the policy. Question 4 (deployment safety for 200 instances): the bar-raiser answer includes the platform investment required to make the safety system the default path, not an opt-in, and the organizational change management required to migrate existing services to the new deployment model without disrupting their release velocity. Question 5 (Fastly observability): the bar-raiser answer includes configuration hash as a first-class telemetry dimension across all services in the fleet, which requires the observability platform to support it natively, not each service to implement it independently.

The pattern across all five questions is the same: the L4 answer describes what the correct technical solution is. The L6 answer describes what platform investment and organizational process makes the correct solution the default for every team in the organization, and how you measure compliance and drift from the standard over time.

---
