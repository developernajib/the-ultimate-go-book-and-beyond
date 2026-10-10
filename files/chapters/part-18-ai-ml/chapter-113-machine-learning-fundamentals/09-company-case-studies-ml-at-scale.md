## 113.8 Company Case Studies: ML at Scale

### Google: TensorFlow Extended (TFX) Patterns

Google built TensorFlow Extended to productionize ML models at scale:

```go
// Google TFX-style ML pipeline components in Go
package tfx

import (
    "context"
    "fmt"
    "time"
)

// Component represents a TFX-style pipeline component
type Component interface {
    Name() string
    Execute(ctx context.Context, inputs Artifacts) (Artifacts, error)
    Validate(inputs Artifacts) error
}

// Artifacts represents input/output data for components
type Artifacts struct {
    Examples     *ExampleArtifact
    Model        *ModelArtifact
    Schema       *SchemaArtifact
    Statistics   *StatisticsArtifact
    Blessing     *BlessingArtifact
}

// ExampleValidator validates input data against schema
type ExampleValidator struct {
    schema *SchemaArtifact
}

func (v *ExampleValidator) Name() string { return "ExampleValidator" }

func (v *ExampleValidator) Execute(ctx context.Context, inputs Artifacts) (Artifacts, error) {
    // Validate examples against schema
    anomalies := v.detectAnomalies(inputs.Examples, inputs.Schema)

    if len(anomalies) > 0 {
        return Artifacts{}, fmt.Errorf("data validation failed: %v", anomalies)
    }

    return inputs, nil
}

// ModelValidator checks if new model is better than production model
type ModelValidator struct {
    threshold float64
}

func (v *ModelValidator) Name() string { return "ModelValidator" }

func (v *ModelValidator) Execute(ctx context.Context, inputs Artifacts) (Artifacts, error) {
    // Compare candidate model against baseline
    candidateMetrics := v.evaluate(inputs.Model)
    baselineMetrics := v.getProductionMetrics()

    blessing := &BlessingArtifact{
        Blessed:     candidateMetrics.AUC > baselineMetrics.AUC+v.threshold,
        CandidateAUC: candidateMetrics.AUC,
        BaselineAUC:  baselineMetrics.AUC,
        Timestamp:    time.Now(),
    }

    return Artifacts{Blessing: blessing}, nil
}

// Pusher deploys blessed models to production
type Pusher struct {
    servingPath string
}

func (p *Pusher) Execute(ctx context.Context, inputs Artifacts) (Artifacts, error) {
    if !inputs.Blessing.Blessed {
        return inputs, fmt.Errorf("model not blessed, skipping push")
    }

    // Push to TensorFlow Serving
    if err := p.pushToServing(inputs.Model); err != nil {
        return inputs, err
    }

    return inputs, nil
}

func (p *Pusher) Name() string { return "Pusher" }
func (p *Pusher) Validate(inputs Artifacts) error { return nil }
func (p *Pusher) pushToServing(m *ModelArtifact) error { return nil }

func (v *ExampleValidator) Validate(inputs Artifacts) error { return nil }
func (v *ExampleValidator) detectAnomalies(ex *ExampleArtifact, s *SchemaArtifact) []string { return nil }

func (v *ModelValidator) Validate(inputs Artifacts) error { return nil }
func (v *ModelValidator) evaluate(m *ModelArtifact) ModelMetrics { return ModelMetrics{AUC: 0.92} }
func (v *ModelValidator) getProductionMetrics() ModelMetrics { return ModelMetrics{AUC: 0.89} }

type ExampleArtifact struct{ URI string }
type ModelArtifact struct{ URI string }
type SchemaArtifact struct{ Version int }
type StatisticsArtifact struct{ ComputedAt time.Time }
type BlessingArtifact struct {
    Blessed      bool
    CandidateAUC float64
    BaselineAUC  float64
    Timestamp    time.Time
}
type ModelMetrics struct{ AUC float64 }
```

### Netflix: Real-Time Personalization

Netflix uses ML for real-time content recommendations:

