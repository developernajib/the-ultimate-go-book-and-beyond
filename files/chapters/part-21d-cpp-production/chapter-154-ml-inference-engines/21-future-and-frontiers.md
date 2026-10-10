## Future and Frontiers

The inference stack is still evolving fast. Six months out from when you read this, some of the pieces in this chapter will be obsolete. This section calls out the frontier in 2026, what to watch, and where the next 10x improvements are coming from.

### Speculative Decoding Variants

Beyond the basic draft-model speculative decoding (section 9), several variants are now production-grade.

**EAGLE / EAGLE-2 / EAGLE-3.** Train a small extra head on the target model that predicts the next token's hidden state, not just the token. The hidden state goes back into a tiny attention layer that predicts the *next* hidden state, and so on. Acceptance rates of 80-90%, with a far lighter draft than a separate model.

**Medusa.** Multiple LM heads, each predicting the i-th-next token. No draft model, no autoregressive pass. Verifier walks a tree of candidates per step.

**Lookahead decoding.** Keep N-gram statistics from generation history. Suggest tokens based on the local n-gram. Cheap and works surprisingly well on repetitive content.

**Self-speculation.** Pretrained large model uses its own early layers as the draft. No extra training. Acceptance is lower but no overhead beyond the speculation.

In production C++, the engine has a pluggable speculator interface. Each decoded request decides which speculator to use based on a heuristic (output length, batch size, model family). The big production wins of 2025-2026 came from EAGLE-3 and Medusa-2 deployed on top of paged attention.

### MoE Inference at Scale

DeepSeek v3 (671B total / 37B active per token), GPT-OSS, Qwen MoE: these models are huge by parameter count but only activate a small subset per token. The serving challenge is different.

Key inference patterns for MoE:

**Expert parallel + replicated.** Each rank holds a subset of experts. Tokens route via all-to-all. Section 10 covers the basic mechanism.

**Hot-cold expert tiering.** Experts that activate often live on fast HBM. Cold experts spill to slower memory (CPU RAM, NVMe). On a token activating a cold expert, you fault it in. Mooncake-style.

**Speculative routing.** A small router predicts which experts will activate. Pre-fetches them. Reduces tail latency.

**Expert quantization heterogeneity.** Hot experts at FP8 (full quality), cold experts at MXFP4 (smaller). The router-skewed access pattern means quality stays high on average.

