## 114.6 Model Serving in Go

### Model Serving Architecture

The model serving system layers a versioned model cache on top of model loaders for different formats (ONNX, TensorFlow, custom Go models), then exposes the unified prediction service through HTTP/JSON, gRPC, and GraphQL APIs. The LRU cache holds warm model sessions in memory so prediction latency is not dominated by model load time on every request.

```
┌──────────────────────────────────────────────────────────────────┐
│                      Model Serving System                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────┐          ┌────────────────────┐          │
│  │  Model Loader      │          │  Model Cache       │          │
│  │  • Load ONNX       │─────────►│  • LRU cache       │          │
│  │  • Load TF         │          │  • Warm-up         │          │
│  │  • Validation      │          │  • Version mgmt    │          │
│  └────────────────────┘          └─────────┬──────────┘          │
│                                             │                    │
│                                             ▼                    │
│  ┌─────────────────────────────────────────────────────┐         │
│  │              Prediction Service                     │         │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────┐   │         │
│  │  │ Real-time    │  │   Batch      │  │ Streaming│   │         │
│  │  │ Inference    │  │  Inference   │  │ Inference│   │         │
│  │  └──────────────┘  └──────────────┘  └──────────┘   │         │
│  └─────────────────────────────────────────────────────┘         │
│                            │                                     │
│                            ▼                                     │
│  ┌─────────────────────────────────────────────────────┐         │
│  │              API Layer                              │         │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────┐   │         │
│  │  │ HTTP/JSON    │  │   gRPC       │  │ GraphQL  │   │         │
│  │  └──────────────┘  └──────────────┘  └──────────┘   │         │
│  └─────────────────────────────────────────────────────┘         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### ONNX Model Serving

ONNX Runtime exposes a C API, and `github.com/yalue/onnxruntime_go` wraps it with CGo. Two consequences follow immediately and shape everything below. First, the runtime is a process-global resource: you call `SetSharedLibraryPath` and `InitializeEnvironment` exactly once per process, not per model. Second, every tensor and session wraps a C handle that Go's garbage collector knows nothing about, so each one needs an explicit `Destroy`. The tensor's numeric data is an ordinary Go slice, but the `OrtValue` behind it is not, and leaking those shows up as native memory growth rather than Go heap growth. That is exactly what makes the leak hard to find: your heap profile looks clean while RSS climbs.

The API is worth reading carefully rather than guessing at, because the shapes are unusual. Input and output names are fixed when the session is constructed, not discovered from the session afterwards: to learn a model's names you call the package-level `GetInputOutputInfo(path)` before building the session. And `DynamicAdvancedSession.Run(inputs, outputs []Value) error` returns an error rather than the outputs, filling the output slice in place. Passing a nil output element makes the library allocate that Value for you, which you then own and must `Destroy`.

```go
// pkg/serving/onnx.go
package serving

import (
    "context"
    "fmt"
    "sync"

    ort "github.com/yalue/onnxruntime_go"
)

// ONNXModel wraps a loaded ONNX model and the names its session was built with.
type ONNXModel struct {
    session     *ort.DynamicAdvancedSession
    inputNames  []string
    outputNames []string
    inputShapes map[string]ort.Shape
}

// ONNXModelServer serves ONNX models.
type ONNXModelServer struct {
    models map[string]*ONNXModel
    mu     sync.RWMutex
}

// NewONNXModelServer initializes the ONNX Runtime environment.
//
// The environment is global and initialized once per process. Returning an
// error rather than panicking matters here: the shared library path is
// deployment configuration, and a missing libonnxruntime.so is a
// misconfiguration your process should report and exit on, not a panic
// unwinding through an init path.
func NewONNXModelServer(sharedLibPath string) (*ONNXModelServer, error) {
    ort.SetSharedLibraryPath(sharedLibPath)
    if err := ort.InitializeEnvironment(); err != nil {
        return nil, fmt.Errorf("initialize ONNX runtime: %w", err)
    }

    return &ONNXModelServer{
        models: make(map[string]*ONNXModel),
    }, nil
}

