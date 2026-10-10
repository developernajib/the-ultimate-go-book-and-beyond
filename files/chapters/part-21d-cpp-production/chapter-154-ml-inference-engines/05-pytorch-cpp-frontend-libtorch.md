## PyTorch C++ Frontend (LibTorch)

LibTorch is the C++ distribution of PyTorch. It ships the same ATen tensor library, the same autograd engine, the same JIT, the same dispatcher, and the same kernel set as the Python version, with no Python interpreter. You link against `libtorch.so` (and `libtorch_cuda.so`, `libc10.so`, `libc10_cuda.so`) and write inference code in C++.

It is the fastest path from a researcher's `model.pt` checkpoint to a production C++ binary, because there is no graph conversion step. What ran in Python eager mode runs in C++ with byte-exact output.

### torch::Tensor

`torch::Tensor` is the C++ alias for `at::Tensor`. The full ATen API is exposed.

```cpp
#include <torch/torch.h>
#include <iostream>

int main() {
    torch::manual_seed(42);

    auto x = torch::randn({4, 3, 224, 224}, torch::kCUDA);
    auto y = torch::nn::functional::softmax(
        x.flatten(1), torch::nn::functional::SoftmaxFuncOptions(-1));

    std::cout << y.sizes() << " on " << y.device() << '\n';

    // Slicing
    auto top_left = x.index({torch::indexing::Slice(),
                             torch::indexing::Slice(),
                             torch::indexing::Slice(0, 32),
                             torch::indexing::Slice(0, 32)});
    std::cout << top_left.sizes() << '\n';

    // Math: same names as Python, no underscores for non-mutating
    auto z = x.mean({2, 3});  // pool spatial dims
    auto z_relu = torch::relu(z);
}
```

Two API styles exist. The `torch::Tensor` member style (`x.mean({2, 3})`) and the free-function style (`torch::mean(x, {2, 3})`). They generate the same dispatch. Pick one and keep your codebase consistent.

### InferenceMode

For inference, always wrap the entire request in `torch::InferenceMode`. This disables autograd metadata (no version counter, no view tracking, no `grad_fn`), which removes a non-trivial overhead per op:

```cpp
{
    torch::InferenceMode guard;
    auto out = model.forward({input}).toTensor();
}
```

Inside the guard, tensors created cannot have `requires_grad=true`. This is enforced at runtime. The savings are 5 to 15% of CPU op-dispatch time.

### jit::script_module: Loading TorchScript

A model is exported to TorchScript via either tracing (run an example input through, record the ops) or scripting (parse Python source). The result is a self-contained `.pt` file that ships the graph and the weights.

```cpp
#include <torch/script.h>

torch::jit::script::Module model = torch::jit::load("model.pt");
model.to(torch::kCUDA);
model.eval();

std::vector<torch::jit::IValue> inputs;
inputs.push_back(torch::randn({1, 3, 224, 224}, torch::kCUDA));

torch::Tensor output;
{
    torch::InferenceMode guard;
    output = model.forward(inputs).toTensor();
}

std::cout << output.sizes() << '\n';
```

`torch::jit::IValue` is a tagged union (like a `std::variant`) for everything Python could return: tensor, list of tensors, dict, tuple, int, str. You unwrap with `.toTensor()`, `.toList()`, etc.

### torch.compile and Inductor

`torch.compile` is the new compilation path. In Python:

```python
model = torch.compile(model, backend="inductor", mode="reduce-overhead")
```

Inductor lowers the graph to a custom IR, generates Triton or C++ kernels, and ships an optimized binary that lives in `~/.cache/torch_compile`. For inference deployments, the relevant artifact is **AOTI** (Ahead-Of-Time Inductor), which compiles the model to a shared library you load from C++.

```python
# Python build step
import torch
model = torch.load("model.pt").cuda().eval()
example = torch.randn(1, 3, 224, 224, device="cuda")
torch._inductor.aoti_compile_and_package(
    torch.export.export(model, (example,)),
    package_path="model.pt2",
    inductor_configs={"max_autotune": True},
)
```

```cpp
// C++ runtime
#include <torch/csrc/inductor/aoti_runner/model_container_runner_cuda.h>

torch::inductor::AOTIModelContainerRunnerCuda runner("model.pt2");
auto inputs = std::vector<torch::Tensor>{
    torch::randn({1, 3, 224, 224}, torch::kCUDA)};
auto outputs = runner.run(inputs);
```

AOTI is the LibTorch path that competes with TensorRT and ONNX Runtime for serving, with the advantage of no graph conversion (the model authors stay in PyTorch). Performance is typically within 10% of TensorRT for vision models and within 20% for LLMs without specialized attention kernels.

### Building a C++ Inference Server

