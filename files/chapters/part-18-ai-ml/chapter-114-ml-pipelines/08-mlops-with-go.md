## 114.7 MLOps with Go

### CI/CD for ML Models

An ML CI/CD pipeline differs from standard software pipelines because it must validate data quality and model performance metrics in addition to unit tests. The GitHub Actions workflow below runs data validation, trains the model, evaluates it against a held-out test set, and only promotes the artifact to the model registry if accuracy meets the threshold, preventing regressions from reaching production.

```yaml
# .github/workflows/ml-pipeline.yml
name: ML Pipeline

on:
  push:
    branches: [ main, develop ]
    paths:
      - 'models/**'
      - 'data/**'
      - 'training/**'
  pull_request:
    branches: [ main ]

jobs:
  data-validation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Validate Data Schema
        run: |
          go run ./cmd/validate-data --path ./data/training

      - name: Check Data Quality
        run: |
          go run ./cmd/data-quality-check --path ./data/training

  model-training:
    needs: data-validation
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Train Model
        run: |
          go run ./cmd/train \
            --config ./configs/training.yaml \
            --data ./data/training \
            --output ./models/trained

      - name: Evaluate Model
        run: |
          go run ./cmd/evaluate \
            --model ./models/trained \
            --data ./data/validation \
            --metrics ./metrics/evaluation.json

      - name: Upload Model Artifact
        uses: actions/upload-artifact@v4
        with:
          name: trained-model
          path: ./models/trained

  model-testing:
    needs: model-training
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Download Model
        uses: actions/download-artifact@v4
        with:
          name: trained-model
          path: ./models/trained

      - name: Unit Tests
        run: |
          go test ./pkg/serving/... -v

      - name: Integration Tests
        run: |
          go test ./tests/integration/... -v

      - name: Performance Tests
        run: |
          go run ./cmd/benchmark \
            --model ./models/trained \
            --requests 1000 \
            --concurrency 10

  model-deployment:
    needs: model-testing
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v5

      - name: Download Model
        uses: actions/download-artifact@v4
        with:
          name: trained-model
          path: ./models/trained

      - name: Build Docker Image
        run: |
          docker build -t ml-serving:${{ github.sha }} .

      - name: Push to Registry
        run: |
          docker push ml-serving:${{ github.sha }}

      - name: Deploy Canary
        run: |
          kubectl apply -f k8s/canary-deployment.yaml
          kubectl set image deployment/ml-serving-canary \
            ml-serving=ml-serving:${{ github.sha }}
```

### A/B Testing for Models

A/B testing models in production is the only evaluation that counts: route a controlled slice of live traffic to the candidate model, compare business metrics against the incumbent, and promote or roll back on evidence.