// LoadModel loads an ONNX model.
func (s *ONNXModelServer) LoadModel(ctx context.Context, modelName, modelPath string) error {
    // Names come from the model file, not from the session: a session must be
    // told its input and output names at construction time.
    inputInfo, outputInfo, err := ort.GetInputOutputInfo(modelPath)
    if err != nil {
        return fmt.Errorf("read model io info for %s: %w", modelPath, err)
    }

    inputNames := make([]string, len(inputInfo))
    inputShapes := make(map[string]ort.Shape, len(inputInfo))
    for i, info := range inputInfo {
        inputNames[i] = info.Name
        inputShapes[info.Name] = info.Dimensions
    }

    outputNames := make([]string, len(outputInfo))
    for i, info := range outputInfo {
        outputNames[i] = info.Name
    }

    session, err := ort.NewDynamicAdvancedSession(modelPath, inputNames, outputNames, nil)
    if err != nil {
        return fmt.Errorf("create ONNX session: %w", err)
    }

    model := &ONNXModel{
        session:     session,
        inputNames:  inputNames,
        outputNames: outputNames,
        inputShapes: inputShapes,
    }

    s.mu.Lock()
    defer s.mu.Unlock()

    // Destroy any session this replaces, or the C memory leaks silently.
    if old, exists := s.models[modelName]; exists {
        old.session.Destroy()
    }
    s.models[modelName] = model

    return nil
}

// Predict runs inference on the model.
func (s *ONNXModelServer) Predict(ctx context.Context, modelName string,
    inputs map[string][]float32) (map[string][]float32, error) {

    s.mu.RLock()
    model, exists := s.models[modelName]
    s.mu.RUnlock()

    if !exists {
        return nil, fmt.Errorf("model %s not found", modelName)
    }

    // Build inputs in the exact order the session was given its names.
    inputValues := make([]ort.Value, len(model.inputNames))
    defer func() {
        for _, v := range inputValues {
            if v != nil {
                v.Destroy()
            }
        }
    }()

    for i, name := range model.inputNames {
        data, ok := inputs[name]
        if !ok {
            return nil, fmt.Errorf("missing input: %s", name)
        }

        // Use the model's declared shape, substituting the real batch size for
        // any dynamic (negative) dimension. Assuming a flat 1-D shape here is
        // the classic way to feed a model that wants (batch, features) and get
        // back a shape error at runtime, or worse, a silently wrong answer.
        shape, err := resolveShape(model.inputShapes[name], len(data))
        if err != nil {
            return nil, fmt.Errorf("input %s: %w", name, err)
        }

        tensor, err := ort.NewTensor(shape, data)
        if err != nil {
            return nil, fmt.Errorf("create tensor for %s: %w", name, err)
        }
        inputValues[i] = tensor
    }

    // Passing nil outputs asks the library to allocate them. They are C
    // memory and belong to us the moment Run returns.
    outputValues := make([]ort.Value, len(model.outputNames))
    if err := model.session.Run(inputValues, outputValues); err != nil {
        return nil, fmt.Errorf("inference failed: %w", err)
    }
    defer func() {
        for _, v := range outputValues {
            if v != nil {
                v.Destroy()
            }
        }
    }()

    outputs := make(map[string][]float32, len(model.outputNames))
    for i, name := range model.outputNames {
        tensor, ok := outputValues[i].(*ort.Tensor[float32])
        if !ok {
            return nil, fmt.Errorf("output %s is not a float32 tensor", name)
        }

        // GetData returns the Go slice backing the tensor. It is ordinary
        // garbage-collected memory, so this is not a use-after-free risk, but
        // copy it anyway for two concrete reasons: Destroy nils the tensor's
        // data field, so GetData must be called before the deferred Destroy
        // runs, and the returned slice aliases the tensor's buffer, which
        // would be overwritten underneath the caller if the tensor were ever
        // pooled and reused across requests. Copying decouples the caller's
        // result from this tensor's lifetime.
        src := tensor.GetData()
        dst := make([]float32, len(src))
        copy(dst, src)
        outputs[name] = dst
    }

    return outputs, nil
}

// resolveShape substitutes the actual element count for a dynamic dimension.
func resolveShape(declared ort.Shape, elems int) (ort.Shape, error) {
    if len(declared) == 0 {
        return ort.NewShape(int64(elems)), nil
    }

    dims := make([]int64, len(declared))
    copy(dims, declared)

    // A negative dimension is ONNX's way of saying "dynamic", almost always
    // the batch axis.
    known := int64(1)
    dynamic := -1
    for i, d := range dims {
        if d < 0 {
            dynamic = i
            continue
        }
        known *= d
    }

    if dynamic == -1 {
        if known != int64(elems) {
            return nil, fmt.Errorf("model wants %d elements, got %d", known, elems)
        }
        return ort.NewShape(dims...), nil
    }

    if known == 0 || int64(elems)%known != 0 {
        return nil, fmt.Errorf("%d elements do not divide into shape %v", elems, dims)
    }
    dims[dynamic] = int64(elems) / known

    return ort.NewShape(dims...), nil
}

