## 113.9 Production Pitfalls: ML Models Gone Wrong

### Pitfall 1: Training/Serving Skew

**Real Incident Report**: A recommendation model achieved 95% accuracy in testing but 60% in production. The training pipeline used batch-normalized data while the serving pipeline received raw data, causing predictions to be completely off.

**The Anti-Pattern**:
```go
// WRONG: Different preprocessing in training vs serving
// Training pipeline
func trainPreprocess(data []float64) []float64 {
    // Using full dataset statistics
    mean := calculateMean(allTrainingData)
    std := calculateStd(allTrainingData)
    return normalize(data, mean, std)
}

// Serving pipeline - DIFFERENT!
func servingPreprocess(data []float64) []float64 {
    // Calculating on single sample - wrong!
    mean := calculateMean(data)
    std := calculateStd(data)
    return normalize(data, mean, std)
}
```

**The Better Approach**:
```go
// RIGHT: Unified preprocessing with persisted statistics
type Preprocessor struct {
    Mean      []float64 `json:"mean"`
    Std       []float64 `json:"std"`
    MinValues []float64 `json:"min_values"`
    MaxValues []float64 `json:"max_values"`
}

// Fit during training
func (p *Preprocessor) Fit(trainingData [][]float64) {
    p.Mean = calculateMeans(trainingData)
    p.Std = calculateStds(trainingData)
    // Save statistics
    p.save("preprocessor.json")
}

// Same transformation in training and serving
func (p *Preprocessor) Transform(sample []float64) []float64 {
    result := make([]float64, len(sample))
    for i := range sample {
        result[i] = (sample[i] - p.Mean[i]) / p.Std[i]
    }
    return result
}

// Load same preprocessor in serving
func LoadPreprocessor(path string) (*Preprocessor, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, err
    }
    var p Preprocessor
    if err := json.Unmarshal(data, &p); err != nil {
        return nil, fmt.Errorf("parse preprocessor %s: %w", path, err)
    }
    return &p, nil
}
```

**Key Insight**: Training and serving must use identical preprocessing. Persist all transformation statistics during training and load them in serving.

---

### Pitfall 2: Data Leakage

**Real Incident Report**: A fraud model showed 99.5% accuracy but barely outperformed random in production. The training data included the fraud label's timestamp, which was always after the transaction time for fraudulent transactions.

**The Anti-Pattern**:
```go
// WRONG: Including future information in features
type Transaction struct {
    AmountCents   int64
    Timestamp     time.Time
    FraudReported time.Time // LEAKAGE: Only known after fraud detected
    ChargebackAmtCents int64 // LEAKAGE: Only known after chargeback
    ReviewResult  string    // LEAKAGE: Human review happens later
}

func extractFeatures(t Transaction) []float64 {
    return []float64{
        float64(t.AmountCents),
        float64(t.FraudReported.Sub(t.Timestamp).Hours()), // Always positive for fraud!
        float64(t.ChargebackAmtCents), // Non-zero correlates perfectly with fraud
    }
}
```

**The Better Approach**:
```go
// RIGHT: Only use features available at prediction time
type Transaction struct {
    AmountCents int64
    Timestamp   time.Time
    UserID      string
    DeviceID    string
    IPAddress   string
}

func extractFeatures(ctx context.Context, t Transaction, store FeatureStore) []float64 {
    // Only features available at transaction time
    features := []float64{
        float64(t.AmountCents),
        float64(t.Timestamp.Hour()),
        float64(t.Timestamp.Weekday()),
    }

    // Historical features (computed before this transaction)
    userHistory := store.GetUserHistory(t.UserID, t.Timestamp)
    features = append(features,
        float64(userHistory.AvgAmountCents),
        userHistory.TxnCount24h,
        userHistory.UniqueDevices7d,
    )

    // Point-in-time correct: no future data
    return features
}

// Validate no leakage during feature engineering
func validateNoLeakage(features FeatureSet, predictionTime time.Time) error {
    for _, f := range features {
        if f.ComputedAt.After(predictionTime) {
            return fmt.Errorf("leakage detected: feature %s computed at %v, prediction at %v",
                f.Name, f.ComputedAt, predictionTime)
        }
    }
    return nil
}
```

**Key Insight**: Features must only contain information available at prediction time. Use point-in-time correct feature engineering and validate no future data leaks into training.

---

### Pitfall 3: Model Performance Degradation (Drift)

**Real Incident Report**: A pricing model worked well for 6 months then started losing money. Market conditions changed during COVID, but the model kept using outdated patterns. Nobody monitored prediction drift.

