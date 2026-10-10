## CUDA Graphs and Stream Capture

Each CUDA kernel launch costs about 5 to 10 microseconds of host overhead, regardless of the kernel's actual work. The decode loop launches dozens of kernels per layer, multiplied by 80 layers. For a 12-ms-per-token target, kernel launch overhead alone can be 2 to 4 ms. CUDA Graphs eliminate that by recording the kernel sequence once and replaying it with one launch.

### Graphs vs Streams

A CUDA stream is a queue. You enqueue kernels, the driver dispatches them in order. Each enqueue costs host CPU time.

A CUDA Graph is a recorded DAG of operations (kernels, memcpys, memsets, events). You build the graph once, instantiate it into a `cudaGraphExec_t`, and then `cudaGraphLaunch` the whole thing for the cost of a single enqueue.

Pattern:

```cpp
cudaStream_t stream;
cudaStreamCreate(&stream);

// Capture
cudaStreamBeginCapture(stream, cudaStreamCaptureModeThreadLocal);
my_kernel_1<<<g, b, 0, stream>>>(...);
cublasLtMatmul(/* on stream */);
my_kernel_2<<<g, b, 0, stream>>>(...);
// ... full decode iteration's worth of work
cudaGraph_t graph;
cudaStreamEndCapture(stream, &graph);

cudaGraphExec_t exec;
cudaGraphInstantiate(&exec, graph, nullptr, nullptr, 0);

// Launch (replayable)
for (int iter = 0; iter < 1000; ++iter) {
    cudaGraphLaunch(exec, stream);
}
cudaStreamSynchronize(stream);
```

The kernel call sequence between `BeginCapture` and `EndCapture` is recorded, not executed. The graph can be relaunched many times.

### What Graphs Do (and Do Not) Capture

Captured: kernel launches, cuBLAS / cuDNN / NCCL calls (with the right stream), `cudaMemcpyAsync`, `cudaMemsetAsync`, library calls that participate in capture.

Not captured: anything that needs immediate host data, anything synchronous, host-side branching. If your decode loop has a Python-style `if (sample == EOS) break`, that does not capture.

The way around it: capture *fixed-shape* iterations. Decode of one token for a fixed batch size is a fixed shape. Branch on the host before the launch (not inside the captured graph). For dynamic batch sizes, capture multiple graphs (one per common batch size) and pick the right one each iteration.

### Decode-Loop Capture

The pattern in vLLM and TensorRT-LLM:

```cpp
class DecodeGraphCache {
public:
    DecodeGraphCache(Model* m) : model_(m) {}

    // Returns the captured graph for this batch size, capturing if needed.
    cudaGraphExec_t get(int batch_size, cudaStream_t stream) {
        std::lock_guard lk(mu_);
        auto it = cache_.find(batch_size);
        if (it != cache_.end()) return it->second;

        // Capture
        cudaStreamBeginCapture(stream, cudaStreamCaptureModeThreadLocal);
        model_->decode_step(batch_size, /*input=*/dummy_input_dev_[batch_size],
                            /*output=*/dummy_output_dev_[batch_size], stream);
        cudaGraph_t graph;
        cudaStreamEndCapture(stream, &graph);

        cudaGraphExec_t exec;
        cudaGraphInstantiate(&exec, graph, nullptr, nullptr, 0);
        cudaGraphDestroy(graph);

        cache_[batch_size] = exec;
        return exec;
    }

private:
    Model* model_;
    std::mutex mu_;
    std::unordered_map<int, cudaGraphExec_t> cache_;
    // dummy input/output buffers per batch size
};
```

Then per iteration:

```cpp
auto exec = graph_cache_->get(batch_size, stream_);
// Update the input buffer in-place to the actual current token IDs
update_input_buffer(batch_size, current_tokens, stream_);
cudaGraphLaunch(exec, stream_);
```

The kernels in the graph reference fixed memory addresses (the `dummy_input_dev_[batch_size]` buffer). To change the input, you write to that buffer, then launch. The graph runs the same kernels but reads new data.

