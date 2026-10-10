## 114.11 Production Pitfalls: ML Pipeline Failures

### Pitfall 1: Feature Store Inconsistency

**Real Incident Report**: A feature store had different computation logic for offline (training) and online (serving). The offline store calculated rolling averages over 30 days, while online calculated over 28 days. This silent inconsistency degraded model accuracy by 15%.

**The Anti-Pattern**:
```go
// WRONG: Separate computation logic
// Offline pipeline
func computeOfflineFeatures(userID string) map[string]float64 {
    return map[string]float64{
        "avg_purchases_30d": db.Query("AVG(purchase_count) WHERE date > NOW() - 30 DAYS"),
    }
}

// Online serving - different window!
func computeOnlineFeatures(userID string) map[string]float64 {
    return map[string]float64{
        "avg_purchases_30d": redis.GetAvg(userID, 28*24*time.Hour), // Wrong window!
    }
}
```

**The Better Approach**:
```go
// RIGHT: Single source of truth for feature definitions
type FeatureDefinition struct {
    Name        string
    Description string
    SQL         string  // Used for offline
    WindowSize  time.Duration
}

var Features = map[string]FeatureDefinition{
    "avg_purchases_30d": {
        Name:       "avg_purchases_30d",
        WindowSize: 30 * 24 * time.Hour, // Single definition
        SQL:        "AVG(purchase_count) WHERE date > NOW() - INTERVAL '30 days'",
    },
}

// Both online and offline use same definition
func (fs *FeatureStore) ComputeOffline(def FeatureDefinition) float64 {
    return fs.db.Query(def.SQL)
}

func (fs *FeatureStore) ComputeOnline(def FeatureDefinition, userID string) float64 {
    return fs.redis.GetWindowedAvg(userID, def.WindowSize)
}

// Consistency checker runs periodically
func (fs *FeatureStore) ValidateConsistency(userID string) error {
    for name, def := range Features {
        offline := fs.ComputeOffline(def)
        online := fs.ComputeOnline(def, userID)

        diff := math.Abs(offline - online) / math.Max(offline, 0.001)
        if diff > 0.01 { // 1% tolerance
            return fmt.Errorf("inconsistency in %s: offline=%.4f, online=%.4f", name, offline, online)
        }
    }
    return nil
}
```

**Key Insight**: Define features once and derive both offline and online computation from the same definition. Run regular consistency checks.

---

### Pitfall 2: Silent Pipeline Failures

**Real Incident Report**: A data pipeline failed silently for 2 weeks. The feature store served stale features, but no alerts fired because the pipeline "succeeded" (it just processed zero rows). Model performance degraded gradually.

**The Anti-Pattern**:
```go
// WRONG: No validation of pipeline outputs
func runPipeline(ctx context.Context) error {
    data, _ := fetchData(ctx)
    features := computeFeatures(data)
    saveFeatures(features)
    return nil // Always succeeds!
}
```

**The Better Approach**:
```go
// RIGHT: Full pipeline validation
type PipelineResult struct {
    RowsProcessed  int64
    RowsWritten    int64
    NullCounts     map[string]int64
    DistributionStats map[string]Stats
    Errors         []error
}

func runPipeline(ctx context.Context) (*PipelineResult, error) {
    result := &PipelineResult{}

    data, err := fetchData(ctx)
    if err != nil {
        return nil, fmt.Errorf("fetch failed: %w", err)
    }

    result.RowsProcessed = int64(len(data))

    // Validate data volume
    if result.RowsProcessed == 0 {
        return nil, errors.New("pipeline produced zero rows")
    }

    expectedMin := getExpectedMinRows()
    if result.RowsProcessed < expectedMin {
        return nil, fmt.Errorf("row count %d below expected minimum %d",
            result.RowsProcessed, expectedMin)
    }

    // Compute and validate features
    features := computeFeatures(data)

    // Check for null explosion
    for col, nullCount := range features.NullCounts {
        nullRate := float64(nullCount) / float64(result.RowsProcessed)
        if nullRate > 0.1 { // >10% nulls
            result.Errors = append(result.Errors,
                fmt.Errorf("high null rate %.2f%% in column %s", nullRate*100, col))
        }
    }

    // Check distribution drift
    for col, stats := range features.Stats {
        baseline := getBaselineStats(col)
        if isDrifted(stats, baseline) {
            result.Errors = append(result.Errors,
                fmt.Errorf("distribution drift detected in %s", col))
        }
    }

    if len(result.Errors) > 0 {
        return result, fmt.Errorf("pipeline validation failed: %v", result.Errors)
    }

    result.RowsWritten = saveFeatures(features)
    return result, nil
}
```