**The Anti-Pattern**:
```go
// WRONG: Deploy once, forget forever
func deployModel() {
    model := loadModel("model_v1.0")
    http.HandleFunc("/predict", func(w http.ResponseWriter, r *http.Request) {
        // Same model forever, no monitoring
        result := model.Predict(parseInput(r))
        json.NewEncoder(w).Encode(result)
    })
    http.ListenAndServe(":8080", nil)
}
```

**The Better Approach**:
```go
// RIGHT: Monitor predictions and detect drift
//
// Predict runs on every request, which means every field it touches is
// touched concurrently. RingBuffer.Add and Len must therefore be safe for
// concurrent use: either synchronize internally or guard them here. This is
// the single most common way a "just add monitoring" change introduces a data
// race into a previously stateless handler.
type MonitoredModel struct {
    model             Model
    baselineStats     *DistributionStats
    mu                sync.Mutex // guards recentPredictions
    recentPredictions *RingBuffer
    driftDetector     *DriftDetector
}

func (m *MonitoredModel) Predict(ctx context.Context, input []float64) (float64, error) {
    prediction := m.model.Predict(input)

    // Log for drift detection
    m.mu.Lock()
    m.recentPredictions.Add(PredictionRecord{
        Input:     input,
        Output:    prediction,
        Timestamp: time.Now(),
    })
    ready := m.recentPredictions.Len() >= 1000
    var currentStats *DistributionStats
    if ready {
        currentStats = m.recentPredictions.ComputeStats()
    }
    m.mu.Unlock()

    // Check prediction distribution drift. The comparison and alerting run
    // outside the lock: holding a mutex across a metrics or alerting call
    // puts network latency directly into every request's critical path.
    if ready {
        drift := m.driftDetector.Detect(m.baselineStats, currentStats)

        if drift.Score > 0.25 { // PSI above 0.25 is the conventional "major shift" line
            metrics.Counter("model_drift_detected").Inc()
            alert.Send("Model drift detected",
                "psi_score", drift.Score,
                "features", drift.DriftedFeatures)
        }
    }

    // Log for later analysis
    metrics.Histogram("prediction_values").Observe(prediction)

    return prediction, nil
}

// CalculatePSI computes the Population Stability Index between a baseline
// and a current sample.
//
//	PSI = Σ (actual% - expected%) * ln(actual% / expected%)
//
// Two details decide whether this number means anything.
//
// First, the bins must be *proportions*, not raw counts. Feeding counts in
// produces a value that scales with sample size, so the same distribution
// measured over a bigger window looks like worse drift. Normalize by the
// total before the sum.
//
// Second, empty bins cannot simply be skipped. A bin holding 10% of the
// baseline that now holds nothing is drift in its purest form, and the
// guard `if baseline > 0 && current > 0` throws away exactly the evidence
// you are looking for while reporting a reassuring low score. Floor each
// proportion with a small epsilon instead, so the term stays finite and the
// bin still contributes.
func (d *DriftDetector) CalculatePSI(baseline, current []float64) float64 {
    const bins = 10

    // Use one shared set of bin edges derived from the baseline. Binning each
    // sample independently compares bins that do not describe the same range.
    edges := binEdges(baseline, bins)
    baselineProps := proportions(baseline, edges)
    currentProps := proportions(current, edges)

    // epsilon keeps ln() finite for empty bins without pretending they match.
    const epsilon = 1e-6

    var psi float64
    for i := range baselineProps {
        b := math.Max(baselineProps[i], epsilon)
        c := math.Max(currentProps[i], epsilon)
        psi += (c - b) * math.Log(c/b)
    }
    return psi
}

// proportions buckets values into the given edges and returns the fraction of
// the sample in each bucket (summing to 1), not the raw counts.
func proportions(values []float64, edges []float64) []float64 {
    counts := make([]float64, len(edges)+1)
    for _, v := range values {
        counts[bucketOf(v, edges)]++
    }

    total := float64(len(values))
    if total == 0 {
        return counts
    }
    for i := range counts {
        counts[i] /= total
    }
    return counts
}
```

The conventional reading of the resulting score: below 0.1 the population is stable, 0.1 to 0.25 is a moderate shift worth investigating, and above 0.25 is a major shift that usually justifies retraining. Treat these as the industry rules of thumb they are rather than as thresholds derived from your data, and calibrate against your own retraining history once you have one.

**Key Insight**: Models degrade over time as data distributions change. Implement continuous monitoring with drift detection and automated retraining triggers.

---

### Pitfall 4: Ignoring Class Imbalance

**Real Incident Report**: A churn prediction model showed 99% accuracy. But since only 1% of users churn, predicting "no churn" for everyone achieves 99% accuracy. The model was useless for identifying at-risk users.

