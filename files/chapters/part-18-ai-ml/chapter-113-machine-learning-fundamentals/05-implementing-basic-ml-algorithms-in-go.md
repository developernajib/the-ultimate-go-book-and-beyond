## 113.4 Implementing Basic ML Algorithms in Go

Understanding algorithms from scratch builds intuition. We'll implement four core algorithms.

### Linear Regression: The Foundation

Linear regression finds the best straight line through data points: `y = mx + b`

```
         Y
         │
     100 │     ×
         │       ×
      80 │   ×     ×
         │ ×         ×
      60 │             ×
         │
      40 │
         └────────────────── X
         0   20  40  60  80

         Goal: Find m (slope) and b (intercept)
         that minimize distance to all × points
```

#### Simple Linear Regression (One Feature)

Simple linear regression computes the slope and intercept that minimize the sum of squared residuals using the closed-form ordinary least squares solution. The `Train` method walks the training examples to accumulate the sums the formula needs, then derives `m` and `b` in O(n) time without any iterative optimization.

```go
package ml

import (
    "fmt"
    "math"
)

// LinearRegression implements simple linear regression
type LinearRegression struct {
    Slope     float64 // m in y = mx + b
    Intercept float64 // b in y = mx + b
    trained   bool
}

// Train fits the model using Ordinary Least Squares
// Math: minimizes sum of squared residuals
func (lr *LinearRegression) Train(X, y []float64) error {
    if len(X) != len(y) {
        return fmt.Errorf("X and y must have same length")
    }

    if len(X) < 2 {
        return fmt.Errorf("need at least 2 data points")
    }

    n := float64(len(X))

    // Calculate means
    var sumX, sumY float64
    for i := range X {
        sumX += X[i]
        sumY += y[i]
    }
    meanX := sumX / n
    meanY := sumY / n

    // Calculate slope: m = Σ((x - mean_x)(y - mean_y)) / Σ((x - mean_x)^2)
    var numerator, denominator float64
    for i := range X {
        numerator += (X[i] - meanX) * (y[i] - meanY)
        denominator += (X[i] - meanX) * (X[i] - meanX)
    }

    if denominator == 0 {
        return fmt.Errorf("cannot compute slope: all X values are identical")
    }

    lr.Slope = numerator / denominator

    // Calculate intercept: b = mean_y - m * mean_x
    lr.Intercept = meanY - lr.Slope*meanX

    lr.trained = true
    return nil
}

// Predict generates predictions for new X values
func (lr *LinearRegression) Predict(X []float64) ([]float64, error) {
    if !lr.trained {
        return nil, fmt.Errorf("model not trained")
    }

    predictions := make([]float64, len(X))
    for i, x := range X {
        predictions[i] = lr.Slope*x + lr.Intercept
    }

    return predictions, nil
}

// Score computes R² (coefficient of determination)
// R² = 1 - (SS_res / SS_tot)
// R² = 1.0: perfect fit, R² = 0.0: model no better than mean
func (lr *LinearRegression) Score(X, y []float64) (float64, error) {
    if len(X) != len(y) {
        return 0, fmt.Errorf("X and y must have same length")
    }

    predictions, err := lr.Predict(X)
    if err != nil {
        return 0, err
    }

    // Calculate mean of y
    var sumY float64
    for _, val := range y {
        sumY += val
    }
    meanY := sumY / float64(len(y))

    // SS_res: sum of squared residuals (errors)
    var ssRes float64
    for i := range y {
        residual := y[i] - predictions[i]
        ssRes += residual * residual
    }

    // SS_tot: total sum of squares
    var ssTot float64
    for _, val := range y {
        ssTot += (val - meanY) * (val - meanY)
    }

    if ssTot == 0 {
        return 0, fmt.Errorf("cannot compute R²: variance is zero")
    }

    return 1 - (ssRes / ssTot), nil
}

// MSE computes Mean Squared Error
func (lr *LinearRegression) MSE(X, y []float64) (float64, error) {
    predictions, err := lr.Predict(X)
    if err != nil {
        return 0, err
    }

    var sumSquaredError float64
    for i := range y {
        residual := y[i] - predictions[i]
        sumSquaredError += residual * residual
    }

    return sumSquaredError / float64(len(y)), nil
}

// RMSE computes Root Mean Squared Error (same units as y)
func (lr *LinearRegression) RMSE(X, y []float64) (float64, error) {
    mse, err := lr.MSE(X, y)
    if err != nil {
        return 0, err
    }
    return math.Sqrt(mse), nil
}
```

#### Complete Example: Predicting House Prices

This end-to-end example trains the linear regression model on a synthetic house price dataset, then calls `Predict` on holdout samples and reports RMSE. It demonstrates how to split data, fit the model, and evaluate prediction quality using the metrics defined earlier in this section.