**Key Insight**: Pipelines should validate row counts, null rates, and data distributions. Fail loudly when expectations aren't met.

---

### Pitfall 3: No Backfill Strategy

**Real Incident Report**: A new feature was added but not backfilled. Training data had the feature, but 30% of production users didn't (they hadn't visited since the feature launched). The model fell back to defaults, causing prediction errors.

**The Anti-Pattern**:
```go
// WRONG: Assuming all users have all features
func predict(userID string) float64 {
    features := featureStore.Get(userID)
    return model.Predict(features) // Crashes or wrong if features missing
}
```

**The Better Approach**:
```go
// RIGHT: Feature versioning with backfill support
type FeatureVersion struct {
    Name        string
    Version     int
    AddedAt     time.Time
    BackfillSQL string
    // DefaultValue is what serving uses when the feature is absent and
    // cannot be computed on demand. Making it a required part of the
    // definition, rather than something the serving code improvises, is the
    // whole point: Go's zero value is 0.0, and 0.0 is a real and often very
    // wrong value for a feature the model was trained to expect.
    DefaultValue float64
}

func (fs *FeatureStore) GetWithBackfill(userID string, required []FeatureVersion) (map[string]float64, error) {
    cached := fs.cache.Get(userID)
    result := make(map[string]float64)

    for _, feature := range required {
        if val, ok := cached[feature.Name]; ok {
            result[feature.Name] = val
            continue
        }

        // Feature missing, so backfill on demand or fall back to the default
        if feature.BackfillSQL != "" {
            // Real-time backfill
            val, err := fs.computeOnDemand(feature.BackfillSQL, userID)
            if err == nil {
                result[feature.Name] = val
                // Cache for next time
                fs.cache.Set(userID, feature.Name, val)
                continue
            }
        }

        // Use default (must be defined for all features)
        result[feature.Name] = feature.DefaultValue
        metrics.Inc("feature_defaulted", "feature", feature.Name)
    }

    return result, nil
}

// Batch backfill job
func backfillFeature(feature FeatureVersion) error {
    // Find users missing this feature
    users := fs.getUsersMissingFeature(feature.Name)

    for _, batch := range chunk(users, 1000) {
        values := fs.batchCompute(feature.BackfillSQL, batch)
        fs.batchWrite(feature.Name, values)
    }

    return nil
}
```

**Key Insight**: Every feature needs a backfill strategy. New features should be backfilled before model deployment, or compute on-demand with defaults.

---

### Pitfall 4: Model Version Mismatch

**Real Incident Report**: A canary deployment ran model v2 with features from model v1. The feature schemas were incompatible: v2 expected one-hot encoded categories while v1 used label encoding. The canary produced garbage predictions.

**The Anti-Pattern**:
```go
// WRONG: Model and features deployed separately
func serve(req Request) Response {
    features := featureStore.Get(req.UserID) // Which version?
    prediction := model.Predict(features)     // Which version?
    return Response{Score: prediction}
}
```

