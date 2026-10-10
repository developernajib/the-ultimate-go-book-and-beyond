## TinyML on MCUs

TinyML is the practice of running machine learning inference on microcontrollers. The category emerged around 2019 with TensorFlow Lite Micro, exploded with Edge Impulse and similar tooling, and is now mainstream in keyword spotting, anomaly detection, gesture recognition, predictive maintenance, and low-resolution vision. A Cortex-M4 at 80 MHz runs a meaningful keyword spotter in real time on a coin cell. A Cortex-M55 with Helium runs object detection on QVGA video at 5-10 FPS.

The C++ side is the inference engine that takes a trained model and runs it on the MCU.

### Why TinyML Instead of Cloud Inference

Latency. Privacy. Power. Connectivity.

A wake-word detector on a smart speaker must respond in under 200 ms. Round-tripping audio to the cloud costs at least that. Local inference is the only option.

A medical wearable that detects atrial fibrillation must process ECG locally because the data is private. Nothing leaves the device unless the user explicitly shares it.

A predictive maintenance sensor on a factory pump must run for 10 years on a battery. Sending raw vibration data to the cloud over LTE-M would drain the battery in weeks. Running an anomaly detector locally and sending only the alert keeps the radio off 99.9 percent of the time.

A geophysical sensor in a desert with no cellular coverage cannot phone home at all. Inference happens on the part or it does not happen.

### TensorFlow Lite Micro

TFLite Micro is the most widely deployed TinyML inference engine. It is a C++ library (the runtime is C++11 even though the broader TF codebase uses newer standards) that loads a quantized model from flash and runs it. No dynamic memory after initialization, no operating system dependency, no string formatting in the hot path.

The application provides:

1. The model bytes (a `.tflite` file, embedded as a C array)
2. A "tensor arena," a fixed-size buffer for activations and intermediates
3. The list of operators the model needs (the OpResolver)

```cpp
#include "tensorflow/lite/micro/all_ops_resolver.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/schema/schema_generated.h"

extern const unsigned char model_tflite[];
extern const unsigned int model_tflite_len;

constexpr std::size_t kTensorArenaSize = 64 * 1024;
alignas(16) std::uint8_t tensor_arena[kTensorArenaSize];

void run_inference(const float* input, float* output) {
    const tflite::Model* model = tflite::GetModel(model_tflite);

    static tflite::AllOpsResolver resolver;
    static tflite::MicroInterpreter interpreter(
        model, resolver, tensor_arena, kTensorArenaSize);

    interpreter.AllocateTensors();
    auto* in_tensor = interpreter.input(0);
    std::memcpy(in_tensor->data.f, input, in_tensor->bytes);

    interpreter.Invoke();

    auto* out_tensor = interpreter.output(0);
    std::memcpy(output, out_tensor->data.f, out_tensor->bytes);
}
```

`AllOpsResolver` pulls in every op kernel TFLite supports, costing tens of KB of code. Production builds use a `MicroMutableOpResolver<N>` that includes only the ops the specific model needs:

```cpp
tflite::MicroMutableOpResolver<6> resolver;
resolver.AddConv2D();
resolver.AddDepthwiseConv2D();
resolver.AddFullyConnected();
resolver.AddSoftmax();
resolver.AddReshape();
resolver.AddMaxPool2D();
```

This typically saves 30 to 50 KB of flash on a real model.

### INT8 Quantization

A trained TensorFlow model is normally float32. Float32 inference on Cortex-M4 is slow and uses 4 bytes per activation. INT8 quantization remaps weights and activations to the int8 range, with per-tensor or per-channel scale factors stored in the model. The math becomes integer multiply-accumulate, which is 4x to 16x faster on Cortex-M and uses 4x less memory.

The conversion happens during the model export, typically with TensorFlow's post-training quantization or quantization-aware training. The Edge Impulse, Google MediaPipe Studio, and Latent AI tools automate the process for common architectures.

The accuracy hit from int8 quantization is typically 0 to 2 percentage points for well-designed models. For ResNet-class image classifiers it is negligible. For some recurrent models it is more significant and quantization-aware training is required.

### CMSIS-NN Kernels

TFLite Micro can use CMSIS-NN as the backend for Cortex-M kernels. The link-time selection is a build flag, and the speedup over reference C kernels is substantial:

| Operator | Reference | CMSIS-NN | Speedup |
|---|---|---|---|
| Conv2D 8-bit, M4 | 100 ms | 25 ms | 4x |
| DepthwiseConv2D, M4 | 80 ms | 20 ms | 4x |
| FullyConnected, M4 | 30 ms | 8 ms | 3.7x |
| Conv2D 8-bit, M55 (Helium) | 100 ms | 5 ms | 20x |

The Helium speedup on M55 comes from 128-bit vector multiply-accumulate. CMSIS-NN's Helium kernels process 16 int8 lanes per cycle.

### Edge Impulse and Tooling

Edge Impulse is the leading commercial TinyML platform. The workflow is:

1. Connect a development board over USB
2. Collect labeled training data (audio, accelerometer, image)
3. Choose a model architecture from a library or use Edge Impulse's auto-search
4. Train in the cloud
5. Deploy as a C++ library that the firmware links against
6. Test on the device

The deployed library is a single `edge-impulse-sdk` directory that the application includes. The API:

```cpp
#include "edge-impulse-sdk/classifier/ei_run_classifier.h"

void run_classifier(const float* features, std::size_t n_features) {
    signal_t signal;
    numpy::signal_from_buffer(features, n_features, &signal);

    ei_impulse_result_t result;
    EI_IMPULSE_ERROR err = run_classifier(&signal, &result, false);
    if (err != EI_IMPULSE_OK) return;

    for (size_t i = 0; i < EI_CLASSIFIER_LABEL_COUNT; ++i) {
        ei_printf("%s: %.5f\n",
                  result.classification[i].label,
                  result.classification[i].value);
    }
}
```

Behind the scenes, the SDK is TFLite Micro plus pre-processing and post-processing code generated from the user's pipeline configuration.

### Anomaly Detection on MCUs

A common TinyML pattern is one-class anomaly detection: train an autoencoder on "normal" data, deploy it on the device, and flag inputs whose reconstruction error exceeds a threshold. The model is small (often under 50 KB), the inference is fast (under 10 ms on Cortex-M4), and the user benefit is clear (predicting bearing failure two weeks before it happens).

```cpp
constexpr float kAnomalyThreshold = 0.15f;

bool is_anomalous(const float* features) {
    float reconstruction[kFeatureCount];
    autoencoder.invoke(features, reconstruction);
    float error = 0.0f;
    for (std::size_t i = 0; i < kFeatureCount; ++i) {
        float d = features[i] - reconstruction[i];
        error += d * d;
    }
    error /= kFeatureCount;
    return error > kAnomalyThreshold;
}
```

The threshold is calibrated by sampling errors on known-good data and choosing a value above the 99th percentile. False positive rate is the metric to watch.

### Practical Footprint Numbers

Real numbers from production TinyML deployments in 2026:

- **Keyword spotting (e.g., "Alexa")** on Cortex-M4F: 50 KB flash, 30 KB RAM, 15 ms inference, runs continuously at 5 mA average current. Battery-powered always-on is feasible.
- **Person detection (96x96 grayscale)** on Cortex-M7 with TCM: 250 KB flash, 80 KB tensor arena, 100 ms inference. Suitable for low-frame-rate doorbell or security camera.
- **Gesture recognition from IMU** on Cortex-M0+: 8 KB flash, 4 KB RAM, 2 ms inference. Runs on \$0.50 worth of silicon.
- **Speech recognition (50-word vocabulary)** on Cortex-M55 with Helium: 500 KB flash, 200 KB RAM, 30 ms inference. Edge of what an MCU can handle.
- **Object detection (320x240, MobileNetV2-SSD)** on Cortex-A55: 4 MB flash, 8 MB RAM, 100 ms inference. This is where MCUs end and MPUs begin.

### What Cannot Run on an MCU

In 2026 the inference frontier on MCUs is roughly:

- Single-image classification with input sizes up to 320x320 grayscale on M55-class with Helium
- Audio models up to 1-second windows
- Time-series models with up to roughly 100,000 parameters

Anything larger lives on the application processor or the cloud. Large language models, full-resolution image segmentation, and real-time video understanding are not MCU workloads in 2026 and probably will not be for several more silicon generations.

---