```go
package ml

import (
    "fmt"
    "log"
)

func ExampleLinearRegression() {
    // Dataset: Square footage -> Price
    sqft := []float64{1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400}
    price := []float64{200000, 230000, 260000, 290000, 320000, 350000, 380000, 410000}

    // Create and train model
    model := &LinearRegression{}
    if err := model.Train(sqft, price); err != nil {
        log.Fatal(err)
    }

    fmt.Printf("Learned equation: Price = %.2f * SqFt + %.2f\n",
        model.Slope, model.Intercept)

    // Evaluate on training data
    r2, _ := model.Score(sqft, price)
    rmse, _ := model.RMSE(sqft, price)

    fmt.Printf("R² Score: %.4f\n", r2)
    fmt.Printf("RMSE: $%.2f\n", rmse)

    // Make predictions
    newHouses := []float64{1500, 2100, 2500}
    predictions, _ := model.Predict(newHouses)

    fmt.Println("\nPredictions:")
    for i, sqft := range newHouses {
        fmt.Printf("  %0.f sq ft -> $%.2f\n", sqft, predictions[i])
    }

    // Output:
    // Learned equation: Price = 150.00 * SqFt + 50000.00
    // R² Score: 1.0000
    // RMSE: $0.00
    //
    // Predictions:
    //   1500 sq ft -> $275000.00
    //   2100 sq ft -> $365000.00
    //   2500 sq ft -> $425000.00
}
```

#### Multiple Linear Regression (Multiple Features)

Real problems have multiple features: house price depends on square footage, bedrooms, age, location, etc.

```go
package ml

import (
    "fmt"
    "log"

    "gonum.org/v1/gonum/mat"
)

// MultipleLinearRegression handles multiple features
// y = b0 + b1*x1 + b2*x2 + ... + bn*xn
type MultipleLinearRegression struct {
    Coefficients []float64 // [b0, b1, b2, ..., bn]
    trained      bool
}

// Train fits the model using matrix operations
// Normal equation: β = (X^T X)^(-1) X^T y
//
// The normal equation is written out explicitly here because it makes the
// linear algebra legible, which is the point of this section. It is not what
// you should ship. Forming X^T X squares the condition number of X, so with
// correlated features the inversion loses precision or fails outright. In
// production, solve the least squares system directly with a QR or SVD based
// routine (mat.Dense.Solve) and never invert a matrix you only intend to
// multiply through.
func (mlr *MultipleLinearRegression) Train(X [][]float64, y []float64) error {
    if len(X) != len(y) {
        return fmt.Errorf("X and y must have same length")
    }

    if len(X) == 0 {
        return fmt.Errorf("need at least one sample")
    }

    n := len(X)      // number of samples
    m := len(X[0])   // number of features

    if n < m+1 {
        return fmt.Errorf("need at least %d samples for %d features: X^T X is singular otherwise", m+1, m)
    }

    // Add bias column (all 1s) to X
    XWithBias := make([]float64, n*(m+1))
    for i := 0; i < n; i++ {
        XWithBias[i*(m+1)] = 1.0 // bias term
        for j := 0; j < m; j++ {
            XWithBias[i*(m+1)+j+1] = X[i][j]
        }
    }

    // Convert to matrices
    XMat := mat.NewDense(n, m+1, XWithBias)
    yVec := mat.NewVecDense(n, y)

    // Compute X^T. The method is CloneFrom: an older gonum API spelled this
    // Clone, and that name no longer exists.
    var XTrans mat.Dense
    XTrans.CloneFrom(XMat.T())

    // Compute X^T * X
    var XTX mat.Dense
    XTX.Mul(&XTrans, XMat)

    // Compute (X^T * X)^(-1)
    var XTXInv mat.Dense
    if err := XTXInv.Inverse(&XTX); err != nil {
        return fmt.Errorf("cannot invert matrix: %v", err)
    }

    // Compute X^T * y
    var XTy mat.VecDense
    XTy.MulVec(&XTrans, yVec)

    // Compute β = (X^T X)^(-1) X^T y
    var beta mat.VecDense
    beta.MulVec(&XTXInv, &XTy)

    // Extract coefficients
    mlr.Coefficients = make([]float64, m+1)
    for i := 0; i < m+1; i++ {
        mlr.Coefficients[i] = beta.AtVec(i)
    }

    mlr.trained = true
    return nil
}

// Predict generates predictions for new data
func (mlr *MultipleLinearRegression) Predict(X [][]float64) ([]float64, error) {
    if !mlr.trained {
        return nil, fmt.Errorf("model not trained")
    }

    predictions := make([]float64, len(X))
    for i, features := range X {
        // y = b0 + b1*x1 + b2*x2 + ...
        pred := mlr.Coefficients[0] // bias
        for j, x := range features {
            pred += mlr.Coefficients[j+1] * x
        }
        predictions[i] = pred
    }

    return predictions, nil
}

// Example: Predicting house prices from multiple features
func ExampleMultipleRegression() {
    // Features: [sqft, bedrooms, age]
    X := [][]float64{
        {1500, 3, 10},
        {2000, 4, 5},
        {1200, 2, 20},
        {1800, 3, 8},
        {2200, 4, 3},
    }

    y := []float64{300000, 400000, 250000, 350000, 450000}

    model := &MultipleLinearRegression{}
    if err := model.Train(X, y); err != nil {
        log.Fatal(err)
    }

    fmt.Printf("Coefficients: %.2f\n", model.Coefficients)
    fmt.Println("Equation: Price = b0 + b1*sqft + b2*bedrooms + b3*age")

    // Predict for new house: 1600 sqft, 3 bedrooms, 7 years old
    newHouse := [][]float64{{1600, 3, 7}}
    pred, _ := model.Predict(newHouse)
    fmt.Printf("Predicted price: $%.2f\n", pred[0])
}
```

