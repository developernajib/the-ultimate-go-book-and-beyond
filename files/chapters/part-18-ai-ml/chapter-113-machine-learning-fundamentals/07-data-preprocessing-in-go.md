## 113.6 Data Preprocessing in Go

Real-world ML is 80% data preprocessing, 20% modeling.

### Loading CSV Datasets

The loader below is deliberately the simple version: `encoding/csv` with `ReadAll`, parsing each field to a `float64` and treating the last column as the label. It reads the whole file into memory and returns on the first bad field, which is exactly right for a training set that fits in RAM and exactly wrong past that point.

Two properties are worth noting before you reuse it. `csv.Reader` defaults `FieldsPerRecord` to the width of the first record and rejects any row that disagrees, so ragged rows are caught for you rather than silently producing short slices. And failing fast on a parse error is a real choice, not laziness: a training loader that skips unparseable rows and carries on will happily train on a silently truncated dataset. When you do want tolerance, count and report what you dropped rather than swallowing it. At dataset sizes that no longer fit in memory, switch to `reader.Read` in a loop and stream.

```go
package ml

import (
    "encoding/csv"
    "fmt"
    "os"
    "strconv"
)

// Dataset holds features and labels
type Dataset struct {
    Features [][]float64
    Labels   []float64
    FeatureNames []string
}

// LoadCSV loads a CSV file into a Dataset
// Assumes last column is the label
func LoadCSV(filename string, hasHeader bool) (*Dataset, error) {
    file, err := os.Open(filename)
    if err != nil {
        return nil, fmt.Errorf("open file: %v", err)
    }
    defer file.Close()

    reader := csv.NewReader(file)
    records, err := reader.ReadAll()
    if err != nil {
        return nil, fmt.Errorf("read CSV: %v", err)
    }

    if len(records) == 0 {
        return nil, fmt.Errorf("empty CSV file")
    }

    dataset := &Dataset{}

    startRow := 0
    if hasHeader {
        dataset.FeatureNames = records[0][:len(records[0])-1]
        startRow = 1
    }

    numFeatures := len(records[0]) - 1
    numSamples := len(records) - startRow

    dataset.Features = make([][]float64, numSamples)
    dataset.Labels = make([]float64, numSamples)

    for i, record := range records[startRow:] {
        dataset.Features[i] = make([]float64, numFeatures)

        // Parse features
        for j := 0; j < numFeatures; j++ {
            val, err := strconv.ParseFloat(record[j], 64)
            if err != nil {
                return nil, fmt.Errorf("parse row %d col %d: %v", i+startRow, j, err)
            }
            dataset.Features[i][j] = val
        }

        // Parse label
        label, err := strconv.ParseFloat(record[numFeatures], 64)
        if err != nil {
            return nil, fmt.Errorf("parse label row %d: %v", i+startRow, err)
        }
        dataset.Labels[i] = label
    }

    return dataset, nil
}
```

### Normalization and Standardization

ML models perform better when input features are on similar scales. Min-max normalization rescales each feature to the [0, 1] range. Standardization (z-score normalization) centers features around zero with unit variance. Choose normalization when you need bounded values, and standardization when your model assumes Gaussian-distributed inputs (e.g., logistic regression, SVMs).

The `Fit`/`Transform` split in both types below is not ceremony, it is the thing that prevents data leakage. Fit on the training set only, then apply that same fitted object to validation, test, and serving data. Calling `FitTransform` on your full dataset before splitting leaks the test set's min, max, mean, and variance into training, and the resulting evaluation scores are optimistically biased in a way no later step can detect. This is the most common way a model looks excellent in a notebook and mediocre in production.

The corollary at serving time: a value outside the range seen during fitting will normalize outside [0, 1], and a standardized feature will exceed the z-scores the model trained on. That is correct behavior and you should not clamp it away silently. Do monitor for it, because a sustained rise in out-of-range features is drift announcing itself early.