```go
// Netflix-style recommendation system
package recommendations

import (
    "cmp"
    "context"
    "slices"
    "time"
)

// RecommendationEngine provides personalized content recommendations
type RecommendationEngine struct {
    userEmbeddings   *EmbeddingStore
    contentEmbeddings *EmbeddingStore
    featureStore     *FeatureStore
    modelServer      *ModelServer
    cache            *RecommendationCache
}

type UserContext struct {
    UserID          string
    DeviceType      string
    TimeOfDay       time.Time
    ViewingHistory  []string
    RecentSearches  []string
}

type Recommendation struct {
    ContentID   string
    Score       float64
    Reason      string
    Position    int
}

// GetPersonalizedRecommendations returns content tailored to user
func (e *RecommendationEngine) GetPersonalizedRecommendations(
    ctx context.Context,
    userCtx UserContext,
    limit int,
) ([]Recommendation, error) {
    // Check cache first
    cacheKey := e.buildCacheKey(userCtx)
    if cached, ok := e.cache.Get(cacheKey); ok {
        return cached, nil
    }

    // Get user embedding
    userEmbed, err := e.userEmbeddings.Get(userCtx.UserID)
    if err != nil {
        // New user: use cold start strategy
        userEmbed = e.computeColdStartEmbedding(userCtx)
    }

    // Get real-time features
    features, err := e.featureStore.GetUserFeatures(ctx, userCtx.UserID)
    if err != nil {
        return nil, err
    }

    // Candidate generation: find similar content via ANN
    candidates := e.contentEmbeddings.FindSimilar(userEmbed, limit*10)

    // Ranking: score candidates with full model
    scored := e.rankCandidates(ctx, userCtx, features, candidates)

    // Diversification: ensure variety in recommendations
    diversified := e.diversifyResults(scored, limit)

    // Cache results
    e.cache.Set(cacheKey, diversified, 5*time.Minute)

    return diversified, nil
}

// rankCandidates uses the full ranking model
func (e *RecommendationEngine) rankCandidates(
    ctx context.Context,
    userCtx UserContext,
    features *UserFeatures,
    candidates []string,
) []Recommendation {
    // Batch prediction for efficiency
    input := e.buildRankingInput(userCtx, features, candidates)

    scores, err := e.modelServer.BatchPredict(ctx, "ranking_model", input)
    if err != nil {
        // Fallback to simpler model
        return e.fallbackRanking(candidates)
    }

    recommendations := make([]Recommendation, len(candidates))
    for i, contentID := range candidates {
        recommendations[i] = Recommendation{
            ContentID: contentID,
            Score:     scores[i],
            Reason:    e.explainRecommendation(contentID, features),
        }
    }

    // Sort descending by score
    slices.SortFunc(recommendations, func(a, b Recommendation) int {
        return cmp.Compare(b.Score, a.Score)
    })

    return recommendations
}

type EmbeddingStore struct{}
func (s *EmbeddingStore) Get(id string) ([]float64, error) { return []float64{0.1, 0.2}, nil }
func (s *EmbeddingStore) FindSimilar(emb []float64, limit int) []string { return []string{"c1", "c2"} }

type UserFeatures struct{ Tier string }
type FeatureStore struct{}
func (s *FeatureStore) GetUserFeatures(ctx context.Context, id string) (*UserFeatures, error) {
    return &UserFeatures{Tier: "premium"}, nil
}

type ModelServer struct{}
func (s *ModelServer) BatchPredict(ctx context.Context, model string, input any) ([]float64, error) {
    return []float64{0.95, 0.82}, nil
}

type RecommendationCache struct{}
func (c *RecommendationCache) Get(key string) ([]Recommendation, bool) { return nil, false }
func (c *RecommendationCache) Set(key string, val []Recommendation, ttl time.Duration) {}

func (e *RecommendationEngine) buildCacheKey(ctx UserContext) string { return ctx.UserID }
func (e *RecommendationEngine) computeColdStartEmbedding(ctx UserContext) []float64 { return []float64{0.5, 0.5} }
func (e *RecommendationEngine) diversifyResults(recs []Recommendation, limit int) []Recommendation { return recs }
func (e *RecommendationEngine) buildRankingInput(ctx UserContext, f *UserFeatures, c []string) any { return c }
func (e *RecommendationEngine) fallbackRanking(candidates []string) []Recommendation { return nil }
func (e *RecommendationEngine) explainRecommendation(contentID string, f *UserFeatures) string { return "trending" }
```

### Uber: Real-Time Feature Computation

Uber computes ML features in real-time for ride pricing and ETA:

