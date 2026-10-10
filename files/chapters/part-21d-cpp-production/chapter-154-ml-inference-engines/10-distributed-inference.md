## Distributed Inference

A 70B model in FP16 does not fit on one H100 (140 GB weights, 80 GB VRAM). A 405B model does not fit on eight H100s (810 GB weights, 640 GB VRAM in a DGX). Distributed inference is the path. This section covers the parallelism strategies and the C++ collective communication code that makes them work.

### Parallelism Strategies

There are four kinds of parallelism in modern inference.

**Data parallel (DP).** Multiple GPUs each run the full model independently on different requests. No communication during forward. Used at the cluster level (replicas), not within a single inference for one request.

**Tensor parallel (TP).** Split each layer's weight matrices across GPUs. Each GPU computes a slice of the activation. Requires all-reduce per layer. Standard for fitting big models in memory and getting compute parallelism within a single request.

**Pipeline parallel (PP).** Split the layers across GPUs. GPU 0 has layers 0-9, GPU 1 has layers 10-19, etc. Activations flow stage-to-stage. Requires point-to-point sends, no all-reduce. Lower bandwidth need than TP but higher latency (pipeline bubbles).

**Expert parallel (EP).** For Mixture-of-Experts (MoE) models. Each GPU holds a subset of the experts. The router sends each token to the right GPU. All-to-all communication.

In production an LLM uses TP within a node (8 GPUs over NVLink) and PP across nodes (multi-node) when the model does not fit in one node. MoE models add EP on top.

### Tensor Parallel: Megatron-Style

For a linear layer `Y = X @ W`, with `W` of shape `[hidden, hidden_out]`, you split `W` along one axis.

**Column parallel.** Split `W` along `hidden_out`. Each GPU computes a slice of `Y`. No reduction needed (concat is free if downstream consumer expects sliced layout).

```
GPU 0: Y[:, 0:N/2]  = X @ W[:, 0:N/2]
GPU 1: Y[:, N/2:N]  = X @ W[:, N/2:N]
```

**Row parallel.** Split `W` along `hidden`. Each GPU computes a partial sum. All-reduce to combine.

```
GPU 0: Y_partial = X[:, 0:H/2] @ W[0:H/2, :]
GPU 1: Y_partial = X[:, H/2:H] @ W[H/2:H, :]
all_reduce(Y_partial)
Y = sum of partials
```

A transformer block has the pattern: column-parallel projection, then row-parallel projection. The activations between them are sharded along the feature axis (no comm needed). The only all-reduce per layer is the one after the row-parallel projection. Two all-reduces per transformer block (one for attention output projection, one for MLP down projection).

```cpp
// Pseudo-skeleton for a TP transformer block forward
void tp_block_forward(const half* x, half* out, int rank, int world_size,
                      ncclComm_t comm, cudaStream_t stream) {
    half* x_norm = rmsnorm(x);

    // Column-parallel QKV projection: each rank gets H/world_size heads
    half* qkv_local = gemm(x_norm, w_qkv_shard);   // [B*S, 3 * H/W * D]

    // Per-rank attention (each rank has its own heads)
    half* attn_out_local = flash_attention(qkv_local);  // [B*S, H/W * D]

    // Row-parallel output projection
    half* attn_out_partial = gemm(attn_out_local, w_o_shard);  // [B*S, hidden]

    // All-reduce
    ncclAllReduce(attn_out_partial, attn_out_partial,
                  B*S*hidden, ncclHalf, ncclSum, comm, stream);

    half* attn_out = attn_out_partial + x;  // residual

    // MLP, same pattern
    half* mlp_norm = rmsnorm(attn_out);
    half* gate_up = gemm(mlp_norm, w_gate_up_shard);  // column parallel
    half* swiglu = swiglu_activation(gate_up);
    half* mlp_partial = gemm(swiglu, w_down_shard);   // row parallel
    ncclAllReduce(mlp_partial, mlp_partial, B*S*hidden, ncclHalf, ncclSum, comm, stream);

    out = mlp_partial + attn_out;
}
```