A minimal HTTP server using LibTorch and a thread pool. This sketch uses a hand-rolled queue, in production you would use a real HTTP framework (Pistache, Drogon, hand-rolled epoll, gRPC).

```cpp
#include <torch/script.h>
#include <torch/torch.h>
#include <thread>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <future>
#include <atomic>

struct Request {
    torch::Tensor input;
    std::promise<torch::Tensor> reply;
};

class Server {
public:
    Server(const std::string& path, int n_workers, torch::Device dev)
        : device_(dev) {
        for (int i = 0; i < n_workers; ++i) {
            // Each worker loads its own copy. Models are typically large
            // enough that you want this on the GPU once and shared, but
            // for CPU models per-worker copies avoid lock contention.
            workers_.emplace_back([this, path] { worker_loop(path); });
        }
    }

    ~Server() {
        stop_ = true;
        cv_.notify_all();
        for (auto& w : workers_) w.join();
    }

    std::future<torch::Tensor> submit(torch::Tensor input) {
        Request r{std::move(input), {}};
        auto fut = r.reply.get_future();
        {
            std::lock_guard lk(mu_);
            queue_.push(std::move(r));
        }
        cv_.notify_one();
        return fut;
    }

private:
    void worker_loop(const std::string& path) {
        auto module = torch::jit::load(path);
        module.to(device_);
        module.eval();

        while (!stop_) {
            Request r;
            {
                std::unique_lock lk(mu_);
                cv_.wait(lk, [this] { return stop_ || !queue_.empty(); });
                if (stop_) return;
                r = std::move(queue_.front());
                queue_.pop();
            }
            try {
                torch::InferenceMode guard;
                std::vector<torch::jit::IValue> in{r.input.to(device_)};
                auto out = module.forward(in).toTensor().to(torch::kCPU);
                r.reply.set_value(std::move(out));
            } catch (...) {
                r.reply.set_exception(std::current_exception());
            }
        }
    }

    torch::Device device_;
    std::vector<std::thread> workers_;
    std::queue<Request> queue_;
    std::mutex mu_;
    std::condition_variable cv_;
    std::atomic<bool> stop_{false};
};
```

Key points hidden in this sketch:

1. **One module per worker thread.** A `script::Module` is not thread-safe for `forward`. Even if it were, multiple threads sharing one module on the same CUDA stream would serialize anyway. Per-worker module + per-worker stream is the standard pattern.

2. **Inputs cross the device boundary explicitly.** The request comes in on CPU, gets `.to(device_)` once, and the output gets `.to(kCPU)` at the end. For high throughput you use pinned host memory for both ends (`torch::TensorOptions().pinned_memory(true)`).

3. **`InferenceMode` per request.** Cheap to enter, expensive to skip.

4. **CUDA stream sync.** `tensor.to(kCPU)` on a CUDA tensor is a synchronizing op. That is fine for one-off requests, but for continuous batching you want non-blocking transfers and explicit `cudaEvent` sync.

### When LibTorch Is The Right Choice

LibTorch is the fastest "first deploy" because there is no model conversion step. It is the right choice when:

- The model uses ops that ONNX or TensorRT would not handle without custom plugins (custom CUDA kernels embedded in the Python model, complex control flow, dynamic graphs).
- You want a single source of truth for training and inference. Researchers run the same code, deploy ships the same `.pt`.
- The team already knows PyTorch and the conversion tax (debugging shape mismatches, reimplementing custom ops in TRT plugins) outweighs the runtime gain.

It is the wrong choice when:

- You are running an LLM. Use TensorRT-LLM or vLLM. LibTorch on its own does not have PagedAttention or continuous batching.
- You need the absolute lowest latency. TRT will win.
- You need to fit the runtime on a tiny device. LibTorch ships hundreds of MB of binary, a TFLite or ONNX Runtime mobile build is a few MB.

### Senior at FAANG: The PyTorch Inductor Pipeline

At Meta, PyTorch is the framework, and the production inference path goes through `torch.export` -> AOTI -> C++ runtime. Senior engineers on the PyTorch team work on:

- Lowering rules in Inductor that pattern-match graph fragments into Triton or CUDA C++ kernels.
- The dispatch keyset machinery that routes ops to the right backend.
- The C10 dispatcher overhead reduction work, since each op call still goes through a hashtable lookup.
- Custom op registration mechanics for production-only ops (a special pre/post-processing op that should not exist in research).

Reading the PyTorch C++ source (`aten/src/ATen`, `torch/csrc/jit`, `torch/csrc/inductor`) is the apprenticeship that brings you up to L5 on the PyTorch internal team. Spend a week tracing a single `torch.matmul` call from Python down to cuBLASLt and you will understand more than 90% of the people writing PyTorch tutorials.

The next section drops into quantization, which is where the largest cost reductions in 2026 are coming from.

---
