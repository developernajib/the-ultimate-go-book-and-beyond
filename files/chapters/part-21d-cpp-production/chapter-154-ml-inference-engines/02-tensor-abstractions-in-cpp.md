## Tensor Abstractions in C++

A tensor is a multidimensional array with a shape, a stride pattern, a data type, and a memory location. Every inference engine has a tensor class at its core: ATen has `at::Tensor`, TensorFlow has `tensorflow::Tensor`, ONNX Runtime has `Ort::Value`, TensorRT has `nvinfer1::ITensor`, MLX has `mlx::core::array`. They all model the same set of concerns. This section walks through the design space, then builds a minimal version in C++23 using `std::mdspan`.

### Shape, Stride, and Layout

The shape of a tensor is a tuple of dimensions: `[N, C, H, W]` for a batch of images, `[B, S, H]` for a batch of token embeddings, `[B, num_heads, S, head_dim]` for an attention activation. The stride at dimension `i` is the number of elements you skip in the underlying storage when you advance the index at dimension `i` by one.

For a contiguous row-major (C-order) tensor of shape `[N, C, H, W]` with `dtype=float`:

```cpp
stride[3] = 1;                     // W: innermost
stride[2] = W;                     // H
stride[1] = H * W;                 // C
stride[0] = C * H * W;             // N: outermost
```

The element at index `(n, c, h, w)` lives at `data[n*stride[0] + c*stride[1] + h*stride[2] + w*stride[3]]`.

The two layouts that matter for vision inference are NCHW (PyTorch / TensorRT default) and NHWC (TensorFlow default, also faster on Tensor Cores for some convolution sizes). For LLMs, the layout is almost always `[B, S, H]` or `[B, H, S]` and the head dimension is split out as needed. The choice affects which cuDNN algorithm fires, which Tensor Core path is taken, and whether a transpose is needed before the kernel.

### Contiguous vs Strided Views

When you slice a tensor, the result is usually non-contiguous. `t[:, :, ::2, ::2]` (every other pixel in H and W) has the same data pointer but doubled strides on the inner two dims. A transpose `t.transpose(2, 3)` swaps two stride values without touching memory.

Most CUDA kernels assume contiguous input. cuBLAS GEMM accepts a leading dimension parameter so it tolerates a stride on the outer dim, but inner-dim strides are not allowed. The standard idiom is:

```cpp
if (!t.is_contiguous()) {
    t = t.contiguous();  // allocates and copies
}
```

This is a hidden allocation. In a hot inference loop you want to avoid it. The discipline is: track which ops produce strided outputs, and either fuse the next op to handle strides or insert an explicit copy where you can amortize it.

### Broadcasting

Broadcasting rules let you add a `[1, C, 1, 1]` bias to a `[N, C, H, W]` activation without materializing the bias to the full shape. The semantics:

1. Align shapes from the right.
2. Each dim must be equal, or one of them must be 1, or one tensor must lack that dim.
3. The dim of size 1 is virtually replicated.

In code, broadcasting is implemented by computing an effective stride of zero on any dim where the original size is 1. With stride zero, advancing the index leaves the data pointer where it is, so the same value gets read repeatedly.

```cpp
struct BroadcastView {
    float* data;
    std::array<int64_t, 4> shape;     // target shape after broadcast
    std::array<int64_t, 4> strides;   // 0 in broadcast dims
};
```

This pattern appears in every framework. ATen calls it `expand`. NumPy calls it `broadcast_to`.

### ATen Tensor Design (PyTorch's Foundation)

`at::Tensor` is a smart pointer to a `TensorImpl`, which holds:

- A `Storage` (a refcounted pointer to a raw allocation, plus an allocator).
- A `SmallVector<int64_t>` for sizes.
- A `SmallVector<int64_t>` for strides.
- An `int64_t storage_offset`.
- A `DispatchKeySet` (which dispatch tables to use: CPU, CUDA, autograd, etc).
- A `caffe2::TypeMeta` for dtype.