### Logistic Regression: Binary Classification

Logistic regression predicts probabilities for binary outcomes (yes/no, spam/not spam, fraud/legitimate).

```
Linear Regression:     Logistic Regression:
y = mx + b            p(y=1) = 1 / (1 + e^(-z))
                      where z = mx + b

   Y                     P(Y=1)
   │                     │ 1.0 ┌─────────
100│  ×  ×                │     ╱
 80│×      ×              │    ╱
 60│        ×             │   ╱
 40│         ×            │  ╱
 20│          ×           │ ╱
   └────────── X          └╱────────── X
   Can go < 0           Always 0 to 1
   or > 100             (probability)
```

```go
package ml

import (
    "fmt"
    "math"
    "math/rand/v2"
)

// LogisticRegression implements binary classification
type LogisticRegression struct {
    Weights      []float64
    Bias         float64
    LearningRate float64
    MaxIter      int
    trained      bool
}

// NewLogisticRegression creates a new logistic regression model
func NewLogisticRegression(learningRate float64, maxIter int) *LogisticRegression {
    return &LogisticRegression{
        LearningRate: learningRate,
        MaxIter:      maxIter,
    }
}

// sigmoid computes 1 / (1 + e^(-x))
func sigmoid(x float64) float64 {
    return 1.0 / (1.0 + math.Exp(-x))
}

// Train fits the model using gradient descent
func (lr *LogisticRegression) Train(X [][]float64, y []float64) error {
    if len(X) != len(y) {
        return fmt.Errorf("X and y must have same length")
    }

    n := len(X)      // samples
    m := len(X[0])   // features

    // Initialize weights randomly
    lr.Weights = make([]float64, m)
    for i := range lr.Weights {
        lr.Weights[i] = rand.Float64()*0.01 - 0.005 // small random values
    }
    lr.Bias = 0.0

    // Gradient descent
    for iter := 0; iter < lr.MaxIter; iter++ {
        // Compute predictions and gradients
        weightGrads := make([]float64, m)
        var biasGrad float64

        for i := 0; i < n; i++ {
            // Forward pass: compute prediction
            z := lr.Bias
            for j := 0; j < m; j++ {
                z += lr.Weights[j] * X[i][j]
            }
            pred := sigmoid(z)

            // Error. Do not name this `error`: it compiles, because Go lets
            // you shadow a predeclared identifier, and it means the builtin
            // error type is unnameable for the rest of the scope.
            diff := pred - y[i]

            // Accumulate gradients
            biasGrad += diff
            for j := 0; j < m; j++ {
                weightGrads[j] += diff * X[i][j]
            }
        }

        // Update weights (average gradients)
        for j := 0; j < m; j++ {
            lr.Weights[j] -= lr.LearningRate * weightGrads[j] / float64(n)
        }
        lr.Bias -= lr.LearningRate * biasGrad / float64(n)

        // Optional: compute and print loss every 100 iterations
        if iter%100 == 0 {
            loss := lr.computeLoss(X, y)
            fmt.Printf("Iteration %d, Loss: %.4f\n", iter, loss)
        }
    }

    lr.trained = true
    return nil
}

// computeLoss calculates binary cross-entropy loss
// Loss = -1/n Σ [y*log(p) + (1-y)*log(1-p)]
func (lr *LogisticRegression) computeLoss(X [][]float64, y []float64) float64 {
    var totalLoss float64
    n := float64(len(X))

    for i := range X {
        pred := lr.predictProba(X[i])

        // Avoid log(0)
        pred = math.Max(pred, 1e-15)
        pred = math.Min(pred, 1-1e-15)

        loss := -y[i]*math.Log(pred) - (1-y[i])*math.Log(1-pred)
        totalLoss += loss
    }

    return totalLoss / n
}

// predictProba returns probability of class 1
func (lr *LogisticRegression) predictProba(features []float64) float64 {
    z := lr.Bias
    for j, x := range features {
        z += lr.Weights[j] * x
    }
    return sigmoid(z)
}

// Predict returns class predictions (0 or 1)
func (lr *LogisticRegression) Predict(X [][]float64) ([]float64, error) {
    if !lr.trained {
        return nil, fmt.Errorf("model not trained")
    }

    predictions := make([]float64, len(X))
    for i, features := range X {
        prob := lr.predictProba(features)
        if prob >= 0.5 {
            predictions[i] = 1.0
        } else {
            predictions[i] = 0.0
        }
    }

    return predictions, nil
}

// PredictProba returns probability estimates
func (lr *LogisticRegression) PredictProba(X [][]float64) ([]float64, error) {
    if !lr.trained {
        return nil, fmt.Errorf("model not trained")
    }

    probabilities := make([]float64, len(X))
    for i, features := range X {
        probabilities[i] = lr.predictProba(features)
    }

    return probabilities, nil
}

// Accuracy computes classification accuracy
func (lr *LogisticRegression) Accuracy(X [][]float64, y []float64) (float64, error) {
    predictions, err := lr.Predict(X)
    if err != nil {
        return 0, err
    }

    correct := 0
    for i := range y {
        if predictions[i] == y[i] {
            correct++
        }
    }

    return float64(correct) / float64(len(y)), nil
}
```

