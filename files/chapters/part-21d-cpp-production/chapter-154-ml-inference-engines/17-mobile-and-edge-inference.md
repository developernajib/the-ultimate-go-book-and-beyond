## Mobile and Edge Inference

The phone is now a real inference target. Apple Intelligence, Gemini Nano, Pixel on-device translation, on-device speech-to-text, on-device image generation, on-device document understanding. All ship inference engines on the device, written in C++ (with platform-specific glue).

This section covers the mobile / edge stack: which runtimes, which APIs, which kernels, and the constraints (battery, RAM, thermal) that make this niche different from server inference.

### TFLite (LiteRT) C++

TFLite was renamed LiteRT in late 2024 but the C++ API is mostly the same. It is Google's reference mobile inference runtime. Used in Android, iOS, embedded Linux, microcontrollers.

```cpp
#include <tensorflow/lite/c/c_api.h>

TfLiteModel* model = TfLiteModelCreateFromFile("model.tflite");
TfLiteInterpreterOptions* opts = TfLiteInterpreterOptionsCreate();

// XNNPACK delegate for CPU acceleration
TfLiteXNNPackDelegateOptions xopts = TfLiteXNNPackDelegateOptionsDefault();
xopts.num_threads = 4;
auto* delegate = TfLiteXNNPackDelegateCreate(&xopts);
TfLiteInterpreterOptionsAddDelegate(opts, delegate);

TfLiteInterpreter* interp = TfLiteInterpreterCreate(model, opts);
TfLiteInterpreterAllocateTensors(interp);

TfLiteTensor* input = TfLiteInterpreterGetInputTensor(interp, 0);
TfLiteTensorCopyFromBuffer(input, image_data, image_bytes);

TfLiteInterpreterInvoke(interp);

const TfLiteTensor* output = TfLiteInterpreterGetOutputTensor(interp, 0);
TfLiteTensorCopyToBuffer(output, output_buf, output_bytes);

TfLiteInterpreterDelete(interp);
TfLiteXNNPackDelegateDelete(delegate);
TfLiteInterpreterOptionsDelete(opts);
TfLiteModelDelete(model);
```

The delegate model is the key abstraction. A `TfLiteDelegate` implements custom kernels for a backend. The standard delegates:

- **XNNPACK.** ARM NEON / AVX optimized CPU kernels. Default on most platforms.
- **GPU.** OpenCL on Android, Metal on iOS, OpenGL ES fallback.
- **NNAPI.** Android Neural Networks API (on-device NPU when available).
- **Core ML.** Apple's NPU + GPU + CPU stack on iOS / macOS.
- **EdgeTPU.** Coral hardware.
- **Hexagon.** Qualcomm DSP.

### NNAPI (Android Neural Networks API)

NNAPI is the abstraction Google ships in Android for talking to the device's NPU. Phone vendors (Qualcomm, MediaTek, Samsung) implement NNAPI HAL drivers that route to their NPU silicon.

The C API is verbose but stable:

```cpp
#include <android/NeuralNetworks.h>

ANeuralNetworksModel* model;
ANeuralNetworksModel_create(&model);

// Add operands and operations
ANeuralNetworksOperandType input_type{
    .type = ANEURALNETWORKS_TENSOR_FLOAT32,
    .dimensionCount = 4,
    .dimensions = (uint32_t[]){1, 224, 224, 3}, ... };
ANeuralNetworksModel_addOperand(model, &input_type);
// ... more operands

ANeuralNetworksModel_addOperation(model, ANEURALNETWORKS_CONV_2D,
    /*input count*/, input_indexes, /*output count*/, output_indexes);

ANeuralNetworksModel_finish(model);

ANeuralNetworksCompilation* compilation;
ANeuralNetworksCompilation_create(model, &compilation);
ANeuralNetworksCompilation_setPreference(compilation,
    ANEURALNETWORKS_PREFER_LOW_POWER);
ANeuralNetworksCompilation_finish(compilation);

ANeuralNetworksExecution* exec;
ANeuralNetworksExecution_create(compilation, &exec);
ANeuralNetworksExecution_setInput(exec, 0, nullptr, input_data, sizeof(input_data));
ANeuralNetworksExecution_setOutput(exec, 0, nullptr, output_data, sizeof(output_data));

ANeuralNetworksEvent* event;
ANeuralNetworksExecution_startCompute(exec, &event);
ANeuralNetworksEvent_wait(event);

ANeuralNetworksEvent_free(event);
// ... cleanup
```

In production you almost never write NNAPI directly. You use TFLite's NNAPI delegate, which translates a TFLite graph into NNAPI ops at delegate time.

### Core ML (Apple Silicon)

Core ML is Apple's framework. It targets the CPU, GPU (Metal), and ANE (Apple Neural Engine, the NPU on M-series and A-series chips).

The C++ surface goes through Objective-C++ on iOS / macOS. The minimal load + predict:

```objc
// Objective-C++ (.mm)
#include <CoreML/CoreML.h>

NSURL* url = [NSURL fileURLWithPath:@"model.mlpackage"];
NSError* err = nil;
MLModel* model = [MLModel modelWithContentsOfURL:url error:&err];

MLFeatureValue* in = [MLFeatureValue featureValueWithMultiArray:input_array];
NSDictionary* features = @{@"input": in};
MLDictionaryFeatureProvider* provider =
    [[MLDictionaryFeatureProvider alloc] initWithDictionary:features error:&err];

id<MLFeatureProvider> output = [model predictionFromFeatures:provider error:&err];
MLFeatureValue* outval = [output featureValueForName:@"output"];
MLMultiArray* arr = outval.multiArrayValue;
// arr.dataPointer holds the output
```

