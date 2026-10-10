## 113.2 ML Fundamentals for Go Developers

### Supervised vs Unsupervised Learning

Machine learning falls into three main categories. Understanding when to use each is crucial.

#### Supervised Learning: Learning with Labels

You have input data (features) and known outputs (labels). The model learns the mapping: `f(X) = y`

**Examples:**
- **Classification**: Is this email spam? (binary: yes/no)
- **Regression**: What will this house sell for? (continuous: $450,000)
- **Time series prediction**: What will server load be in 5 minutes?

**Go Use Cases:**
- Fraud detection in payment systems
- Log anomaly classification
- Request routing based on predicted latency
- Resource usage forecasting

```go
// Supervised learning structure in Go
type SupervisedModel interface {
    // Train learns from labeled examples
    Train(features [][]float64, labels []float64) error

    // Predict generates output for new input
    Predict(features []float64) (float64, error)

    // Evaluate measures performance on test data
    Evaluate(testFeatures [][]float64, testLabels []float64) (float64, error)
}

// Example: Email spam classifier
type SpamClassifier struct {
    weights []float64
    bias    float64
}

func (s *SpamClassifier) Train(emails []Email, labels []bool) error {
    // Convert emails to feature vectors
    features := make([][]float64, len(emails))
    for i, email := range emails {
        features[i] = extractFeatures(email) // word counts, link counts, etc.
    }

    // Convert boolean labels to float64 (0.0 = not spam, 1.0 = spam)
    y := make([]float64, len(labels))
    for i, isSpam := range labels {
        if isSpam {
            y[i] = 1.0
        }
    }

    // Training happens here (we'll implement this later)
    return s.trainLogisticRegression(features, y)
}
```

#### Unsupervised Learning: Finding Patterns Without Labels

No labels provided. The model discovers hidden structure in data.

**Examples:**
- **Clustering**: Group similar customers together
- **Dimensionality reduction**: Compress high-dimensional data
- **Anomaly detection**: Find unusual patterns (fraud, intrusions)

**Go Use Cases:**
- User segmentation for A/B testing
- Log pattern discovery
- Network traffic analysis
- System behavior profiling

```go
// Unsupervised learning structure in Go
type UnsupervisedModel interface {
    // Fit discovers patterns in unlabeled data
    Fit(data [][]float64) error

    // Transform applies learned patterns to new data
    Transform(data [][]float64) ([][]float64, error)

    // PredictCluster assigns data points to discovered groups
    PredictCluster(point []float64) (int, error)
}

// Example: K-means clustering for user segmentation
type KMeans struct {
    k        int           // number of clusters
    centroids [][]float64   // cluster centers
    maxIter   int
}

func (km *KMeans) Fit(users [][]float64) error {
    // Initialize random centroids
    km.centroids = km.initializeCentroids(users)

    for iter := 0; iter < km.maxIter; iter++ {
        // Assign each user to nearest centroid
        assignments := make([]int, len(users))
        for i, user := range users {
            assignments[i] = km.nearestCentroid(user)
        }

        // Update centroids based on assignments
        if !km.updateCentroids(users, assignments) {
            break // converged
        }
    }

    return nil
}
```

#### Reinforcement Learning: Learning Through Trial and Error

An agent learns by interacting with an environment, receiving rewards and penalties.

**Examples:**
- Game playing (AlphaGo)
- Robot control
- Resource allocation
- Trading strategies

**Go Use Cases:**
- Auto-scaling policies (reward: cost savings, penalty: SLO violations)
- Load balancer optimization
- Cache eviction strategies
- Rate limiting policies

```go
// Reinforcement learning structure in Go
type RLAgent interface {
    // SelectAction chooses next action based on current state
    SelectAction(state State) Action

    // Learn updates policy based on reward received
    Learn(state State, action Action, reward float64, nextState State)

    // Policy returns the learned decision function
    Policy() func(State) Action
}

// Example: Simple Q-learning for cache eviction
type QLearningAgent struct {
    qTable      map[string]map[Action]float64 // state -> action -> Q-value
    alpha       float64                        // learning rate
    gamma       float64                        // discount factor
    epsilon     float64                        // exploration rate
}

func (q *QLearningAgent) Learn(state State, action Action, reward float64, nextState State) {
    // Q-learning update rule
    currentQ := q.qTable[state.Key()][action]
    maxNextQ := q.maxQValue(nextState)

    newQ := currentQ + q.alpha * (reward + q.gamma*maxNextQ - currentQ)
    q.qTable[state.Key()][action] = newQ
}
```

