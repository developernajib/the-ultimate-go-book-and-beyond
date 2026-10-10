## Company Case Studies: ML Platforms at Scale

Understanding how major tech companies build their ML platforms gives you valuable context for architectural decisions. Each company below solved the same fundamental problems -- experiment tracking, model serving, feature management -- but made different trade-offs based on their scale, latency requirements, and organizational structure. The code samples here are simplified representations of each company's approach, designed to illustrate the key design patterns rather than replicate the full systems.

### Uber: Michelangelo ML Platform

Uber's Michelangelo is one of the most well-known industry ML platforms. It was built to unify the dozens of ad-hoc ML systems that had sprung up across the company, covering everything from ride-time estimation to fraud detection. The platform manages the full lifecycle from feature engineering through training, evaluation, and deployment, with a strong emphasis on a centralized feature store that ensures consistency between training and serving.

```go
// Uber Michelangelo-style ML platform
package michelangelo

import (
    "context"
    "time"
)

// MLPlatform manages the ML lifecycle
type MLPlatform struct {
    featureStore    *FeatureStore
    trainingService *TrainingService
    modelRegistry   *ModelRegistry
    predictionService *PredictionService
}

// Feature represents a Michelangelo feature
type Feature struct {
    Name        string            `json:"name"`
    Entity      string            `json:"entity"` // user, driver, trip
    ValueType   string            `json:"value_type"`
    Description string            `json:"description"`
    Owners      []string          `json:"owners"`
    Tags        map[string]string `json:"tags"`
    Source      *FeatureSource    `json:"source"`
    Freshness   time.Duration     `json:"freshness"`
}

// FeatureSource defines where feature values come from
type FeatureSource struct {
    Type        string `json:"type"` // batch, streaming, request
    Table       string `json:"table,omitempty"`
    Query       string `json:"query,omitempty"`
    KafkaTopic  string `json:"kafka_topic,omitempty"`
    Transform   string `json:"transform,omitempty"`
}

// GetOnlineFeatures retrieves features for real-time prediction
func (p *MLPlatform) GetOnlineFeatures(ctx context.Context, entityType string, entityIDs []string, featureNames []string) (map[string]map[string]any, error) {
    results := make(map[string]map[string]any)

    for _, entityID := range entityIDs {
        features := make(map[string]any)

        for _, name := range featureNames {
            value, err := p.featureStore.GetOnline(ctx, entityType, entityID, name)
            if err != nil {
                continue // Use default or skip
            }
            features[name] = value
        }

        results[entityID] = features
    }

    return results, nil
}

// TrainModel trains a model with given configuration
func (p *MLPlatform) TrainModel(ctx context.Context, config *TrainingConfig) (*TrainingJob, error) {
    // Create training job
    job := &TrainingJob{
        ID:        generateJobID(),
        Config:    config,
        Status:    "pending",
        CreatedAt: time.Now(),
    }

    // Get training features
    trainingData, err := p.featureStore.GetTrainingSet(ctx, &TrainingSetRequest{
        Features:   config.Features,
        Label:      config.Label,
        StartTime:  config.StartTime,
        EndTime:    config.EndTime,
        SampleRate: config.SampleRate,
    })

    if err != nil {
        return nil, err
    }

    // Submit to training cluster
    job.Status = "running"
    p.trainingService.Submit(ctx, job, trainingData)

    return job, nil
}

// Predict serves real-time predictions
func (p *MLPlatform) Predict(ctx context.Context, modelID string, request *PredictionRequest) (*PredictionResponse, error) {
    // Get model from registry
    model, err := p.modelRegistry.GetModel(ctx, modelID)
    if err != nil {
        return nil, err
    }

    // Get features
    features, err := p.GetOnlineFeatures(ctx, request.EntityType, []string{request.EntityID}, model.Features)
    if err != nil {
        return nil, err
    }

    // Run prediction
    prediction, err := p.predictionService.Predict(ctx, model, features[request.EntityID])
    if err != nil {
        return nil, err
    }

    return &PredictionResponse{
        Prediction:  prediction,
        ModelID:     modelID,
        ModelVersion: model.Version,
        Latency:     time.Since(time.Now()),
    }, nil
}
```