// UnloadModel unloads a model.
func (s *ONNXModelServer) UnloadModel(modelName string) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    model, exists := s.models[modelName]
    if !exists {
        return fmt.Errorf("model %s not found", modelName)
    }

    delete(s.models, modelName)
    return model.session.Destroy()
}

// Close cleans up resources.
func (s *ONNXModelServer) Close() error {
    s.mu.Lock()
    defer s.mu.Unlock()

    for name, model := range s.models {
        if err := model.session.Destroy(); err != nil {
            return fmt.Errorf("destroy session %s: %w", name, err)
        }
        delete(s.models, name)
    }

    return ort.DestroyEnvironment()
}
```

A note on concurrency, because the locking above is easy to misread. The `sync.RWMutex` guards the *map*, not the session. ONNX Runtime sessions are safe for concurrent `Run` calls, which is what allows this server to hold only a read lock on the map and let many requests run inference at once. Do not "fix" this by adding a per-model mutex around `Run`: you would serialize every inference request through one lock and throw away most of your throughput to prevent a problem that does not exist.

The real hazard is `UnloadModel` racing an in-flight `Predict`. `Predict` releases the map lock before it runs inference, so an unload can destroy the session underneath it, and a use-after-free in C does not produce a Go panic you can recover from. Production code refcounts the model, or defers `Destroy` until in-flight requests drain, exactly as the hot-swap path elsewhere in this chapter does.

### gRPC Model Serving

gRPC uses Protocol Buffers for strongly typed, binary-encoded communication between services, providing lower latency and smaller payloads than JSON-based REST. The following code shows Go server and client implementation patterns including interceptors for cross-cutting concerns.

```protobuf
// api/prediction.proto
syntax = "proto3";

package prediction;

option go_package = "yourmodule/api/prediction";

service PredictionService {
    rpc Predict(PredictRequest) returns (PredictResponse);
    rpc BatchPredict(BatchPredictRequest) returns (BatchPredictResponse);
    rpc GetModelMetadata(ModelMetadataRequest) returns (ModelMetadataResponse);
}

message PredictRequest {
    string model_name = 1;
    string model_version = 2;
    map<string, TensorProto> inputs = 3;
}

message PredictResponse {
    map<string, TensorProto> outputs = 1;
    double latency_ms = 2;
}

// A map field cannot carry a label, so `repeated map<...>` is not valid
// protobuf: protoc rejects it with "Field labels (required/optional/repeated)
// are not allowed on map fields". To get a list of maps, wrap the map in its
// own message and repeat that. The wrapper is not ceremony, it is the only way
// to express this, and it gives you somewhere to hang per-instance fields
// later.
message NamedTensors {
    map<string, TensorProto> tensors = 1;
}

message BatchPredictRequest {
    string model_name = 1;
    string model_version = 2;
    repeated NamedTensors inputs = 3;
}

message BatchPredictResponse {
    repeated NamedTensors outputs = 1;
    double latency_ms = 2;
}

message ModelMetadataRequest {
    string model_name = 1;
    string model_version = 2;
}

message ModelMetadataResponse {
    string model_name = 1;
    string model_version = 2;
    repeated string input_names = 3;
    repeated string output_names = 4;
    map<string, string> metadata = 5;
}

message TensorProto {
    repeated int64 shape = 1;
    DataType dtype = 2;
    bytes data = 3;
}

enum DataType {
    DT_INVALID = 0;
    DT_FLOAT = 1;
    DT_DOUBLE = 2;
    DT_INT32 = 3;
    DT_INT64 = 4;
    DT_STRING = 5;
    DT_BOOL = 6;
}
```

```go
// pkg/serving/grpc_server.go
package serving

import (
    "context"
    "encoding/binary"
    "fmt"
    "math"
    "time"

    pb "yourmodule/api/prediction"
)

// GRPCPredictionServer implements the gRPC prediction service
type GRPCPredictionServer struct {
    pb.UnimplementedPredictionServiceServer
    modelServer *ONNXModelServer
}

func NewGRPCPredictionServer(modelServer *ONNXModelServer) *GRPCPredictionServer {
    return &GRPCPredictionServer{
        modelServer: modelServer,
    }
}

