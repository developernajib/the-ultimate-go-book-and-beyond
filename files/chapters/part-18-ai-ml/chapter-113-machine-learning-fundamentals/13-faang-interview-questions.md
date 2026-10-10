## 113.12 FAANG Interview Questions

**Q: Why would a FAANG team pick Go over Python for a machine learning system?**

A: Go wins on serving, not on training. The Python ecosystem owns model development, but the moment a model leaves research and must serve traffic under strict tail-latency and cost constraints, Go becomes attractive. Static binaries eliminate dependency drift across thousands of pods. Goroutines and channels give predictable concurrency for request fan-out, batching, and streaming decode. Garbage collector pause times stay well under a millisecond for typical serving heap sizes. The pattern of putting a Go proxy in front of a Python or C++ model runtime is a common one at companies serving inference on the request path, precisely because the proxy layer is where concurrency, batching, and failure handling live, and none of that needs the model's runtime.

**Q: How do you handle training and inference skew in a production ML service written in Go?**

A: Skew is usually a feature problem, not a model problem. Centralize feature computation behind a feature store that both training pipelines and the Go serving path query through the same client library. Version every feature definition and record which version produced each training example. During serving, log the exact feature vector that was sent to the model, then periodically replay production vectors through the training pipeline to confirm bit-identical output. Add unit tests that assert feature parity between the Go producer and the Python offline producer on a shared fixture set.

**Q: A latency-sensitive model needs to run at 10 thousand QPS on CPU. Walk through the Go serving design.**

A: Load the model once at process start using an ONNX Runtime or TensorFlow C binding exposed through cgo, then keep a pool of session handles sized to GOMAXPROCS. Accept requests on a buffered channel and micro-batch them with a 2 to 5 millisecond timer to amortize tensor copy cost. Pre-allocate input and output buffers in sync.Pool to avoid allocator pressure. Export p50, p95, and p99 latency and queue depth to Prometheus, and scale horizontally on queue depth rather than CPU. Pin the serving container to isolated cores and disable CPU frequency scaling on the node.

**Q: How would you detect and respond to model drift in production?**

A: Run two monitors in parallel. The first is input drift: compute streaming statistics on each feature (mean, variance, null rate) and alert when the Population Stability Index against a reference window crosses 0.25. The second is output drift: track prediction distribution and, where ground truth becomes available, rolling accuracy, AUC, or calibration. Wire alerts into an on-call rotation with a runbook that covers three responses: rollback to the last known good model, shadow a candidate model against live traffic, or freeze the model and escalate to the ML team.

**Q: Explain how you would structure the code boundary between a Go service and a model artifact so the service does not need a rebuild on every retrain.**

A: Treat the model as configuration. Store the serialized model in an object store keyed by version. At startup the Go service reads a pointer (for example, the current champion version) from a config service and downloads the artifact. A background reloader watches the pointer and hot-swaps the in-memory model behind a read-write mutex, draining in-flight requests against the old model. This lets the ML team promote new models through an approval workflow without touching the service code, and it supports fast rollback by flipping the pointer back.

### Junior → FAANG: How to Use These Questions

Read each question and write out your answer before reading the provided answer. Compare your answer to the provided one and identify the specific elements you missed. For most candidates, the gaps are in production details: they describe the happy path but omit the failure modes, or they describe the system correctly but cannot quantify the tradeoffs. Practice adding a "failure mode and mitigation" paragraph to every answer, and practice quantifying your answers with rough numbers (latency in milliseconds, throughput in requests per second, memory in gigabytes).

The question about Go versus Python language choice is one where many candidates underperform by giving vague answers. Prepare a concise, structured answer: "Go for serving because single binary deployment eliminates Python environment management overhead, goroutines handle concurrent inference requests without working around the GIL, and static typing forces schema mismatches to be handled at the boundary instead of surfacing as a NaN deep in the pipeline." That level of specificity signals that you have done this, not just read about it.

### Senior @ FAANG: Interview Questions as Bar-Raiser Calibration

These questions, in the hands of a senior interviewer, are designed to separate L4 from L5 from L6 candidates by the depth of the answers. An L4 answer to "how do you detect model drift?" mentions PSI and monitoring. An L5 answer adds the alert threshold rationale, the retraining trigger policy, and the rollback procedure. An L6 answer adds the organizational process for who reviews the alert, how the decision to retrain versus roll back is made, and how the lessons from each drift event are institutionalized as platform improvements. Practice giving L6-depth answers to each question by layering organizational and governance considerations on top of the technical answer.

The model-artifact-as-configuration question is one of the highest-signal questions in this set because it tests whether the candidate thinks in terms of operational decoupling. The best answers describe not just the hot-reload mechanism but also the model validation that runs after loading (checksum verification, warm-up inference against a golden input, prediction distribution sanity check before accepting live traffic) and the observability that proves the hot-reload succeeded (log the new model version at the moment of swap, emit a metric for the swap duration, alert if the swap takes longer than expected).

Bar-raiser interviewers specifically probe for systemic thinking. When a candidate describes the read-write mutex for hot-reload, the bar-raiser follows up: "What happens if the new model is corrupt and produces NaN predictions?" The expected answer covers: warm-up validation before the swap, NaN detection in the prediction result before returning to the caller, automatic rollback to the previous model version when the error rate exceeds a threshold, and alerting that wakes the on-call engineer with the specific model version that failed and the validation error. Having a complete answer to these follow-up probes is the difference between a hire and a no-hire at L5 and above.

---
