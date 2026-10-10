## 114.1 Overview

Machine learning in production is far more than training a model. The model itself is a small component in a complex system that ingests data, engineers features, trains models, serves predictions, monitors performance, and automatically retrains when needed. This entire workflow, from raw data to production predictions, is called an ML pipeline.

Go excels at building production ML pipelines because:
- High performance for data processing and feature computation
- Excellent concurrency for parallel data operations
- Strong typing catches errors before deployment
- Simple deployment (single binary, no runtime dependencies)
- Great for building reliable, long-running services

This chapter teaches you to build production ML pipelines in Go, covering everything from data ingestion to model monitoring.

### Junior → FAANG: Pipeline Thinking as a Career Skill

The shift from "I built a model" to "I built an ML pipeline" is the most important career transition for a junior engineer targeting FAANG ML infrastructure roles. Models are fungible: every data scientist can build a model. Reliable, observable, automatically retrained ML pipelines are scarce engineering assets. The large ML-driven companies all staff dedicated platform teams against this problem, and sustain them for years, precisely because it is hard to build well and creates lasting competitive advantage.

When studying this chapter, focus on the interfaces between stages rather than the implementation of each stage. The interface between data ingestion and feature engineering (schema-validated records), between feature engineering and training (versioned dataset artifacts), and between training and serving (model bundles with evaluation metadata) are the architectural insights that transfer from one ML system to the next regardless of the specific libraries or infrastructure used.

A practical study habit: for each pipeline stage in this chapter, write a one-paragraph description of what the stage outputs, what format the output is in, and what happens when the stage fails. This mental model of pipeline stages as atomic units with explicit input-output contracts is what makes it possible to reason about complex ML systems under interview pressure.

### Senior @ FAANG: Pipelines as Organizational Infrastructure

At senior level, an ML pipeline is not a technical artifact: it is organizational infrastructure. The pipeline encodes the organization's decisions about data quality standards (what constitutes a valid training example), model quality standards (what evaluation thresholds a model must pass before promotion), and operational standards (what monitoring is required before a model can serve production traffic). Changing any of these standards requires updating the pipeline, which creates a natural forcing function for cross-team alignment.

Senior engineers who own ML pipelines at FAANG are expected to design them for multi-tenancy from the start. Multiple model teams will use the same pipeline infrastructure, and each team needs the ability to customize their feature schema, evaluation criteria, and retraining schedule without modifying the shared infrastructure code. This leads to a plugin architecture where the pipeline provides extension points (custom feature transformers, custom evaluation metrics, custom retraining triggers) that teams implement and register without forking the core pipeline code.

Operational maturity for an ML pipeline means the on-call rotation can debug any failure at 3 AM with the observability tooling available, without needing to escalate to the engineer who built the pipeline. This requires comprehensive structured logging at each stage, metrics for stage throughput and latency, distributed tracing that spans the entire pipeline run, and runbooks that map common failure modes to diagnosis steps and remediation actions. Building this operational maturity is a continuous investment that senior engineers prioritize over feature additions.
