## 113.5 Working with Tensors in Gorgonia

Tensors are multi-dimensional arrays, the fundamental data structure in deep learning.

```
Scalar (0D):     5
Vector (1D):     [1, 2, 3, 4]
Matrix (2D):     [[1, 2],
                  [3, 4]]
Tensor (3D):     [[[1, 2], [3, 4]],
                  [[5, 6], [7, 8]]]

Image: 3D tensor (height, width, channels)
Batch of images: 4D tensor (batch, height, width, channels)
```

### Gorgonia Tensor Basics

Gorgonia provides a computation graph abstraction for tensor operations in Go, which is what makes automatic differentiation possible: the graph records the operations, so the gradients can be derived from it. CUDA support exists behind a build tag, but treat it as experimental rather than as a reason to choose Gorgonia. The following example demonstrates basic tensor creation, arithmetic operations, and the graph execution model that underpins more complex model definitions.

```go
package main

import (
    "fmt"
    "log"

    "gorgonia.org/gorgonia"
    "gorgonia.org/tensor"
)

func main() {
    // Create computation graph
    g := gorgonia.NewGraph()

    // Create 2x3 matrix tensor
    matData := []float64{1, 2, 3, 4, 5, 6}
    mat := gorgonia.NewMatrix(g,
        tensor.Float64,
        gorgonia.WithShape(2, 3),
        gorgonia.WithName("matrix"),
        gorgonia.WithValue(tensor.New(
            tensor.WithShape(2, 3),
            tensor.WithBacking(matData),
        )),
    )

    // Create vector
    vecData := []float64{1, 1, 1}
    vec := gorgonia.NewVector(g,
        tensor.Float64,
        gorgonia.WithShape(3),
        gorgonia.WithName("vector"),
        gorgonia.WithValue(tensor.New(
            tensor.WithShape(3),
            tensor.WithBacking(vecData),
        )),
    )

    // Matrix-vector multiplication
    // [[1, 2, 3],   [1]   [6]
    //  [4, 5, 6]] × [1] = [15]
    //               [1]
    result := gorgonia.Must(gorgonia.Mul(mat, vec))

    // Create VM and run
    vm := gorgonia.NewTapeMachine(g)
    defer vm.Close()

    if err := vm.RunAll(); err != nil {
        log.Fatal(err)
    }

    fmt.Printf("Matrix:\n%v\n\n", mat.Value())
    fmt.Printf("Vector:\n%v\n\n", vec.Value())
    fmt.Printf("Result:\n%v\n", result.Value())
}
```

### Building a Simple Neural Network with Gorgonia

A neural network is function composition: `output = f3(f2(f1(input)))`

```
Input Layer    Hidden Layer    Output Layer
    x1 ────┬──► h1 ────┬──► y
    x2 ────┼──► h2 ────┤
    x3 ────┘    h3 ────┘

Each arrow has a weight
Each node has activation function
```