```go
package ml

import (
    "math"
)

// Normalizer scales features to [0, 1] range
type Normalizer struct {
    min []float64
    max []float64
}

// Fit learns min and max from training data
func (n *Normalizer) Fit(X [][]float64) {
    if len(X) == 0 {
        return
    }

    numFeatures := len(X[0])
    n.min = make([]float64, numFeatures)
    n.max = make([]float64, numFeatures)

    // Initialize with first row
    copy(n.min, X[0])
    copy(n.max, X[0])

    // Find min and max for each feature
    for _, sample := range X[1:] {
        for j, val := range sample {
            if val < n.min[j] {
                n.min[j] = val
            }
            if val > n.max[j] {
                n.max[j] = val
            }
        }
    }
}

// Transform scales data to [0, 1]
func (n *Normalizer) Transform(X [][]float64) [][]float64 {
    result := make([][]float64, len(X))

    for i, sample := range X {
        result[i] = make([]float64, len(sample))
        for j, val := range sample {
            if n.max[j] == n.min[j] {
                result[i][j] = 0.0 // avoid division by zero
            } else {
                result[i][j] = (val - n.min[j]) / (n.max[j] - n.min[j])
            }
        }
    }

    return result
}

// FitTransform fits and transforms in one step
func (n *Normalizer) FitTransform(X [][]float64) [][]float64 {
    n.Fit(X)
    return n.Transform(X)
}

// Standardizer scales to mean=0, std=1 (z-score normalization)
type Standardizer struct {
    mean   []float64
    stddev []float64
}

// Fit learns mean and standard deviation
func (s *Standardizer) Fit(X [][]float64) {
    if len(X) == 0 {
        return
    }

    numFeatures := len(X[0])
    n := float64(len(X))

    s.mean = make([]float64, numFeatures)
    s.stddev = make([]float64, numFeatures)

    // Compute means
    for _, sample := range X {
        for j, val := range sample {
            s.mean[j] += val
        }
    }
    for j := range s.mean {
        s.mean[j] /= n
    }

    // Compute standard deviations
    for _, sample := range X {
        for j, val := range sample {
            diff := val - s.mean[j]
            s.stddev[j] += diff * diff
        }
    }
    for j := range s.stddev {
        s.stddev[j] = math.Sqrt(s.stddev[j] / n)
    }
}

// Transform standardizes data
func (s *Standardizer) Transform(X [][]float64) [][]float64 {
    result := make([][]float64, len(X))

    for i, sample := range X {
        result[i] = make([]float64, len(sample))
        for j, val := range sample {
            if s.stddev[j] == 0 {
                result[i][j] = 0.0
            } else {
                result[i][j] = (val - s.mean[j]) / s.stddev[j]
            }
        }
    }

    return result
}

// FitTransform fits and transforms
func (s *Standardizer) FitTransform(X [][]float64) [][]float64 {
    s.Fit(X)
    return s.Transform(X)
}
```

### Handling Missing Values

Missing value imputation prevents model training failures caused by null inputs and avoids the bias that naive zero-filling introduces. The implementation below offers three strategies: mean, median, and an explicit zero fill. Reach for the median when the feature is skewed or has outliers, since the mean chases them and the median does not. Reach for zero only when zero is genuinely meaningful for that feature, not as a default.

One caveat this code makes easy to miss: imputing away a missing value discards the fact that it was missing, and missingness is often itself predictive. If a field is absent because the user declined to provide it, that signal is worth keeping as a separate binary indicator column alongside the imputed value.

```go
package ml

import (
    "math"
    "slices"
)

// ImputeStrategy defines how to fill missing values
type ImputeStrategy int

const (
    ImputeMean ImputeStrategy = iota
    ImputeMedian
    ImputeZero
)

// SimpleImputer fills missing values (represented as NaN)
type SimpleImputer struct {
    strategy ImputeStrategy
    fillValues []float64
}

// NewSimpleImputer creates an imputer
func NewSimpleImputer(strategy ImputeStrategy) *SimpleImputer {
    return &SimpleImputer{strategy: strategy}
}

// Fit learns fill values from training data
func (si *SimpleImputer) Fit(X [][]float64) {
    if len(X) == 0 {
        return
    }

    numFeatures := len(X[0])
    si.fillValues = make([]float64, numFeatures)

    switch si.strategy {
    case ImputeMean:
        si.computeMeans(X)
    case ImputeMedian:
        si.computeMedians(X)
    case ImputeZero:
        // fillValues already initialized to 0
    }
}

// computeMeans calculates mean for each feature
func (si *SimpleImputer) computeMeans(X [][]float64) {
    numFeatures := len(X[0])
    counts := make([]int, numFeatures)

    for _, sample := range X {
        for j, val := range sample {
            if !math.IsNaN(val) {
                si.fillValues[j] += val
                counts[j]++
            }
        }
    }

    for j := range si.fillValues {
        if counts[j] > 0 {
            si.fillValues[j] /= float64(counts[j])
        }
    }
}

// computeMedians calculates median for each feature
func (si *SimpleImputer) computeMedians(X [][]float64) {
    numFeatures := len(X[0])

    for j := 0; j < numFeatures; j++ {
        var values []float64
        for _, sample := range X {
            if !math.IsNaN(sample[j]) {
                values = append(values, sample[j])
            }
        }

        if len(values) > 0 {
            si.fillValues[j] = median(values)
        }
    }
}

// Transform fills missing values
func (si *SimpleImputer) Transform(X [][]float64) [][]float64 {
    result := make([][]float64, len(X))

    for i, sample := range X {
        result[i] = make([]float64, len(sample))
        for j, val := range sample {
            if math.IsNaN(val) {
                result[i][j] = si.fillValues[j]
            } else {
                result[i][j] = val
            }
        }
    }

    return result
}

// median computes median of slice
func median(values []float64) float64 {
    if len(values) == 0 {
        return 0
    }

    // Sort values
    sorted := make([]float64, len(values))
    copy(sorted, values)
    slices.Sort(sorted)

    mid := len(sorted) / 2
    if len(sorted)%2 == 0 {
        return (sorted[mid-1] + sorted[mid]) / 2
    }
    return sorted[mid]
}
```