### Training, Validation, and Testing: The Data Split

One of the most critical concepts in ML is properly splitting your data. Get this wrong and you'll deploy models that fail in production.

```
┌──────────────────────────────────────────────────────────┐
│                    Available Data (100%)                 │
└──────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐
│  Training Set   │  │ Validation Set  │  │  Test Set   │
│      70%        │  │      15%        │  │     15%     │
└─────────────────┘  └─────────────────┘  └─────────────┘
         │                    │                    │
         │                    │                    │
         ▼                    ▼                    │
    Learn model          Tune hyperparameters      │
    parameters           Choose best model         │
    (weights, bias)      Prevent overfitting       │
                                                    │
                                                    ▼
                                        Final evaluation
                                        "Never seen before"
                                        Estimate real-world
                                        performance
```

**Training Set (70%)**: Model sees this data during learning. Updates weights based on errors.

**Validation Set (15%)**: Model doesn't train on this. Used to tune hyperparameters (learning rate, regularization, model architecture). Prevents overfitting to training data.

**Test Set (15%)**: Model never sees this until final evaluation. Simulates real-world performance. If test performance is much worse than validation, you've overfit.

#### Implementing Data Splitting in Go

Splitting datasets into training and test sets prevents overfitting by evaluating model performance on data it has never seen during training. The following implementation uses reproducible shuffling with a fixed random seed so that splits are consistent across runs and team members.

```go
package ml

import (
    "fmt"
    "math/rand/v2"
)

// DataSplit holds train/validation/test sets
type DataSplit struct {
    TrainX [][]float64
    TrainY []float64
    ValX   [][]float64
    ValY   []float64
    TestX  [][]float64
    TestY  []float64
}

// SplitData divides data into train/val/test sets
// trainRatio: fraction for training (e.g., 0.7)
// valRatio: fraction for validation (e.g., 0.15)
// remainder goes to test set
func SplitData(X [][]float64, y []float64, trainRatio, valRatio float64, seed int64) (*DataSplit, error) {
    if len(X) != len(y) {
        return nil, fmt.Errorf("X and y must have same length: got %d and %d", len(X), len(y))
    }

    if trainRatio+valRatio >= 1.0 {
        return nil, fmt.Errorf("trainRatio + valRatio must be < 1.0: got %.2f", trainRatio+valRatio)
    }

    n := len(X)

    // Create indices and shuffle them
    indices := make([]int, n)
    for i := range indices {
        indices[i] = i
    }

    // Shuffle for random split
    rng := rand.New(rand.NewPCG(uint64(seed), 0))
    rng.Shuffle(n, func(i, j int) {
        indices[i], indices[j] = indices[j], indices[i]
    })

    // Calculate split points
    trainEnd := int(float64(n) * trainRatio)
    valEnd := trainEnd + int(float64(n)*valRatio)

    split := &DataSplit{
        TrainX: make([][]float64, trainEnd),
        TrainY: make([]float64, trainEnd),
        ValX:   make([][]float64, valEnd-trainEnd),
        ValY:   make([]float64, valEnd-trainEnd),
        TestX:  make([][]float64, n-valEnd),
        TestY:  make([]float64, n-valEnd),
    }

    // Training set
    for i := 0; i < trainEnd; i++ {
        idx := indices[i]
        split.TrainX[i] = X[idx]
        split.TrainY[i] = y[idx]
    }

    // Validation set
    for i := trainEnd; i < valEnd; i++ {
        idx := indices[i]
        split.ValX[i-trainEnd] = X[idx]
        split.ValY[i-trainEnd] = y[idx]
    }

    // Test set
    for i := valEnd; i < n; i++ {
        idx := indices[i]
        split.TestX[i-valEnd] = X[idx]
        split.TestY[i-valEnd] = y[idx]
    }

    return split, nil
}

// Example usage
func ExampleDataSplit() {
    // Simulate dataset: predicting house prices from square footage
    X := [][]float64{
        {1500}, {1600}, {1700}, {1800}, {1900},
        {2000}, {2100}, {2200}, {2300}, {2400},
    }
    y := []float64{
        300000, 320000, 340000, 360000, 380000,
        400000, 420000, 440000, 460000, 480000,
    }

    split, err := SplitData(X, y, 0.7, 0.15, 42)
    if err != nil {
        panic(err)
    }

    fmt.Printf("Training samples: %d\n", len(split.TrainX))
    fmt.Printf("Validation samples: %d\n", len(split.ValX))
    fmt.Printf("Test samples: %d\n", len(split.TestX))

    // Output:
    // Training samples: 7
    // Validation samples: 1
    // Test samples: 2
}
```