```go
// Uber-style real-time feature platform
package features

import (
    "context"
    "sync"
    "time"
)

// FeaturePlatform manages feature computation and serving
type FeaturePlatform struct {
    batchFeatures   *BatchFeatureStore    // Pre-computed features
    streamFeatures  *StreamFeatureStore   // Real-time features
    computeEngine   *FeatureComputeEngine
}

// FeatureRequest specifies which features to retrieve
type FeatureRequest struct {
    EntityType string            // user, driver, trip
    EntityID   string
    Features   []string
    Context    map[string]any
}

type FeatureVector struct {
    Features  map[string]float64
    Timestamp time.Time
    Source    string // batch, stream, computed
}

// GetFeatures retrieves features with fallback chain
func (p *FeaturePlatform) GetFeatures(
    ctx context.Context,
    req FeatureRequest,
) (*FeatureVector, error) {
    result := &FeatureVector{
        Features:  make(map[string]float64),
        Timestamp: time.Now(),
    }

    var wg sync.WaitGroup

    // Fetch batch and stream features in parallel.
    //
    // Each goroutine writes to its own variable rather than into the shared
    // result map. The obvious version, where both goroutines lock a mutex and
    // merge into result directly, compiles, passes the race detector, and is
    // still wrong: precedence would then depend on which goroutine happened to
    // finish last. Stream features are meant to win, and "usually wins" is not
    // a semantic. Merging after the barrier, in a fixed order, is what makes
    // the override deterministic.
    var batch, stream map[string]float64

    wg.Add(2)

    go func() {
        defer wg.Done()
        batch, _ = p.batchFeatures.Get(ctx, req.EntityType, req.EntityID, req.Features)
    }()

    go func() {
        defer wg.Done()
        stream, _ = p.streamFeatures.Get(ctx, req.EntityType, req.EntityID, req.Features)
    }()

    wg.Wait()

    // Merge in precedence order: batch first, then stream on top.
    for k, v := range batch {
        result.Features[k] = v
    }
    for k, v := range stream {
        result.Features[k] = v // Stream features override batch
    }

    // Compute any missing features on-demand
    missing := p.findMissing(req.Features, result.Features)
    if len(missing) > 0 {
        computed, err := p.computeEngine.Compute(ctx, req, missing)
        if err == nil {
            for k, v := range computed {
                result.Features[k] = v
            }
        }
    }

    return result, nil
}

// StreamProcessor ingests events and updates stream features
type StreamProcessor struct {
    featureStore *StreamFeatureStore
    aggregators  map[string]Aggregator
}

type Aggregator interface {
    Add(value float64, timestamp time.Time)
    Get(window time.Duration) float64
}

func (p *StreamProcessor) ProcessEvent(event Event) error {
    // Extract features from event
    switch e := event.(type) {
    case *RideRequestEvent:
        // Update user request count (last hour)
        p.aggregators["user_requests_1h"].Add(1, e.Timestamp)

        // Update surge pricing features
        p.aggregators["area_demand_5m"].Add(1, e.Timestamp)

    case *RideCompletedEvent:
        // Update driver rating features
        p.aggregators["driver_rating_7d"].Add(e.Rating, e.Timestamp)

        // Update trip duration features
        p.aggregators["avg_trip_duration_1h"].Add(e.Duration.Minutes(), e.Timestamp)
    }

    return nil
}

type BatchFeatureStore struct{}
func (s *BatchFeatureStore) Get(ctx context.Context, entityType, entityID string, features []string) (map[string]float64, error) {
    return make(map[string]float64), nil
}

type StreamFeatureStore struct{}
func (s *StreamFeatureStore) Get(ctx context.Context, entityType, entityID string, features []string) (map[string]float64, error) {
    return make(map[string]float64), nil
}

type FeatureComputeEngine struct{}
func (e *FeatureComputeEngine) Compute(ctx context.Context, req FeatureRequest, missing []string) (map[string]float64, error) {
    return make(map[string]float64), nil
}

func (p *FeaturePlatform) findMissing(requested []string, available map[string]float64) []string {
    var missing []string
    for _, f := range requested {
        if _, ok := available[f]; !ok {
            missing = append(missing, f)
        }
    }
    return missing
}

type Event interface{}

type RideRequestEvent struct {
    Timestamp time.Time
}

type RideCompletedEvent struct {
    Rating    float64
    Duration  time.Duration
    Timestamp time.Time
}
```

