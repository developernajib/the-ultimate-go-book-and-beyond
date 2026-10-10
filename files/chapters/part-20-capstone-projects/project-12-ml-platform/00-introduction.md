# Capstone Project 12: ML Platform - Machine Learning Infrastructure

**Difficulty**: Advanced
**Estimated Time**: 3-4 weeks
**Target**: Production-grade MLOps platform for model management, feature stores, and inference
**Tech Stack**: Go 1.27+, ONNX Runtime / CGO, Redis, PostgreSQL, MinIO/S3, gRPC, Docker, Kubernetes

---

### Project Overview & Architecture

While data scientists train models in Python, production serving infrastructure at tech giants is predominantly built in Go and C++. High-throughput model serving requires low latencies, small binary footprints, efficient memory layouts, and stable concurrency that Python runtimes cannot deliver at enterprise scale.

In this capstone project, you will build an end-to-end Machine Learning Infrastructure Platform in Go. The platform provides four core enterprise capabilities: an Experiment Tracking service, an automated Model Registry with artifact versioning, an ultra-low-latency Feature Store supporting both offline batch training and real-time online inference lookups, and an optimized Model Serving Gateway running ONNX models with dynamic request batching.

```
┌──────────────────────────────────────────────────────────────┐
│                     Developer & CI Workflow                  │
│                                                              │
│   Training Pipeline (Python/Go) ────> Experiment Tracking    │
│                                         │                    │
│                                         ▼                    │
│                                      Model Registry (S3)     │
└─────────────────────────────────────────┬────────────────────┘
                                          │ Deploy Artifact
                                          ▼
┌──────────────────────────────────────────────────────────────┐
│                    Online Serving Engine                     │
│                                                              │
│   Client Inquiries (gRPC / REST)                             │
│       │                                                      │
│       ▼                                                      │
│   Feature Store Enrichment (<1ms Redis Lookup)               │
│       │                                                      │
│       ▼                                                      │
│   Dynamic Batching Queue (Aggregates Concurrent Requests)    │
│       │                                                      │
│       ▼                                                      │
│   CGO / ONNX Runtime Inference Engine                        │
│       │                                                      │
│       ▼                                                      │
│   Prediction Response + Drift & Latency Telemetry            │
└──────────────────────────────────────────────────────────────┘
```

### What You Will Build and Learn Across Sections

- **Part 1 & 2 (Architecture & Experiment Tracking)**: Design the data models for experiments, runs, parameters, and metrics, building a high-throughput tracking API.
- **Part 3 (Model Registry & Artifact Storage)**: Build the model registry service managing semantic versions, lifecycle stages (Staging, Production, Archived), and S3/MinIO artifact uploads.
- **Part 4 (Online & Offline Feature Store)**: Implement a dual-tier feature store with Redis for real-time <1ms feature lookups and PostgreSQL for historical feature point-in-time joins.
- **Part 5 (Model Serving & Dynamic Batching)**: Integrate the ONNX C-API runtime using CGO to execute machine learning models in Go, and build a dynamic batcher that coalesces individual inference requests into batched tensor operations.
- **Part 6 (Monitoring & Drift Detection)**: Implement real-time prediction distribution tracking to detect data drift and concept drift in production pipelines.

### Junior → FAANG: Bridging Go and Machine Learning

- **Understanding CGO Overhead in Inference**: Calling C-libraries via CGO incurs a small context switch penalty (~50ns). If you invoke CGO per individual scalar prediction, the context switch overhead dominates. Learn how to buffer and batch tensor requests so CGO overhead is amortized across hundreds of predictions.
- **Safe Memory Management across C/Go Boundaries**: Passing Go pointers into C runtimes can trigger runtime panics if Go's garbage collector moves memory. Master allocating memory with C-native allocators and copying tensor buffers safely.

### Senior @ FAANG: MLOps Reliability & Compliance

- **Point-in-Time Correctness**: In feature engineering, joining future feature values with past training labels causes "data leakage", producing models that perform artificially well in training but fail miserably in production. Design feature schemas that enforce point-in-time correctness for temporal queries.
- **Zero-Downtime Model Hot Swapping**: Updating a machine learning model in production must not drop inference traffic. Implement dual-buffer model runners where the new model is loaded, warmed up with synthetic test tensors, and atomically switched into the active serving path only after passing validation assertions.