Two all-reduces per layer, 32 to 80 layers in a typical model. Bandwidth dominates.

For TP=8 on an H100 NVL (NVLink, 900 GB/s per GPU), the all-reduce takes microseconds and is hidden by overlap. For TP=8 across nodes (PCIe + InfiniBand at ~50 GB/s), all-reduce becomes a serious latency tax. This is why TP stays inside a node.

### Pipeline Parallel: 1F1B

Pipeline parallel splits layers across stages. GPU 0 has layers 0-19, GPU 1 has layers 20-39, etc. For a single request:

```
GPU 0: forward layers 0-19, send activation to GPU 1
GPU 1: receive, forward layers 20-39, send to GPU 2
...
```

For a single request this is *slower* than TP because only one GPU is active at a time (the others wait). The trick is to pipeline multiple micro-batches:

```
time-> 1     2     3     4     5     6     7
GPU0: F1    F2    F3    F4    -     -     -
GPU1:  -    F1    F2    F3    F4    -     -
GPU2:  -    -     F1    F2    F3    F4    -
GPU3:  -    -     -     F1    F2    F3    F4
```

After the warm-up, all GPUs are busy. The "1F1B" schedule (one forward, one backward) was for training, for inference the analog is just forward but with continuous batching. Each GPU is always running a different micro-batch.

In C++ each stage is a worker thread holding a CUDA stream. NCCL Send / Recv (point-to-point) move activations:

```cpp
void stage_worker(int stage, int num_stages, ncclComm_t comm) {
    while (running) {
        // Receive activation from prev stage
        if (stage > 0) {
            ncclRecv(recv_buf, num_elements, ncclHalf, stage - 1, comm, stream);
        } else {
            recv_buf = embed_input(input_token_ids);
        }

        // Forward through this stage's layers
        forward_my_layers(recv_buf, send_buf);

        // Send to next stage
        if (stage < num_stages - 1) {
            ncclSend(send_buf, num_elements, ncclHalf, stage + 1, comm, stream);
        } else {
            run_lm_head_and_sample(send_buf);
        }
    }
}
```

Pipeline parallel adds latency (you eat `num_stages * stage_latency` for one token), so you only use it when TP cannot fit the model in one node. For Llama 3 70B you can do TP=8 inside a DGX H100 and skip PP. For 405B and beyond you typically do TP=8 within a node, PP=2 across two nodes.

### Expert Parallel: MoE

Mixtral 8x22B, DeepSeek v3, GPT-OSS, Qwen MoE: these models have many experts per MLP layer (8 to 256), and each token routes to a small subset (2 to 8). The expert weights are huge in aggregate but only a few are used per token.

EP places experts on different GPUs. The router computes which experts each token needs. Tokens flow to the expert GPUs (all-to-all), get processed, and flow back (all-to-all):

```cpp
void moe_forward(const half* x, half* y, int num_experts_per_rank,
                 ncclComm_t comm, cudaStream_t stream) {
    // 1. Local routing: which expert does each token go to?
    int* expert_assign = compute_router(x);  // [num_tokens, top_k]

    // 2. Permute tokens by destination expert / rank
    half* permuted_x = permute_by_expert(x, expert_assign);
    int* counts_send = ...;  // tokens to send to each rank

    // 3. All-to-all dispatch
    ncclAllToAllv(permuted_x, counts_send, displs_send,
                  recv_buf, counts_recv, displs_recv,
                  ncclHalf, comm, stream);

    // 4. Local expert computation: each rank runs its own experts
    half* expert_out = run_local_experts(recv_buf, counts_recv);

    // 5. All-to-all combine: send results back to original rank
    ncclAllToAllv(expert_out, counts_recv, displs_recv,
                  combined, counts_send, displs_send,
                  ncclHalf, comm, stream);

    // 6. Unpermute and weighted sum (top-k gating)
    unpermute_and_sum(combined, expert_assign, y);
}
```

The all-to-all is the expensive step. NCCL has `ncclAllToAll` and `ncclAllToAllv` (variable counts per peer), but the throughput is limited by the slowest pair. For very large EP (>16 ranks) you typically use Microsoft's DeepEP or MoE-specific libraries that pipeline send/recv to hide latency.

