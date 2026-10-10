## TensorRT: ML Inference Optimization

Training a neural network and deploying it for inference are fundamentally different engineering problems. Training tolerates latency, runs on large GPU clusters with ample memory, and benefits from automatic differentiation. Inference demands millisecond latency, maximum throughput, and minimal memory footprint, often on a single GPU or even an edge device. TensorRT is NVIDIA's answer to the inference problem.

TensorRT takes a trained model and produces an optimized execution engine that is typically 2-10× faster than running the same model in a training framework. For production ML serving, where GPU use costs money and latency directly affects user experience, this is not optional.

### What TensorRT Does

TensorRT applies several transformations to a model graph:

**Layer fusion**: Consecutive operations that would each launch a separate kernel get merged into one. Conv + BatchNorm + ReLU, three cuDNN calls in a framework, become a single fused kernel with no intermediate memory writes. A typical ResNet block has 10+ fusible operation pairs.

**Kernel auto-tuning**: For each layer configuration (batch size, input shape, data type), TensorRT benchmarks dozens of kernel variants on the actual target GPU and selects the fastest. The tuned engine is GPU-specific and batch-size-specific.

**Precision reduction**: TensorRT can run in FP32, FP16, or INT8. FP16 doubles throughput on tensor cores. INT8 quadruples throughput with minimal accuracy loss when properly calibrated.

**Memory optimization**: TensorRT reuses tensor memory across layers that don't overlap in execution time, reducing peak GPU memory usage.

### TensorRT Workflow

The TensorRT workflow is a two-phase process: a one-time build phase parses the ONNX model, runs auto-tuning to select the fastest kernel implementations for the target GPU, and serializes the optimized engine to disk. The runtime phase deserializes the engine and runs inference in microseconds, without ever running the slow build phase again, making engine serialization essential for production deployments where restart latency matters.
```
                     ┌─────────────────┐
  PyTorch Model  ──► │  ONNX Export    │ ──► model.onnx
                     └─────────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ TensorRT Build  │  (1-10 minutes, done once)
                     │ - Parse ONNX    │
                     │ - Optimize      │
                     │ - Auto-tune     │
                     └─────────────────┘
                              │
                              ▼
                         engine.trt  (GPU-specific, serialized)
                              │
                              ▼
                     ┌─────────────────┐
                     │  Load & Run     │  (microseconds per inference)
                     │ deserialize →   │
                     │ allocate I/O →  │
                     │ executeV2 →     │
                     └─────────────────┘
```

### Building a TensorRT Engine from ONNX

TensorRT's C++ API starts with a `TRTLogger` that receives diagnostic messages, then chains `createInferBuilder` → `createNetworkV2` → `createOnnxParser` to load the ONNX model into TensorRT's internal representation. Setting `BuilderFlag::kFP16` or `kINT8` on the builder config enables mixed-precision quantization, which typically doubles throughput on Tensor Core-equipped GPUs at the cost of slightly reduced model accuracy.
```cpp
#include <NvInfer.h>
#include <NvOnnxParser.h>
#include <cuda_runtime.h>
#include <fstream>
#include <memory>
#include <vector>
#include <cstring>

// TensorRT logger, required by the API
class TRTLogger : public nvinfer1::ILogger {
    void log(Severity severity, const char* msg) noexcept override {
        if (severity <= Severity::kWARNING)
            printf("[TRT] %s\n", msg);
    }
} gLogger;

// RAII wrapper for TensorRT objects (they use raw pointer ownership)
template <typename T>
struct TRTDeleter {
    void operator()(T* obj) const { delete obj; }
};
template <typename T>
using TRTUniquePtr = std::unique_ptr<T, TRTDeleter<T>>;

// Build an optimized engine from an ONNX model file
std::vector<uint8_t> build_engine_from_onnx(const char* onnx_path,
                                              bool use_fp16,
                                              int max_batch_size) {
    TRTUniquePtr<nvinfer1::IBuilder> builder{
        nvinfer1::createInferBuilder(gLogger)};
    TRTUniquePtr<nvinfer1::INetworkDefinition> network{
        builder->createNetworkV2(
            1U << static_cast<uint32_t>(
                nvinfer1::NetworkDefinitionCreationFlag::kEXPLICIT_BATCH))};
    TRTUniquePtr<nvinfer1::IBuilderConfig> config{
        builder->createBuilderConfig()};
    TRTUniquePtr<nvonnxparser::IParser> parser{
        nvonnxparser::createParser(*network, gLogger)};

    // Parse ONNX file
    if (!parser->parseFromFile(onnx_path,
            static_cast<int>(nvinfer1::ILogger::Severity::kWARNING))) {
        throw std::runtime_error("Failed to parse ONNX model");
    }

    // Configure optimization
    config->setMaxWorkspaceSize(1ULL << 30);  // 1GB workspace for auto-tuning

    if (use_fp16 && builder->platformHasFastFp16()) {
        config->setFlag(nvinfer1::BuilderFlag::kFP16);
        printf("FP16 precision enabled\n");
    }

    // Dynamic shape profile (allows variable batch sizes at runtime)
    auto profile = builder->createOptimizationProfile();
    // Input name must match the ONNX graph's input tensor name
    profile->setDimensions("input",
        nvinfer1::OptProfileSelector::kMIN, nvinfer1::Dims4{1, 3, 224, 224});
    profile->setDimensions("input",
        nvinfer1::OptProfileSelector::kOPT, nvinfer1::Dims4{8, 3, 224, 224});
    profile->setDimensions("input",
        nvinfer1::OptProfileSelector::kMAX, nvinfer1::Dims4{max_batch_size, 3, 224, 224});
    config->addOptimizationProfile(profile);

    // Build engine (this is the slow, one-time step)
    TRTUniquePtr<nvinfer1::IHostMemory> serialized{
        builder->buildSerializedNetwork(*network, *config)};
    if (!serialized) throw std::runtime_error("Engine build failed");

    // Return serialized engine bytes
    const uint8_t* data = static_cast<const uint8_t*>(serialized->data());
    return std::vector<uint8_t>(data, data + serialized->size());
}

// Save engine to disk
void save_engine(const std::vector<uint8_t>& engine_data, const char* path) {
    std::ofstream file(path, std::ios::binary);
    file.write(reinterpret_cast<const char*>(engine_data.data()),
               engine_data.size());
}
```