**The Better Approach**:
```go
// RIGHT: Versioned model bundles
type ModelBundle struct {
    ModelVersion    string
    ModelPath       string
    FeatureSchema   FeatureSchema
    Preprocessor    *Preprocessor
    RequiredFeatures []string
}

type FeatureSchema struct {
    Features []FeatureDef
    Version  string
}

func (b *ModelBundle) Serve(ctx context.Context, req Request) (Response, error) {
    // Get features matching this model's schema
    features, err := featureStore.GetForSchema(req.UserID, b.FeatureSchema)
    if err != nil {
        return Response{}, err
    }

    // Validate feature schema matches
    if err := b.validateFeatures(features); err != nil {
        return Response{}, fmt.Errorf("schema mismatch: %w", err)
    }

    // Preprocess with bundled preprocessor
    processed := b.Preprocessor.Transform(features)

    // Predict with bundled model
    prediction := b.model.Predict(processed)

    return Response{
        Score:        prediction,
        ModelVersion: b.ModelVersion,
        SchemaVersion: b.FeatureSchema.Version,
    }, nil
}

// Deployment validates compatibility
func Deploy(bundle ModelBundle) error {
    // Verify feature schema exists in feature store
    if !featureStore.HasSchema(bundle.FeatureSchema.Version) {
        return fmt.Errorf("feature schema %s not found", bundle.FeatureSchema.Version)
    }

    // Verify preprocessor matches training
    if bundle.Preprocessor.Version != bundle.ModelVersion {
        return errors.New("preprocessor version mismatch")
    }

    return nil
}
```

**Key Insight**: Bundle model, preprocessor, and feature schema together. Deploy as atomic units and validate compatibility before serving.

---

### Pitfall 5: Resource Exhaustion in Batch Inference

**Real Incident Report**: A batch inference job loaded all user features into memory to "optimize" prediction speed. With 10M users, it consumed 200GB RAM and OOM killed, leaving partial results.

**The Anti-Pattern**:
```go
// WRONG: Loading everything into memory
func batchPredict(userIDs []string) map[string]float64 {
    allFeatures := make(map[string][]float64)

    for _, id := range userIDs { // 10M users
        allFeatures[id] = featureStore.Get(id) // 200GB in memory
    }

    results := make(map[string]float64)
    for id, features := range allFeatures {
        results[id] = model.Predict(features)
    }

    return results
}
```

**The Better Approach**:
```go
// RIGHT: Streaming batch inference
const batchSize = 1000

func batchPredict(ctx context.Context, userIDs []string, output io.Writer) error {
    writer := bufio.NewWriter(output)
    defer writer.Flush()

    // A bufio.Writer is not safe for concurrent use. The obvious version of
    // this function has every worker call fmt.Fprintf(writer, ...) directly,
    // which is a data race: `go test -race` reports it, and untested it
    // produces interleaved or truncated lines in the output file. Serialize
    // the writes with a mutex.
    var writeMu sync.Mutex

    g, ctx := errgroup.WithContext(ctx)

    // SetLimit replaces the hand-rolled semaphore channel: same bound on
    // concurrency, no acquire/release to get wrong.
    g.SetLimit(10)

    for i := 0; i < len(userIDs); i += batchSize {
        end := min(i+batchSize, len(userIDs))
        batch := userIDs[i:end]

        g.Go(func() error {
            // Stop starting work once a sibling has failed or the caller
            // cancelled. errgroup.WithContext cancels ctx on first error.
            if err := ctx.Err(); err != nil {
                return err
            }

            // Load batch features
            features, err := featureStore.GetBatch(ctx, batch)
            if err != nil {
                return err
            }

            // Predict batch
            predictions := model.PredictBatch(features)

            // Stream to output immediately
            writeMu.Lock()
            defer writeMu.Unlock()
            for j, id := range batch {
                if _, err := fmt.Fprintf(writer, "%s,%.6f\n", id, predictions[j]); err != nil {
                    return err
                }
            }

            return nil
        })
    }

    return g.Wait()
}

// With checkpointing for fault tolerance
type BatchJob struct {
    checkpoint string
    processed  int64
}

func (j *BatchJob) Run(userIDs []string) error {
    // Resume from checkpoint
    startIdx := j.loadCheckpoint()

    for i := startIdx; i < len(userIDs); i += batchSize {
        batch := userIDs[i:min(i+batchSize, len(userIDs))]

        if err := j.processBatch(batch); err != nil {
            return err
        }

        // Checkpoint every N batches
        if i%10000 == 0 {
            j.saveCheckpoint(i)
        }
    }

    return nil
}
```