#### Cross-Validation: When You Have Limited Data

With small datasets, a single train/val/test split might not be reliable. Cross-validation uses multiple splits.

```
K-Fold Cross-Validation (K=5)

Fold 1: [Test] [Train] [Train] [Train] [Train]
Fold 2: [Train] [Test] [Train] [Train] [Train]
Fold 3: [Train] [Train] [Test] [Train] [Train]
Fold 4: [Train] [Train] [Train] [Test] [Train]
Fold 5: [Train] [Train] [Train] [Train] [Test]

Average performance across all 5 folds = more reliable estimate
```

```go
package ml

import "fmt"

// Model is the minimal contract cross-validation needs from a trained model.
type Model interface {
    Evaluate(testX [][]float64, testY []float64) float64
}

// CrossValidate performs k-fold cross-validation.
//
// The folds are contiguous slices of X, so the caller must shuffle the data
// before calling this. Data arriving sorted by label or by timestamp will
// produce folds whose class balance is nothing like the real distribution,
// and the resulting score is meaningless. For time series data do not shuffle
// at all: use forward-chaining splits instead, where every fold trains only on
// data that precedes its test window.
func CrossValidate(X [][]float64, y []float64, k int, trainFunc func([][]float64, []float64) Model) (float64, error) {
    if k <= 1 {
        return 0, fmt.Errorf("k must be > 1: got %d", k)
    }

    n := len(X)
    foldSize := n / k

    scores := make([]float64, k)

    for fold := 0; fold < k; fold++ {
        // Create train and test sets for this fold
        testStart := fold * foldSize
        testEnd := testStart + foldSize
        if fold == k-1 {
            testEnd = n // last fold gets remainder
        }

        var trainX [][]float64
        var trainY []float64
        var testX [][]float64
        var testY []float64

        for i := 0; i < n; i++ {
            if i >= testStart && i < testEnd {
                testX = append(testX, X[i])
                testY = append(testY, y[i])
            } else {
                trainX = append(trainX, X[i])
                trainY = append(trainY, y[i])
            }
        }

        // Train model on this fold
        model := trainFunc(trainX, trainY)

        // Evaluate on test portion
        score := model.Evaluate(testX, testY)
        scores[fold] = score
    }

    // Return average score
    var sum float64
    for _, score := range scores {
        sum += score
    }

    return sum / float64(k), nil
}
```

### Feature Engineering Basics

Raw data is rarely suitable for ML models. Feature engineering transforms raw data into informative inputs.

**Example: Predicting Server Failure**

