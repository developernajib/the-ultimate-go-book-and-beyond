## 114.14 FAANG Interview Questions

**Q: Design an ML feature pipeline that serves both batch training and online inference without skew.**

A: Define features once in a declarative registry that emits both a Spark or Beam job for backfill and a Go streaming operator for online computation. The streaming path writes to a low-latency online store (Redis, DynamoDB, or Bigtable). The batch path writes to an offline store (Parquet on S3 or BigQuery) plus the same online store for parity. Point-in-time correct joins during training pull feature values as they were at the label timestamp. Every feature carries a version, and both paths are tested with shared golden data so any divergence fails CI.

**Q: How do you make a training pipeline reproducible end to end?**

A: Pin code, data, config, and environment. The orchestrator captures the git SHA of the pipeline code, the hash of the input dataset snapshot, the model config blob, the container image digest, and the resolved dependency lockfile. All artifacts land in an experiment tracker with lineage edges. Retraining with the same inputs must produce a model whose eval metrics match within a documented tolerance, and CI runs this determinism check weekly on a small dataset to catch regressions.

**Q: What would you monitor on a production ML pipeline that trains daily?**

A: Four layers. Infrastructure: runtime, CPU, GPU utilization, and spot preemption rate. Data: row counts, schema hash, null rate, and feature distribution versus last run. Model: training loss curve, eval metric, and calibration relative to the last known good model. Business: shadow scoring of the new model against live traffic before promotion. Page on SLA breach for any of the four, and require a human approval for promotion when the model layer shows a regression beyond threshold.

**Q: Explain blue-green deployment for an ML model behind a Go serving stack.**

A: Deploy the new model as a separate inference target (different port, different Kubernetes deployment, or different session inside the same binary). Route a small percent of live traffic to green using a weighted router, and mirror a copy of production traffic as shadow calls that do not affect the response. Compare p99 latency, error rate, and business metric lift between blue and green. Promote green to 100 percent only after the SLO and metric gates hold for a defined bake period. Keep blue warm for fast rollback, then decommission after the next stable release.

**Q: How do you scope an ML platform team's responsibilities versus product teams that ship models?**

A: The platform team owns the feature store, training orchestration, model registry, serving runtime, evaluation framework, and observability. Product teams own the model code, the feature definitions for their domain, and the evaluation criteria for their use case. The contract is a set of library and API surfaces: product teams never hand-roll their own serving path, and the platform team never ships business logic. This mirrors how Netflix, Meta, and Airbnb separate their Metaflow, FBLearner, and Bighead platforms from the product model teams.

### Junior → FAANG: Practicing Interview Questions Effectively

For each question in this set, write a structured answer using the following format: situation (what is the context?), complication (what is the hard part?), solution (what would you do?), tradeoff (what did you give up?). This structure forces you to go beyond describing what to do and explain why, which is what FAANG interviewers are actually evaluating. A candidate who says "I would use a canary deployment" is describing what. A candidate who says "I would use a 1% canary because the cost of a bad deployment at full traffic outweighs the opportunity cost of a 24-hour evaluation window, and I would use user-ID-based routing to ensure consistent experience during the evaluation period" is explaining why and demonstrating production thinking.

Time yourself answering each question out loud for five minutes. If you go over five minutes, you are including too much detail for an interview context. If you finish in under two minutes, you are not going deep enough. The five-minute mark is approximately correct for a senior-level behavioral or system design question in a 45-minute interview where multiple questions are asked.

### Senior @ FAANG: Questions as Bar-Raiser Calibration

The platform team versus product team ownership question is one of the highest-signal questions for L5/L6 calibration in a bar-raiser interview. An L5 answer correctly identifies the component ownership split and describes the API contract. An L6 answer adds: how the contract is versioned and how breaking changes are communicated, what the escalation path is when the platform team's development velocity blocks the product team's model iteration, how the cost of the shared infrastructure is allocated across product teams, and how the on-call rotation is structured when an incident spans both platform and product code. The depth of the L6 answer reveals organizational thinking that goes beyond individual component ownership.

Expect a cost estimation follow-up on any of these questions, because it is the cheapest way for an interviewer to test quantitative reasoning about ML infrastructure. A typical form: "roughly what does it cost to run this daily training pipeline, and what would you cut first?" A strong answer estimates compute time from model and dataset size, storage from parameter count and the training data retention policy, and serving from request volume and inference latency, then names the dominant term and the levers against it. The point is not the number, it is whether the candidate states assumptions out loud, does the arithmetic in the open, and knows which term dominates. Doing this live with rough figures demonstrates the quantitative infrastructure thinking FAANG expects at L5 and above.

---