#### Example: Email Spam Classification

Spam classification demonstrates the core ML workflow end to end: feature extraction, model training on labeled examples, and probability-based prediction at inference time. The example below trains the `LogisticRegression` type built above on a handful of hand-labeled emails, which is enough to show the mechanics and far too few to draw any conclusion about real accuracy.

```go
package ml

import (
    "fmt"
    "log"
)

func ExampleLogisticRegression() {
    // Features: [word_count, link_count, has_urgent_words]
    // Simplified email features
    X := [][]float64{
        {50, 0, 0},   // legitimate: short, no links, not urgent
        {200, 1, 0},  // legitimate: long, 1 link
        {30, 5, 1},   // spam: short, many links, urgent
        {100, 0, 0},  // legitimate
        {25, 10, 1},  // spam: short, many links, urgent
        {150, 2, 0},  // legitimate
        {40, 8, 1},   // spam
        {180, 1, 0},  // legitimate
    }

    // Labels: 0 = legitimate, 1 = spam
    y := []float64{0, 0, 1, 0, 1, 0, 1, 0}

    // Create and train model
    model := NewLogisticRegression(0.01, 1000)
    if err := model.Train(X, y); err != nil {
        log.Fatal(err)
    }

    // Evaluate
    acc, _ := model.Accuracy(X, y)
    fmt.Printf("Training Accuracy: %.2f%%\n", acc*100)

    // Predict on new emails
    newEmails := [][]float64{
        {60, 1, 0},   // legitimate-looking
        {20, 15, 1},  // spam-looking
    }

    predictions, _ := model.Predict(newEmails)
    probabilities, _ := model.PredictProba(newEmails)

    fmt.Println("\nPredictions:")
    for i := range newEmails {
        // PredictProba returns P(spam). Confidence in the label actually
        // reported is that probability for spam, and its complement for
        // legitimate. Printing P(spam) next to the word "Legitimate" is a
        // classic reporting bug: it makes a confident ham call look like a
        // coin flip.
        label := "Legitimate"
        confidence := 1 - probabilities[i]
        if predictions[i] == 1 {
            label = "Spam"
            confidence = probabilities[i]
        }
        fmt.Printf("  Email %d: %s (%.1f%% confidence, P(spam)=%.3f)\n",
            i+1, label, confidence*100, probabilities[i])
    }
}
```

Two things about this example are worth naming rather than glossing over.

The features are on wildly different scales: `word_count` runs to 200 while `link_count` stays under 16. Gradient descent on unscaled features like these takes a badly conditioned path down the loss surface, because a step size appropriate for the word-count weight is far too large for the link-count weight. The model still separates this toy dataset, but on real data you standardize first. That is exactly what the preprocessing section later in this chapter is for.

Training accuracy on eight rows is not a result. With three features and eight examples the model has more than enough capacity to memorize the labels, so a perfect training score tells you nothing about generalization. This is the smallest possible illustration of why the train/test discipline from earlier in the chapter exists. Note also that `Train` logs its loss every 100 iterations, so the real console output is interleaved with those progress lines.

### K-Means Clustering: Unsupervised Learning

