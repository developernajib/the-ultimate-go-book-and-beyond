## 114.9 Production ML Pipeline Example

Let's build a complete recommendation system as a production example:

```go
// examples/recommendation-system/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "os"
    "time"

    "yourmodule/pkg/featurestore"
    "yourmodule/pkg/monitoring"
    "yourmodule/pkg/serving"
)

func main() {
    ctx := context.Background()

    // Initialize feature store
    onlineStore := featurestore.NewRedisOnlineStore("localhost:6379", 24*time.Hour)
    defer onlineStore.Close()

    fs := featurestore.NewFeatureStore(onlineStore, nil)

    // Register features
    registerRecommendationFeatures(fs)

    // Initialize model server. The ONNX Runtime shared library path is
    // deployment configuration, so it comes from the environment.
    modelServer, err := serving.NewONNXModelServer(os.Getenv("ONNXRUNTIME_LIB_PATH"))
    if err != nil {
        log.Fatal("Failed to initialize ONNX runtime:", err)
    }
    defer modelServer.Close()

    // Load recommendation model
    if err := modelServer.LoadModel(ctx, "recommendations",
        "./models/recommender.onnx"); err != nil {
        log.Fatal("Failed to load model:", err)
    }

    // Initialize monitoring
    alertMgr := monitoring.NewAlertManager()
    alertMgr.AddHandler(&monitoring.LogAlertHandler{})

    monitor := monitoring.NewModelMonitor("recommendations", alertMgr)

    // Initialize drift detector
    driftDetector := monitoring.NewDriftDetector("recommendations", 3.0)

    // Set baseline statistics (from training data)
    baselineStats := &monitoring.FeatureStatistics{
        Mean: map[string]float64{
            "user_age":            28.5,
            "user_activity_score": 850.0,
            "item_popularity":     0.15,
            "time_of_day":         14.5,
        },
        Std: map[string]float64{
            "user_age":            8.2,
            "user_activity_score": 450.0,
            "item_popularity":     0.08,
            "time_of_day":         6.5,
        },
    }
    driftDetector.SetBaseline(baselineStats)

    // Simulate recommendation requests
    fmt.Println("Starting recommendation system...")

    for i := 0; i < 100; i++ {
        userID := fmt.Sprintf("user_%d", i%10)

        // Get user features from feature store
        features, err := fs.GetOnlineByGroup(ctx, userID, "user_features")
        if err != nil {
            // If features don't exist, compute them
            features = computeUserFeatures(userID)
            if err := fs.WriteOnline(ctx, features); err != nil {
                log.Printf("Failed to write features: %v", err)
                continue
            }
        }

        // Prepare model input
        modelInput, err := prepareModelInput(features)
        if err != nil {
            log.Printf("Skipping %s: %v", userID, err)
            continue
        }

        // Run inference under a deadline. Without one, a stalled inference
        // pins this loop indefinitely and the latency metric records a number
        // nobody is alive to read.
        inferCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
        start := time.Now()
        predictions, err := modelServer.Predict(inferCtx, "recommendations", modelInput)
        latency := time.Since(start).Seconds() * 1000 // Convert to ms
        cancel()

        if err != nil {
            log.Printf("Prediction failed: %v", err)
            monitor.RecordPrediction(latency, -1, err)
            continue
        }

        // Record successful prediction
        accuracy := computeAccuracy(predictions) // Simplified
        monitor.RecordPrediction(latency, accuracy, nil)

        // Print recommendations
        topItems := extractTopRecommendations(predictions, 5)
        fmt.Printf("User %s: Recommended items %v (latency: %.2fms)\n",
            userID, topItems, latency)

        // Periodically check metrics
        if i%20 == 0 {
            thresholds := &monitoring.PerformanceThresholds{
                MaxErrorRate: 0.05,
                MaxLatency:   100.0,
                MinAccuracy:  0.70,
            }
            monitor.CheckThresholds(ctx, thresholds)

            // Check for drift
            currentData := collectCurrentFeatures()
            currentStats := monitoring.ComputeStatistics(currentData)

            driftReport, err := driftDetector.DetectDrift(ctx, currentStats)
            if err != nil {
                log.Printf("Drift detection failed: %v", err)
            } else if driftReport.HasDrift {
                fmt.Printf("DRIFT DETECTED in features: %v\n", driftReport.DriftedFeatures)
                // Trigger retraining
                fmt.Println("Triggering model retraining...")
            }
        }

        time.Sleep(100 * time.Millisecond)
    }

    // Print final metrics
    metrics := monitor.GetMetrics()
    fmt.Printf("\nFinal Metrics:\n")
    fmt.Printf("Total Predictions: %d\n", metrics.Predictions)
    fmt.Printf("Error Rate: %.2f%%\n", metrics.ErrorRate*100)
    fmt.Printf("Average Latency: %.2fms\n", metrics.AverageLatency)
    fmt.Printf("Average Accuracy: %.2f%%\n", metrics.AverageAccuracy*100)
}

func registerRecommendationFeatures(fs *featurestore.FeatureStore) {
    features := []*featurestore.Feature{
        {
            Name:        "user_age",
            Type:        featurestore.FeatureTypeInt,
            Description: "User age",
            Version:     1,
        },
        {
            Name:        "user_activity_score",
            Type:        featurestore.FeatureTypeFloat,
            Description: "User activity score",
            Version:     1,
        },
        {
            Name:        "user_country",
            Type:        featurestore.FeatureTypeString,
            Description: "User country",
            Version:     1,
        },
        {
            Name:        "item_popularity",
            Type:        featurestore.FeatureTypeFloat,
            Description: "Item popularity score",
            Version:     1,
        },
    }

    for _, feature := range features {
        fs.RegisterFeature(feature)
    }

    group := &featurestore.FeatureGroup{
        Name:        "user_features",
        EntityType:  "user",
        Features:    []string{"user_age", "user_activity_score", "user_country"},
        Description: "User profile features for recommendations",
    }
    fs.RegisterGroup(group)
}

func computeUserFeatures(userID string) *featurestore.FeatureVector {
    // Simplified feature computation
    return &featurestore.FeatureVector{
        EntityID: userID,
        Features: map[string]any{
            "user_age":            25 + (len(userID) % 20),
            "user_activity_score": 500.0 + float64(len(userID)*100),
            "user_country":        "US",
        },
        Timestamp: time.Now(),
    }
}

// prepareModelInput converts features to the model's input format.
//
// The naive version of this function asserts concrete types directly:
//
//	age := float32(features.Features["user_age"].(int))
//
// That panics in production and passes in tests, which is the worst possible
// combination. A vector built locally by computeUserFeatures really does hold
// an int, but the same vector fetched from Redis has been through JSON, and
// JSON has exactly one number type: it comes back a float64. The unchecked
// assertion therefore works on the cache-miss path and takes down the process
// on the cache-hit path.
//
// Convert defensively, and fail with a diagnosis rather than a panic.
func prepareModelInput(features *featurestore.FeatureVector) (map[string][]float32, error) {
    age, err := toFloat32(features.Features["user_age"])
    if err != nil {
        return nil, fmt.Errorf("user_age: %w", err)
    }

    activityScore, err := toFloat32(features.Features["user_activity_score"])
    if err != nil {
        return nil, fmt.Errorf("user_activity_score: %w", err)
    }

    return map[string][]float32{
        "input": {age, activityScore, 0.5, 14.0}, // Simplified
    }, nil
}

// toFloat32 accepts any numeric representation a feature may arrive in.
func toFloat32(v any) (float32, error) {
    switch n := v.(type) {
    case float64:
        return float32(n), nil
    case float32:
        return n, nil
    case int:
        return float32(n), nil
    case int64:
        return float32(n), nil
    case json.Number:
        f, err := n.Float64()
        return float32(f), err
    case nil:
        return 0, fmt.Errorf("feature is absent")
    default:
        return 0, fmt.Errorf("unexpected feature type %T", v)
    }
}

func computeAccuracy(predictions map[string][]float32) float64 {
    // Simplified accuracy computation
    return 0.85
}

func extractTopRecommendations(predictions map[string][]float32, k int) []int {
    // Extract top-k items from predictions
    // Simplified: return mock item IDs
    items := make([]int, k)
    for i := 0; i < k; i++ {
        items[i] = 100 + i
    }
    return items
}

func collectCurrentFeatures() map[string][]float64 {
    // Collect current feature values for drift detection
    return map[string][]float64{
        "user_age":            {27.5, 29.0, 25.5, 30.2, 28.8},
        "user_activity_score": {820.0, 890.0, 750.0, 920.0, 860.0},
        "item_popularity":     {0.14, 0.16, 0.13, 0.17, 0.15},
        "time_of_day":         {13.5, 15.2, 12.8, 16.1, 14.5},
    }
}
```