DeepEP (DeepSeek's expert parallel library) and the work being done on expert offload suggest MoE inference will look very different from dense inference by late 2026.

### Test-Time Compute (o1, o3, R1, the Reasoning Paradigm)

OpenAI's o1, o3, and DeepSeek's R1 / V3 demonstrate that inference compute can be traded for accuracy. The model thinks for longer (generates many internal tokens) before responding. Inference cost per *user-visible* token rises 5 to 50x.

Implications for the inference engine:

1. **Per-request output budget**, not just max_tokens. Some requests use 100 tokens of thinking, some use 100,000. The scheduler must handle very long-running requests without starving short ones.

2. **Internal vs external tokens.** The thinking tokens are not streamed to the user. They are billed (often more), and they take cache slots, but they do not appear in the response. The engine API distinguishes them.

3. **KV cache pressure.** A single 100k-token reasoning trace eats GPU memory. Trade-off: large reasoning models with smaller context budgets, or smaller reasoning models with longer thinking budgets.

4. **Speculative decoding for reasoning.** Reasoning traces have more pattern repetition (chain of thought rephrases the question, restates intermediate steps). Speculative decoding hits very high acceptance.

5. **Best-of-N sampling.** Generate N parallel completions, score them with a reward model, return the best. Multiplies inference cost by N. Common for math / code / safety-critical use cases.

The C++ engine work for reasoning models is mostly scheduler tuning (long-running requests, fairness) and KV cache work (reasoning traces dominate cache).

### Test-Time Search (Tree Search Inference)

Inference can branch. AlphaGo-style: at each step, generate K candidates, score each, expand the best. This applies to LLM reasoning (Monte Carlo Tree Search over reasoning steps), code generation (each step produces multiple valid programs), and agentic decision making.

For the engine: K parallel rollouts share a prefix (the question and reasoning so far). Prefix caching is now structural, not just opportunistic. The engine must support tree-shaped requests, with shared K/V at internal nodes.

vLLM and TRT-LLM are working on first-class support. In 2026 most teams build this on top with custom code.

### Agent-Based Serving

Agents (LangGraph, CrewAI, internal frameworks) make many small LLM calls per user request: tool selection, parameter generation, result interpretation. Each call has small context.

Implications:

1. **Per-call overhead matters.** TTFT must be low or the cumulative overhead is huge.
2. **Cache hit rate is high.** The same agent code with the same tool schemas hits the prefix cache hard.
3. **Many small requests.** The scheduler is the bottleneck, not the GPU.

Engines tuned for chat (long output) underperform on agent traffic. Some teams (Anthropic, OpenAI) have separate agent-tier deployments with different scheduler tuning.

### Hardware Trajectory

Late 2026 / early 2027 hardware visible on the roadmap:

- **NVIDIA Blackwell B300.** Refresh of B200 with more HBM (288 GB) and faster NVLink. Same FP4 path.
- **NVIDIA Vera Rubin.** Successor architecture, expected 2026-2027. Larger NVLink fabric, GPU-to-GPU bandwidth doubling.
- **AMD MI355X.** ROCm 7+ support, FP4 / FP6 native. Targeting H100 / B100 segments.
- **Intel Gaudi 4.** Niche but cheap.
- **Apple M5 / M5 Pro.** Better unified-memory AI Server market entry.
- **AWS Trainium 2 / 3, Google TPU v6 / v7.** In-house accelerators with their own software stacks.
- **Cerebras WSE-3, Groq LPU.** Specialty hardware for small-batch low-latency inference. Both good at very small batches but lose at high batch.

The C++ inference engineer should track all of these. The kernel work for AMD ROCm in 2026 is now mostly catch-up to CUDA. The TPU and Trainium paths require XLA / Neuron compiler work.

### What To Bet On

If you are staffing a 2026-2027 inference team, the highest-use investments:

1. **MXFP4 / MXFP6 kernels for B200.** The hardware is shipping, and the kernel ecosystem is still thin. First-mover wins.

2. **Speculative decoding with EAGLE-3 / Medusa.** Off-the-shelf vLLM and TRT-LLM are conservative. Custom integration gets 50%+ throughput improvements.

3. **Disaggregated prefill / decode.** Mooncake / DistServe is the architecture going forward. Get good at it.

4. **Continuous batching for MoE.** All-to-all overlap, hot-expert caching, expert offload.

5. **Reasoning-model-specific scheduling.** Long-running fairness, internal token billing, best-of-N support.

6. **Edge LLM inference.** As models like Llama 3.2 1B and Phi-4 reach phone-runnable quality, on-device LLM apps explode. C++ inference on Apple Silicon, Snapdragon, MediaTek.

7. **Inference compilers.** Triton, MLIR, Mojo, CUDA C++ codegen frontends. The kernel scaling problem is real and the hand-tuning ceiling is being hit.

### What Is Probably Going Away

1. **Static batching.** Already dead for LLMs. Will fade further.
2. **FP32 inference.** Outside of debugging, no production runs FP32.
3. **Heavy framework lock-in.** ONNX as a lingua franca, more cross-framework deployment.
4. **Single-GPU inference for big models.** Even 7B models on edge are quantized. Server side, multi-GPU is the default.
5. **Per-request Python in the hot path.** All major frameworks moved to C++ schedulers. Python is the API surface only.

### Senior at FAANG: How To Stay Current

Three habits:

1. Read the vLLM, TRT-LLM, llama.cpp, and ggml commit logs weekly. New algorithms appear there before papers.

2. Run a single-GPU benchmark suite against new models on day-of-release. You learn the real performance numbers, not the published ones.

3. Read the NVIDIA H100 / B200 architecture whitepapers, the AMD CDNA whitepapers, and the MLPerf results. The hardware vendors are explicit about what their silicon does well, the marketing is just where to find it.

By the time the technique is in a tutorial, the frontier has moved. The chapter you have just read will need a refresh in eighteen months. Treat it as a baseline.

The next section is the interview question bank.

---