**The Anti-Pattern**:
```go
// WRONG: Using accuracy on imbalanced data
func evaluateModel(predictions, labels []int) float64 {
    correct := 0
    for i := range predictions {
        if predictions[i] == labels[i] {
            correct++
        }
    }
    // 99% accuracy but 0% recall on minority class!
    return float64(correct) / float64(len(predictions))
}
```

**The Better Approach**:
```go
// RIGHT: Use appropriate metrics and handle imbalance
type ClassificationMetrics struct {
    Accuracy    float64
    Precision   float64
    Recall      float64
    F1Score     float64
    AUROC       float64
    AUPRC       float64 // Better for imbalanced data
    Confusion   ConfusionMatrix
}

func evaluateImbalancedModel(predictions, labels []int, scores []float64) ClassificationMetrics {
    cm := computeConfusionMatrix(predictions, labels)

    metrics := ClassificationMetrics{
        Accuracy:  float64(cm.TP+cm.TN) / float64(cm.Total()),
        Precision: float64(cm.TP) / float64(cm.TP+cm.FP),
        Recall:    float64(cm.TP) / float64(cm.TP+cm.FN), // Critical for rare events
        Confusion: cm,
    }

    metrics.F1Score = 2 * metrics.Precision * metrics.Recall /
        (metrics.Precision + metrics.Recall)

    // AUPRC is better than AUROC for imbalanced data
    metrics.AUROC = computeAUROC(scores, labels)
    metrics.AUPRC = computeAUPRC(scores, labels)

    return metrics
}

// Handle imbalance during training
type ImbalanceHandler struct {
    Strategy string // "oversample", "undersample", "class_weight"
}

func (h *ImbalanceHandler) Balance(X [][]float64, y []int) ([][]float64, []int) {
    switch h.Strategy {
    case "oversample":
        return h.SMOTE(X, y) // Synthetic Minority Over-sampling
    case "undersample":
        return h.randomUndersample(X, y)
    case "class_weight":
        // Return weights instead of resampling
        return X, y
    }
    return X, y
}

func (h *ImbalanceHandler) ComputeClassWeights(y []int) map[int]float64 {
    counts := make(map[int]int)
    for _, label := range y {
        counts[label]++
    }

    total := float64(len(y))
    weights := make(map[int]float64)
    for class, count := range counts {
        weights[class] = total / (float64(len(counts)) * float64(count))
    }
    return weights
}
```

**Key Insight**: For imbalanced datasets, accuracy is misleading. Use precision/recall/F1, AUPRC, and handle imbalance through resampling or class weights.

---

### Pitfall 5: Not Validating Model Inputs

**Real Incident Report**: A model received a negative value for "age" (data corruption). Without input validation, it extrapolated wildly, approving a $500K loan that should have been denied.

**The Anti-Pattern**:
```go
// WRONG: Trust all inputs blindly
func (m *Model) Predict(features []float64) float64 {
    // No validation - garbage in, garbage out
    return m.inference(features)
}
```

**The Better Approach**:
```go
// RIGHT: Validate inputs match training distribution
type InputValidator struct {
    featureStats map[string]FeatureStats
    strict       bool
}

type FeatureStats struct {
    Min    float64
    Max    float64
    Mean   float64
    Std    float64
    Name   string
    IsNull bool
}

func (v *InputValidator) Validate(features map[string]float64) (*ValidationResult, error) {
    result := &ValidationResult{Valid: true}

    for name, value := range features {
        stats, ok := v.featureStats[name]
        if !ok {
            result.AddWarning("unknown_feature", name)
            continue
        }

        // Check for NaN/Inf
        if math.IsNaN(value) || math.IsInf(value, 0) {
            result.AddError("invalid_value", name, "NaN or Inf")
            result.Valid = false
            continue
        }

        // Check bounds
        if value < stats.Min || value > stats.Max {
            result.AddWarning("out_of_range", name,
                fmt.Sprintf("%.2f outside [%.2f, %.2f]", value, stats.Min, stats.Max))
        }

        // Check for extreme outliers (>5 std from mean). Guard the divisor:
        // a constant feature has Std == 0, and dividing by it yields +Inf,
        // which trips this branch on every single request and buries the
        // real warnings in noise.
        if stats.Std > 0 {
            zScore := math.Abs(value-stats.Mean) / stats.Std
            if zScore > 5 {
                result.AddWarning("extreme_outlier", name,
                    fmt.Sprintf("z-score %.2f", zScore))
            }
        }
    }

    // Check for missing required features
    for name := range v.featureStats {
        if _, ok := features[name]; !ok {
            result.AddError("missing_feature", name, "required feature missing")
            result.Valid = false
        }
    }

    return result, nil
}

// Use in prediction pipeline
func (m *Model) SafePredict(ctx context.Context, features map[string]float64) (float64, error) {
    validation, err := m.validator.Validate(features)
    if err != nil {
        return 0, err
    }

    if !validation.Valid {
        return 0, fmt.Errorf("invalid input: %v", validation.Errors)
    }

    if len(validation.Warnings) > 0 {
        log.Warn("prediction input warnings",
            "warnings", validation.Warnings,
            "features", features)
    }

    return m.predict(features), nil
}
```