### Amazon: SageMaker-Style Model Deployment

Amazon's SageMaker patterns for model deployment:

```go
// Amazon SageMaker-style model deployment
package sagemaker

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// ModelEndpoint represents a deployed ML model
type ModelEndpoint struct {
    Name           string
    Model          *Model
    InstanceType   string
    InstanceCount  int
    AutoScaling    *AutoScalingConfig
    Variants       []ProductionVariant
}

type ProductionVariant struct {
    Name          string
    Model         *Model
    Weight        float64 // Traffic percentage
    InstanceCount int
}

// EndpointManager handles model deployment and updates
type EndpointManager struct {
    mu        sync.RWMutex
    endpoints map[string]*ModelEndpoint
    metrics   *MetricsCollector
}

// DeployModel creates or updates an endpoint
func (m *EndpointManager) DeployModel(
    ctx context.Context,
    config EndpointConfig,
) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    // Validate model artifacts
    if err := config.Model.Validate(); err != nil {
        return fmt.Errorf("model validation failed: %w", err)
    }

    // Create endpoint
    endpoint := &ModelEndpoint{
        Name:          config.Name,
        Model:         config.Model,
        InstanceType:  config.InstanceType,
        InstanceCount: config.InstanceCount,
        AutoScaling:   config.AutoScaling,
    }

    // If endpoint exists, do blue-green deployment
    if existing, ok := m.endpoints[config.Name]; ok {
        return m.blueGreenUpdate(ctx, existing, endpoint)
    }

    m.endpoints[config.Name] = endpoint
    return nil
}

// blueGreenUpdate performs zero-downtime model update.
//
// Do not name a parameter `new`: it shadows the builtin. `candidate` also
// says more about what it is.
func (m *EndpointManager) blueGreenUpdate(
    ctx context.Context,
    current, candidate *ModelEndpoint,
) error {
    // Seed the stable variant explicitly so index 0 always means "stable"
    // and index 1 always means "canary". The original version appended the
    // canary onto a possibly empty slice and then wrote to Variants[0],
    // which could address the canary itself.
    current.Variants = []ProductionVariant{{
        Name:   "stable",
        Model:  current.Model,
        Weight: 0.9,
    }, {
        Name:   "canary",
        Model:  candidate.Model,
        Weight: 0.1, // 10% traffic initially
    }}

    const (
        stable = 0
        canary = 1
    )

    // Monitor canary performance
    if err := m.monitorCanary(ctx, current, current.Variants[canary], 5*time.Minute); err != nil {
        current.Variants = nil
        return fmt.Errorf("canary failed: %w", err)
    }

    // Gradually shift traffic to the new model.
    //
    // Two things to get right here. First, mutate the variant through the
    // slice index: ProductionVariant is a value type, so the natural-looking
    // version that updates a local copy of the struct shifts no traffic at
    // all while logging that it did. That was the original bug, and it is
    // invisible until you notice the canary never actually takes load.
    //
    // Second, derive each weight from an integer step rather than
    // accumulating `weight += 0.2`. The accumulating form happens to land on
    // exactly 1.0 for this particular step size, so it works here by luck,
    // not by design. Change the step to 0.1 or 0.3 and the final iteration
    // can fall off the end of the guard, stranding the rollout below 100%.
    // Integer stepping removes the question entirely.
    for step := 1; step <= 5; step++ {
        weight := float64(step) / 5.0

        current.Variants[canary].Weight = weight
        current.Variants[stable].Weight = 1.0 - weight

        // Respect cancellation: an unconditional Sleep here pins a rollout
        // goroutine for minutes after the caller has given up.
        select {
        case <-ctx.Done():
            current.Variants[canary].Weight = 0
            current.Variants[stable].Weight = 1.0
            return ctx.Err()
        case <-time.After(2 * time.Minute):
        }

        if m.metrics.GetErrorRate(current.Variants[canary].Name) > 0.01 {
            // Rollback
            current.Variants[canary].Weight = 0
            current.Variants[stable].Weight = 1.0
            return fmt.Errorf("error rate too high during traffic shift at weight %.1f", weight)
        }
    }

    // Complete cutover
    current.Model = candidate.Model
    current.Variants = nil

    return nil
}

type Model struct{}
func (m *Model) Validate() error { return nil }

type AutoScalingConfig struct{ MinCapacity, MaxCapacity int }
type EndpointConfig struct {
    Name          string
    Model         *Model
    InstanceType  string
    InstanceCount int
    AutoScaling   *AutoScalingConfig
}

type MetricsCollector struct{}
func (c *MetricsCollector) GetErrorRate(variant string) float64 { return 0.001 }

func (m *EndpointManager) monitorCanary(ctx context.Context, current *ModelEndpoint, canary ProductionVariant, d time.Duration) error {
    return nil
}
```