```go
// pkg/mlops/ab_testing.go
package mlops

import (
    "crypto/md5"
    "encoding/binary"
    "fmt"
    "sync"
)

// ABTest manages A/B testing of models
type ABTest struct {
    name         string
    modelA       string
    modelB       string
    splitPercent int // Percentage of traffic for model B
    metrics      *ABTestMetrics
    mu           sync.RWMutex
}

// ABTestMetrics tracks A/B test metrics
type ABTestMetrics struct {
    ModelARequests int64
    ModelBRequests int64
    ModelALatency  []float64
    ModelBLatency  []float64
    ModelAErrors   int64
    ModelBErrors   int64
    mu             sync.RWMutex
}

func NewABTest(name, modelA, modelB string, splitPercent int) *ABTest {
    return &ABTest{
        name:         name,
        modelA:       modelA,
        modelB:       modelB,
        splitPercent: splitPercent,
        metrics:      &ABTestMetrics{},
    }
}

// SelectModel selects which model to use based on user ID
func (ab *ABTest) SelectModel(userID string) string {
    // Use consistent hashing to assign users to models
    hash := md5.Sum([]byte(userID))
    bucket := binary.BigEndian.Uint32(hash[:4]) % 100

    if int(bucket) < ab.splitPercent {
        return ab.modelB
    }
    return ab.modelA
}

// RecordRequest records a request to a model
func (ab *ABTest) RecordRequest(model string, latency float64, err error) {
    ab.metrics.mu.Lock()
    defer ab.metrics.mu.Unlock()

    if model == ab.modelB {
        ab.metrics.ModelBRequests++
        ab.metrics.ModelBLatency = append(ab.metrics.ModelBLatency, latency)
        if err != nil {
            ab.metrics.ModelBErrors++
        }
    } else {
        ab.metrics.ModelARequests++
        ab.metrics.ModelALatency = append(ab.metrics.ModelALatency, latency)
        if err != nil {
            ab.metrics.ModelAErrors++
        }
    }
}

// GetMetrics returns current A/B test metrics
func (ab *ABTest) GetMetrics() *ABTestMetrics {
    ab.metrics.mu.RLock()
    defer ab.metrics.mu.RUnlock()

    return &ABTestMetrics{
        ModelARequests: ab.metrics.ModelARequests,
        ModelBRequests: ab.metrics.ModelBRequests,
        ModelALatency:  append([]float64{}, ab.metrics.ModelALatency...),
        ModelBLatency:  append([]float64{}, ab.metrics.ModelBLatency...),
        ModelAErrors:   ab.metrics.ModelAErrors,
        ModelBErrors:   ab.metrics.ModelBErrors,
    }
}

// ABTestManager manages multiple A/B tests
type ABTestManager struct {
    tests map[string]*ABTest
    mu    sync.RWMutex
}

func NewABTestManager() *ABTestManager {
    return &ABTestManager{
        tests: make(map[string]*ABTest),
    }
}

// CreateTest creates a new A/B test
func (m *ABTestManager) CreateTest(name, modelA, modelB string,
    splitPercent int) error {

    m.mu.Lock()
    defer m.mu.Unlock()

    if _, exists := m.tests[name]; exists {
        return fmt.Errorf("test %s already exists", name)
    }

    m.tests[name] = NewABTest(name, modelA, modelB, splitPercent)
    return nil
}

// GetTest retrieves an A/B test
func (m *ABTestManager) GetTest(name string) (*ABTest, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()

    test, exists := m.tests[name]
    if !exists {
        return nil, fmt.Errorf("test %s not found", name)
    }

    return test, nil
}

// DeleteTest removes an A/B test
func (m *ABTestManager) DeleteTest(name string) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    delete(m.tests, name)
    return nil
}
```

### Canary Deployment

A canary rollout answers one question repeatedly: given what we have observed so far, is it safe to send the candidate more traffic? The type below holds the traffic split, routes requests by a stable hash of the request ID, accumulates per-arm metrics, and steps the percentage up only when a health check and an error-rate comparison both pass.