For C++-heavy code, you wrap this in an ObjC++ shim and expose a clean C++ interface. CoreML automatically picks the ANE for ops it supports, GPU for ops it does not, CPU for the rest. You can constrain it via `MLModelConfiguration.computeUnits`.

The ANE on M3 / M4 / A18 is purpose-built for INT8 and FP16. It does ~38 TOPS on M4. For a quantized model that fits the ANE op set, it is faster and lower power than the GPU.

### ONNX Runtime Mobile

ORT has a mobile build (`onnxruntime-mobile`) that strips features and ships ~3 MB of binary instead of ~30 MB. Same C++ API as desktop ORT, with the mobile delegates (NNAPI on Android, Core ML on iOS).

```cpp
Ort::SessionOptions opts;
// On Android
OrtSessionOptionsAppendExecutionProvider_Nnapi(opts, NNAPI_FLAG_USE_FP16);
// On iOS
OrtSessionOptionsAppendExecutionProvider_CoreML(opts,
    COREML_FLAG_USE_CPU_AND_GPU | COREML_FLAG_USE_ANE);

Ort::Session session(env, "model.onnx", opts);
```

Ort Mobile is a good choice when your model targets multiple mobile platforms from one artifact. For Android-only or iOS-only, the platform-native runtime (TFLite or Core ML) typically beats it on size and latency.

### MediaPipe

Google's MediaPipe framework wraps inference and pre/post-processing into a graph. Used inside Android for Live Caption, the Pixel camera pipeline, and Gemini Nano on-device. The C++ side is a graph runtime with calculators (nodes), each implementing a small piece of work.

```cpp
mediapipe::CalculatorGraphConfig config;
mediapipe::ParseTextProto(R"(
    input_stream: "image"
    output_stream: "labels"
    node {
        calculator: "ImageToTensorCalculator"
        input_stream: "IMAGE:image"
        output_stream: "TENSORS:input_tensors"
    }
    node {
        calculator: "InferenceCalculator"
        input_stream: "TENSORS:input_tensors"
        output_stream: "TENSORS:output_tensors"
        node_options {
            [type.googleapis.com/mediapipe.InferenceCalculatorOptions]: {
                model_path: "classifier.tflite"
                delegate { gpu {} }
            }
        }
    }
    node {
        calculator: "TensorsToClassificationCalculator"
        input_stream: "TENSORS:output_tensors"
        output_stream: "CLASSIFICATIONS:labels"
    }
)", &config);

mediapipe::CalculatorGraph graph;
graph.Initialize(config);
graph.StartRun({});

graph.AddPacketToInputStream("image",
    mediapipe::MakePacket<ImageFrame>(...).At(timestamp));
```

The framework is overkill for a simple inference call but invaluable when the production pipeline has many stages (image normalize -> NN -> NMS -> tracking -> blur -> render).

### GPU Compute Shaders for Inference

On mobile GPUs (Mali, Adreno, Apple GPU) you can run inference via compute shaders. Frameworks abstract this: TFLite GPU delegate uses OpenCL, Vulkan, or Metal under the hood. For custom kernels, you write GLSL / Metal Shading Language / Vulkan compute shaders.

A Metal shader for a simple GEMV (decode pattern):

```metal
#include <metal_stdlib>
using namespace metal;

kernel void gemv_fp16(
    device const half* W [[buffer(0)]],   // [M, K]
    device const half* x [[buffer(1)]],   // [K]
    device half* y       [[buffer(2)]],   // [M]
    constant uint& M     [[buffer(3)]],
    constant uint& K     [[buffer(4)]],
    uint tid             [[thread_position_in_grid]]) {
    if (tid >= M) return;
    float acc = 0.0f;
    for (uint k = 0; k < K; ++k) {
        acc += float(W[tid * K + k]) * float(x[k]);
    }
    y[tid] = half(acc);
}
```

Apple's MPS (Metal Performance Shaders) framework wraps this in higher-level objects. MPSGraph is the modern API, you build a compute graph in Objective-C++, MPSGraph compiles to Metal shaders.

### Constraints That Reshape The Design

Mobile inference has constraints server inference does not.

**Battery.** A spike in NPU usage drains battery. The OS may throttle if the model runs for too long. Solution: shorter generations, smaller models, longer cool-down between calls.

**Thermals.** Sustained inference on a phone will throttle the SoC after seconds to minutes. Spread work, use efficient cores, exploit the NPU (more efficient than GPU for the same work).

**Memory.** A phone has 8 to 16 GB of RAM. The OS reclaims memory aggressively. Models above 4 GB struggle on most phones in 2026. Use INT4 quantization and `mmap` so the OS can page out unused weights.

**Storage.** Models compete with photos and apps for space. Compress aggressively. GGUF Q4_K_M, MLPackage with model encryption + compression.

**Cold start.** First inference can take seconds (ANE compile, weight load). Subsequent are fast. Pre-warm at app start if the user is likely to use the feature.

### Senior at FAANG: The Mobile Inference Bar

At Google (Tensor SoC, Pixel), Apple (M / A series, ANE), and Meta (Quest, Ray-Ban smart glasses), mobile inference engineers care about:

1. The op coverage of the NPU. Models that use ops not in the NPU set fall back to GPU or CPU, losing the win.
2. Quantization to fit the NPU's native data type (INT8 for ANE. FP16 for some Snapdragon NPUs).
3. Model architecture choices that map to the NPU. Avoid dynamic shapes, avoid uncommon activation functions.
4. Power budget. The metric is "tokens per joule," not just latency.

A good mobile inference engineer can profile a model with platform tools (Xcode Instruments for ANE, Android GPU Inspector, Snapdragon Profiler), identify which ops are running where, and refactor the model architecture to keep more on the NPU.

The next section covers the production serving frameworks that wrap all the above.

---
