## cuBLAS, cuDNN, and ML Inference

Writing your own CUDA kernels for matrix multiplication and convolution is a useful learning exercise, but production ML inference does not use hand-written kernels for standard operations. NVIDIA's cuBLAS and cuDNN libraries are the result of years of hardware-specific optimization, auto-tuned kernel selection, tensor core use, algorithm search across hundreds of variants, and they outperform any reasonably written custom kernel. The right strategy: use these libraries for standard operations, write custom kernels only for novel operations that the libraries don't cover.

### cuBLAS: GPU BLAS Library

cuBLAS implements the BLAS (Basic Linear Algebra Subprograms) interface on NVIDIA GPUs. The most important function is `cublasGemmEx`, generalized matrix multiply with configurable precision.

```cpp
#include <cublas_v2.h>
#include <cuda_runtime.h>
#include <cuda_fp16.h>
#include <cstdio>
#include <cstdlib>

#define CUBLAS_CHECK(call)                                                  \
    do {                                                                    \
        cublasStatus_t status = (call);                                     \
        if (status != CUBLAS_STATUS_SUCCESS) {                              \
            fprintf(stderr, "cuBLAS error at %s:%d: %d\n",                 \
                    __FILE__, __LINE__, status);                            \
            std::exit(EXIT_FAILURE);                                        \
        }                                                                   \
    } while (0)

// C = alpha * A * B + beta * C
// A: M×K, B: K×N, C: M×N (all row-major on host, but cuBLAS is column-major)
// We pass CUBLAS_OP_T to handle the row-major vs column-major difference.
void sgemm_example(int M, int N, int K) {
    cublasHandle_t handle;
    CUBLAS_CHECK(cublasCreate(&handle));

    size_t bytes_A = M * K * sizeof(float);
    size_t bytes_B = K * N * sizeof(float);
    size_t bytes_C = M * N * sizeof(float);

    float *d_A, *d_B, *d_C;
    cudaMalloc(&d_A, bytes_A);
    cudaMalloc(&d_B, bytes_B);
    cudaMalloc(&d_C, bytes_C);

    // Initialize on device (in production, copy from host or generate in kernel)
    // ... cudaMemcpy ...

    float alpha = 1.0f, beta = 0.0f;

    // cuBLAS is column-major. To compute C = A*B in row-major, use the identity:
    // C^T = B^T * A^T  (swap A/B and transpose both)
    CUBLAS_CHECK(cublasSgemm(
        handle,
        CUBLAS_OP_N,  // B not transposed (but treated as B^T by column-major logic)
        CUBLAS_OP_N,  // A not transposed
        N,            // rows of op(B) and C
        M,            // cols of op(A) and C
        K,            // inner dimension
        &alpha,
        d_B, N,       // B: leading dimension = N
        d_A, K,       // A: leading dimension = K
        &beta,
        d_C, N        // C: leading dimension = N
    ));

    // Wait and check
    cudaDeviceSynchronize();

    cublasDestroy(handle);
    cudaFree(d_A); cudaFree(d_B); cudaFree(d_C);
}
```

**Mixed precision with tensor cores**, the production path for ML inference:

```cpp
// FP16 inputs, FP32 accumulation, FP16 output, uses tensor cores on Volta+
void mixed_precision_gemm(cublasHandle_t handle,
                          const __half* d_A, const __half* d_B, __half* d_C,
                          int M, int N, int K) {
    float alpha = 1.0f, beta = 0.0f;

    // Enable tensor core math (TF32 on Ampere, FP16 on Volta/Turing)
    cublasSetMathMode(handle, CUBLAS_TENSOR_OP_MATH);

    cublasGemmEx(
        handle,
        CUBLAS_OP_N, CUBLAS_OP_N,
        N, M, K,
        &alpha,
        d_B, CUDA_R_16F, N,   // B in FP16
        d_A, CUDA_R_16F, K,   // A in FP16
        &beta,
        d_C, CUDA_R_16F, N,   // C in FP16
        CUBLAS_COMPUTE_32F,   // Accumulate in FP32 for numerical stability
        CUBLAS_GEMM_DEFAULT_TENSOR_OP  // Let cuBLAS pick the best tensor core algo
    );
}
```

**Batched GEMM**, essential for transformer attention where you compute many small independent matrix multiplies in parallel:

```cpp
// Compute B independent GEMMs simultaneously: C[i] = A[i] * B[i]
void batched_gemm(cublasHandle_t handle,
                  const float** d_A_array,   // Array of B device pointers
                  const float** d_B_array,
                  float** d_C_array,
                  int M, int N, int K, int batch_size) {
    float alpha = 1.0f, beta = 0.0f;

    cublasSgemmBatched(
        handle,
        CUBLAS_OP_N, CUBLAS_OP_N,
        N, M, K,
        &alpha,
        d_B_array, N,
        d_A_array, K,
        &beta,
        d_C_array, N,
        batch_size
    );
}
```

For contiguous batches (strided layout), use `cublasSgemmStridedBatched` with stride parameters, it avoids the pointer-array overhead.

### cuDNN: Deep Neural Network Primitives

cuDNN provides GPU implementations of the building blocks of neural networks: convolutions, activation functions, batch normalization, pooling, softmax, attention, and more.

```cpp
#include <cudnn.h>

#define CUDNN_CHECK(call)                                                   \
    do {                                                                    \
        cudnnStatus_t status = (call);                                      \
        if (status != CUDNN_STATUS_SUCCESS) {                               \
            fprintf(stderr, "cuDNN error at %s:%d: %s\n",                  \
                    __FILE__, __LINE__, cudnnGetErrorString(status));       \
            std::exit(EXIT_FAILURE);                                        \
        }                                                                   \
    } while (0)

// Forward pass of a single convolutional layer
struct ConvLayer {
    cudnnHandle_t           cudnn;
    cudnnTensorDescriptor_t input_desc, output_desc, bias_desc;
    cudnnFilterDescriptor_t filter_desc;
    cudnnConvolutionDescriptor_t conv_desc;
    cudnnActivationDescriptor_t  act_desc;

    // Workspace for cuDNN algorithm scratch space
    void* workspace = nullptr;
    size_t workspace_bytes = 0;

    cudnnConvolutionFwdAlgo_t algo;

    ConvLayer(int N, int C, int H, int W,     // input: batch×channels×height×width
              int K, int R, int S,             // filter: out_channels×in_ch×R×S
              int pad, int stride) {
        CUDNN_CHECK(cudnnCreate(&cudnn));

        // Input tensor: NCHW layout
        CUDNN_CHECK(cudnnCreateTensorDescriptor(&input_desc));
        CUDNN_CHECK(cudnnSetTensor4dDescriptor(input_desc, CUDNN_TENSOR_NCHW,
                                               CUDNN_DATA_FLOAT, N, C, H, W));

        // Filter (weights)
        CUDNN_CHECK(cudnnCreateFilterDescriptor(&filter_desc));
        CUDNN_CHECK(cudnnSetFilter4dDescriptor(filter_desc, CUDNN_DATA_FLOAT,
                                               CUDNN_TENSOR_NCHW, K, C, R, S));

        // Convolution descriptor
        CUDNN_CHECK(cudnnCreateConvolutionDescriptor(&conv_desc));
        CUDNN_CHECK(cudnnSetConvolution2dDescriptor(conv_desc,
            pad, pad,        // padding h, w
            stride, stride,  // stride h, w
            1, 1,            // dilation h, w
            CUDNN_CROSS_CORRELATION,
            CUDNN_DATA_FLOAT));

        // Enable tensor core math
        CUDNN_CHECK(cudnnSetConvolutionMathType(conv_desc,
                                                CUDNN_TENSOR_OP_MATH));

        // Compute output dimensions
        int oN, oC, oH, oW;
        CUDNN_CHECK(cudnnGetConvolution2dForwardOutputDim(
            conv_desc, input_desc, filter_desc, &oN, &oC, &oH, &oW));

        CUDNN_CHECK(cudnnCreateTensorDescriptor(&output_desc));
        CUDNN_CHECK(cudnnSetTensor4dDescriptor(output_desc, CUDNN_TENSOR_NCHW,
                                               CUDNN_DATA_FLOAT, oN, oC, oH, oW));

        // Auto-tune: find the fastest algorithm for this configuration on this GPU
        int num_algos;
        cudnnConvolutionFwdAlgoPerf_t perf_results[8];
        CUDNN_CHECK(cudnnFindConvolutionForwardAlgorithm(
            cudnn, input_desc, filter_desc, conv_desc, output_desc,
            8, &num_algos, perf_results));
        algo = perf_results[0].algo;  // Best algorithm

        // Allocate workspace
        CUDNN_CHECK(cudnnGetConvolutionForwardWorkspaceSize(
            cudnn, input_desc, filter_desc, conv_desc, output_desc,
            algo, &workspace_bytes));
        if (workspace_bytes > 0)
            cudaMalloc(&workspace, workspace_bytes);

        // ReLU activation
        CUDNN_CHECK(cudnnCreateActivationDescriptor(&act_desc));
        CUDNN_CHECK(cudnnSetActivationDescriptor(act_desc,
            CUDNN_ACTIVATION_RELU, CUDNN_NOT_PROPAGATE_NAN, 0.0));
    }

    void forward(const float* d_input, const float* d_filter,
                 const float* d_bias, float* d_output) {
        float alpha = 1.0f, beta = 0.0f;

        // Convolution
        CUDNN_CHECK(cudnnConvolutionForward(
            cudnn, &alpha,
            input_desc, d_input,
            filter_desc, d_filter,
            conv_desc, algo,
            workspace, workspace_bytes,
            &beta, output_desc, d_output));

        // Add bias
        float alpha1 = 1.0f, beta1 = 1.0f;
        CUDNN_CHECK(cudnnAddTensor(cudnn, &alpha1, bias_desc, d_bias,
                                  &beta1, output_desc, d_output));

        // Apply ReLU in-place
        CUDNN_CHECK(cudnnActivationForward(
            cudnn, act_desc,
            &alpha, output_desc, d_output,
            &beta,  output_desc, d_output));
    }

    ~ConvLayer() {
        cudaFree(workspace);
        cudnnDestroyTensorDescriptor(input_desc);
        cudnnDestroyTensorDescriptor(output_desc);
        cudnnDestroyFilterDescriptor(filter_desc);
        cudnnDestroyConvolutionDescriptor(conv_desc);
        cudnnDestroyActivationDescriptor(act_desc);
        cudnnDestroy(cudnn);
    }
};
```

