## 113.3 Go ML Libraries Overview

Go's ML ecosystem is smaller than Python's but focused on production quality.

### Gonum: Numerical Computing Foundation

Gonum is Go's equivalent to NumPy. It provides linear algebra, statistics, and numerical algorithms.

```bash
go get -u gonum.org/v1/gonum/...
```

```go
package main

import (
    "fmt"
    "gonum.org/v1/gonum/mat"
    "gonum.org/v1/gonum/stat"
)

func main() {
    // Create matrices
    data := mat.NewDense(3, 3, []float64{
        1, 2, 3,
        4, 5, 6,
        7, 8, 9,
    })

    // Matrix operations
    var result mat.Dense
    result.Scale(2, data) // multiply all elements by 2

    fmt.Printf("Scaled matrix:\n%.0f\n\n", mat.Formatted(&result))

    // Statistical operations
    values := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
    mean := stat.Mean(values, nil)

    // stat.StdDev is the *sample* standard deviation: it divides by n-1,
    // not n. For these ten values that is 3.03, where the population
    // standard deviation is 2.87. Reach for stat.PopStdDev when your slice
    // really is the entire population rather than a sample drawn from one.
    stddev := stat.StdDev(values, nil)

    fmt.Printf("Mean: %.2f\n", mean)
    fmt.Printf("Std Dev: %.2f\n", stddev)

    // Output:
    // Scaled matrix:
    // ⎡ 2   4   6⎤
    // ⎢ 8  10  12⎥
    // ⎣14  16  18⎦
    //
    // Mean: 5.50
    // Std Dev: 3.03
}
```

**When to use Gonum:**
- Matrix operations for implementing custom algorithms
- Statistical analysis of data
- Linear algebra (solving systems, eigenvalues)
- Foundation for building custom ML libraries

### Gorgonia: Automatic Differentiation and Neural Networks

Gorgonia is Go's answer to TensorFlow/PyTorch. It builds computation graphs and computes gradients automatically.

Know what you are adopting: Gorgonia's most recent tagged release is v0.9.18 from December 2023, and upstream activity has been minimal since 2024. The library still works and remains the clearest way to learn automatic differentiation without leaving Go, which is why this chapter uses it. It is not, however, a project you should expect to track new hardware or new model architectures. Pin the version, and if a graph you need is not already expressible, budget for the fact that you may be the one implementing it.

```bash
go get -u gorgonia.org/gorgonia
go get -u gorgonia.org/tensor
```

```go
package main

import (
    "fmt"
    "log"

    "gorgonia.org/gorgonia"
)

func main() {
    // Create computation graph
    g := gorgonia.NewGraph()

    // Define variables
    x := gorgonia.NewScalar(g, gorgonia.Float64, gorgonia.WithName("x"))
    y := gorgonia.NewScalar(g, gorgonia.Float64, gorgonia.WithName("y"))

    // Define computation: z = x^2 + y^2
    xSquared := gorgonia.Must(gorgonia.Square(x))
    ySquared := gorgonia.Must(gorgonia.Square(y))
    z := gorgonia.Must(gorgonia.Add(xSquared, ySquared))

    // Create VM to execute graph
    vm := gorgonia.NewTapeMachine(g)
    defer vm.Close()

    // Set input values
    gorgonia.Let(x, 3.0)
    gorgonia.Let(y, 4.0)

    // Run computation
    if err := vm.RunAll(); err != nil {
        log.Fatal(err)
    }

    fmt.Printf("z = x^2 + y^2 = 3^2 + 4^2 = %.0f\n", z.Value())

    // Output:
    // z = x^2 + y^2 = 3^2 + 4^2 = 25
}
```

**When to use Gorgonia:**
- Building neural networks in pure Go
- Custom gradient-based optimization
- Need automatic differentiation
- Production deployment (compiles to binary)

### GoLearn: Classical ML Algorithms

GoLearn provides a scikit-learn style interface for classical ML algorithms. The same caveat as Gorgonia applies, and more sharply: the repository has seen no substantive commits since early 2024. It is fine for prototyping and for learning the Fit/Predict shape, but do not build a long-lived production dependency on it without being prepared to vendor and maintain it yourself.

```bash
go get -u github.com/sjwhitworth/golearn/...
```

```go
package main

import (
    "fmt"

    "github.com/sjwhitworth/golearn/base"
    "github.com/sjwhitworth/golearn/evaluation"
    "github.com/sjwhitworth/golearn/knn"
)

func main() {
    // Load the iris dataset. This ships in the golearn repository under
    // datasets/, it is not compiled into the library: copy the file next to
    // your binary or pass an absolute path.
    rawData, err := base.ParseCSVToInstances("datasets/iris.csv", true)
    if err != nil {
        panic(err)
    }

    // Create k-NN classifier. Prefer an odd k for binary problems so that
    // neighbour votes cannot tie.
    cls := knn.NewKnnClassifier("euclidean", "linear", 3)

    // Train-test split
    trainData, testData := base.InstancesTrainTestSplit(rawData, 0.70)
    if err := cls.Fit(trainData); err != nil {
        panic(err)
    }

    // Make predictions
    predictions, err := cls.Predict(testData)
    if err != nil {
        panic(err)
    }

    // Evaluate
    confusionMat, err := evaluation.GetConfusionMatrix(testData, predictions)
    if err != nil {
        panic(err)
    }

    fmt.Println(evaluation.GetAccuracy(confusionMat))
}
```