K-means groups data into K clusters without labels.

```
Before K-Means:              After K-Means (K=3):
    ×  ×                         A  A
  ×      ×                     A      A
    ×  ×                         A  A

      ×                              B
    ×   ×                          B   B
      ×                              B

×                              C
  ×   ×                          C   C
×                              C

Cluster A: Users who buy electronics
Cluster B: Users who buy clothing
Cluster C: Users who buy groceries
```

```go
package ml

import (
    "fmt"
    "math"
    "math/rand/v2"
)

// KMeans implements k-means clustering
type KMeans struct {
    K          int         // number of clusters
    Centroids  [][]float64 // cluster centers
    MaxIter    int
    trained    bool
}

// NewKMeans creates a k-means clusterer
func NewKMeans(k, maxIter int) *KMeans {
    return &KMeans{
        K:       k,
        MaxIter: maxIter,
    }
}

// euclideanDistance computes distance between two points
func euclideanDistance(a, b []float64) float64 {
    var sum float64
    for i := range a {
        diff := a[i] - b[i]
        sum += diff * diff
    }
    return math.Sqrt(sum)
}

// Fit discovers K clusters in data
func (km *KMeans) Fit(X [][]float64) error {
    if len(X) < km.K {
        return fmt.Errorf("need at least K=%d data points, got %d", km.K, len(X))
    }

    n := len(X)
    m := len(X[0]) // feature dimension

    // Initialize centroids randomly (k-means++)
    km.Centroids = km.initializeCentroidsKMeansPlusPlus(X)

    // Iterate until convergence or max iterations
    for iter := 0; iter < km.MaxIter; iter++ {
        // Step 1: Assign each point to nearest centroid
        assignments := make([]int, n)
        for i, point := range X {
            assignments[i] = km.nearestCentroid(point)
        }

        // Step 2: Update centroids to mean of assigned points
        newCentroids := make([][]float64, km.K)
        counts := make([]int, km.K)

        for i := 0; i < km.K; i++ {
            newCentroids[i] = make([]float64, m)
        }

        // Sum up points in each cluster
        for i, point := range X {
            cluster := assignments[i]
            counts[cluster]++
            for j, val := range point {
                newCentroids[cluster][j] += val
            }
        }

        // Compute means. A cluster can end an iteration with zero points
        // assigned to it. Dividing is then skipped, which would leave the
        // centroid at the all-zero vector: the cluster silently teleports to
        // the origin, attracts whatever happens to lie near it, and the
        // results become nonsense that still looks like a clustering. Carry
        // the previous centroid forward instead.
        for i := 0; i < km.K; i++ {
            if counts[i] == 0 {
                copy(newCentroids[i], km.Centroids[i])
                continue
            }
            for j := range newCentroids[i] {
                newCentroids[i][j] /= float64(counts[i])
            }
        }

        // Check convergence
        converged := true
        for i := 0; i < km.K; i++ {
            dist := euclideanDistance(km.Centroids[i], newCentroids[i])
            if dist > 1e-4 {
                converged = false
                break
            }
        }

        km.Centroids = newCentroids

        if converged {
            fmt.Printf("K-means converged after %d iterations\n", iter+1)
            break
        }
    }

    km.trained = true
    return nil
}

// initializeCentroidsKMeansPlusPlus uses k-means++ initialization
// Chooses initial centroids to be far apart, improves convergence
func (km *KMeans) initializeCentroidsKMeansPlusPlus(X [][]float64) [][]float64 {
    centroids := make([][]float64, km.K)

    // First centroid: random point
    firstIdx := rand.IntN(len(X))
    centroids[0] = make([]float64, len(X[0]))
    copy(centroids[0], X[firstIdx])

    // Subsequent centroids: probability proportional to distance from nearest centroid
    for i := 1; i < km.K; i++ {
        distances := make([]float64, len(X))
        var totalDist float64

        for j, point := range X {
            minDist := math.MaxFloat64
            for k := 0; k < i; k++ {
                dist := euclideanDistance(point, centroids[k])
                if dist < minDist {
                    minDist = dist
                }
            }
            distances[j] = minDist * minDist // squared distance
            totalDist += distances[j]
        }

        // Choose next centroid with weighted probability
        r := rand.Float64() * totalDist
        var cumulative float64
        for j, dist := range distances {
            cumulative += dist
            if cumulative >= r {
                centroids[i] = make([]float64, len(X[0]))
                copy(centroids[i], X[j])
                break
            }
        }

        // Fallback: when every remaining point coincides with an existing
        // centroid, totalDist is 0 and the loop above may select nothing,
        // leaving a nil centroid that panics on first use. Duplicate rows in
        // real datasets make this reachable, not theoretical.
        if centroids[i] == nil {
            centroids[i] = make([]float64, len(X[0]))
            copy(centroids[i], X[rand.IntN(len(X))])
        }
    }

    return centroids
}

// nearestCentroid finds the closest centroid to a point
func (km *KMeans) nearestCentroid(point []float64) int {
    minDist := math.MaxFloat64
    nearest := 0

    for i, centroid := range km.Centroids {
        dist := euclideanDistance(point, centroid)
        if dist < minDist {
            minDist = dist
            nearest = i
        }
    }

    return nearest
}

// Predict assigns data points to clusters
func (km *KMeans) Predict(X [][]float64) ([]int, error) {
    if !km.trained {
        return nil, fmt.Errorf("model not trained")
    }

    assignments := make([]int, len(X))
    for i, point := range X {
        assignments[i] = km.nearestCentroid(point)
    }

    return assignments, nil
}

// Inertia computes within-cluster sum of squares
// Lower is better: measures cluster compactness
func (km *KMeans) Inertia(X [][]float64) (float64, error) {
    assignments, err := km.Predict(X)
    if err != nil {
        return 0, err
    }

    var inertia float64
    for i, point := range X {
        cluster := assignments[i]
        dist := euclideanDistance(point, km.Centroids[cluster])
        inertia += dist * dist
    }

    return inertia, nil
}
```