// Predict handles single prediction requests
func (s *GRPCPredictionServer) Predict(ctx context.Context,
    req *pb.PredictRequest) (*pb.PredictResponse, error) {

    start := time.Now()

    // Convert proto tensors to float32 arrays
    inputs := make(map[string][]float32)
    for name, tensor := range req.Inputs {
        data, err := tensorProtoToFloat32(tensor)
        if err != nil {
            return nil, fmt.Errorf("failed to convert input %s: %w", name, err)
        }
        inputs[name] = data
    }

    // Run prediction
    outputs, err := s.modelServer.Predict(ctx, req.ModelName, inputs)
    if err != nil {
        return nil, err
    }

    // Convert outputs to proto tensors
    outputProtos := make(map[string]*pb.TensorProto)
    for name, data := range outputs {
        tensor, err := float32ToTensorProto(data)
        if err != nil {
            return nil, fmt.Errorf("failed to convert output %s: %w", name, err)
        }
        outputProtos[name] = tensor
    }

    // Seconds()*1000, not Milliseconds(). Milliseconds() truncates to an
    // integer, so every inference faster than 1ms reports 0.0 into a field
    // typed as a double. That is how a p99 latency dashboard ends up
    // confidently flat at zero.
    latencyMs := float64(time.Since(start).Nanoseconds()) / 1e6

    return &pb.PredictResponse{
        Outputs:   outputProtos,
        LatencyMs: latencyMs,
    }, nil
}

// BatchPredict handles batch prediction requests
func (s *GRPCPredictionServer) BatchPredict(ctx context.Context,
    req *pb.BatchPredictRequest) (*pb.BatchPredictResponse, error) {

    start := time.Now()

    allOutputs := make([]*pb.NamedTensors, 0, len(req.Inputs))

    for _, inputMap := range req.Inputs {
        // Convert proto tensors
        inputs := make(map[string][]float32)
        for name, tensor := range inputMap.Tensors {
            data, err := tensorProtoToFloat32(tensor)
            if err != nil {
                return nil, fmt.Errorf("failed to convert input %s: %w", name, err)
            }
            inputs[name] = data
        }

        // Run prediction
        outputs, err := s.modelServer.Predict(ctx, req.ModelName, inputs)
        if err != nil {
            return nil, err
        }

        // Convert outputs
        outputProtos := make(map[string]*pb.TensorProto)
        for name, data := range outputs {
            tensor, err := float32ToTensorProto(data)
            if err != nil {
                return nil, fmt.Errorf("failed to convert output %s: %w", name, err)
            }
            outputProtos[name] = tensor
        }

        allOutputs = append(allOutputs, &pb.NamedTensors{Tensors: outputProtos})
    }

    latencyMs := float64(time.Since(start).Nanoseconds()) / 1e6

    return &pb.BatchPredictResponse{
        Outputs:   allOutputs,
        LatencyMs: latencyMs,
    }, nil
}

// GetModelMetadata returns model metadata
func (s *GRPCPredictionServer) GetModelMetadata(ctx context.Context,
    req *pb.ModelMetadataRequest) (*pb.ModelMetadataResponse, error) {

    // This would be implemented with actual model metadata
    return &pb.ModelMetadataResponse{
        ModelName:    req.ModelName,
        ModelVersion: req.ModelVersion,
        InputNames:   []string{"input"},
        OutputNames:  []string{"output"},
        Metadata:     map[string]string{},
    }, nil
}

// Helper functions

func tensorProtoToFloat32(tensor *pb.TensorProto) ([]float32, error) {
    if tensor.Dtype != pb.DataType_DT_FLOAT {
        return nil, fmt.Errorf("unsupported data type: %v", tensor.Dtype)
    }

    data := tensor.Data

    // Reject a payload that is not a whole number of float32s. Integer
    // division would otherwise silently discard the trailing bytes and hand
    // the model a truncated feature vector, which is a wrong answer rather
    // than an error. This is untrusted input from the wire: validate it.
    if len(data)%4 != 0 {
        return nil, fmt.Errorf("tensor data length %d is not a multiple of 4", len(data))
    }

    numElements := len(data) / 4

    result := make([]float32, numElements)
    for i := 0; i < numElements; i++ {
        bits := binary.LittleEndian.Uint32(data[i*4 : (i+1)*4])
        result[i] = math.Float32frombits(bits)
    }

    return result, nil
}

