## Project Overview

This capstone project implements a production-grade ML platform that handles the complete machine learning lifecycle:

1. **Experiment Tracking**: Track ML experiments, parameters, metrics, and artifacts
2. **Model Registry**: Version, stage, and manage ML models
3. **Feature Store**: Centralized feature management with online/offline serving
4. **Model Serving**: High-performance model inference with multiple formats
5. **Pipeline Orchestration**: DAG-based workflow execution for ML pipelines
6. **A/B Testing**: Traffic splitting and statistical analysis
7. **Monitoring**: Data drift, model performance, and alerting

### Why This Matters at FAANG

ML platforms are critical infrastructure at major tech companies:
- **Google**: Vertex AI, TFX (TensorFlow Extended)
- **Meta**: FBLearner Flow
- **Uber**: Michelangelo
- **Netflix**: Metaflow
- **Amazon**: SageMaker
- **Airbnb**: Bighead

Understanding ML platform architecture demonstrates staff engineer-level systems thinking.

### Architecture Overview

The platform separates concerns into six cooperating subsystems arranged in two tiers. The upper tier, Experiment Tracking, Model Registry, and Feature Store, handles the authoring and storage of ML assets, while the lower tier, Pipeline Orchestrator and Model Serving, handles execution and inference. A/B Testing and Monitoring sit across both tiers, consuming metadata from the registry and live traffic metrics from the serving layer to close the feedback loop.

```
┌─────────────────────────────────────────────────────────────────┐
│                         ML Platform                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │  Experiment  │  │    Model     │  │   Feature    │           │
│  │   Tracking   │  │   Registry   │  │    Store     │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│         │                  │                  │                 │
│         └──────────────────┴──────────────────┘                 │
│                           │                                     │
│         ┌─────────────────┴─────────────────┐                   │
│         │                                     │                 │
│  ┌──────────────┐                   ┌──────────────┐            │
│  │   Pipeline   │                   │    Model     │            │
│  │ Orchestrator │                   │   Serving    │            │
│  └──────────────┘                   └──────────────┘            │
│         │                                     │                 │
│         └─────────────────┬─────────────────┘                   │
│                           │                                     │
│         ┌─────────────────┴─────────────────┐                   │
│         │                                     │                 │
│  ┌──────────────┐                   ┌──────────────┐            │
│  │  A/B Testing │                   │  Monitoring  │            │
│  │    Engine    │                   │  & Alerting  │            │
│  └──────────────┘                   └──────────────┘            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   ┌───────────┐     ┌───────────┐     ┌───────────┐
   │PostgreSQL │     │   Redis   │     │   S3 /    │
   │(Metadata) │     │  (Cache)  │     │   MinIO   │
   └───────────┘     └───────────┘     └───────────┘
```

---