#### Example: Customer Segmentation

Customer segmentation with k-means clustering groups similar users together based on behavioral features, enabling targeted marketing and personalized experiences. The following implementation demonstrates centroid initialization, iterative assignment, and convergence detection using Go's numerical computing primitives.

```go
package ml

import (
    "fmt"
    "log"
)

func ExampleKMeans() {
    // Customer features: [purchase_frequency, average_order_value]
    // Normalized to 0-1 range
    customers := [][]float64{
        {0.1, 0.2},  // low frequency, low value
        {0.15, 0.25},
        {0.8, 0.9},  // high frequency, high value (VIP)
        {0.85, 0.95},
        {0.5, 0.3},  // medium frequency, low value
        {0.45, 0.35},
        {0.2, 0.8},  // low frequency, high value (occasional big spender)
        {0.25, 0.85},
    }

    // Cluster into 3 segments
    model := NewKMeans(3, 100)
    if err := model.Fit(customers); err != nil {
        log.Fatal(err)
    }

    // Assign customers to clusters
    assignments, _ := model.Predict(customers)

    fmt.Println("Customer Segments:")
    segmentNames := []string{"Budget", "Premium", "VIP"}

    for i, customer := range customers {
        segment := assignments[i]
        fmt.Printf("Customer %d [freq=%.2f, value=%.2f] -> Segment %s\n",
            i+1, customer[0], customer[1], segmentNames[segment])
    }

    // Cluster centroids show typical customer in each segment
    fmt.Println("\nSegment Profiles (centroids):")
    for i, centroid := range model.Centroids {
        fmt.Printf("Segment %s: freq=%.2f, value=%.2f\n",
            segmentNames[i], centroid[0], centroid[1])
    }

    // Compute cluster quality
    inertia, _ := model.Inertia(customers)
    fmt.Printf("\nInertia (lower is better): %.4f\n", inertia)
}
```

### Decision Trees: Interpretable Classification

Decision trees make decisions by asking questions about features.

```
                    [All Customers]
                           │
                   CPU Usage > 80%?
                    ╱            ╲
                  Yes             No
                   │               │
            Memory > 4GB?     Disk I/O > 500?
             ╱        ╲         ╱        ╲
           Yes         No     Yes         No
            │           │       │           │
        [Upgrade]  [Monitor] [Optimize] [Normal]
```