func float32ToTensorProto(data []float32) (*pb.TensorProto, error) {
    bytes := make([]byte, len(data)*4)
    for i, val := range data {
        bits := math.Float32bits(val)
        binary.LittleEndian.PutUint32(bytes[i*4:(i+1)*4], bits)
    }

    return &pb.TensorProto{
        Shape: []int64{int64(len(data))},
        Dtype: pb.DataType_DT_FLOAT,
        Data:  bytes,
    }, nil
}
```

Worth naming what `BatchPredict` above actually does: it loops, calling `Predict` once per item. That amortizes one network round trip across many inputs, which is a real win, but it is not batched inference. The model still runs once per input, so you get none of the throughput that comes from letting the runtime multiply one larger matrix. True batching stacks the inputs into a single tensor along the batch axis and issues one `Run`. If the endpoint is named `BatchPredict`, someone will reasonably assume the latter, so either implement it or name it honestly.

### Junior → FAANG: Model Serving as a Reliability Engineering Challenge

Model serving is where the research world meets the production world, and it is where most ML projects fail to deliver on their promise. A model that is 95% accurate in offline evaluation but takes 500 milliseconds to serve a prediction is not suitable for a real-time product feature. A model that times out under load or returns stale predictions due to a caching bug is worse than no model at all. The serving layer is the component that makes or breaks the user experience, and it demands the same rigor as any other production service.

The first thing to internalize about model serving in Go is that inference latency has two components: feature retrieval and model computation. Feature retrieval from a remote feature store adds network latency (typically 5 to 20 milliseconds for a Redis lookup). Model computation adds CPU time (typically under 1 millisecond for a gradient-boosted tree, 5 to 50 milliseconds for a small neural network on CPU). The total latency budget must account for both, plus HTTP overhead. If your latency budget is 50 milliseconds, you cannot afford a slow feature store lookup and a large model: you must either pre-compute features, use a faster model, or accept reduced model complexity.

For interview prep, practice designing the request path for a model serving system: request arrives, feature store lookup happens concurrently with input validation, features are assembled into the input tensor, inference is called, output is post-processed and returned with model metadata. Then practice the failure path: feature store is unavailable (fall back to cached features from the last request or use default values), inference times out (return a default prediction with a degraded flag in the response), model produces NaN (return an error with structured context for the on-call engineer).

### Senior @ FAANG: Model Serving Platform Architecture

At FAANG, model serving is a platform concern shared by the infrastructure team and the model team. The infrastructure team owns the serving runtime (ONNX or gRPC inference server), the feature retrieval layer, the caching infrastructure, and the observability pipeline. The model team owns the model artifact, the feature schema, and the business logic for handling prediction errors (what default to return when inference fails). This separation requires a clear API contract at the boundary: the serving platform exposes a standard interface, and the model team provides a compliant artifact bundle.

Canary deployment for models is more complex than canary deployment for regular services because prediction quality is harder to measure in real time than request success rate. A model canary sends 1% of traffic to the challenger model and 99% to the champion. The challenge is determining whether the challenger is performing better or worse: if the ground truth (did the user convert, was this actually fraud) is available within minutes, you can compute real-time accuracy metrics. If ground truth is delayed (a loan default might take months to confirm), you must rely on proxy metrics (prediction score distribution, user behavioral signals) for the canary evaluation period.

Caching model predictions is a significant latency and cost optimization for use cases where the same input frequently recurs. A semantic search query like "what are your office hours?" might be asked thousands of times per day: caching the prediction for common query patterns can reduce average latency by 80% and LLM API costs by 70%. Designing the cache key (hash of the normalized input), the cache TTL (how long a prediction remains valid given the model version and feature freshness), and the invalidation strategy (when a new model is promoted, what predictions should be invalidated) requires careful thought about the consistency model.

At L6, model serving architecture must account for multi-model serving: a single serving cluster that hosts hundreds of models simultaneously, each with different latency requirements, memory footprints, and update frequencies. Multi-model serving requires model co-location policies (which models can share resources without interfering with each other's latency), independent scaling per model (a high-traffic model should not starve resources from a lower-traffic but more latency-sensitive model), and zero-downtime model updates that do not interrupt serving for other models on the same host. Designing and operating this at scale is one of the most complex challenges in ML infrastructure engineering.

The cold start problem in model serving deserves explicit design attention. When a new model version is loaded for the first time, the first few inference requests experience elevated latency because the model weights are being loaded from memory, CPU caches are cold, and JIT compilation (for some runtimes) has not yet occurred. A pre-warming step that runs inference against a set of representative inputs before routing live traffic to the new model version addresses this problem. Designing this pre-warming step into the deployment pipeline is a senior-level detail that separates reliable model deployments from ones that cause brief latency spikes on every rollout.