### Junior → FAANG: Data Preprocessing as Production Infrastructure

The "80% preprocessing, 20% modeling" ratio is often cited but rarely internalized by juniors. In a FAANG interview, describing a data preprocessing pipeline means talking about Go channels for streaming data through transformation stages, goroutines for parallel processing of independent records, and error handling that distinguishes between malformed records (skip and log) versus system errors (fail fast with an alert). A preprocessing pipeline that silently drops malformed records without counting them is a production bug waiting to happen.

The three preprocessing steps that matter most for interview discussions are normalization (feature scaling to prevent gradient descent instability and ensure fair distance metrics), missing value imputation (choosing between mean substitution, median, forward fill, and learned imputation based on the feature's distribution and the business logic around missing data), and categorical encoding (one-hot encoding for nominal categories, target encoding for high-cardinality features, ordinal encoding for ordered categories). Know when each is appropriate and what the failure mode is if you choose wrong.

A concrete habit to build: always compute and log preprocessing statistics (means, standard deviations, cardinality of categoricals, missing value rates) as part of the pipeline, and store them alongside the processed data. These statistics let you detect distribution shift between training runs, validate that serving-time preprocessing matches training-time preprocessing, and debug silent model degradation by comparing current statistics against the baseline from when the model was trained.

### Senior @ FAANG: Preprocessing Pipelines as Data Contracts

The training-serving skew problem is almost always a preprocessing problem. Data scientists preprocess training data in Python notebooks with subtle differences from how the Go serving layer preprocesses inference requests: different normalization statistics, different missing value handling, different tokenization logic. The solution is not to write better documentation: it is to share code. Define the preprocessing logic as a schema-validated transformation specification (a protobuf message or a JSON schema), generate the transformation code in both Python and Go from the same specification, and run integration tests that assert identical outputs given identical inputs.

Data quality validation is a first-class engineering concern at senior level. A preprocessing pipeline without input validation is a liability: malformed data can produce NaN features that propagate silently into predictions, cause integer overflow in feature computation, or trigger denial-of-service conditions if unbounded string lengths are allowed in text features. Define input schemas explicitly (field name, type, valid range, allowed nullability), validate every incoming record against the schema before processing, and emit structured rejection events with reasons so that upstream data owners can correct the issue.

Preprocessing at scale requires careful attention to Go's memory allocation patterns. Processing millions of records through a pipeline that allocates a new struct per record creates significant garbage collection pressure. Senior engineers design preprocessing pipelines to reuse memory: use sync.Pool for preprocessing buffer structs, process records in fixed-size batches to amortize allocation overhead, and profile allocation rates under representative load before declaring the pipeline production-ready.

Feature store integration changes the preprocessing architecture fundamentally. When a feature store provides pre-computed features, the serving-time preprocessing pipeline becomes much simpler: validate the request identifier, look up the pre-computed feature vector, validate that the features are not stale, and pass them to the model. The complex transformation logic moves to the offline feature computation pipeline. Designing the handoff between online and offline computation, and defining the staleness tolerance for pre-computed features, are senior-level architectural decisions.

At L7, preprocessing governance includes data lineage tracking at the organizational level. Every feature that enters a model should have a recorded lineage: which source table, which transformation version, which data engineering job, and which business rule. This lineage enables impact analysis when upstream schemas change (which models are affected?), compliance audits (was this feature computed from data that required user consent?), and post-incident debugging (did the preprocessing change when the model started degrading?). Building and maintaining this lineage infrastructure is a multi-team effort that requires staff-level coordination.
