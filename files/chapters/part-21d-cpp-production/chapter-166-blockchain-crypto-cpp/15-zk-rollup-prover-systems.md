## zk-Rollup Prover Systems

A zk-rollup is a Layer 2 that batches transactions, executes them off-chain, and posts a single zero-knowledge proof to Layer 1 attesting that the batch was executed correctly. The prover infrastructure that produces these proofs is the most computationally intensive system in crypto today, and it is where C++, CUDA, and FPGA engineering converge.

This section covers the production prover stacks of the major zkEVMs (Polygon zkEVM, Scroll, zkSync, Linea), the GPU pipeline architecture, and the hardware-acceleration trends.

### What a Prover Pipeline Looks Like

The end-to-end prover pipeline for a typical zkEVM batch:

1. **Trace generation**. Execute the EVM batch and record every state transition as a sequence of opcodes plus their pre- and post-state.
2. **Witness generation**. For each opcode in the trace, populate the constraint system's wires. This produces a giant table of field elements (typically 50 to 200 million entries per batch).
3. **Polynomial commitment**. Commit to the witness columns using KZG, IPA, or FRI.
4. **Constraint evaluation**. Compute the quotient polynomial that proves all constraints are satisfied.
5. **Opening proofs**. Produce KZG (or FRI) openings at the challenge points.
6. **Recursion / aggregation**. If multiple sub-proofs are produced, aggregate into a single proof.
7. **Final wrapping**. Wrap the aggregate proof in a Groth16 (or PlonK-on-BN254) proof for cheap on-chain verification.

A batch covering 5000 Ethereum-equivalent transactions takes 10 to 60 minutes on a 16-GPU prover cluster. Each step has a different bottleneck.

### Polygon zkEVM Prover

Polygon zkEVM uses Plonky2 (FRI-based) for the heavy lifting and a Groth16 wrapper for L1 verification. The architecture:

- **State Manager** (Go): manages the L2 state and produces transaction batches.
- **Executor** (C++): replays transactions through a custom zkEVM implementation that emits a constraint-friendly trace.
- **Prover** (C++ + CUDA): consumes the trace, builds the witness, runs Plonky2 to produce a STARK proof, then runs a circom-based wrapper to convert to Groth16.

The Executor is interesting from a C++ perspective because it must produce traces that are bit-identical across runs. Any non-determinism (uninitialized memory, hash map iteration order, parallelism with non-deterministic scheduling) causes a proof failure.

```cpp
// Polygon zkEVM executor sketch
class ZkEvmExecutor {
public:
    BatchTrace execute(const std::vector<Transaction>& txs, State pre_state) {
        BatchTrace trace;
        State state = std::move(pre_state);
        for (const auto& tx : txs) {
            TxTrace tt = execute_tx(state, tx);
            trace.txs.push_back(std::move(tt));
        }
        trace.post_state_root = state.compute_root();
        return trace;
    }

private:
    TxTrace execute_tx(State& state, const Transaction& tx) {
        TxTrace tt;
        tt.pre_state = state.snapshot();
        // Run interpreter that emits per-opcode trace entries
        ZkEvmInterpreter interp(state, tt);
        interp.execute(tx);
        tt.post_state = state.snapshot();
        return tt;
    }
};
```

The interpreter is similar to evmone's baseline but emits a trace entry per executed opcode, capturing the stack, memory, and storage delta. The trace is the input to witness generation.

### Scroll Prover

Scroll uses Halo2 with KZG commitments over BN254. The prover is in Rust, but the GPU acceleration kernels are C++/CUDA. Scroll's key engineering choices:

- **Bytecode-level zkEVM**. Every EVM opcode is a chip in the Halo2 circuit. The circuit is large (hundreds of thousands of constraints per typical opcode) but the cost is amortized across many executions.
- **MSM-heavy proving**. Halo2-KZG commits to many polynomial columns, each requiring an MSM. A single proof does several billion scalar multiplications, which only makes sense on GPU.
- **GPU MSM via ICICLE**. Scroll uses Ingonyama's ICICLE library. Custom CUDA kernels parallelize MSM across thousands of GPU cores.

A simplified MSM CUDA kernel:

```cuda
// CUDA kernel for BN254 G1 MSM, bucket method
__global__ void bn254_msm_window(
    const Bn254G1* bases, std::size_t n,
    const std::uint64_t* scalars,  // 4 limbs per scalar
    int window_idx, int window_size,
    Bn254G1* buckets) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= n) return;

    std::uint64_t s_low = scalars[tid * 4 + window_idx / 64];
    int shift = window_idx % 64;
    std::uint32_t bucket_idx = (s_low >> shift) & ((1u << window_size) - 1);
    if (bucket_idx == 0) return;

    // Atomic-add into bucket
    bn254_g1_atomic_add(&buckets[bucket_idx], &bases[tid]);
}
```

The atomic add is the expensive operation. Production kernels use per-thread bucket arrays plus a reduction tree to avoid contention.

### zkSync Prover (Boojum)

