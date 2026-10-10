## Part 11: Testing and Quality Assurance

A platform this complex demands thorough testing at multiple levels. Unit tests verify that individual service methods behave correctly in isolation using mock dependencies. Integration tests confirm that services work properly with real databases and caches. Benchmark tests measure inference latency and throughput so you can catch performance regressions before they reach production. Together, these layers give you confidence that changes do not break existing functionality.

### 11.1 Unit Tests

The unit tests below use the testify library for assertions and mocking. Each test creates a mock repository that returns controlled data, calls a service method, and verifies both the return value and that the repository was called with the expected arguments. This approach tests your business logic in complete isolation from external systems like databases and caches, making the tests fast and deterministic.

```go
// internal/service/experiment/service_test.go
package experiment_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"

	"ml-platform/internal/domain"
	"ml-platform/internal/service/experiment"
	"ml-platform/internal/storage/mocks"
)

func TestCreateExperiment(t *testing.T) {
	// Create mocks
	mockStore := new(mocks.ExperimentStore)
	mockArtifactStore := new(mocks.ArtifactStore)
	mockMetricStore := new(mocks.MetricStore)

	// Create service
	svc := experiment.NewService(mockStore, mockArtifactStore, mockMetricStore)

	// Setup test data
	req := experiment.CreateExperimentRequest{
		Name:        "test-experiment",
		Description: "Test experiment",
		CreatedBy:   "test-user",
		Tags:        map[string]string{"env": "test"},
		Metadata:    map[string]any{},
	}

	// Setup expectations
	mockStore.On("ExperimentNameExists", mock.Anything, "test-experiment").Return(false, nil)
	mockStore.On("CreateExperiment", mock.Anything, mock.AnythingOfType("*domain.Experiment")).Return(nil)

	// Execute
	exp, err := svc.CreateExperiment(context.Background(), req)

	// Assert
	assert.NoError(t, err)
	assert.NotNil(t, exp)
	assert.Equal(t, "test-experiment", exp.Name)
	assert.Equal(t, "test-user", exp.CreatedBy)

	mockStore.AssertExpectations(t)
}

func TestCreateRun(t *testing.T) {
	mockStore := new(mocks.ExperimentStore)
	mockArtifactStore := new(mocks.ArtifactStore)
	mockMetricStore := new(mocks.MetricStore)

	svc := experiment.NewService(mockStore, mockArtifactStore, mockMetricStore)

	experimentID := uuid.New()

	req := experiment.CreateRunRequest{
		ExperimentID: experimentID,
		Name:         "test-run",
		Parameters:   map[string]any{"lr": 0.001, "batch_size": 32},
		User:         "test-user",
	}

	// Mock experiment exists
	mockStore.On("GetExperiment", mock.Anything, experimentID).Return(&domain.Experiment{
		ID:   experimentID,
		Name: "test-experiment",
	}, nil)
	mockStore.On("CreateRun", mock.Anything, mock.AnythingOfType("*domain.Run")).Return(nil)

	run, err := svc.CreateRun(context.Background(), req)

	assert.NoError(t, err)
	assert.NotNil(t, run)
	assert.Equal(t, experimentID, run.ExperimentID)
	assert.Equal(t, domain.RunStatusRunning, run.Status)

	mockStore.AssertExpectations(t)
}

func TestLogMetric(t *testing.T) {
	mockStore := new(mocks.ExperimentStore)
	mockArtifactStore := new(mocks.ArtifactStore)
	mockMetricStore := new(mocks.MetricStore)

	svc := experiment.NewService(mockStore, mockArtifactStore, mockMetricStore)

	runID := uuid.New()

	run := &domain.Run{
		ID:     runID,
		Status: domain.RunStatusRunning,
		Metrics: make(map[string]float64),
	}

	mockStore.On("GetRun", mock.Anything, runID).Return(run, nil)
	mockMetricStore.On("LogMetric", mock.Anything, mock.AnythingOfType("*domain.MetricPoint")).Return(nil)
	mockStore.On("UpdateRun", mock.Anything, mock.AnythingOfType("*domain.Run")).Return(nil)

	err := svc.LogMetric(context.Background(), runID, "loss", 0.123, 100)

	assert.NoError(t, err)
	assert.Equal(t, 0.123, run.Metrics["loss"])

	mockStore.AssertExpectations(t)
	mockMetricStore.AssertExpectations(t)
}
```