### Running Inference with a Serialized Engine

Serialization converts in-memory objects into a byte representation suitable for storage or transmission, and deserialization reconstructs the original object graph from that representation. The choice of format involves trade-offs between schema evolution, human readability, encoding size, and parse performance.
```cpp
struct TRTInferenceEngine {
    TRTUniquePtr<nvinfer1::IRuntime> runtime;
    TRTUniquePtr<nvinfer1::ICudaEngine> engine;
    TRTUniquePtr<nvinfer1::IExecutionContext> context;
    cudaStream_t stream;

    // Device buffers, one per I/O tensor
    std::vector<void*> bindings;
    std::vector<size_t> binding_sizes;

    explicit TRTInferenceEngine(const char* engine_path) {
        // Load serialized engine
        std::ifstream file(engine_path, std::ios::binary | std::ios::ate);
        size_t size = file.tellg();
        file.seekg(0);
        std::vector<char> data(size);
        file.read(data.data(), size);

        runtime.reset(nvinfer1::createInferRuntime(gLogger));
        engine.reset(runtime->deserializeCudaEngine(data.data(), size));
        context.reset(engine->createExecutionContext());

        cudaStreamCreate(&stream);

        // Allocate device buffers for all I/O tensors
        int num_bindings = engine->getNbIOTensors();
        bindings.resize(num_bindings);
        binding_sizes.resize(num_bindings);

        for (int i = 0; i < num_bindings; ++i) {
            const char* name = engine->getIOTensorName(i);
            nvinfer1::Dims dims = engine->getTensorShape(name);
            nvinfer1::DataType dtype = engine->getTensorDataType(name);

            size_t elem_size = (dtype == nvinfer1::DataType::kFLOAT) ? 4 : 2;
            size_t count = 1;
            for (int d = 0; d < dims.nbDims; ++d) count *= dims.d[d];

            binding_sizes[i] = count * elem_size;
            cudaMalloc(&bindings[i], binding_sizes[i]);

            // Tell the context where the tensors live
            context->setTensorAddress(name, bindings[i]);
        }
    }

    // Run inference for one batch (input already in bindings[0])
    void infer(const float* h_input, float* h_output,
               size_t input_bytes, size_t output_bytes) {
        // H2D
        cudaMemcpyAsync(bindings[0], h_input, input_bytes,
                        cudaMemcpyHostToDevice, stream);

        // Execute
        context->enqueueV3(stream);

        // D2H
        cudaMemcpyAsync(h_output, bindings[1], output_bytes,
                        cudaMemcpyDeviceToHost, stream);

        cudaStreamSynchronize(stream);
    }

    ~TRTInferenceEngine() {
        for (void* ptr : bindings) cudaFree(ptr);
        cudaStreamDestroy(stream);
    }
};
```

