## Multi-GPU Host Orchestration

A multi-GPU inference process has one host process and N CUDA contexts. The host code orchestrates: it allocates memory on each device, launches kernels on each device, runs NCCL collectives across them, and copies inputs / outputs to the right device. This section covers the C++ patterns that make this work without serializing the GPUs against the host.

### The Host Threading Model

Two viable models.

**Single host thread per device.** N threads, each pinned to one GPU. Each thread creates a CUDA stream, runs the model forward for that GPU, participates in NCCL collectives. The threads sync at NCCL calls (which are host-async on the GPU but block-style on the host until the call returns).

**Single host thread for all devices.** One thread iterates devices, calls `cudaSetDevice`, launches kernels. Simpler, but the host becomes a bottleneck because kernel launch is synchronous on the calling thread.

For TP=8 the per-thread model wins. For TP=2 the single-thread model is fine. The cutoff is around TP=4.

```cpp
class TPInferenceProcess {
public:
    TPInferenceProcess(int world_size) : world_size_(world_size) {
        // Initialize NCCL
        ncclUniqueId id;
        if (rank_zero()) ncclGetUniqueId(&id);
        broadcast_id(id);

        for (int rank = 0; rank < world_size_; ++rank) {
            workers_.emplace_back([this, rank, id] { worker_loop(rank, id); });
        }
    }

private:
    void worker_loop(int rank, ncclUniqueId id) {
        cudaSetDevice(rank);
        ncclComm_t comm;
        ncclCommInitRank(&comm, world_size_, id, rank);

        cudaStream_t stream;
        cudaStreamCreate(&stream);

        // Per-rank model shard
        ModelShard model(rank, world_size_);
        model.load_weights(rank);

        // Main loop
        while (running_) {
            auto batch = scheduler_.next_batch_for(rank);
            model.forward(batch, comm, stream);
            cudaStreamSynchronize(stream);
            scheduler_.commit(rank, batch);
        }

        ncclCommDestroy(comm);
        cudaStreamDestroy(stream);
    }

    int world_size_;
    std::vector<std::thread> workers_;
    Scheduler scheduler_;
    std::atomic<bool> running_{true};
};
```

The synchronization between threads: typically a barrier per iteration, since all ranks must call NCCL ops in lock-step.

### Multi-Stream and cudaEvent

Within a single GPU, you can have multiple CUDA streams. Independent work runs concurrently. Two main uses:

1. **Compute / copy overlap.** Stream A runs the kernel, stream B does an async H2D copy of the next iteration's input. The two overlap.

2. **Compute / collective overlap.** Stream A computes the next layer's GEMM, stream B does the previous layer's all-reduce. The all-reduce hides behind compute.

```cpp
cudaStream_t compute, comm;
cudaStreamCreate(&compute);
cudaStreamCreate(&comm);

cudaEvent_t reduce_done;
cudaEventCreate(&reduce_done);

for (int layer = 0; layer < num_layers; ++layer) {
    // GEMM on compute stream
    gemm_layer(weights[layer], x, y, compute);

    // All-reduce on comm stream, depending on the GEMM result
    cudaStreamWaitEvent(comm, gemm_done, 0);  // wait for the layer's GEMM
    ncclAllReduce(y, y, n, ncclHalf, ncclSum, nccl_comm_, comm);
    cudaEventRecord(reduce_done, comm);

    // Next layer's input is the reduced y - compute stream waits
    cudaStreamWaitEvent(compute, reduce_done, 0);
    rmsnorm(y, x_next, compute);
}
```

The `cudaEvent_t` / `cudaStreamWaitEvent` pair is the synchronization primitive between streams. Use it sparingly, over-synchronization just serializes again.

### Pinned Memory for Host Transfer

Copies between host and device use the PCIe bus. Default host memory is pageable, which forces the CUDA driver to first copy to a pinned staging buffer, then DMA. Two copies. Pinned memory skips the staging step.

```cpp
void* pinned;
cudaMallocHost(&pinned, n_bytes);  // pinned, page-locked

// Async D2H copy
cudaMemcpyAsync(pinned, gpu_buf, n_bytes, cudaMemcpyDeviceToHost, stream);
```

For an inference server, allocate pinned input and output buffers per worker thread at startup. Copy request inputs into the pinned buffer (CPU memcpy), then async H2D into the GPU.

Pinned allocations are expensive (`cudaMallocHost` can take hundreds of ms). Pool them. Never allocate pinned memory in the request hot path.

### NCCL Collective Patterns

The collectives every inference engineer should know:

**All-reduce.** Each rank contributes a tensor. Result is `sum(all tensors)` on every rank. Used after a row-parallel layer.

```cpp
ncclAllReduce(send, recv, count, ncclHalf, ncclSum, comm, stream);
```

**All-gather.** Each rank contributes a slice. Result is the concatenation, on every rank. Used to gather tensor-parallel sharded results.

