## GPU Crash Triage and Debugging

GPU crashes are categorically worse than CPU crashes. A CPU segfault produces a core file with symbols. A GPU fault produces a `CUDA error: an illegal memory access was encountered` message, potentially dozens of kernel launches after the offending one, with the host process still running but every subsequent CUDA call returning the same sticky error. Triage requires specific tooling and discipline.

### Synchronous error checking

CUDA runtime errors from kernel launches are reported asynchronously by default. The error surfaces on the next synchronizing call, not on the call that caused it. During development, force synchronous reporting with the environment variable `CUDA_LAUNCH_BLOCKING=1`, which serializes every launch and surfaces errors immediately.

```cpp
#define CHECK_CUDA(call)                                                   \
    do {                                                                   \
        cudaError_t e = (call);                                            \
        if (e != cudaSuccess) {                                            \
            fprintf(stderr, "CUDA %s at %s:%d: %s\n", #call,               \
                    __FILE__, __LINE__, cudaGetErrorString(e));            \
            std::abort();                                                  \
        }                                                                  \
    } while (0)

#define CHECK_LAST()                                                       \
    CHECK_CUDA(cudaPeekAtLastError());                                     \
    CHECK_CUDA(cudaDeviceSynchronize());
```

`cudaPeekAtLastError` does not clear the error, which is what you want so the next check sees the same state. Put `CHECK_LAST` after every launch during debugging, remove for release builds only after the kernel is proven stable.

### compute-sanitizer

The CUDA equivalent of ASan is `compute-sanitizer` (the successor to `cuda-memcheck`). It has four tools:

```
compute-sanitizer --tool memcheck   ./app   # OOB and misaligned access
compute-sanitizer --tool racecheck  ./app   # shared-memory data races
compute-sanitizer --tool initcheck  ./app   # uninitialized reads
compute-sanitizer --tool synccheck  ./app   # barrier misuse
```

Each tool instruments kernel code and reports faults with source attribution if the binary was compiled with `-lineinfo` (which is nearly free, unlike `-G` full debug). Make `memcheck` and `racecheck` mandatory CI gates for every kernel change, at least on a representative workload. One bad shared-memory access past a block barrier corrupts every launch afterward and will not appear in standard testing.

### Nsight Systems and Nsight Compute

Nsight Systems profiles at the timeline level: kernel launches, memcpy, streams, CPU activity, NVTX ranges. It answers "why is my GPU idle at 40 percent." Nsight Compute profiles a single kernel at the PTX/SASS level: memory throughput, occupancy, stall reasons. It answers "why is this kernel at 20 percent of peak."

Annotate code with NVTX ranges so the timeline is readable:

```cpp
#include <nvtx3/nvToolsExt.h>
nvtxRangePushA("inference_batch");
for (...) { launch_kernel(); }
nvtxRangePop();
```

Without NVTX, Nsight shows an undifferentiated wall of `vector_add` launches. With it, the timeline reads like a flame graph.

### Debugging a kernel with cuda-gdb

`cuda-gdb` attaches to a host process and can set breakpoints inside kernels. It switches context between CPU threads and CUDA warps with `cuda thread` and `cuda block`.

```
cuda-gdb ./app
(cuda-gdb) break my_kernel
(cuda-gdb) run
(cuda-gdb) cuda thread (8,0,0) block (1,0,0)
(cuda-gdb) info locals
(cuda-gdb) p shared_tile[threadIdx.x]
```

Compile with `-G` for full debug, which disables most optimizations. Alternatively `-lineinfo -Xcompiler=-rdynamic` keeps optimization and still supplies source line numbers, which is usually enough for crash triage.

### Handling sticky context errors

Once a CUDA context hits an illegal memory access, every subsequent call on that context returns the same error. You cannot recover in-place. The only clean actions are to abort the process or destroy and recreate the context:

```cpp
cudaError_t err = cudaDeviceSynchronize();
if (err != cudaSuccess) {
    LOG(ERROR) << "device unrecoverable: " << cudaGetErrorString(err);
    cudaDeviceReset();  // destroys all allocations, streams, events
    std::exit(EXIT_FAILURE);
}
```

Long-running inference servers that handle tenant errors must isolate each tenant in a separate CUDA context (or even a separate process with MPS) so one bad kernel does not take down the fleet.

### Out-of-memory on the device

Device OOM is a cleanly reported error (`cudaErrorMemoryAllocation`), unlike host OOM. But the device has no swap, so policy is binary: either your workload fits or it fails. Track `cudaMemGetInfo(&free, &total)` before large allocations, pre-allocate a single arena at startup (`cudaMallocAsync` against a memory pool), and refuse admission when the pool cannot satisfy the request. This avoids fragmentation spirals where `free` is large but no contiguous allocation succeeds.

### XID errors: the GPU told the driver it is unhealthy

`dmesg | grep NVRM` surfaces XID events. XID 13 is a graphics engine error, XID 31 is a MMU fault, XID 79 is a GPU fallen off the bus. XID 79 is terminal, the device will not recover without a reboot. Production monitoring should scrape `nvidia-smi -q -x` and alert on XID events immediately. A silent XID 31 often precedes a cluster-wide job failure by seconds.

### Reproducing a crash

Crashes at 0.01 percent of kernel launches are common. Reproduce by:

1. Capturing the exact input tensor (shapes, dtype, content hash).
2. Fixing the random seed and cuBLAS/cuDNN workspace to deterministic.
3. Running under `compute-sanitizer memcheck` with the captured input.
4. If it reproduces, bisect across recent kernel changes. If it does not, the bug is racy, switch to `racecheck` and pin to a single stream.

### What the postmortem requires

Driver version, CUDA runtime version, SM architecture, kernel source hash, NVTX range that was active, input shapes and dtypes, compute-sanitizer output from a reproduction attempt, Nsight Compute report for the suspect kernel, and a regression test. Without the reproduction, the bug is filed as "flaky" and will return.