For an LLM decode loop this is a 5 to 30% speedup, because launch overhead was a real fraction of decode time.

### Graph Update API

When the input buffer pointer must change between launches (rare in inference but happens with paged KV), use `cudaGraphExecKernelNodeSetParams` to update node parameters without re-instantiation:

```cpp
cudaKernelNodeParams new_params{};
new_params.func = my_kernel;
new_params.gridDim = grid;
new_params.blockDim = block;
new_params.sharedMemBytes = 0;
new_params.extra = nullptr;
void* args[] = {&new_input_ptr, &new_output_ptr, &n};
new_params.kernelParams = args;

cudaGraphExecKernelNodeSetParams(exec, kernel_node, &new_params);
```

Slower than relaunching the same graph, faster than re-instantiating.

### Conditional Graph Nodes (CUDA 12.4+)

CUDA 12.4 added conditional nodes: an `IF` node with a body subgraph that runs only if a device-side condition variable is set, plus `WHILE` nodes for device-side loops.

```cpp
cudaGraphConditionalHandle handle;
cudaGraphConditionalHandleCreate(&handle, graph, /*default_value=*/1, 0);

cudaGraphNodeParams params{};
params.type = cudaGraphNodeTypeConditional;
params.conditional.handle = handle;
params.conditional.type = cudaGraphCondTypeIf;
params.conditional.size = 1;

cudaGraphNode_t cond_node;
cudaGraphAddNode(&cond_node, graph, /*deps=*/nullptr, 0, &params);

// Body subgraph (runs if handle != 0)
cudaGraph_t body = params.conditional.phGraph_out[0];
// add nodes to body...
```

A device-side kernel sets the handle:

```cpp
__global__ void check_eos(const int* tokens, cudaGraphConditionalHandle handle) {
    if (tokens[0] == EOS_TOKEN_ID) {
        cudaGraphSetConditional(handle, 0);  // skip body
    } else {
        cudaGraphSetConditional(handle, 1);  // run body
    }
}
```

This is how you fold "stop on EOS" or "skip layer if condition" into the captured graph without breaking out to host.

### When Graphs Hurt

Graphs are not always a win.

1. **Tiny work.** If your kernel is so small that launch overhead is a big fraction, graphs help. But if it is *too* small, the graph machinery itself has overhead (a few microseconds per launch). For per-iteration work below 10 us, just inline the kernel manually instead.

2. **Highly variable shape.** If batch size changes every iteration, you need a graph per shape. Memory cost adds up, compilation cost is hit on every new shape.

3. **NCCL inside graphs.** NCCL collectives can be captured (as of NCCL 2.18+) but require careful matching across all ranks. A single rank with a non-captured NCCL call deadlocks the cluster. Test thoroughly.

4. **Memory pool resets.** If your kernels allocate via cuMemAlloc inside the captured region, you need stream-ordered allocation (`cudaMallocAsync`) for graphs to capture them. Older `cudaMalloc` does not capture.

### Stream Capture Modes

Three capture modes:

- `cudaStreamCaptureModeGlobal`: any concurrent stream activity raises an error.
- `cudaStreamCaptureModeThreadLocal`: only this thread's other streams are checked.
- `cudaStreamCaptureModeRelaxed`: no checks.

Use thread-local for inference. It catches accidental cross-stream sync without breaking unrelated host threads.

### Senior at FAANG: vLLM and CUDA Graphs

vLLM captures one graph per `(batch_size)` value. The decoder runs ~30 different captured graphs, one for each batch size from 1 to 256 in tiered steps. The decision tree:

1. Get current batch size.
2. Round up to nearest captured batch size (1, 2, 4, 8, ..., 256).
3. Pad input to that size.
4. Launch the graph.

Padding is wasteful but launch overhead is more so. The 5-15% throughput gain at production scale pays for the extra padding tokens.

The next section covers multi-GPU host orchestration: how the C++ side manages multiple devices.

---