**Key Insight**: Stream batch inference results instead of accumulating in memory. Use checkpointing for fault tolerance on large jobs.

---

### ML Pipeline Pitfall Quick Reference

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Feature inconsistency | Train/serve mismatch | Single feature definition |
| Silent failures | Stale features | Validate row counts, distributions |
| No backfill | Missing features in prod | Backfill strategy + defaults |
| Version mismatch | Schema incompatibility | Atomic model bundles |
| Resource exhaustion | OOM in batch jobs | Streaming + checkpointing |

### Junior → FAANG: Pipeline Failure Modes as Interview Case Studies

Each row in the pitfall table is a scenario you should be able to walk through in an interview. "Feature inconsistency" is the training-serving skew problem: your answer should cover how it happens (independent implementations of the same feature computation), how it is detected (comparing prediction distributions between training environment and production, or noticing model degradation after a serving code change), and how it is prevented (shared feature specification, integration tests that compare Python and Go feature outputs). Having a complete cause-detect-prevent narrative for each pitfall demonstrates production ML maturity.

Resource exhaustion in batch training jobs is a particularly common pitfall because training jobs often run on larger data than development jobs, exposing memory and disk constraints that were invisible during development. The fix is streaming processing with checkpointing: instead of loading the entire dataset into memory, process it in chunks and write intermediate results to disk. Go's streaming architecture with channels makes this pattern natural. Practice implementing a CSV processing pipeline that processes 10 million rows in constant memory using a channel-based streaming approach.

Version mismatch between model and feature schema is prevented by atomic model bundles: the model artifact, the feature schema definition, and the preprocessing configuration are packaged together and always deployed as a unit. When the serving layer loads a model, it loads the entire bundle and validates that the runtime feature schema matches the bundle's expected schema before accepting any traffic. Designing this validation step into the serving layer startup routine is the kind of production detail that prevents version mismatch incidents.

### Senior @ FAANG: Pipeline Failure Modes as Platform Design Requirements

Senior engineers read the pitfall table and derive platform requirements from it. Feature inconsistency becomes: "the platform must enforce that feature transformation logic is defined in a shared schema and executed by the platform in both training and serving contexts." Silent failures become: "the platform must validate feature row counts and distributions at every stage boundary and fail loudly when validation fails." Resource exhaustion becomes: "the platform must enforce memory budgets on training jobs and implement streaming processing by default."

Each pitfall that has been encountered in production represents an opportunity to improve the platform so that future teams do not encounter it. This is the compounding value of a mature ML platform: the accumulated operational experience of all teams is encoded into platform guardrails that new teams benefit from automatically. Senior engineers are responsible for translating post-mortem learnings into platform improvements, not just fixing the immediate incident.

The version mismatch pitfall is particularly insidious at scale because it only manifests when the model and the feature schema are updated separately. Prevention requires that the model registry enforces atomic bundling: a model cannot be registered without an associated feature schema version, and the feature schema version cannot be deprecated while any registered model depends on it. Designing and enforcing these constraints in the model registry is a senior-level platform design decision with significant operational impact.

At L6, the pitfall table is a living artifact that grows with each production incident. Staff engineers run quarterly reviews of the pitfall inventory with the operations team, add new pitfalls discovered in recent incidents, and evaluate which platform investments would have the highest ROI in terms of preventing future occurrences. This practice of systematic pitfall management, combined with platform improvements that encode the learnings, is how ML infrastructure teams achieve the high reliability expected at FAANG.

---