### Stripe: ML for Fraud Detection

Stripe uses ML for real-time fraud detection:

```go
// Stripe-style fraud detection system
package fraud

import (
    "context"
    "sync"
    "time"
)

// FraudDetector evaluates transactions for fraud risk
type FraudDetector struct {
    models      []*FraudModel
    ruleEngine  *RuleEngine
    featureGen  *FeatureGenerator
    thresholds  *ThresholdConfig
}

type Transaction struct {
    ID          string
    AmountCents int64
    Currency    string
    CardLast4   string
    CardCountry string
    IPAddress   string
    Email       string
    Timestamp   time.Time
    Metadata    map[string]string
}

type RiskAssessment struct {
    Score       float64
    Decision    string // allow, review, block
    Signals     []RiskSignal
    ModelScores map[string]float64
}

type RiskSignal struct {
    Name        string
    Score       float64
    Description string
}

// Evaluate performs real-time fraud assessment
func (d *FraudDetector) Evaluate(
    ctx context.Context,
    tx Transaction,
) (*RiskAssessment, error) {
    // Generate features
    features, err := d.featureGen.Generate(ctx, tx)
    if err != nil {
        return nil, err
    }

    assessment := &RiskAssessment{
        ModelScores: make(map[string]float64),
        Signals:     make([]RiskSignal, 0),
    }

    // Run all fraud models in parallel
    var wg sync.WaitGroup
    var mu sync.Mutex

    for _, model := range d.models {
        wg.Add(1)
        go func(m *FraudModel) {
            defer wg.Done()
            score, signals := m.Predict(features)

            mu.Lock()
            assessment.ModelScores[m.Name] = score
            assessment.Signals = append(assessment.Signals, signals...)
            mu.Unlock()
        }(model)
    }

    wg.Wait()

    // Apply rule engine
    ruleSignals := d.ruleEngine.Evaluate(tx, features)
    assessment.Signals = append(assessment.Signals, ruleSignals...)

    // Combine scores (ensemble)
    assessment.Score = d.ensembleScores(assessment.ModelScores)

    // Make decision
    assessment.Decision = d.makeDecision(assessment.Score, assessment.Signals)

    return assessment, nil
}

// FeatureGenerator computes fraud detection features
type FeatureGenerator struct {
    velocityStore  *VelocityStore
    deviceStore    *DeviceStore
    geoStore       *GeoStore
}

func (g *FeatureGenerator) Generate(ctx context.Context, tx Transaction) (map[string]float64, error) {
    features := make(map[string]float64)

    // Velocity features
    features["card_txns_1h"] = g.velocityStore.GetCount(tx.CardLast4, time.Hour)
    features["card_txns_24h"] = g.velocityStore.GetCount(tx.CardLast4, 24*time.Hour)
    features["email_txns_1h"] = g.velocityStore.GetCount(tx.Email, time.Hour)
    features["ip_txns_1h"] = g.velocityStore.GetCount(tx.IPAddress, time.Hour)

    // Device fingerprint features
    features["device_age_days"] = g.deviceStore.GetDeviceAge(tx.Metadata["device_id"])
    features["device_txn_count"] = g.deviceStore.GetTxnCount(tx.Metadata["device_id"])

    // Geographic features
    features["card_country_match"] = boolToFloat(tx.CardCountry == g.geoStore.GetIPCountry(tx.IPAddress))
    features["ip_risk_score"] = g.geoStore.GetIPRiskScore(tx.IPAddress)

    // Amount features
    features["amount_zscore"] = g.computeAmountZScore(float64(tx.AmountCents), tx.CardLast4)

    return features, nil
}

type FraudModel struct {
    Name string
}
func (m *FraudModel) Predict(features map[string]float64) (float64, []RiskSignal) {
    return 0.1, nil
}

type RuleEngine struct{}
func (r *RuleEngine) Evaluate(tx Transaction, features map[string]float64) []RiskSignal {
    return nil
}

type ThresholdConfig struct{}

type VelocityStore struct{}
func (s *VelocityStore) GetCount(key string, window time.Duration) float64 { return 1 }

type DeviceStore struct{}
func (s *DeviceStore) GetDeviceAge(id string) float64 { return 30 }
func (s *DeviceStore) GetTxnCount(id string) float64 { return 5 }

type GeoStore struct{}
func (s *GeoStore) GetIPCountry(ip string) string { return "US" }
func (s *GeoStore) GetIPRiskScore(ip string) float64 { return 0.05 }

func boolToFloat(b bool) float64 {
    if b {
        return 1.0
    }
    return 0.0
}

func (g *FeatureGenerator) computeAmountZScore(amount float64, cardLast4 string) float64 {
    return 0.2
}

func (d *FraudDetector) ensembleScores(scores map[string]float64) float64 {
    var sum float64
    for _, s := range scores {
        sum += s
    }
    if len(scores) == 0 {
        return 0
    }
    return sum / float64(len(scores))
}

func (d *FraudDetector) makeDecision(score float64, signals []RiskSignal) string {
    if score > 0.8 {
        return "block"
    } else if score > 0.5 {
        return "review"
    }
    return "allow"
}
```

