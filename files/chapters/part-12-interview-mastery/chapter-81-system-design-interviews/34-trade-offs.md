## Trade-offs

| Decision | Trade-off |
|----------|-----------|
| WebSocket | Persistent connections vs HTTP polling (latency vs resources) |
| Cassandra | Write performance vs query flexibility |
| Redis presence | Fast but ephemeral vs persistent presence in DB |
| Sequence numbers | Strict ordering vs distributed timestamps |


### Junior → FAANG: Chat System Trade-off Analysis

Every major decision in a chat system involves a trade-off. Message ordering: strict (high coordination cost) versus causal (better scalability, worse UX). Storage: relational (strong consistency, harder to scale writes) versus wide-column (high write throughput, limited query flexibility). Presence: push-based fan-out (fast read, expensive write on high-fan-out users) versus pull-based polling (simple, but higher read latency). For an interview, pick two or three decisions and articulate both sides fluently. The goal is not to have the correct answer but to demonstrate that you understand why both sides exist.

### Senior @ FAANG: Trade-off Analysis as an Organizational Calibration Tool

At the senior level, trade-off analysis in a system design interview mirrors the technical strategy process in an engineering organization. A well-structured trade-off analysis produces a decision memo that the team can reference when revisiting the decision. The memo captures: the problem context, the alternatives considered, the decision criteria, the chosen approach, and the predicted trigger conditions for revisiting. At the L6/L7 bar, interviewers look for candidates who structure their thinking this way naturally, because staff engineers are expected to produce these memos and use them to drive alignment across teams. The additional dimension at the staff level is the organizational trade-off: some technically superior approaches are rejected because they require capabilities the org does not have, create unacceptable operational burden for an under-staffed team, or introduce dependencies on other teams that are not reliable. Naming these organizational constraints explicitly is a signal of leadership maturity.

---