### Netflix: Metaflow ML Framework

Netflix built Metaflow to make it easy for data scientists to build and deploy ML workflows without needing deep infrastructure expertise. The framework emphasizes developer ergonomics -- workflows are defined as Python classes with decorated methods, and the infrastructure handles versioning, dependency management, and scaling automatically. The Go-style representation below shows how a step-based flow executor might work, with automatic artifact passing between steps and built-in support for parallel fan-out.

```go
// Netflix Metaflow-style ML workflow
package metaflow

import (
    "context"
    "time"
)

// Flow represents a Metaflow workflow
type Flow struct {
    Name        string
    Steps       []*Step
    Parameters  []*Parameter
    Decorators  []Decorator
}

// Step represents a flow step
type Step struct {
    Name       string
    Function   StepFunc
    Next       []string
    Decorators []Decorator
    Retry      *RetryConfig
}

// StepFunc is the signature for step functions
type StepFunc func(ctx *FlowContext) error

// Decorator modifies step behavior
type Decorator interface {
    Apply(step *Step) *Step
}

// FlowContext provides step execution context
type FlowContext struct {
    Flow       *Flow
    Run        *FlowRun
    Step       *Step
    Index      int
    Input      any
    Parameters map[string]any
    Artifacts  map[string]any
    self       any
}

// Start begins flow execution
func (f *Flow) Start(ctx context.Context, params map[string]any) (*FlowRun, error) {
    run := &FlowRun{
        ID:         generateRunID(),
        Flow:       f.Name,
        Parameters: params,
        Status:     "running",
        StartTime:  time.Now(),
        Steps:      make(map[string]*StepRun),
    }

    // Execute start step
    startStep := f.getStep("start")
    flowCtx := &FlowContext{
        Flow:       f,
        Run:        run,
        Step:       startStep,
        Parameters: params,
        Artifacts:  make(map[string]any),
    }

    if err := f.executeStep(ctx, flowCtx); err != nil {
        run.Status = "failed"
        return run, err
    }

    return run, nil
}

func (f *Flow) executeStep(ctx context.Context, flowCtx *FlowContext) error {
    step := flowCtx.Step

    // Record step start
    stepRun := &StepRun{
        Name:      step.Name,
        Status:    "running",
        StartTime: time.Now(),
    }
    flowCtx.Run.Steps[step.Name] = stepRun

    // Execute with retry
    var err error
    for attempt := 0; attempt <= step.Retry.MaxAttempts; attempt++ {
        err = step.Function(flowCtx)
        if err == nil {
            break
        }
        time.Sleep(step.Retry.Delay)
    }

    if err != nil {
        stepRun.Status = "failed"
        stepRun.Error = err.Error()
        return err
    }

    stepRun.Status = "completed"
    stepRun.EndTime = time.Now()
    stepRun.Artifacts = flowCtx.Artifacts

    // Execute next steps
    for _, nextName := range step.Next {
        nextStep := f.getStep(nextName)
        nextCtx := &FlowContext{
            Flow:       f,
            Run:        flowCtx.Run,
            Step:       nextStep,
            Parameters: flowCtx.Parameters,
            Artifacts:  flowCtx.Artifacts,
            Input:      flowCtx.Artifacts,
        }

        if err := f.executeStep(ctx, nextCtx); err != nil {
            return err
        }
    }

    return nil
}
```

### Google: Vertex AI Platform

Google's Vertex AI is a fully managed platform that unifies their earlier ML tools (AI Platform, AutoML, and custom training) under a single API surface. It provides managed training jobs that automatically provision and release GPU clusters, a model registry with automatic endpoint deployment, and built-in monitoring for prediction drift. The code below illustrates the key abstractions: custom training jobs with configurable machine specs, managed endpoints that handle scaling and traffic splitting, and an integrated pipeline system.