### Junior → FAANG: Learning from Production ML Case Studies

Reading case studies from Google, Meta, and Uber is not optional background reading: it is interview preparation. When a FAANG interviewer asks "tell me about a large-scale ML system you find interesting," having a detailed and accurate understanding of TFX, Michelangelo, or FBLearner Flow lets you anchor the conversation in real engineering decisions rather than hypothetical designs. Know the architecture of at least one of these systems well enough to draw it on a whiteboard: what the components are, how data flows between them, what the model lifecycle looks like from training to serving to monitoring.

The specific engineering choices in these case studies are teaching tools. TFX's use of a DAG-based pipeline with strongly typed artifacts teaches you why type safety matters in ML workflows (a mismatch between the feature schema the model was trained on and the schema the serving system provides is a runtime error, not a compile-time error, unless you build explicit schema validation). Michelangelo's online feature store teaches you why low-latency feature retrieval is a separate architectural concern from batch feature computation. These are concepts you will apply in your own systems.

Study the operational failure modes described in these case studies as carefully as the happy path. The sections on training-serving skew, concept drift, and pipeline failures are where the real engineering lessons are. An interviewer who mentions "we had an issue where model performance degraded after a data schema change" wants to know if you have thought about schema validation, feature lineage tracking, and automated rollback. The case studies give you concrete examples to reference.

### Senior @ FAANG: Case Studies as Architectural Benchmarks

Senior engineers use case studies from peer companies not as inspiration but as benchmarks. When evaluating a proposed ML platform architecture, the question is: where does this design sit relative to what Google, Meta, and Uber have built? What problems have those companies already solved that we are about to reinvent, and what solutions can we adopt or adapt? What problems have they described that we will inevitably face at our scale, and are we designing with those problems in mind?

The TFX architecture reveals several hard-won lessons that apply to any ML platform. First, artifacts must be strongly typed and versioned: a model that was trained on a specific version of a feature schema should record that dependency, and the serving system should validate compatibility before loading the model. Second, the pipeline must be idempotent and restartable: a training pipeline that fails halfway through should be resumable from the last successful checkpoint, not from scratch. Third, lineage tracking is load-bearing infrastructure, not a nice-to-have: without knowing which data version trained which model version, root-cause analysis of model regressions is nearly impossible.

Michelangelo's feature store design is the gold standard for the online/offline feature consistency problem. The key insight is that online and offline feature computation must share the same transformation code, and the feature store serves as the contract layer that enforces this. Senior engineers evaluating feature store vendors or designing internal feature stores should use Michelangelo's architecture as the reference design: online serving at sub-10ms latency, offline batch computation for training, and shared transformation definitions that eliminate training-serving skew by construction.

At L6 and above, these case studies also serve as evidence for resourcing requests. When arguing for investment in ML platform infrastructure, being able to cite "Google invested X years of engineering to build TFX because their team experienced Y production failures that cost Z" is more persuasive than abstract arguments about engineering quality. The case studies provide a validated narrative for why ML platform investment has a positive ROI, which is a necessary component of any staff-level infrastructure proposal.

---