A view operation creates a new `TensorImpl` pointing at the same `Storage` with different sizes / strides / offset. The refcount on `Storage` keeps the buffer alive until all views are gone.

The dispatch system is what makes `tensor.add_(other)` route to the CPU or CUDA implementation transparently. The `DispatchKeySet` holds a bitmask, the operator's dispatcher walks it from highest priority to lowest. For inference, you want the CUDA dispatch key on every input tensor and you want to skip autograd entirely (`InferenceMode` or `NoGradGuard`).

The takeaway for engine design: separate the metadata (shape, stride, dtype, device) from the storage. Reference-count the storage. Allow zero-copy views. This is the design that has won across every framework and you should copy it.

### Building a Minimal Tensor in C++23 with mdspan

C++23 introduced `std::mdspan`, a non-owning multidimensional view. It is the right primitive for a tensor view. Combined with a refcounted storage class, you get a clean tensor type.

```cpp
#include <mdspan>
#include <memory>
#include <vector>
#include <span>
#include <cstdint>
#include <cstring>
#include <stdexcept>

namespace mlc {

enum class DType : uint8_t { F32, F16, BF16, I8, I32, U8, FP8_E4M3, FP4 };

inline size_t dtype_size(DType d) {
    switch (d) {
        case DType::F32: case DType::I32:                 return 4;
        case DType::F16: case DType::BF16:                return 2;
        case DType::I8: case DType::U8: case DType::FP8_E4M3: return 1;
        case DType::FP4:                                   return 1;  // 2 elements per byte, handled by caller
    }
    return 0;
}

enum class Device : uint8_t { CPU, CUDA, ROCm };

class Storage {
public:
    Storage(size_t bytes, Device dev) : bytes_(bytes), device_(dev) {
        if (dev == Device::CPU) {
            data_ = std::aligned_alloc(64, bytes);
        } else {
            // cudaMalloc(&data_, bytes); on real builds
            data_ = nullptr;
        }
    }
    ~Storage() {
        if (device_ == Device::CPU) std::free(data_);
        // else cudaFree(data_);
    }

    Storage(const Storage&) = delete;
    Storage& operator=(const Storage&) = delete;

    void* data() const noexcept { return data_; }
    size_t bytes() const noexcept { return bytes_; }
    Device device() const noexcept { return device_; }

private:
    void* data_ = nullptr;
    size_t bytes_ = 0;
    Device device_;
};

template <size_t Rank>
class Tensor {
public:
    using extents_t = std::dextents<int64_t, Rank>;

    Tensor(std::array<int64_t, Rank> shape, DType dtype, Device dev) : dtype_(dtype) {
        int64_t numel = 1;
        for (auto s : shape) numel *= s;
        size_t bytes = static_cast<size_t>(numel) * dtype_size(dtype);
        storage_ = std::make_shared<Storage>(bytes, dev);
        shape_ = shape;
        // contiguous strides, row-major
        strides_[Rank - 1] = 1;
        for (int i = static_cast<int>(Rank) - 2; i >= 0; --i) {
            strides_[i] = strides_[i + 1] * shape_[i + 1];
        }
    }

    // View constructor
    Tensor(std::shared_ptr<Storage> s,
           std::array<int64_t, Rank> shape,
           std::array<int64_t, Rank> strides,
           int64_t offset,
           DType dtype)
        : storage_(std::move(s)), shape_(shape), strides_(strides),
          offset_(offset), dtype_(dtype) {}

    template <typename T>
    std::mdspan<T, extents_t> as_mdspan() {
        // Build the dynamic extents from shape_
        auto e = make_extents(std::make_index_sequence<Rank>{});
        T* base = static_cast<T*>(storage_->data()) + offset_;
        // Note: std::mdspan with custom layout_stride for non-contiguous views
        return std::mdspan<T, extents_t>(base, e);
    }

    bool is_contiguous() const {
        int64_t expected = 1;
        for (int i = static_cast<int>(Rank) - 1; i >= 0; --i) {
            if (strides_[i] != expected) return false;
            expected *= shape_[i];
        }
        return true;
    }

    Tensor<Rank> contiguous() const {
        if (is_contiguous()) return *this;
        Tensor<Rank> out(shape_, dtype_, storage_->device());
        // Real impl: dispatch to a copy kernel that handles strides.
        return out;
    }

    int64_t numel() const {
        int64_t n = 1; for (auto s : shape_) n *= s; return n;
    }

    const std::array<int64_t, Rank>& shape() const { return shape_; }
    const std::array<int64_t, Rank>& strides() const { return strides_; }
    DType dtype() const { return dtype_; }
    void* data_ptr() const {
        return static_cast<char*>(storage_->data())
             + offset_ * dtype_size(dtype_);
    }

private:
    template <size_t... Is>
    auto make_extents(std::index_sequence<Is...>) const {
        return extents_t{shape_[Is]...};
    }

    std::shared_ptr<Storage> storage_;
    std::array<int64_t, Rank> shape_{};
    std::array<int64_t, Rank> strides_{};
    int64_t offset_ = 0;
    DType dtype_;
};

}  // namespace mlc
```

