## 24.1 Debugging Philosophy

Production debugging operates under constraints that invert most development habits. You cannot pause the world, you cannot add instrumentation on the fly, and every diagnostic action carries the risk of making the incident worse. The techniques that work at your desk, setting breakpoints, adding print statements, restarting to reproduce, either do not apply or are actively dangerous when a service is handling live traffic. A clear mental model of what is different, and what questions to ask first, saves critical minutes during an incident.

### Production vs Development

The table below contrasts the default tools and constraints in each environment. Development prioritizes depth of inspection. Production prioritizes minimal disruption.

| Development | Production |
|-------------|------------|
| Attach debugger | Read logs and metrics |
| Add print statements | Query traces |
| Stop at breakpoints | Sample profiles |
| Reproduce locally | Analyze after the fact |
| Unlimited time | Minimize impact |

In development, reproducing the bug is the hard part. Once you can trigger it, a debugger gives you full visibility. In production, the bug is already happening, the hard part is observing it without altering the conditions that caused it.

### The Three Questions

Every production investigation, regardless of the specific tooling, follows the same three-question sequence. Skipping straight to "why" without answering "what" and "where" first leads to hypothesis-driven wild goose chases that waste the incident window.

1. **What** is happening? (Symptoms, error rates, latency percentiles, resource exhaustion)
2. **Where** is it happening? (Location, which service, which endpoint, which pod, which code path)
3. **Why** is it happening? (Root cause, the specific condition, data, or timing that triggers the failure)

Answering each question narrows the search space for the next. Metrics dashboards and alerts answer "what." Distributed traces and log correlation answer "where." Profiles, goroutine dumps, and sometimes Delve answer "why."

### Staff Lens: Incident Response Playbook

The what-where-why sequence should be a team playbook. On-call engineers run the playbook, not improvise. Consistent playbook application means faster diagnosis, more even on-call skill distribution.

---