```go
package ml

import (
    "fmt"
)

// DecisionTree implements classification decision tree
type DecisionTree struct {
    MaxDepth int
    MinSamplesSplit int
    Root     *TreeNode
}

// TreeNode represents a node in the decision tree
type TreeNode struct {
    // Internal node (split)
    FeatureIndex int
    Threshold    float64
    Left         *TreeNode
    Right        *TreeNode

    // Leaf node (prediction)
    IsLeaf bool
    Class  float64

    // Metadata
    Samples int
    Gini    float64
}

// NewDecisionTree creates a new decision tree
func NewDecisionTree(maxDepth, minSamplesSplit int) *DecisionTree {
    return &DecisionTree{
        MaxDepth:        maxDepth,
        MinSamplesSplit: minSamplesSplit,
    }
}

// Train builds the decision tree
func (dt *DecisionTree) Train(X [][]float64, y []float64) error {
    if len(X) != len(y) {
        return fmt.Errorf("X and y must have same length")
    }

    dt.Root = dt.buildTree(X, y, 0)
    return nil
}

// buildTree recursively builds the tree
func (dt *DecisionTree) buildTree(X [][]float64, y []float64, depth int) *TreeNode {
    n := len(X)

    // Create node
    node := &TreeNode{
        Samples: n,
        Gini:    dt.giniImpurity(y),
    }

    // Stopping criteria
    if depth >= dt.MaxDepth || n < dt.MinSamplesSplit || node.Gini == 0 {
        // Make leaf node
        node.IsLeaf = true
        node.Class = dt.majorityClass(y)
        return node
    }

    // Find best split
    bestGain := 0.0
    var bestFeature int
    var bestThreshold float64
    var bestLeftX, bestRightX [][]float64
    var bestLeftY, bestRightY []float64

    m := len(X[0]) // number of features

    for feature := 0; feature < m; feature++ {
        // Try different thresholds for this feature
        thresholds := dt.uniqueValues(X, feature)

        for _, threshold := range thresholds {
            // Split data
            leftX, rightX, leftY, rightY := dt.split(X, y, feature, threshold)

            if len(leftX) == 0 || len(rightX) == 0 {
                continue // skip invalid splits
            }

            // Compute information gain
            gain := dt.informationGain(y, leftY, rightY)

            if gain > bestGain {
                bestGain = gain
                bestFeature = feature
                bestThreshold = threshold
                bestLeftX, bestRightX = leftX, rightX
                bestLeftY, bestRightY = leftY, rightY
            }
        }
    }

    // If no good split found, make leaf
    if bestGain == 0 {
        node.IsLeaf = true
        node.Class = dt.majorityClass(y)
        return node
    }

    // Create internal node
    node.FeatureIndex = bestFeature
    node.Threshold = bestThreshold
    node.Left = dt.buildTree(bestLeftX, bestLeftY, depth+1)
    node.Right = dt.buildTree(bestRightX, bestRightY, depth+1)

    return node
}

// giniImpurity computes Gini impurity
// Gini = 1 - Σ(p_i^2) where p_i is fraction of class i
// Gini = 0: pure (all same class), Gini = 0.5: maximum impurity (50/50 split)
func (dt *DecisionTree) giniImpurity(y []float64) float64 {
    if len(y) == 0 {
        return 0
    }

    // Count classes
    counts := make(map[float64]int)
    for _, label := range y {
        counts[label]++
    }

    // Compute Gini
    var gini float64 = 1.0
    n := float64(len(y))

    for _, count := range counts {
        p := float64(count) / n
        gini -= p * p
    }

    return gini
}

// informationGain computes reduction in Gini impurity from split
func (dt *DecisionTree) informationGain(parent, left, right []float64) float64 {
    n := float64(len(parent))
    nLeft := float64(len(left))
    nRight := float64(len(right))

    parentGini := dt.giniImpurity(parent)
    leftGini := dt.giniImpurity(left)
    rightGini := dt.giniImpurity(right)

    weightedGini := (nLeft/n)*leftGini + (nRight/n)*rightGini

    return parentGini - weightedGini
}

// split divides data based on feature threshold
func (dt *DecisionTree) split(X [][]float64, y []float64, feature int, threshold float64) (
    [][]float64, [][]float64, []float64, []float64) {

    var leftX, rightX [][]float64
    var leftY, rightY []float64

    for i, sample := range X {
        if sample[feature] <= threshold {
            leftX = append(leftX, sample)
            leftY = append(leftY, y[i])
        } else {
            rightX = append(rightX, sample)
            rightY = append(rightY, y[i])
        }
    }

    return leftX, rightX, leftY, rightY
}

// uniqueValues returns unique values for a feature (used as thresholds)
func (dt *DecisionTree) uniqueValues(X [][]float64, feature int) []float64 {
    seen := make(map[float64]bool)
    var values []float64

    for _, sample := range X {
        if !seen[sample[feature]] {
            seen[sample[feature]] = true
            values = append(values, sample[feature])
        }
    }

    return values
}

// majorityClass returns most common class
func (dt *DecisionTree) majorityClass(y []float64) float64 {
    counts := make(map[float64]int)
    for _, label := range y {
        counts[label]++
    }

    var maxCount int
    var majorityClass float64

    for class, count := range counts {
        if count > maxCount {
            maxCount = count
            majorityClass = class
        }
    }

    return majorityClass
}

// Predict classifies new data
func (dt *DecisionTree) Predict(X [][]float64) ([]float64, error) {
    if dt.Root == nil {
        return nil, fmt.Errorf("model not trained")
    }

    predictions := make([]float64, len(X))
    for i, sample := range X {
        predictions[i] = dt.predictOne(dt.Root, sample)
    }
    return predictions, nil
}

// predictOne traverses tree for single sample
func (dt *DecisionTree) predictOne(node *TreeNode, sample []float64) float64 {
    if node.IsLeaf {
        return node.Class
    }

    if sample[node.FeatureIndex] <= node.Threshold {
        return dt.predictOne(node.Left, sample)
    }
    return dt.predictOne(node.Right, sample)
}

// PrintTree prints tree structure (for debugging)
func (dt *DecisionTree) PrintTree(node *TreeNode, depth int) {
    if node == nil {
        return
    }

    indent := ""
    for i := 0; i < depth; i++ {
        indent += "  "
    }

    if node.IsLeaf {
        fmt.Printf("%sLeaf: class=%.0f, samples=%d, gini=%.3f\n",
            indent, node.Class, node.Samples, node.Gini)
    } else {
        fmt.Printf("%sSplit: feature[%d] <= %.2f, samples=%d, gini=%.3f\n",
            indent, node.FeatureIndex, node.Threshold, node.Samples, node.Gini)
        dt.PrintTree(node.Left, depth+1)
        dt.PrintTree(node.Right, depth+1)
    }
}
```