**When to use GoLearn:**
- Quick prototyping of classical ML algorithms
- Standard algorithms (k-NN, decision trees, linear models)
- Need scikit-learn familiarity
- Small to medium datasets

### Gonum/Plot: Data Visualization

Gonum's plot package generates static charts and graphs from Go code. It supports scatter plots, line plots, histograms, and more. This is useful for visualizing training data, model predictions, and evaluation metrics during development.

```bash
go get -u gonum.org/v1/plot/...
```

```go
package main

import (
    "image/color"

    "gonum.org/v1/plot"
    "gonum.org/v1/plot/plotter"
    "gonum.org/v1/plot/vg"
)

func PlotLinearRegression(X, y, predictions []float64) error {
    p := plot.New()
    p.Title.Text = "Linear Regression"
    p.X.Label.Text = "X"
    p.Y.Label.Text = "Y"

    // Actual data points
    actualPoints := make(plotter.XYs, len(X))
    for i := range X {
        actualPoints[i].X = X[i]
        actualPoints[i].Y = y[i]
    }

    actual, err := plotter.NewScatter(actualPoints)
    if err != nil {
        return err
    }
    actual.GlyphStyle.Color = color.RGBA{R: 255, A: 255}

    // Predicted line
    predPoints := make(plotter.XYs, len(X))
    for i := range X {
        predPoints[i].X = X[i]
        predPoints[i].Y = predictions[i]
    }

    pred, err := plotter.NewLine(predPoints)
    if err != nil {
        return err
    }
    pred.LineStyle.Color = color.RGBA{B: 255, A: 255}

    p.Add(actual, pred)
    p.Legend.Add("Actual", actual)
    p.Legend.Add("Predicted", pred)

    return p.Save(6*vg.Inch, 4*vg.Inch, "regression.png")
}

func main() {
    X := []float64{1, 2, 3, 4, 5}
    y := []float64{2.1, 3.9, 6.2, 8.1, 9.8}
    pred := []float64{2.0, 4.0, 6.0, 8.0, 10.0}
    if err := PlotLinearRegression(X, y, pred); err != nil {
        panic(err)
    }
}
```

### Junior → FAANG: Choosing the Right Go ML Library

The Go ML ecosystem is smaller than Python's, and that is actually good news for a junior who wants to build working knowledge quickly. Instead of navigating hundreds of libraries, you need depth in a few: Gonum for numerical computing and matrix operations, GoLearn for classical ML algorithms, and Gorgonia for neural network experimentation. Start with Gonum because it is the foundation that other libraries build on, and because matrix operations are directly relevant to understanding embedding arithmetic in LLM and vector database work.

For FAANG interviews, the library you know matters less than your ability to explain what the library is doing and why. If you implement k-nearest neighbors using Gonum's matrix package, you should be able to explain the time complexity of naive versus indexed KNN, why cosine similarity is preferred over Euclidean distance for high-dimensional embedding spaces, and what a production KNN service looks like at scale (hint: it uses approximate nearest neighbor algorithms, not exact search). That depth of understanding is more valuable than knowing every API in the library.

A practical exercise: load the Iris dataset in Go using Gonum, split it into train/test sets, train a k-nearest neighbors classifier, evaluate precision and recall per class, and plot a confusion matrix. Time yourself: if it takes more than two hours from scratch, spend more time with Gonum's documentation and examples. Being fluent with the library means you can prototype ML ideas quickly, which is a real-world expectation on ML infrastructure teams.

### Senior @ FAANG: Library Evaluation and Dependency Governance

Senior engineers evaluate ML libraries against production criteria that go beyond feature completeness. License compatibility (is it Apache 2.0 or GPL?), maintenance activity (when was the last release?), test coverage, API stability guarantees, and the library's own dependency footprint all factor into the decision. A library that pulls in CGo dependencies complicates cross-compilation and container image builds: document this in the ADR if you choose such a library.

The decision to use Gorgonia for production neural network inference rather than calling a gRPC inference server deserves explicit justification. Gorgonia is well-suited for small models where the operational simplicity of a single binary outweighs the performance benefits of a specialized inference runtime. For models larger than a few hundred megabytes, or for models that require GPU acceleration, the gRPC approach with Triton Inference Server or TorchServe is almost always the better architectural choice. Write this tradeoff down.

Library versioning governance is a staff concern. In a large engineering organization, multiple teams may take different versions of the same ML library as a transitive dependency, leading to diamond dependency conflicts and inconsistent behavior. The solution is to define an approved version list for core ML libraries, managed by the platform team, with a clear upgrade process that includes testing and deprecation notices. This is analogous to how large organizations manage database driver versions.

At L6 and above, you are also responsible for evaluating when Go's ML library ecosystem is insufficient and a different serving strategy is needed. For example, transformer-based LLM inference is not realistically done in pure Go today: the ecosystem lacks the optimized CUDA kernels and memory management that Python/PyTorch or C++/ONNX Runtime provide. Recognizing these boundaries and designing hybrid architectures appropriately is a key staff-level skill, and communicating those boundaries clearly to research teams avoids months of wasted engineering effort.

Observability tooling for ML libraries is an area where seniors should contribute rather than just consume. Wrapping library calls with structured logging, histogram metrics for inference latency, and counter metrics for error types creates a diagnostics layer that the entire team benefits from. This instrumentation should be part of the initial library integration, not added after the first production incident. At FAANG scale, the difference between a 5-minute and a 2-hour incident response often comes down to whether the right metrics existed before the incident occurred.