zkSync (Era) introduced **Boojum**, a Halo2-style FRI-based prover written in Rust. The C++ relevance is the Goldilocks field arithmetic and the fast NTT used in FRI.

Boojum's headline characteristics:

- **Goldilocks prime field** (`p = 2^64 - 2^32 + 1`). Every field element fits in a single 64-bit word, with cheap modular reduction.
- **CPU-first design**. Boojum was designed to prove on commodity CPUs, with GPU support added later. This contrasts with Halo2-KZG provers that are GPU-mandatory.
- **Recursive aggregation**. Each batch is split into shards, each proved independently, and the shard proofs are recursively aggregated into a final proof.

The CPU-first design pays off in operational cost: Boojum can run on a 64-core EPYC server without a GPU, at maybe 3x the time of a GPU prover but at a fraction of the dollar cost.

### Linea Prover

Linea (ConsenSys) uses a PlonK variant with Vortex polynomial commitment. The prover is again Rust, with C++ inside the gnark-crypto library that handles BLS12-377 (the main curve) and BW6-761 (the recursive verifier curve).

Linea's design uses the **Plonkish + Vortex + recursion** combination, similar to Polygon's approach but with BLS curves instead of Goldilocks. The trade-off is more expensive field arithmetic (255 bits vs 64) but pairing-friendly, which simplifies the on-L1 verifier.

### Hardware Acceleration: GPU and ASIC

The MSM and NTT bottlenecks have driven specialized hardware. The landscape in 2025:

- **NVIDIA H100 / H200 GPUs**: dominant choice. ~2-4 BN254 MSMs per second per GPU at typical zkEVM circuit sizes. Large clusters (200+ H100s) for production proving.
- **AMD MI300**: improving. Software stack lagging NVIDIA for crypto workloads.
- **Cysic FPGA**: specialized for MSM. Claimed 10x perf-per-watt over GPU.
- **Ingonyama Z1**: announced ASIC for MSM and NTT. Sampling 2024-2025.
- **Ulvetanna FPGA**: similar play, focus on STARK FRI.
- **Fabric Cryptography VPU**: announced general-purpose ZK accelerator.

The economics: a typical zkEVM batch costs \$0.50 to \$3.00 in cloud GPU compute. Hardware acceleration aims to drive this to \$0.05 per batch, which makes consumer-affordable proving feasible for personal privacy applications.

### Software Architecture: A Production Prover Service

A real prover service must:

- Pull witness data from the executor.
- Distribute proving across GPUs and machines.
- Handle GPU failures and retries.
- Submit final proofs to L1 with appropriate gas pricing.
- Monitor prover throughput and queue depth.

```cpp
class ProverService {
public:
    void run() {
        std::vector<std::jthread> workers;
        for (int i = 0; i < num_gpus_; ++i) {
            workers.emplace_back([this, i](std::stop_token stop) {
                run_gpu_worker(i, stop);
            });
        }
        // Aggregator
        workers.emplace_back([this](std::stop_token stop) {
            run_aggregator(stop);
        });
    }

private:
    void run_gpu_worker(int gpu_id, std::stop_token stop) {
        cudaSetDevice(gpu_id);
        while (!stop.stop_requested()) {
            auto witness = work_queue_.pop_blocking();
            if (!witness) break;
            auto shard_proof = prove_shard(*witness);
            agg_queue_.push(std::move(shard_proof));
        }
    }

    void run_aggregator(std::stop_token stop) {
        std::vector<ShardProof> pending;
        while (!stop.stop_requested()) {
            auto sp = agg_queue_.pop_blocking();
            if (!sp) break;
            pending.push_back(std::move(*sp));
            if (pending.size() == shards_per_batch_) {
                auto agg = aggregate(pending);
                pending.clear();
                auto wrapped = wrap_groth16(agg);
                submit_to_l1(wrapped);
            }
        }
    }

    int num_gpus_;
    int shards_per_batch_;
    BlockingQueue<Witness> work_queue_;
    BlockingQueue<ShardProof> agg_queue_;
};
```

### Senior Track Notes

- **The witness for a 1M-tx batch is 50 to 100 GB**. Streaming this through the prover without OOM is a memory engineering challenge. Polygon and zkSync both use memory-mapped files plus careful buffer management.
- **Prover failures are operational hell**. A subtle determinism bug (e.g., a parallel hashmap iteration that differs across runs) causes the proof to fail at the last step, with no useful error message. Proving teams maintain extensive replay infrastructure.
- **Mainnet proving frequency** is the operational metric. zkSync produces a proof every 10 to 30 minutes. Polygon zkEVM and Scroll are similar. Reducing the cadence requires either faster provers, more parallel prover instances, or smaller batch sizes.
- **Recursive proving has subtle security implications**. The verifier circuit must match the prover's hash function exactly. Halo2's "amortization" technique skips the costly pairing inside the circuit, but the security argument is more delicate than a non-recursive PlonK.

The next section moves laterally into the Cosmos / Tendermint world, which uses different consensus primitives but has growing C++ relevance.

---