```go
// pkg/mlops/canary.go
package mlops

import (
    "context"
    "crypto/md5"
    "encoding/binary"
    "fmt"
    "math"
    "sync"
    "time"
)

// CanaryDeployment manages gradual model rollouts
type CanaryDeployment struct {
    name            string
    productionModel string
    canaryModel     string
    canaryPercent   int
    metrics         *CanaryMetrics
    healthChecker   HealthChecker
    mu              sync.RWMutex
}

// CanaryMetrics tracks canary deployment metrics
type CanaryMetrics struct {
    ProductionRequests int64
    CanaryRequests     int64
    ProductionErrors   int64
    CanaryErrors       int64
    ProductionLatency  []float64
    CanaryLatency      []float64
    mu                 sync.RWMutex
}

// HealthChecker checks model health
type HealthChecker interface {
    Check(ctx context.Context, model string) (bool, error)
}

func NewCanaryDeployment(name, prodModel, canaryModel string,
    checker HealthChecker) *CanaryDeployment {

    return &CanaryDeployment{
        name:            name,
        productionModel: prodModel,
        canaryModel:     canaryModel,
        canaryPercent:   0,
        metrics:         &CanaryMetrics{},
        healthChecker:   checker,
    }
}

// IncreaseTraffic gradually increases canary traffic
func (cd *CanaryDeployment) IncreaseTraffic(ctx context.Context,
    increment int) error {

    cd.mu.Lock()
    newPercent := cd.canaryPercent + increment
    if newPercent > 100 {
        newPercent = 100
    }
    cd.mu.Unlock()

    // Check canary health before increasing traffic
    healthy, err := cd.healthChecker.Check(ctx, cd.canaryModel)
    if err != nil {
        return fmt.Errorf("health check failed: %w", err)
    }

    if !healthy {
        return fmt.Errorf("canary model is unhealthy")
    }

    // Check error rates.
    //
    // Guard the denominators. On the first step the canary has served zero
    // requests, so CanaryErrors/CanaryRequests is 0/0, which is NaN. Every
    // comparison against NaN is false, including `canaryErrorRate >
    // threshold`, so the gate does not merely misbehave: it silently approves
    // the rollout while appearing to check it. A safety check that cannot fail
    // is not a safety check.
    //
    // Requiring a minimum sample before promoting also stops a single early
    // error from reading as a 100% error rate.
    const minSamples = 100

    metrics := cd.GetMetrics()
    if metrics.CanaryRequests < minSamples {
        return fmt.Errorf("insufficient canary traffic to evaluate: %d requests, need %d",
            metrics.CanaryRequests, minSamples)
    }

    canaryErrorRate := float64(metrics.CanaryErrors) / float64(metrics.CanaryRequests)

    prodErrorRate := 0.0
    if metrics.ProductionRequests > 0 {
        prodErrorRate = float64(metrics.ProductionErrors) / float64(metrics.ProductionRequests)
    }

    // Compare against the production rate, but keep an absolute floor: when
    // production's error rate is 0, any multiple of it is still 0, and a
    // purely relative gate would block on a single canary error forever.
    const absoluteErrorFloor = 0.01
    threshold := math.Max(prodErrorRate*1.5, absoluteErrorFloor)

    if canaryErrorRate > threshold {
        return fmt.Errorf("canary error rate too high: %.2f%% vs threshold %.2f%% (production %.2f%%)",
            canaryErrorRate*100, threshold*100, prodErrorRate*100)
    }

    cd.mu.Lock()
    cd.canaryPercent = newPercent
    cd.mu.Unlock()

    return nil
}

// SelectModel selects which model to use
func (cd *CanaryDeployment) SelectModel(requestID string) string {
    cd.mu.RLock()
    percent := cd.canaryPercent
    cd.mu.RUnlock()

    // Use consistent hashing
    hash := md5.Sum([]byte(requestID))
    bucket := binary.BigEndian.Uint32(hash[:4]) % 100

    if int(bucket) < percent {
        return cd.canaryModel
    }
    return cd.productionModel
}

// RecordRequest records a request
func (cd *CanaryDeployment) RecordRequest(model string, latency float64, err error) {
    cd.metrics.mu.Lock()
    defer cd.metrics.mu.Unlock()

    if model == cd.canaryModel {
        cd.metrics.CanaryRequests++
        cd.metrics.CanaryLatency = append(cd.metrics.CanaryLatency, latency)
        if err != nil {
            cd.metrics.CanaryErrors++
        }
    } else {
        cd.metrics.ProductionRequests++
        cd.metrics.ProductionLatency = append(cd.metrics.ProductionLatency, latency)
        if err != nil {
            cd.metrics.ProductionErrors++
        }
    }
}

// GetMetrics returns current metrics
func (cd *CanaryDeployment) GetMetrics() *CanaryMetrics {
    cd.metrics.mu.RLock()
    defer cd.metrics.mu.RUnlock()

    return &CanaryMetrics{
        ProductionRequests: cd.metrics.ProductionRequests,
        CanaryRequests:     cd.metrics.CanaryRequests,
        ProductionErrors:   cd.metrics.ProductionErrors,
        CanaryErrors:       cd.metrics.CanaryErrors,
        ProductionLatency:  append([]float64{}, cd.metrics.ProductionLatency...),
        CanaryLatency:      append([]float64{}, cd.metrics.CanaryLatency...),
    }
}

// Promote promotes canary to production
func (cd *CanaryDeployment) Promote() {
    cd.mu.Lock()
    defer cd.mu.Unlock()

    cd.productionModel = cd.canaryModel
    cd.canaryPercent = 0
}

// Rollback rolls back the canary
func (cd *CanaryDeployment) Rollback() {
    cd.mu.Lock()
    defer cd.mu.Unlock()

    cd.canaryPercent = 0
}