**Key Insight**: Models can produce dangerous outputs with invalid inputs. Validate all inputs against training data statistics before prediction.

---

### ML Pitfall Quick Reference

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Training/serving skew | High test, low prod accuracy | Unified preprocessing, persist stats |
| Data leakage | Too-good-to-be-true metrics | Point-in-time features only |
| Model drift | Performance degrades over time | Monitor predictions, detect drift |
| Class imbalance | High accuracy, poor recall | Use F1/AUPRC, resample/weight |
| Invalid inputs | Wild predictions | Validate against training stats |

### Junior → FAANG: Pitfalls as Interview Topics

Every pitfall in this table is a potential interview question. "Your fraud model was working fine and now it is missing fraud it used to catch. Walk me through your debugging process." The answer should mention: check if model was recently updated (deployment regression), check if input feature distributions have shifted (data drift), check if there are new fraud patterns that the training data does not cover (concept drift), check if the serving infrastructure changed in a way that affects feature computation (training-serving skew). Walking through this structured diagnostic process demonstrates production ML maturity.

Training-serving skew is the pitfall that bites almost every team once. The classic example: in training, missing user age is filled with the dataset mean (32.5). In serving, a missing user age field is handled by Go's zero-value for float64, which is 0.0. The model now receives a wildly out-of-distribution value and produces unreliable predictions. The fix is to always apply the same imputation logic at training and serving time using shared configuration, and to add a production test that sends a request with a missing field and asserts the response matches the expected imputation behavior.

Class imbalance is endemic in fraud detection, anomaly detection, and medical diagnosis use cases. Build the habit of immediately asking "what is the class distribution?" whenever you encounter a binary classification problem. If one class is less than 5% of the dataset, accuracy is a meaningless metric and you should default to precision-recall AUC and F1-score as your primary evaluation metrics. In Go serving code, this translates to logging the distribution of predicted probabilities over time so you can detect when the model's output distribution shifts unexpectedly.

### Senior @ FAANG: Systematic Pitfall Prevention at Scale

At senior level, pitfall prevention is a process design problem. Individual engineers encountering and fixing individual pitfalls is not scalable: the same pitfalls will recur with each new model and each new team. The solution is to encode pitfall prevention into the ML platform: mandatory schema validation in the pipeline prevents training-serving skew, automated drift detection alerts prevent undetected model degradation, required class distribution reporting in model cards prevents the accuracy trap. Senior engineers design these guardrails into the platform so that teams following the default path are automatically protected.

Training-serving skew prevention at FAANG scale requires a formal feature schema registry. Every feature in every model has a registered schema: name, type, valid range, imputation strategy, and the exact code version that computes it. When a model is deployed, the serving system validates that its feature schema is compatible with the current registry entries. When a feature computation changes, the registry version increments and model compatibility is re-evaluated. This prevents the most common form of training-serving skew from reaching production.

Model drift detection should be layered: prediction score monitoring catches immediate behavioral changes (the model is suddenly predicting high fraud probability for most transactions, suggesting a feature pipeline failure), feature distribution monitoring catches gradual drift (the average transaction amount is trending upward because of inflation, shifting outside the training distribution), and business metric monitoring catches cases where neither model nor feature metrics detect the degradation but users are experiencing worse outcomes. Designing this three-layer monitoring system and ensuring all three layers are active before a model goes live is a senior-level responsibility.

At L6, you own the post-mortem culture for ML incidents. When a pitfall causes a production incident, the post-mortem should go beyond "we fixed the bug" to identify the systemic gap that allowed the bug to reach production: what monitoring should have caught it earlier, what process should have prevented the change that introduced it, and what platform feature would make this class of failure impossible in the future. Driving these systemic improvements is the most impactful work a senior ML infrastructure engineer can do.

Adversarial inputs are a pitfall that is underinvested in most ML systems but receives intense scrutiny at FAANG during security reviews and bar-raiser interviews. In production, malicious actors actively probe models to find inputs that produce favorable predictions (in fraud detection, finding transaction patterns that score below the fraud threshold). Senior engineers design input validation that goes beyond range checking: anomaly detection on the input feature vector itself, rate limiting on inference requests from suspicious clients, and monitoring for coordinated patterns of inputs that cluster near the decision boundary.

---