```go
// Google Vertex AI-style ML platform
package vertexai

import (
    "context"
    "time"
)

// VertexAI manages ML workloads on Google Cloud
type VertexAI struct {
    aiplatformClient *AIPlatformClient
    storageClient    *StorageClient
    bqClient         *BigQueryClient
}

// CustomJob represents a Vertex AI custom training job
type CustomJob struct {
    Name           string              `json:"name"`
    DisplayName    string              `json:"displayName"`
    JobSpec        *CustomJobSpec      `json:"jobSpec"`
    State          string              `json:"state"`
    CreateTime     time.Time           `json:"createTime"`
    StartTime      time.Time           `json:"startTime,omitempty"`
    EndTime        time.Time           `json:"endTime,omitempty"`
}

// CustomJobSpec defines training job configuration
type CustomJobSpec struct {
    WorkerPoolSpecs []*WorkerPoolSpec `json:"workerPoolSpecs"`
    Scheduling      *Scheduling       `json:"scheduling,omitempty"`
}

// WorkerPoolSpec defines compute resources
type WorkerPoolSpec struct {
    MachineSpec    *MachineSpec      `json:"machineSpec"`
    ReplicaCount   int64             `json:"replicaCount"`
    ContainerSpec  *ContainerSpec    `json:"containerSpec,omitempty"`
    PythonPackageSpec *PythonPackageSpec `json:"pythonPackageSpec,omitempty"`
}

// CreateTrainingJob submits a custom training job
func (v *VertexAI) CreateTrainingJob(ctx context.Context, req *CreateJobRequest) (*CustomJob, error) {
    job := &CustomJob{
        Name:        generateJobName(req.ProjectID, req.Location),
        DisplayName: req.DisplayName,
        JobSpec: &CustomJobSpec{
            WorkerPoolSpecs: []*WorkerPoolSpec{
                {
                    MachineSpec: &MachineSpec{
                        MachineType:      req.MachineType,
                        AcceleratorType:  req.AcceleratorType,
                        AcceleratorCount: req.AcceleratorCount,
                    },
                    ReplicaCount: 1,
                    ContainerSpec: &ContainerSpec{
                        ImageUri: req.ContainerImage,
                        Args:     req.Args,
                        Env:      req.Env,
                    },
                },
            },
        },
        State:      "PENDING",
        CreateTime: time.Now(),
    }

    // Submit to Vertex AI
    created, err := v.aiplatformClient.CreateCustomJob(ctx, job)
    if err != nil {
        return nil, err
    }

    return created, nil
}

// DeployModel deploys a model to an endpoint
func (v *VertexAI) DeployModel(ctx context.Context, req *DeployModelRequest) (*Endpoint, error) {
    // Create or get endpoint
    var endpoint *Endpoint
    if req.EndpointID != "" {
        endpoint, _ = v.aiplatformClient.GetEndpoint(ctx, req.EndpointID)
    } else {
        endpoint = &Endpoint{
            Name:        generateEndpointName(req.ProjectID, req.Location),
            DisplayName: req.DisplayName,
        }
        endpoint, _ = v.aiplatformClient.CreateEndpoint(ctx, endpoint)
    }

    // Deploy model to endpoint
    deployedModel := &DeployedModel{
        Model:              req.ModelID,
        DisplayName:        req.ModelDisplayName,
        MachineSpec:        req.MachineSpec,
        MinReplicaCount:    req.MinReplicas,
        MaxReplicaCount:    req.MaxReplicas,
        AutoscalingMetricSpecs: req.AutoscalingMetrics,
    }

    _, err := v.aiplatformClient.DeployModel(ctx, endpoint.Name, deployedModel, req.TrafficSplit)
    if err != nil {
        return nil, err
    }

    return endpoint, nil
}
```

### Stripe: Fraud Detection ML System

Stripe's fraud detection system is a specialized ML platform that must make accurate decisions in real time -- every payment processed by Stripe runs through ML models that score fraud risk. The system requires extremely low latency (single-digit milliseconds), high reliability (any downtime means lost revenue), and the ability to update models frequently as fraud patterns evolve. The code below shows how such a system might structure its real-time scoring pipeline, feature computation, and model ensemble logic.