```go
package ml

import (
    "fmt"
    "math"
    "math/rand/v2"

    "gorgonia.org/gorgonia"
    "gorgonia.org/tensor"
)

// NeuralNetwork using Gorgonia
type NeuralNetwork struct {
    g      *gorgonia.ExprGraph
    x      *gorgonia.Node // input
    y      *gorgonia.Node // true labels
    pred   *gorgonia.Node // predictions
    loss   *gorgonia.Node // loss function

    // Learnable parameters
    w1, b1 *gorgonia.Node // first layer
    w2, b2 *gorgonia.Node // second layer
}

// NewNeuralNetwork creates a 2-layer neural network
// batchSize:  number of samples per forward pass
// inputSize:  number of input features
// hiddenSize: number of hidden units
// outputSize: number of output classes
//
// Gorgonia builds a static graph and resolves every shape at construction
// time, so batchSize is baked into the graph and cannot be -1 or otherwise
// left open the way it can in a define-by-run framework. Feeding a batch of a
// different size means building a second graph. This constraint is the main
// reason Gorgonia models are usually served at a fixed batch size.
func NewNeuralNetwork(batchSize, inputSize, hiddenSize, outputSize int) *NeuralNetwork {
    g := gorgonia.NewGraph()

    nn := &NeuralNetwork{g: g}

    // Input placeholders
    nn.x = gorgonia.NewMatrix(g, tensor.Float64,
        gorgonia.WithShape(batchSize, inputSize),
        gorgonia.WithName("x"))

    nn.y = gorgonia.NewMatrix(g, tensor.Float64,
        gorgonia.WithShape(batchSize, outputSize),
        gorgonia.WithName("y"))

    // Initialize weights. See randomMatrix: this is a fan-in scaled uniform
    // draw, which is LeCun-style rather than true Xavier/Glorot.
    w1Val := randomMatrix(inputSize, hiddenSize, float64(inputSize))
    nn.w1 = gorgonia.NewMatrix(g, tensor.Float64,
        gorgonia.WithShape(inputSize, hiddenSize),
        gorgonia.WithName("w1"),
        gorgonia.WithValue(w1Val))

    nn.b1 = gorgonia.NewMatrix(g, tensor.Float64,
        gorgonia.WithShape(1, hiddenSize),
        gorgonia.WithName("b1"),
        gorgonia.WithValue(zeroMatrix(1, hiddenSize)))

    w2Val := randomMatrix(hiddenSize, outputSize, float64(hiddenSize))
    nn.w2 = gorgonia.NewMatrix(g, tensor.Float64,
        gorgonia.WithShape(hiddenSize, outputSize),
        gorgonia.WithName("w2"),
        gorgonia.WithValue(w2Val))

    nn.b2 = gorgonia.NewMatrix(g, tensor.Float64,
        gorgonia.WithShape(1, outputSize),
        gorgonia.WithName("b2"),
        gorgonia.WithValue(zeroMatrix(1, outputSize)))

    // Build forward pass
    nn.buildForward()

    return nn
}

// buildForward constructs the forward pass computation graph
func (nn *NeuralNetwork) buildForward() {
    // Layer 1: h = ReLU(x * w1 + b1)
    l1 := gorgonia.Must(gorgonia.Mul(nn.x, nn.w1))
    l1 = gorgonia.Must(gorgonia.BroadcastAdd(l1, nn.b1, nil, []byte{0}))
    h := gorgonia.Must(gorgonia.Rectify(l1)) // ReLU activation

    // Layer 2: output = x * w2 + b2
    l2 := gorgonia.Must(gorgonia.Mul(h, nn.w2))
    output := gorgonia.Must(gorgonia.BroadcastAdd(l2, nn.b2, nil, []byte{0}))

    // Softmax for probabilities (classification)
    nn.pred = gorgonia.Must(gorgonia.SoftMax(output))

    // Cross-entropy loss.
    //
    // The elementwise product here must be HadamardProd, not Mul. Gorgonia's
    // Mul is overloaded on rank: given two matrices it performs matrix
    // multiplication, so Mul(y, Log(pred)) with both shaped (batch, classes)
    // is a shape error rather than the per-element masking that cross-entropy
    // requires. This is the single easiest mistake to make in Gorgonia.
    //
    // Note also that Mean averages over every element, so with one-hot labels
    // the result is divided by batch*classes rather than batch. That scales
    // the loss (and its gradient) by 1/classes, which is absorbed into the
    // learning rate here but is worth knowing when you compare loss curves
    // against another framework.
    logPred := gorgonia.Must(gorgonia.Log(nn.pred))
    nn.loss = gorgonia.Must(gorgonia.Neg(
        gorgonia.Must(gorgonia.Mean(
            gorgonia.Must(gorgonia.HadamardProd(nn.y, logPred))))))
}

// Train trains the neural network
func (nn *NeuralNetwork) Train(X, y tensor.Tensor, epochs int, learningRate float64) error {
    // Create solver for gradient descent
    solver := gorgonia.NewVanillaSolver(gorgonia.WithLearnRate(learningRate))

    // Create VM
    vm := gorgonia.NewTapeMachine(nn.g, gorgonia.BindDualValues(nn.w1, nn.b1, nn.w2, nn.b2))
    defer vm.Close()

    for epoch := 0; epoch < epochs; epoch++ {
        // Set inputs
        gorgonia.Let(nn.x, X)
        gorgonia.Let(nn.y, y)

        // Forward + backward pass
        if err := vm.RunAll(); err != nil {
            return fmt.Errorf("epoch %d: %v", epoch, err)
        }

        // Update weights
        if err := solver.Step(gorgonia.NodesToValueGrads(nn.w1, nn.b1, nn.w2, nn.b2)); err != nil {
            return fmt.Errorf("epoch %d solver step: %v", epoch, err)
        }

        // Print loss
        if epoch%10 == 0 {
            fmt.Printf("Epoch %d, Loss: %.4f\n", epoch, nn.loss.Value())
        }

        // Reset for next iteration
        vm.Reset()
    }

    return nil
}

// Predict makes predictions on new data.
//
// nn.g is the training graph, and it contains the loss node, which depends on
// nn.y. Running the whole graph therefore evaluates the loss too and fails if
// y is unbound. Binding a zero label tensor keeps this honest and cheap for a
// teaching example. For a real serving path, build a separate inference graph
// that terminates at pred, or pass gorgonia.WithPrecomputed / use a Lisp
// machine limited to the nodes you need: you do not want to pay for loss
// evaluation on every request.
func (nn *NeuralNetwork) Predict(X tensor.Tensor, batchSize, outputSize int) (tensor.Tensor, error) {
    if err := gorgonia.Let(nn.x, X); err != nil {
        return nil, err
    }
    if err := gorgonia.Let(nn.y, zeroMatrix(batchSize, outputSize)); err != nil {
        return nil, err
    }

    vm := gorgonia.NewTapeMachine(nn.g)
    defer vm.Close()

    if err := vm.RunAll(); err != nil {
        return nil, err
    }

    return nn.pred.Value().(tensor.Tensor), nil
}

// Helper functions

// randomMatrix draws weights from U(-1, 1) scaled by 1/sqrt(fan_in).
//
// This is a fan-in scaled uniform initialization, in the LeCun family. It is
// not Xavier/Glorot, which scales by fan_in + fan_out, and it is not He
// initialization, which uses a variance of 2/fan_in and is the better default
// for the ReLU layers this network actually uses. The distinction matters for
// deep networks, where the wrong scale makes activations vanish or explode
// layer by layer. At two layers you will not notice.
func randomMatrix(rows, cols int, fanIn float64) tensor.Tensor {
    data := make([]float64, rows*cols)
    for i := range data {
        data[i] = (rand.Float64()*2 - 1) / math.Sqrt(fanIn)
    }
    return tensor.New(tensor.WithShape(rows, cols), tensor.WithBacking(data))
}

func zeroMatrix(rows, cols int) tensor.Tensor {
    data := make([]float64, rows*cols)
    return tensor.New(tensor.WithShape(rows, cols), tensor.WithBacking(data))
}
```