```go
package monitoring

import (
    "math"
    "sync"
    "time"
)

// RawServerMetrics from monitoring system
type RawServerMetrics struct {
    Timestamp       time.Time
    CPUPercent      float64
    MemoryUsedGB    float64
    DiskIOPS        int
    NetworkMbps     float64
    RequestCount    int
}

// EngineeredFeatures for ML model
type EngineeredFeatures struct {
    // Time-based features. Hour of day is encoded as a (sin, cos) pair:
    // one component alone is ambiguous, because sin maps 03:00 and 09:00
    // to the same value. The pair places each hour at a unique point on
    // the unit circle, so 23:00 sits next to 00:00 as intended.
    HourSin         float64
    HourCos         float64
    DayOfWeek       float64
    IsWeekend       float64

    // Current metrics (normalized)
    CPUNorm         float64
    MemoryNorm      float64
    DiskIOPSNorm    float64
    NetworkNorm     float64

    // Derived features
    CPUMemoryRatio  float64
    LoadPerRequest  float64

    // Trend features (compared to 1 hour ago)
    CPUTrend        float64
    MemoryTrend     float64
    RequestTrend    float64

    // Interaction features
    HighCPUHighMem  float64
}

// FeatureEngineer transforms raw metrics to ML features.
//
// Transform keeps per-server history, so it mutates shared state on every
// call. In a serving path that means concurrent requests for different
// servers still contend on the same map, and an unguarded map write from two
// goroutines is a hard crash, not merely a race. The mutex is not optional.
type FeatureEngineer struct {
    // Normalization parameters (learned from training data)
    cpuMax     float64
    memMax     float64
    diskMax    float64
    networkMax float64

    // Historical data for trend calculation, guarded by mu
    mu      sync.Mutex
    history map[string][]RawServerMetrics
}

func NewFeatureEngineer() *FeatureEngineer {
    return &FeatureEngineer{
        history: make(map[string][]RawServerMetrics),
    }
}

// Fit learns normalization parameters from training data
func (fe *FeatureEngineer) Fit(data []RawServerMetrics) {
    for _, m := range data {
        if m.CPUPercent > fe.cpuMax {
            fe.cpuMax = m.CPUPercent
        }
        if m.MemoryUsedGB > fe.memMax {
            fe.memMax = m.MemoryUsedGB
        }
        if float64(m.DiskIOPS) > fe.diskMax {
            fe.diskMax = float64(m.DiskIOPS)
        }
        if m.NetworkMbps > fe.networkMax {
            fe.networkMax = m.NetworkMbps
        }
    }
}

// Transform converts raw metrics to features
func (fe *FeatureEngineer) Transform(serverID string, current RawServerMetrics) EngineeredFeatures {
    fe.mu.Lock()
    defer fe.mu.Unlock()

    features := EngineeredFeatures{}

    // Time-based features (cyclic encoding, sin and cos together)
    hour := float64(current.Timestamp.Hour())
    features.HourSin = math.Sin(2 * math.Pi * hour / 24)
    features.HourCos = math.Cos(2 * math.Pi * hour / 24)
    features.DayOfWeek = float64(current.Timestamp.Weekday())
    if current.Timestamp.Weekday() == time.Saturday || current.Timestamp.Weekday() == time.Sunday {
        features.IsWeekend = 1.0
    }

    // Normalize current metrics (0-1 range). Guard every divisor: if Fit was
    // never called, or a metric was flat zero across the whole training set,
    // the max is 0 and the division silently yields NaN. NaN features
    // propagate through the model and produce a prediction that is not merely
    // wrong but unorderable, which breaks any downstream threshold comparison.
    features.CPUNorm = safeDiv(current.CPUPercent, fe.cpuMax)
    features.MemoryNorm = safeDiv(current.MemoryUsedGB, fe.memMax)
    features.DiskIOPSNorm = safeDiv(float64(current.DiskIOPS), fe.diskMax)
    features.NetworkNorm = safeDiv(current.NetworkMbps, fe.networkMax)

    // Derived features
    if current.MemoryUsedGB > 0 {
        features.CPUMemoryRatio = current.CPUPercent / current.MemoryUsedGB
    }
    if current.RequestCount > 0 {
        features.LoadPerRequest = current.CPUPercent / float64(current.RequestCount)
    }

    // Trend features (requires historical data). Spanning a full hour at
    // 5-minute intervals needs 13 samples, not 12: 12 samples bracket only
    // 11 gaps, or 55 minutes. Keep the fencepost straight or every trend
    // feature is quietly computed over the wrong window.
    const trendSamples = 13 // 12 intervals x 5 min = 60 min

    fe.history[serverID] = append(fe.history[serverID], current)
    if len(fe.history[serverID]) > trendSamples {
        fe.history[serverID] = fe.history[serverID][1:]
    }

    if len(fe.history[serverID]) >= trendSamples {
        hourAgo := fe.history[serverID][0]
        features.CPUTrend = current.CPUPercent - hourAgo.CPUPercent
        features.MemoryTrend = current.MemoryUsedGB - hourAgo.MemoryUsedGB
        features.RequestTrend = float64(current.RequestCount - hourAgo.RequestCount)
    }

    // Interaction features (captures correlations)
    if features.CPUNorm > 0.8 && features.MemoryNorm > 0.8 {
        features.HighCPUHighMem = 1.0
    }

    return features
}

// safeDiv returns 0 rather than NaN or Inf when the divisor is unset.
func safeDiv(num, den float64) float64 {
    if den == 0 {
        return 0
    }
    return num / den
}

// ToVector converts features to float64 slice for ML model
func (f EngineeredFeatures) ToVector() []float64 {
    return []float64{
        f.HourSin,
        f.HourCos,
        f.DayOfWeek,
        f.IsWeekend,
        f.CPUNorm,
        f.MemoryNorm,
        f.DiskIOPSNorm,
        f.NetworkNorm,
        f.CPUMemoryRatio,
        f.LoadPerRequest,
        f.CPUTrend,
        f.MemoryTrend,
        f.RequestTrend,
        f.HighCPUHighMem,
    }
}
```