```go
// Stripe-style fraud detection ML system
package stripe

import (
    "context"
    "time"
)

// FraudDetectionService handles payment fraud ML
type FraudDetectionService struct {
    featureEngine   *FeatureEngine
    modelEnsemble   *ModelEnsemble
    ruleEngine      *RuleEngine
    feedbackLoop    *FeedbackLoop
}

// Transaction for fraud scoring
type Transaction struct {
    ID              string            `json:"id"`
    Amount          int64             `json:"amount"`
    Currency        string            `json:"currency"`
    CardFingerprint string            `json:"card_fingerprint"`
    CustomerID      string            `json:"customer_id"`
    MerchantID      string            `json:"merchant_id"`
    IPAddress       string            `json:"ip_address"`
    DeviceID        string            `json:"device_id"`
    Metadata        map[string]string `json:"metadata"`
    Timestamp       time.Time         `json:"timestamp"`
}

// FraudScore represents fraud detection result
type FraudScore struct {
    TransactionID string            `json:"transaction_id"`
    Score         float64           `json:"score"` // 0-100
    Outcome       string            `json:"outcome"` // allow, review, block
    RiskFactors   []*RiskFactor     `json:"risk_factors"`
    ModelScores   map[string]float64 `json:"model_scores"`
    RuleMatches   []string          `json:"rule_matches"`
    LatencyMS     int64             `json:"latency_ms"`
}

// ScoreTransaction evaluates fraud risk
func (s *FraudDetectionService) ScoreTransaction(ctx context.Context, txn *Transaction) (*FraudScore, error) {
    start := time.Now()

    result := &FraudScore{
        TransactionID: txn.ID,
        ModelScores:   make(map[string]float64),
    }

    // Extract features
    features, err := s.featureEngine.Extract(ctx, txn)
    if err != nil {
        return nil, err
    }

    // Run model ensemble
    scores := s.modelEnsemble.Predict(ctx, features)
    result.ModelScores = scores

    // Combine model scores
    ensembleScore := s.combineScores(scores)

    // Run rule engine
    ruleMatches := s.ruleEngine.Evaluate(ctx, txn, features)
    result.RuleMatches = ruleMatches

    // Adjust score based on rules
    finalScore := s.adjustScoreWithRules(ensembleScore, ruleMatches)
    result.Score = finalScore

    // Determine outcome
    result.Outcome = s.determineOutcome(finalScore)

    // Extract risk factors
    result.RiskFactors = s.extractRiskFactors(features, scores, ruleMatches)

    result.LatencyMS = time.Since(start).Milliseconds()

    // Async: record for feedback loop
    go s.feedbackLoop.Record(ctx, txn, result)

    return result, nil
}

// FeatureEngine computes real-time features
type FeatureEngine struct {
    redisClient  *RedisClient
    featureStore *FeatureStore
}

func (e *FeatureEngine) Extract(ctx context.Context, txn *Transaction) (map[string]float64, error) {
    features := make(map[string]float64)

    // Transaction features
    features["amount_usd"] = float64(txn.Amount) / 100
    features["is_recurring"] = boolToFloat(e.isRecurring(ctx, txn))

    // Card velocity features
    features["card_txn_count_1h"] = float64(e.getCardVelocity(ctx, txn.CardFingerprint, time.Hour))
    features["card_txn_count_24h"] = float64(e.getCardVelocity(ctx, txn.CardFingerprint, 24*time.Hour))
    features["card_distinct_merchants_24h"] = float64(e.getDistinctMerchants(ctx, txn.CardFingerprint))

    // Customer history features
    features["customer_age_days"] = float64(e.getCustomerAgeDays(ctx, txn.CustomerID))
    features["customer_total_txns"] = float64(e.getCustomerTxnCount(ctx, txn.CustomerID))
    features["customer_avg_amount"] = e.getCustomerAvgAmount(ctx, txn.CustomerID)

    // IP/device features
    features["ip_country_matches_card"] = boolToFloat(e.ipMatchesCardCountry(ctx, txn))
    features["device_seen_before"] = boolToFloat(e.deviceSeenBefore(ctx, txn.DeviceID, txn.CustomerID))

    return features, nil
}
```

### Key Takeaways from Industry Leaders

| Company | Key Innovation | Scale |
|---------|---------------|-------|
| Uber Michelangelo | Feature store, model versioning | Millions of predictions/sec |
| Netflix Metaflow | Data scientist workflow, reproducibility | Hundreds of models |
| Google Vertex AI | Managed infrastructure, AutoML | Enterprise scale |
| Stripe Radar | Real-time fraud scoring, ensemble models | Billions of transactions |

---