### cuDNN Convolution Algorithms

`cudnnFindConvolutionForwardAlgorithm` searches among:

| Algorithm | Best for |
|---|---|
| `IMPLICIT_GEMM` | General purpose, any size |
| `IMPLICIT_PRECOMP_GEMM` | Repeated same-size convolutions |
| `GEMM` | Large kernels (e.g., 5×5+) |
| `DIRECT` | Small kernels |
| `FFT` | Large spatial dimensions |
| `FFT_TILING` | Medium spatial, tensor cores |
| `WINOGRAD` | 3×3 convolution, fastest for CNNs |
| `WINOGRAD_NONFUSED` | Winograd without fusion |

For ResNet-style 3×3 convolutions, `WINOGRAD` typically wins by 20-30% over `IMPLICIT_GEMM`.

### FlashAttention: Fused Kernel for Transformer Attention

Standard attention computes `softmax(QK^T / sqrt(d)) * V`. The intermediate `QK^T` matrix for a sequence length of 4096 and batch size 32 requires 32 × 4096 × 4096 × 4 bytes = 2GB of GPU memory. FlashAttention avoids materializing this matrix entirely:

```
Standard attention:  Q×K^T → [QK^T matrix] → softmax → [softmax matrix] → ×V
FlashAttention:      Tiles (Q, K, V) into shared memory, fuses all three ops
                     into one kernel, never writes the full QK^T to DRAM.
```

Memory usage drops from O(n²) to O(n) in sequence length. For long-context models (100K+ tokens), this is not an optimization, it is the difference between possible and impossible. The FlashAttention CUDA kernel is one of the most important custom kernels ever written for ML.

### Go Comparison

Go's `gonum.org/v1/gonum/blas` provides CPU BLAS operations. There is no GPU equivalent. For ML inference from Go, the production pattern is:

1. Train model in Python (PyTorch/TensorFlow)
2. Export to ONNX or TensorRT engine
3. Serve via Triton Inference Server (C++ gRPC)
4. Call from Go via gRPC using the Triton client proto

The Go process never touches CUDA. It sends a gRPC request with a tensor payload and receives a result tensor. This is the standard ML serving architecture at companies like NVIDIA, Meta, and Google.

---