### 11.2 Integration Tests

Integration tests verify that your services work correctly when connected to real infrastructure like PostgreSQL and Redis. They use build tags (`//go:build integration`) so they only run when you explicitly request them, since they require running database instances. These tests catch issues that unit tests cannot, such as incorrect SQL queries, serialization mismatches, and transaction handling bugs.

```go
// test/integration/experiment_test.go
//go:build integration
// +build integration

package integration

import (
	"context"
	"database/sql"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"ml-platform/internal/service/experiment"
	"ml-platform/internal/storage"
	"ml-platform/test/testutil"
)

func TestExperimentE2E(t *testing.T) {
	// Setup test database
	db := testutil.SetupTestDB(t)
	defer db.Close()

	// Create stores
	experimentStore := storage.NewPostgresExperimentStore(db)
	artifactStore := testutil.NewMockArtifactStore()
	metricStore := storage.NewPostgresMetricStore(db)

	// Create service
	svc := experiment.NewService(experimentStore, artifactStore, metricStore)

	ctx := context.Background()

	// Create experiment
	exp, err := svc.CreateExperiment(ctx, experiment.CreateExperimentRequest{
		Name:        "integration-test-" + uuid.New().String(),
		Description: "Integration test experiment",
		CreatedBy:   "test-user",
		Tags:        map[string]string{"env": "integration"},
	})
	require.NoError(t, err)
	require.NotNil(t, exp)

	// Create run
	run, err := svc.CreateRun(ctx, experiment.CreateRunRequest{
		ExperimentID: exp.ID,
		Name:         "test-run",
		Parameters: map[string]any{
			"learning_rate": 0.001,
			"batch_size":    32,
		},
		User: "test-user",
	})
	require.NoError(t, err)
	require.NotNil(t, run)

	// Log metrics
	for i := 0; i < 10; i++ {
		err = svc.LogMetric(ctx, run.ID, "train_loss", float64(i)*0.1, int64(i))
		require.NoError(t, err)
	}

	// Get metric history
	history, err := svc.GetMetricHistory(ctx, run.ID, "train_loss")
	require.NoError(t, err)
	assert.Len(t, history, 10)

	// Finish run
	err = svc.FinishRun(ctx, run.ID, domain.RunStatusCompleted)
	require.NoError(t, err)

	// Verify run status
	retrievedRun, err := experimentStore.GetRun(ctx, run.ID)
	require.NoError(t, err)
	assert.Equal(t, domain.RunStatusCompleted, retrievedRun.Status)
	assert.NotNil(t, retrievedRun.EndTime)
}
```

### 11.3 Benchmark Tests

Benchmark tests measure how fast your model serving layer can process predictions. In ML platforms, inference latency directly affects user experience -- a recommendation model that takes 500 milliseconds to respond is too slow for a real-time feed. Go's built-in benchmarking framework (`testing.B`) runs the function repeatedly and reports the average time per operation, giving you a reliable performance baseline that you can track over time.

```go
// internal/service/serving/benchmark_test.go
package serving_test

import (
	"context"
	"testing"

	"ml-platform/internal/service/serving"
)

func BenchmarkPredict(b *testing.B) {
	// Setup
	svc := setupServingService(b)
	
	req := serving.PredictRequest{
		ModelName: "benchmark-model",
		Stage:     "PRODUCTION",
		Inputs: map[string]any{
			"features": []float32{1.0, 2.0, 3.0, 4.0},
		},
	}

	ctx := context.Background()

	b.ResetTimer()

	// Benchmark
	for b.Loop() {
		_, err := svc.Predict(ctx, req)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPredictParallel(b *testing.B) {
	svc := setupServingService(b)
	
	req := serving.PredictRequest{
		ModelName: "benchmark-model",
		Stage:     "PRODUCTION",
		Inputs: map[string]any{
			"features": []float32{1.0, 2.0, 3.0, 4.0},
		},
	}

	ctx := context.Background()

	b.ResetTimer()

	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_, err := svc.Predict(ctx, req)
			if err != nil {
				b.Fatal(err)
			}
		}
	})
}

func setupServingService(b *testing.B) *serving.Service {
	// Setup mock services
	// Load test model
	// Return configured service
	return nil
}
```

---