### Junior → FAANG: Tensors as the Language of Embeddings

Understanding tensors is not just about neural networks in Gorgonia: it is about understanding the data structure that underlies every embedding-based system you will build in Go. An embedding is a tensor, a vector database stores tensors, semantic similarity search computes dot products between tensors, and LLM APIs return tensors that you need to store and query efficiently. Internalizing tensor shapes and operations is therefore a prerequisite for the vector database and LLM chapters that follow.

The most important tensor operations for backend ML engineers are matrix multiplication (for computing similarity between embedding matrices), broadcasting (for applying the same operation across a batch of vectors), and slicing (for extracting embeddings for specific items from a larger matrix). Practice these with Gonum's matrix package before Gorgonia because Gonum's API is closer to what you will use in production serving code.

For interviews, be prepared to explain why embedding dimensionality affects both storage cost and retrieval latency. Work an example: 1536 dimensions is a common output width across several widely used embedding models, and at float32 that is 1536 x 4 = 6 kilobytes per vector. A million vectors is therefore roughly 6 gigabytes of RAM, before any index overhead. Finding the top-10 nearest neighbors by brute-force cosine similarity over that set costs about 1.5 billion multiply-accumulate operations per query. These numbers tell you that production semantic search requires approximate nearest neighbor indexing, and knowing that chain of reasoning demonstrates the kind of quantitative thinking FAANG interviewers look for.

### Senior @ FAANG: Tensor Infrastructure and Memory Management

At production scale, tensor memory management is a significant operational concern. Embedding matrices for large document collections can occupy hundreds of gigabytes. Senior engineers design the memory layout of these matrices carefully: whether to store them in row-major or column-major order (which affects cache performance during batch similarity computation), whether to use float32 or float16 (which halves memory at the cost of some precision), and whether to load the entire matrix into memory or use memory-mapped files that the OS pages in on demand.

Batch inference is the primary lever for improving throughput in tensor-heavy serving systems. Instead of processing one inference request at a time, a Go server accumulates requests for a short window (typically 5 to 50 milliseconds) and processes them as a single batched tensor operation. The batch dimension becomes the first dimension of the tensor, and the operation is computed over the entire batch in a single pass. This improves hardware utilization dramatically because modern CPUs and GPUs are highly optimized for large matrix multiplications. The ADR for a tensor serving system should define the maximum batch size and the batching window duration based on latency and throughput requirements.

Numerical precision is a correctness concern that seniors track explicitly. Float32 tensor operations can accumulate significant rounding errors in deep networks, leading to NaN or Inf values propagating through the computation graph. In production, add explicit NaN checks after each major tensor operation, define what the system does when it encounters NaN in a feature vector (substitute with the training mean, reject the request, alert the on-call), and monitor the rate of NaN occurrences as a production health metric.

At L6, tensor infrastructure decisions intersect with hardware procurement and capacity planning. The choice between CPU-optimized inference (SIMD-accelerated matrix operations on modern CPUs) and GPU inference affects server fleet composition, cost structure, and the engineering complexity of the serving stack. A well-designed ADR for this decision includes benchmark results at representative batch sizes, cost-per-inference estimates for each hardware option, and a roadmap for migrating between hardware options without serving downtime. Staff engineers who have done this analysis once can reuse the framework across multiple model serving decisions.

The Gorgonia computation graph model is also worth understanding for its architectural lessons even if you do not use Gorgonia in production. Deferred computation (building the graph before executing it) is a pattern that enables automatic differentiation and graph-level optimizations like operation fusion and constant folding. Understanding this pattern helps you reason about why frameworks like TensorFlow and JAX make the design choices they do, which is relevant context when your team evaluates inference framework options.
