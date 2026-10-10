## 114.2 ML Pipeline Architecture

### The Complete ML System

A complete ML system integrates data ingestion, feature transformation, training, model inference, and monitoring. The diagram below maps how those pieces connect before we build any of them, and it is worth studying the arrows more than the boxes: the boxes are where the code goes, but the arrows are where the production incidents come from.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ML Pipeline System                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐       │
│  │   Raw Data   │─────►│   Feature    │─────►│   Feature    │       │
│  │  Ingestion   │      │ Engineering  │      │    Store     │       │
│  └──────────────┘      └──────────────┘      └──────┬───────┘       │
│         │                                            │              │
│         │                                            │              │
│         ▼                                            ▼              │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐       │
│  │  Training    │◄─────│   Model      │◄─────│  Training    │       │
│  │   Data       │      │  Training    │      │  Pipeline    │       │
│  │   Store      │      └──────┬───────┘      └──────────────┘       │
│  └──────────────┘             │                                     │
│                                │                                    │
│                                ▼                                    │
│                         ┌──────────────┐                            │
│                         │    Model     │                            │
│                         │   Registry   │                            │
│                         └──────┬───────┘                            │
│                                │                                    │
│         ┌──────────────────────┼──────────────────────┐             │
│         │                      │                      │             │
│         ▼                      ▼                      ▼             │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐       │
│  │  Production  │      │   Canary     │      │     A/B      │       │
│  │   Serving    │      │  Deployment  │      │   Testing    │       │
│  └──────┬───────┘      └──────┬───────┘      └──────┬───────┘       │
│         │                      │                      │             │
│         └──────────────────────┼──────────────────────┘             │
│                                │                                    │
│                                ▼                                    │
│                         ┌──────────────┐                            │
│                         │  Monitoring  │                            │
│                         │  & Metrics   │                            │
│                         └──────┬───────┘                            │
│                                │                                    │
│                                ▼                                    │
│                         ┌──────────────┐                            │
│                         │  Automatic   │                            │
│                         │ Retraining   │                            │
│                         └──────────────┘                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Pipeline Stages

Every production ML pipeline consists of these core stages:

1. **Data Ingestion**: Collect and validate raw data from various sources
2. **Feature Engineering**: Transform raw data into ML-ready features
3. **Feature Store**: Centralized repository for feature definitions and values
4. **Model Training**: Train models using historical features and labels
5. **Model Registry**: Version and store trained models
6. **Model Serving**: Deploy models to production and serve predictions
7. **Monitoring**: Track data quality, model performance, and system health
8. **Retraining**: Automatically retrain models when performance degrades

### Junior → FAANG: Architecture as Interview Framework

The eight-component pipeline architecture in this section is your system design interview framework. When asked to design an ML system, use these eight components as your structure: state the component, explain its responsibility, describe how it interfaces with adjacent components, and identify the failure mode you would monitor for. An answer that covers all eight components with one sentence each is already significantly above average. An answer that covers three or four components with depth and trade-off reasoning demonstrates engineering maturity.

The most commonly omitted components in junior interview answers are the model registry and the retraining trigger. Juniors describe how to train and serve a model but rarely address versioning, rollback, or automated retraining. Prepare a two-minute explanation of how a model registry works: models are stored as versioned artifacts with associated metadata (training dataset version, hyperparameters, evaluation metrics, feature schema version), a champion pointer tracks the version currently in production, and the serving system loads the champion version on startup and polls for updates to enable hot-reload.

Practice drawing this architecture on a whiteboard in under five minutes. Start with the data source on the left, draw arrows through each component in order, label the interface between each pair of components with the format of the data crossing it (events, feature vectors, model artifacts, predictions), and mark the failure mode for each component. This five-minute exercise, repeated enough times, becomes automatic in interview pressure.

### Senior @ FAANG: Architecture as Organizational Topology

The eight-component architecture maps directly to organizational responsibilities. At FAANG, the platform team typically owns components 1-4 (data ingestion, validation, feature engineering, feature store) and components 5-8 are shared between the platform team (registry, serving runtime, monitoring infrastructure) and the model team (model-specific evaluation criteria, retraining triggers). The boundary between shared and team-owned components is an organizational negotiation that senior engineers lead.

Each component boundary is a potential production incident source. Data ingestion failures that are not detected by the validation component result in models trained on silent corrupt data. Feature store availability failures that are not handled gracefully by the serving layer result in degraded predictions or service unavailability. Model registry API changes that are not versioned break serving infrastructure across all model teams simultaneously. Designing each interface with explicit failure contracts (what does this component do when the upstream component is unavailable?) is a senior-level architectural responsibility.

The retraining component is architecturally the most complex because it creates a feedback loop through the entire pipeline. A poorly designed retraining trigger can cause oscillation: a model trained on biased data produces biased predictions that influence user behavior that generates more biased training data. Senior engineers design retraining pipelines with explicit bias audits, holdout populations, and human-in-the-loop review gates for model promotions that have significant business impact. These safeguards must be designed into the architecture from the start, not added after a feedback loop incident occurs.

At L6, the pipeline architecture is a living document that evolves with the organization's ML maturity. The initial architecture handles single models in isolation. The evolved architecture handles hundreds of models with shared infrastructure, automated evaluation, and self-service tooling for model teams. Each evolution is driven by a clear business need (we have too many models to manage manually), a pain point diagnosis (the feature store is a bottleneck for new model onboarding), and a solution that is backward compatible with existing models (the new feature store API is a superset of the old one). Driving these architectural evolutions with minimal disruption to existing workloads is the highest-value work a staff ML infrastructure engineer does.