### Junior → FAANG: Implementing Algorithms to Build Intuition

Implementing ML algorithms from scratch in Go is not about production code: it is about building the intuition to debug production systems intelligently. When a gradient descent optimizer oscillates instead of converging, you need to understand that the learning rate is too high relative to the loss landscape curvature. When a decision tree overfits training data, you know to add max depth constraints or minimum leaf sample counts. That debugging intuition only comes from having built the thing yourself.

For FAANG interviews, the most commonly tested algorithm implementations are linear regression (demonstrates understanding of gradient descent and loss functions), k-means clustering (demonstrates understanding of iterative optimization and convergence), and k-nearest neighbors (demonstrates understanding of similarity metrics and the curse of dimensionality). Practice explaining the time and space complexity of each before implementing it: O(n*d) for KNN at inference time where n is dataset size and d is dimensionality, for example.

The decision tree implementation is particularly valuable because it is the foundation for gradient boosted trees, which are the most common classical ML algorithm in production at FAANG companies. Once you understand how a single tree splits on features to minimize impurity, you can reason about why random forests average multiple trees to reduce variance, and why gradient boosting trains trees sequentially to correct the previous ensemble's errors. These concepts appear frequently in fraud detection and ad ranking system design interviews.

### Senior @ FAANG: Algorithm Selection and Production Tradeoffs

Algorithm selection at senior level is a precision engineering decision, not a preference. For each ML use case, you define the constraints (latency budget, memory budget, minimum accuracy threshold, explainability requirement, retraining frequency) and select the algorithm that satisfies all constraints with the least operational complexity. Gradient boosted trees satisfy all constraints for most structured-data classification tasks at FAANG: they train fast, serve at microsecond latency, produce feature importances for explainability, and retrain reliably on new data. Neural networks are the right choice when the input is unstructured (text, images, embeddings) or when the feature interactions are too complex to engineer manually.

The training-serving consistency problem is most visible with decision trees and similar algorithms. The split logic implemented in Go for serving must be byte-for-byte identical to what the Python training code produces. Floating-point arithmetic differences, subtle rounding behavior, and NaN handling can all cause serving predictions to diverge from training predictions. The standard solution is to export the model as a serialized artifact (ONNX, JSON, or a custom protobuf) and load that artifact in Go, rather than reimplementing the algorithm independently in each language. If you must reimplement, write a cross-language validation test that sends the same input to both the Python training code and the Go serving code and asserts identical outputs.

Complexity analysis matters for capacity planning. A KNN model with one million training examples and one thousand dimensions per example requires one billion distance computations per inference request. At 10,000 requests per second, that is ten trillion operations per second, which is not feasible without approximate nearest neighbor indexing. Senior engineers catch these complexity mismatches before they become production incidents by doing back-of-the-envelope math during the design review, not after the first load test.

Explainability requirements add constraints that affect algorithm choice from the start. Regulatory requirements in finance and healthcare often mandate that model predictions be explainable in terms of input features. Decision trees and linear models are inherently explainable. Deep neural networks require post-hoc explanation methods like LIME or SHAP, which add inference latency and introduce their own approximation errors. Documenting the explainability requirement in the system design document and selecting an algorithm family that satisfies it natively is significantly cleaner than retrofitting an explanation layer onto a black-box model that was chosen without considering this constraint.

At L7, you are expected to evaluate novel algorithm families and judge whether they are production-ready. The standard evaluation includes: does the algorithm have a stable, well-tested implementation in the languages your team uses? Has it been validated at the scale you need? Does the research paper's performance claims hold up on your data distribution? Are there known failure modes at the edge cases your production traffic will hit? This evaluation process, done rigorously, is what prevents the org from being burned by premature adoption of techniques that work in research but fail in production.