// AutoCanary automatically manages canary rollout
func (cd *CanaryDeployment) AutoCanary(ctx context.Context,
    checkInterval time.Duration) error {

    increments := []int{10, 25, 50, 75, 100}

    for _, target := range increments {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(checkInterval):
        }

        cd.mu.RLock()
        current := cd.canaryPercent
        cd.mu.RUnlock()

        increment := target - current
        if increment <= 0 {
            continue
        }

        if err := cd.IncreaseTraffic(ctx, increment); err != nil {
            cd.Rollback()
            return fmt.Errorf("canary rollout failed at %d%%: %w", current, err)
        }

        fmt.Printf("Canary traffic increased to %d%%\n", target)
    }

    // Promote to production
    cd.Promote()
    fmt.Println("Canary promoted to production")

    return nil
}
```

### Junior → FAANG: MLOps as the Production Bridge

MLOps is the discipline of applying DevOps principles to the ML lifecycle, and it is the topic that most clearly distinguishes backend engineers who have shipped ML to production from those who have only trained models. The key MLOps concepts to internalize are: CI/CD for model artifacts (automated training, evaluation, and deployment triggered by code or data changes), A/B testing for model quality validation before full rollout, and drift monitoring for ongoing quality assurance after deployment. These three practices, applied consistently, are what prevent ML models from silently degrading in production.

For interviews, the most commonly asked MLOps question is: "How would you safely deploy a new version of a fraud detection model that serves 100 million transactions per day?" The answer covers: shadow deployment (run the new model in parallel with the current model, log both predictions, compare offline before any live traffic), canary deployment (route 1% of live traffic to the new model, compare precision/recall over 24 hours), gradual rollout (increase from 1% to 5% to 25% to 100% with evaluation gates at each step), and automated rollback (if precision drops below the threshold at any step, automatically route all traffic back to the previous model and alert the on-call engineer).

Build a simple CI/CD pipeline for a toy ML model as a study exercise: a GitHub Actions workflow that trains a model on data changes, runs evaluation, fails the workflow if metrics drop below threshold, and deploys by writing the new model path to a configuration file. The specific tools matter less than understanding the flow: trigger, train, evaluate, gate, deploy or reject.

### Senior @ FAANG: MLOps Maturity and Organizational Change

MLOps maturity is a spectrum that most organizations are still climbing. Level one: models are deployed manually, evaluation is done ad-hoc, and retraining happens when someone notices the model is degrading. Level two: training is automated but deployment is manual, evaluation is standardized but not automated. Level three: the full pipeline is automated from data change to deployment with evaluation gates. Level four: continuous training with automated retraining triggered by drift detection, with human review only for significant model changes. Moving an organization from level one to level four is a multi-year program that requires both technical investment and organizational change management.

The technical work of MLOps at senior level includes: designing the CD pipeline for model artifacts that integrates with the existing software deployment infrastructure, building the evaluation framework that defines the quality gates each model must pass, implementing the canary routing infrastructure that enables gradual rollout with real-time metric comparison, and designing the rollback automation that ensures degraded models are removed from production within minutes of detection. Each of these components requires careful design for the organization's scale and reliability requirements.

The organizational work of MLOps is equally important. Model teams must adopt the evaluation framework, which means accepting constraints on model promotion that may slow their velocity. The on-call rotation must be trained on ML-specific failure modes (drift, skew, artifact corruption) that are different from normal service failures. The incident review process must be adapted for ML incidents, where root cause analysis requires examining training data, feature distributions, and model evaluation metrics rather than just service logs and error rates. Senior engineers lead this organizational change alongside the technical implementation.

At L7, MLOps strategy intersects with the broader engineering organization's platform strategy. The question is: should MLOps tooling be built in-house (maximum customization, significant investment) or adopted from the ecosystem (faster time to value, less control)? Companies like Google build TFX and Vertex AI. Netflix builds Metaflow. Many companies adopt Kubeflow or MLflow. The right answer depends on the organization's scale, the team's expertise, and the strategic importance of ML differentiation. Staff engineers who can make this build-versus-buy recommendation with data and defend it to engineering leadership are operating at the highest level of organizational impact.

Governance in a mature MLOps system includes model cards as a required deliverable for every production model, an approval workflow for models with significant business impact, and a post-deployment review process that evaluates model performance 30 days after launch against the projections in the model card. This governance framework creates accountability for model quality and provides the evidence base for continuous improvement of the evaluation criteria.