DeepSeek v3's inference deploys EP=8 within a node (one node hosts 8 of 256 experts) and DP across nodes for replicas. The MoE communication is ~50% of decode latency. Optimizing it (DeepEP, low-latency InfiniBand RDMA) is a research-and-engineering frontier.

### NCCL: The C++ Collective Library

NCCL is NVIDIA's collective library. The core operations:

| Operation | Pattern |
|-----------|---------|
| `ncclAllReduce` | Sum / max / min / avg across all ranks, result on every rank |
| `ncclAllGather` | Gather input from all ranks, concat result on every rank |
| `ncclReduceScatter` | Like all-reduce but result is scattered (each rank gets a slice) |
| `ncclBroadcast` | One rank's data copied to all |
| `ncclSend` / `ncclRecv` | Point-to-point |
| `ncclAllToAll` | Each rank sends a different slice to each other rank |

The C++ usage pattern:

```cpp
ncclUniqueId id;
if (rank == 0) ncclGetUniqueId(&id);
broadcast_unique_id(id);  // via your job-launcher (MPI / SLURM / your own)

ncclComm_t comm;
ncclCommInitRank(&comm, world_size, id, rank);

cudaStream_t stream;
cudaStreamCreate(&stream);

ncclAllReduce(send_buf, recv_buf, count, ncclHalf, ncclSum, comm, stream);
cudaStreamSynchronize(stream);

ncclCommDestroy(comm);
```

Gotchas:

1. **NCCL is async.** It returns immediately, the work is queued on the stream. You must sync the stream to be sure it is done.
2. **All ranks must call NCCL ops in the same order.** Out-of-order calls deadlock.
3. **NCCL versions matter.** Match the NCCL version across your cluster. Mixing 2.18 and 2.20 has caused production outages.

### Bandwidth Budget

The interconnect bandwidth determines what is feasible.

| Link | Bandwidth | Latency | Use |
|------|-----------|---------|-----|
| NVLink 4 (Hopper) | 900 GB/s per GPU | ~1 us | TP within node |
| NVLink 5 (Blackwell NVL72) | 1.8 TB/s per GPU | ~1 us | TP within rack-scale (72 GPUs) |
| PCIe 5.0 x16 | 64 GB/s | ~5 us | GPU<->CPU, GPU<->NIC |
| InfiniBand NDR (400 Gbps) | ~50 GB/s | ~2 us | Cross-node |
| InfiniBand XDR (800 Gbps) | ~100 GB/s | ~2 us | Cross-node 2026+ |
| Ethernet RoCE (400 Gbps) | ~50 GB/s | ~5 us | Cross-node, cheaper |

For TP, you need ~hidden_size * 2 bytes per layer per rank, twice per layer. At hidden=8192, FP16, that is 32 KB per layer per rank. 80 layers = 2.6 MB per token per rank. Across 8 ranks all-reducing twice per layer over NVLink at 900 GB/s, the comm time is microseconds, dominated by latency rather than bandwidth.

For decode TP across PCIe (100x slower than NVLink), this becomes milliseconds per layer. Decode TP across PCIe is unworkable. NVLink-equipped nodes are not optional for production inference.

### Senior at FAANG: Choosing the Parallelism

The decision tree for a new model deployment:

1. Does the model fit in one GPU's HBM (weights + KV budget)? Yes -> single GPU + DP replicas. Done.
2. Does it fit in one NVLink-connected node? Yes -> TP within node + DP across nodes.
3. Does it fit in two NVLink nodes? Yes -> TP within node + PP across two nodes + DP for replicas.
4. Is it MoE? Add EP for the expert layers.

For Llama 3 70B: TP=8 on one DGX, replicate. For Llama 3 405B: TP=8 + PP=2 on two DGXs, replicate. For DeepSeek v3 (671B with 37B active per token, MoE): TP=8 + EP=8 within a node, replicate.

The next section covers batching strategies.

---