**Key Feature Engineering Principles:**

1. **Domain Knowledge**: Use your understanding of the problem (server failures correlate with increasing trends)
2. **Normalization**: Scale features to similar ranges (0-1 or standardized)
3. **Cyclic Features**: Encode cyclical data as a sin/cos pair so that hour 23 is close to hour 0 and no two hours collide
4. **Derived Features**: Create ratios, products, differences
5. **Interaction Features**: Capture feature combinations
6. **Temporal Features**: Trends, moving averages, seasonality

### Junior → FAANG: ML Fundamentals as Interview Currency

The supervised/unsupervised/reinforcement learning taxonomy is one of the first things an interviewer will probe when you claim ML infrastructure experience. Be able to name three concrete production use cases for each paradigm and explain which evaluation metrics apply. Fraud detection is supervised classification. Customer segmentation is unsupervised clustering. Dynamic pricing optimization is reinforcement learning. Knowing the paradigm tells you what kind of training data you need, what your evaluation loop looks like, and how frequently you must retrain.

The bias-variance tradeoff is tested in interviews not as a theory question but as a debugging question. "Your model performs well in testing but degrades in production after two weeks. What do you check?" The correct answer involves both high-variance problems (overfitting the training distribution that has since shifted) and high-bias problems (the model is too simple to capture patterns in the new data). Walk through a systematic investigation: check the feature distribution, compare training versus serving prediction score distributions, look at segment-level performance breakdowns.

Feature engineering is the area where Go developers have the most immediate impact on model quality. Practice building a feature extraction function in Go that takes a raw event stream and computes rolling window aggregates: count in last 1 hour, count in last 24 hours, ratio of event types, time since last event. These temporal features are some of the most predictive in fraud detection and recommendation systems, and implementing them correctly in Go (handling time zones, handling sparse events, ensuring identical logic at training time) is a skill that differentiates ML-aware backend engineers.

### Senior @ FAANG: ML Paradigm Selection and System Architecture

Choosing between supervised and unsupervised approaches is often a data labeling cost question at senior level. Supervised models are usually more accurate, but they require labeled training data, which is expensive to produce and tends to lag production reality. Unsupervised approaches work on unlabeled data but produce outputs that are harder to evaluate objectively and explain to non-technical stakeholders. Senior engineers are expected to make this tradeoff explicitly and document it: how much labeling budget is available, what the label quality requirements are, and how the team will validate that an unsupervised clustering actually captures meaningful user segments rather than statistical noise.

The bias-variance framework maps to infrastructure decisions as well. High-variance models (large neural networks, deep trees with no regularization) require larger training datasets, more frequent retraining to avoid distributional drift, and more sophisticated monitoring to detect overfitting on recent data. High-bias models (shallow trees, linear models) are more stable but may systematically underperform in certain segments. Infrastructure engineers need to design retraining pipelines and monitoring systems that are appropriate for the variance level of the models they are serving.

Feature engineering governance is a staff-level concern because feature definitions become organizational contracts. When the data science team defines "user session length" as a feature, every downstream system that uses that model depends on that feature being computed identically at inference time. Feature drift, where the computation logic changes subtly due to upstream schema changes or ETL bugs, is one of the most common causes of silent model degradation in production. Senior engineers design feature lineage tracking systems that record exactly which data sources, transformations, and versions produced each feature vector in training, and enforce that the same lineage is maintained at serving time.

The training loop design (batch vs. mini-batch vs. online) has serving architecture implications. Online learning models that update continuously from production events require real-time data pipelines, atomic model weight updates with safety checks, and monitoring for adversarial feedback loops where the model's predictions influence the data it is subsequently trained on. Batch retraining is operationally simpler but creates a staleness window. Staff engineers define the acceptable staleness tolerance based on how quickly the target distribution changes, and design the retraining schedule and pipeline reliability requirements accordingly.

At L7, feature engineering strategy intersects with data strategy. The decision to build a centralized feature store affects not just the ML platform but also the data warehouse architecture, the data contracts team, the privacy and compliance posture, and the cost allocation model for compute and storage. Staff engineers who own this decision must build consensus across data engineering, ML research, privacy, and product teams before committing to an implementation, and must write the business case that justifies the investment to engineering leadership.