A few design choices worth calling out.

**Rank is a template parameter.** This trades flexibility for performance. The shape and stride arrays are stack-allocated. PyTorch uses a `SmallVector` (stack storage up to 5 dims, heap beyond) for the same reason. For inference, ranks above 5 are vanishingly rare (4D activations, 5D for video). Templating on rank lets the compiler unroll loops and removes a heap allocation per tensor.

**Storage is shared_ptr.** This gives you cheap views. A transpose, a slice, a reshape all share the same buffer. The buffer is freed when the last view drops. In a hot loop you want to be careful: keeping a single token's KV cache slice alive can pin a megabyte page.

**dtype is an enum.** The alternative is to template on dtype too. PyTorch chose enum for ergonomics, this lets you store heterogeneous tensors in containers and dispatch at runtime. ATen pays a virtual call cost per op that templated dtype would avoid, but the JIT and Inductor compile away the dispatch for traced graphs.

**No autograd.** Inference does not need it. Cutting autograd from your tensor type means no version counter, no `requires_grad` flag, no `grad_fn` pointer, smaller TensorImpl. PyTorch's `InferenceMode` does this dynamically. A from-scratch inference engine should never have autograd in the type at all.

### Layouts Beyond NCHW

For attention, the canonical layout is `[batch, num_heads, seq, head_dim]` with `head_dim` innermost. FlashAttention works on this layout. For PagedAttention, the KV cache uses a block layout: `[num_blocks, num_heads, block_size, head_dim]` for K and `[num_blocks, num_heads, head_dim, block_size]` for V. The K vs V layout difference is deliberate. K is read once per token to compute scores. V is read on the contracted dimension to mix into the output. Putting the block_size on the inner axis for V gives coalesced reads when scoring.

For MoE expert weights, the layout is `[num_experts, intermediate_size, hidden_size]` with the expert axis outermost. Routing an input to an expert is a strided gather followed by a contiguous GEMM.

Picking the right layout for each tensor type is the single largest source of performance gains in a hand-tuned engine. Most engines spend their first six months getting layouts wrong, then refactor.

### Senior at FAANG: Layout-Aware Op Dispatch

At Meta and Google, the inference codebases have an explicit `MemoryFormat` enum and the dispatcher routes to different kernels based on it. Convolution on NHWC float16 hits one cuDNN algorithm, on NCHW float32 it hits another. The kernel author writes both. The framework picks. As an L5+, you will be expected to read the cuDNN algorithm tables, run benchmarks, and update the dispatch heuristics when a new GPU generation changes the optimal pick.

The next section covers ONNX Runtime, the most widely deployed inference runtime in the industry.

---