### Junior → FAANG: Studying Production Examples for Interview Depth

The recommendation system example in this section is a microcosm of every production ML system, and it is deliberately a sequential single-threaded loop so the flow stays legible. Read it for the engineering decisions rather than the code. Why does the inference call carry a timeout? Why does the compute-on-miss path write back to the store? What is missing that production would demand? The answers all have production rationales: timeouts prevent one stalled dependency from cascading, write-back turns a miss into a warm cache for the next request, and a real service would fetch features concurrently, attach the model version to every response for later A/B analysis, and fall back to defaults rather than skipping the user entirely. Being able to articulate those rationales, including the gaps, turns a code review question into a system design discussion.

Practice extending this example with monitoring: add Prometheus metrics that record feature retrieval latency, inference latency, and the distribution of recommendation scores. Add a health check endpoint that tests the feature store connection and the inference runtime and returns a degraded status if either is slow. These additions turn the example from a prototype into something approaching production quality, and they give you concrete code to reference when discussing observability in interviews.

The end-to-end flow in this example, from request receipt to recommendation delivery, should be memorizable in outline form: receive user ID and context, fetch user features from feature store, assemble feature vector, call inference, post-process scores, filter and rank candidates, return top-k recommendations with model version. Being able to trace this flow verbally in two minutes, including the failure path at each step, is a standard expectation for senior ML infrastructure interviews.

### Senior @ FAANG: Production Examples as Team Knowledge Transfer

At senior level, production code examples serve a different purpose: they are the reference implementation that all new model integrations should follow. When a new model team joins the ML platform, they should be able to start from this example and customize it for their use case without needing to redesign the core serving, monitoring, and error handling patterns. The example should therefore be treated as a maintained artifact with tests, documentation, and a version history that explains why each design choice was made.

Feature retrieval is the pattern most worth standardizing across the organization, and the example above is only the sketch of it. The production shape is: concurrent lookup for independent features, a timeout matching the overall request latency budget, and graceful fallback to default or cached values when the feature store is slow or unavailable, with the fallback recorded as a metric so silent degradation stays visible. Enforcing this pattern as the organizational standard prevents the per-team divergence that makes ML serving infrastructure increasingly difficult to maintain.

At L6, the production example is the foundation for an internal SDK that model teams use to build serving paths. The SDK encapsulates the feature retrieval, inference, monitoring, and error handling patterns, exposing a clean interface that model teams customize with their specific feature names, inference endpoints, and post-processing logic. This SDK is itself a production service with versioning, testing, and backward compatibility guarantees. Building and maintaining it is a platform team responsibility that delivers compounding value as the number of model teams grows.

---