```cpp
ncclAllGather(send, recv, count_per_rank, ncclHalf, comm, stream);
```

**Reduce-scatter.** Each rank contributes a full tensor. Result is `sum / scatter`: each rank gets its slice of the sum. Used as the inverse of all-gather.

```cpp
ncclReduceScatter(send, recv, count_per_rank, ncclHalf, ncclSum, comm, stream);
```

**Broadcast.** One rank's data copied to all. Used at startup to distribute the unique ID, weights from a master rank, etc.

```cpp
ncclBroadcast(buf, buf, count, ncclHalf, /*root=*/0, comm, stream);
```

**Send / Recv.** Point-to-point. Used for pipeline parallel hand-offs and KV cache transfer.

```cpp
ncclSend(send_buf, count, ncclHalf, peer, comm, stream);
ncclRecv(recv_buf, count, ncclHalf, peer, comm, stream);
```

The choice between all-reduce and reduce-scatter+all-gather depends on the layer's data flow. For TP, all-reduce is the standard. For ZeRO-style sharded inference, reduce-scatter feeds the next layer's sharded computation.

### NCCL Group Operations

For multiple non-blocking collectives that should be batched together, use a group:

```cpp
ncclGroupStart();
ncclSend(send_a, n, ncclHalf, peer_a, comm, stream);
ncclRecv(recv_b, n, ncclHalf, peer_b, comm, stream);
ncclGroupEnd();
```

Without the group, send and recv would block waiting for each other (deadlock if the peer is also doing the symmetric pair).

### MPI Alternative

NCCL is GPU-aware and the right choice for GPU collectives. MPI (Message Passing Interface) is the older HPC equivalent. You see it in:

- Pre-CUDA-10 codebases that have not migrated.
- Job launchers (mpirun, srun) that do process spawning. Even when using NCCL for compute, you might use MPI to start the processes.
- Mixed CPU / GPU codebases (some legacy supercomputing inference).

For a from-scratch inference engine in 2026, use NCCL for collectives, your own (or torchrun-style) job launcher for spawning. MPI is heavyweight and adds dependencies.

### Multi-GPU Memory Pool

Each GPU has its own VRAM. Allocations are device-specific. A typical engine has:

- Per-rank weight memory (`cudaMalloc`).
- Per-rank KV cache pool (`cudaMallocAsync` from a stream-ordered pool).
- Per-rank workspace (transient activations).
- Per-rank pinned host buffer (for input/output).

A `cudaMemPool_t` per device with a configured release threshold:

```cpp
cudaMemPool_t pool;
cudaDeviceGetDefaultMemPool(&pool, device);
size_t threshold = 2ULL << 30;  // hold 2 GB before releasing back to OS
cudaMemPoolSetAttribute(pool, cudaMemPoolAttrReleaseThreshold, &threshold);

void* buf;
cudaMallocFromPoolAsync(&buf, n_bytes, pool, stream);
// ...
cudaFreeAsync(buf, stream);  // freed back to pool, available next iter
```

The pool means transient buffers are reused without crossing the system allocator. Latency drops dramatically.

### Peer-to-Peer Memory Access

GPUs in the same NVLink island can directly access each other's memory.

```cpp
cudaSetDevice(0);
cudaDeviceEnablePeerAccess(/*peer=*/1, 0);

cudaSetDevice(1);
cudaDeviceEnablePeerAccess(0, 0);

// Now device 0 can read/write device 1's buffers
half* dev1_ptr = ...;  // allocated on device 1
cudaSetDevice(0);
cudaMemcpyAsync(my_dev0_buf, dev1_ptr, n, cudaMemcpyDeviceToDevice, stream);
```

P2P is faster than going through host. NCCL uses it automatically when topology supports it. You only call P2P APIs directly if you have hand-rolled cross-GPU code (uncommon outside of NCCL itself).

### Senior at FAANG: Topology-Aware Communication

Real DGX systems have asymmetric NVLink topology. On DGX H100, two clusters of 4 GPUs each, with cross-cluster bandwidth lower than within-cluster. NCCL's tree algorithms account for this. But your scheduling can too:

- Place TP=4 within a single NVSwitch cluster of 4 GPUs. Two TP groups per node.
- Use the second TP group as a separate replica (DP=2 within node, TP=4 each).

For NVL72 (Blackwell rack with 72 GPUs on a single NVSwitch fabric), the topology is uniform. TP=8 or TP=16 inside one rack with full bisection bandwidth. This is why NVL72 deployments hit numbers single-node H100 cannot.

Reading the topology: `nvidia-smi topo -m` shows the GPU-to-GPU connection matrix. Your engine should query it at startup (`cuDeviceGetP2PAttribute`, `cuDeviceCanAccessPeer`) and pick a TP grouping that maximizes bandwidth.

The next section steps off the GPU and covers CPU inference.

---