### INT8 Calibration

INT8 inference requires **calibration**: feeding representative input data through the network, measuring the range of activations at each layer, and choosing scale factors that map FP32 ranges to the INT8 range [-127, 127].

```cpp
#include <NvInferRuntime.h>
#include <cassert>

class ResNetCalibrator : public nvinfer1::IInt8EntropyCalibrator2 {
    int batch_size_;
    int current_batch_ = 0;
    std::vector<std::string> image_paths_;  // 500-1000 representative images

    float* d_input_batch = nullptr;  // Device buffer for calibration batch
    std::string cache_file_ = "resnet50_int8.cache";

public:
    ResNetCalibrator(int batch_size, std::vector<std::string> images)
        : batch_size_(batch_size), image_paths_(std::move(images)) {
        cudaMalloc(&d_input_batch,
                   batch_size_ * 3 * 224 * 224 * sizeof(float));
    }

    int getBatchSize() const noexcept override { return batch_size_; }

    // Called repeatedly until returns false, load the next calibration batch
    bool getBatch(void* bindings[], const char* names[],
                  int nbBindings) noexcept override {
        if (current_batch_ * batch_size_ >= (int)image_paths_.size())
            return false;

        // Load images into d_input_batch (preprocessing: resize, normalize)
        // ... load_and_preprocess_images(image_paths_, current_batch_, d_input_batch) ...

        bindings[0] = d_input_batch;
        current_batch_++;
        return true;
    }

    // Cache the calibration table, reuse without re-calibrating
    const void* readCalibrationCache(size_t& length) noexcept override {
        // Try to load cached calibration data
        static std::vector<char> cache_data;
        std::ifstream f(cache_file_, std::ios::binary);
        if (!f) { length = 0; return nullptr; }
        cache_data = std::vector<char>(std::istreambuf_iterator<char>(f), {});
        length = cache_data.size();
        return cache_data.data();
    }

    void writeCalibrationCache(const void* cache,
                                size_t length) noexcept override {
        std::ofstream f(cache_file_, std::ios::binary);
        f.write(static_cast<const char*>(cache), length);
    }

    ~ResNetCalibrator() { cudaFree(d_input_batch); }
};

// Enable INT8 in the builder config:
// config->setFlag(BuilderFlag::kINT8);
// ResNetCalibrator calibrator(32, images);
// config->setInt8Calibrator(&calibrator);
```

### Performance Reference

| Configuration | ResNet-50 Batch=1 Latency | Throughput (img/s) |
|---|---|---|
| CPU (Xeon, FP32) | ~5 ms | ~200 |
| A100, FP32 | ~0.5 ms | ~2,000 |
| A100, FP16 + TensorRT | ~0.15 ms | ~6,500 |
| A100, INT8 + TensorRT | ~0.08 ms | ~12,500 |
| H100, FP8 + TensorRT | ~0.04 ms | ~25,000 |

INT8 TensorRT is roughly 60× faster than CPU at batch=1. For online serving where batch=1 latency matters, this is the optimization that makes real-time ML inference economically viable.

### Go Comparison

Go engineers interact with TensorRT-optimized models through **Triton Inference Server**, NVIDIA's model serving framework that wraps TensorRT, ONNX Runtime, and other backends behind a unified gRPC and HTTP/REST API.

```go
package main

import (
	"context"

	triton "github.com/triton-inference-server/client/src/grpc_generated/go"
	"google.golang.org/grpc"
)

// Go client for Triton Inference Server (pseudocode, real proto generated by protoc)
func runInference(ctx context.Context, conn *grpc.ClientConn, imageData []float32) (*triton.ModelInferResponse, error) {
	client := triton.NewGRPCInferenceServiceClient(conn)
	req := &triton.ModelInferRequest{
		ModelName:    "resnet50_int8",
		ModelVersion: "1",
		Inputs: []*triton.ModelInferRequest_InferInputTensor{{
			Name:     "input",
			Datatype: "FP32",
			Shape:    []int64{1, 3, 224, 224},
			Contents: &triton.InferTensorContents{Fp32Contents: imageData},
		}},
	}
	resp, err := client.ModelInfer(ctx, req)
	if err != nil {
		return nil, err
	}
	// resp.Outputs[0].Contents.Fp32Contents contains the 1000-class logits
	return resp, nil
}
```

The Go process never loads the model, allocates GPU memory, or calls CUDA. It sends a proto message over gRPC and receives a proto response. All GPU work happens in the Triton C++ process.

---
