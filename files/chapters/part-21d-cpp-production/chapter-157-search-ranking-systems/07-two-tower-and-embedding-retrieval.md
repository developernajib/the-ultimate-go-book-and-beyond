## Two-Tower Models and Embedding Retrieval

A two-tower (dual encoder) model maps queries and documents into the same vector space, where relevant pairs are close and irrelevant pairs are far. At query time, the query is encoded to a single vector, and an ANN index returns the k nearest document vectors. This is the foundation of dense retrieval and is what runs alongside (or instead of) BM25 in modern Google, Bing, Meta, and most modern search systems.

### Architecture

Two encoders, no parameter sharing required (though common in practice):

```
query  --> Q_encoder  --> q_vec  in R^d
doc    --> D_encoder  --> d_vec  in R^d

similarity(q, d) = <q_vec, d_vec>     (inner product)
                 = q_vec . d_vec / (|q_vec| |d_vec|)   (cosine, if normalized)
```

The encoders are usually transformers (BERT-base, MiniLM, E5, Qwen-Embedding, OpenAI text-embedding-3, Cohere embed-v3). Output dimension typically 384 (small models) to 1536 (OpenAI). Higher dimension trades quality for memory and ANN cost.

Why two towers and not a cross-encoder. Cross-encoders take (q, d) pairs and produce a score, quality is excellent but they cannot pre-compute document vectors, so every (q, d) pair requires a forward pass. Two towers pre-compute document vectors offline and only encode the query online, which makes ANN over millions to billions of vectors feasible.

### Training Objective

The standard loss is contrastive: pull positive (q, d+) pairs together, push negatives (q, d-) apart.

```
L = -log( exp(s(q, d+)) / (exp(s(q, d+)) + sum over d- of exp(s(q, d-))) )
```

This is InfoNCE / softmax cross-entropy over the candidates. The temperature parameter (a multiplier on the logits) is critical and is usually 0.05-0.1 for sentence embeddings, 0.01-0.05 for retrieval.

### In-Batch Negatives

The standard trick: in a batch of B (q, d+) pairs, treat the B-1 other documents as negatives for each query. This gives B^2 - B negative scores per batch with no extra forward passes.

Batch size matters enormously. With B = 8, each query sees 7 negatives. With B = 8192 (multi-GPU, gradient accumulation), each query sees 8191 negatives. Larger batches give a tighter contrastive signal and better embeddings. Karpukhin et al. (DPR, 2020) trained with B = 128 and saw incremental gains up to B = 256. Modern recipes (E5, BGE, GTE) use B = 8192 or higher.

### Hard Negative Mining

Random in-batch negatives are easy negatives: most random documents are obviously unrelated to the query. The model learns to separate easy cases but fails on confusable pairs. Hard negative mining adds explicitly difficult negatives:

1. **BM25 hard negatives.** Use BM25 to retrieve top documents for each query, treat top-K (excluding positives) as hard negatives. Used in DPR.

2. **Self-mined hard negatives.** Train a first version of the model, use it to retrieve top documents, treat near-top as hard negatives, retrain. Repeat. Used in ANCE (Xiong et al. 2020) and most subsequent work.

3. **Cross-encoder distillation.** Use a strong cross-encoder to score (q, d-) pairs, weight the contrastive loss by the cross-encoder score (RocketQA, RocketQAv2). The dual encoder learns to mimic the cross-encoder.

The hard negative ratio (positives to hard negatives to in-batch easy negatives) is typically 1 : 4-8 : (batch_size - 1). Too many hard negatives destabilizes training.

### Fine-Tuning Patterns

For most production cases, do not train an embedding model from scratch. Start from a strong open base (E5-large, BGE-large, Qwen3-embedding, GTE-large, Snowflake Arctic Embed) and fine-tune on domain data. The recipe:

1. Collect (query, relevant_doc) pairs. Editorial labels, click data with click model debiasing, or generated pairs (use an LLM to write queries from documents).
2. Fine-tune with InfoNCE + hard negative mining. 1-3 epochs, learning rate 1e-5 to 5e-5, batch size as large as memory allows.
3. Evaluate by `recall@k` and NDCG@10 on a held-out judgment set.

Production embedding models at Pinecone, Weaviate, and most enterprise customers are tuned this way. Training from scratch is a research-team activity.

### Encoding Documents at Scale

For a billion-document corpus, encoding all documents is the largest cost in the system. A 110M-parameter MiniLM on an A100 GPU encodes about 5000 documents per second at 512 tokens. That is 200000 GPU-seconds for one billion documents (about 56 GPU-hours, or roughly \$200 at on-demand pricing). For a 7B-parameter embedding model the cost goes up by 50-100x.

Practical tricks:

- Truncate documents (most retrieval signal is in the first 512 tokens).
- Use shorter context windows (256 tokens) where possible.
- Batch and pipeline: pre-tokenize, then GPU-batch in fp16.
- Quantize the model to int8 for inference (vLLM, TensorRT, or just `bitsandbytes` for development).

### C++ Inference

Production document encoders rarely run in C++, the training and bulk inference is in PyTorch. The query-time encoder is more interesting because it has hard latency budgets.

Three production options:

1. **ONNX Runtime in C++.** Export the encoder to ONNX, run it via the C++ API. ~5 ms for MiniLM on CPU, ~1 ms on GPU.
2. **TensorRT.** NVIDIA's optimized runtime, another 2-3x over ONNX on GPU.
3. **In-process via libtorch.** PyTorch's C++ API. Higher overhead but easier integration.

Sketch with ONNX Runtime:

```cpp
#include <onnxruntime_cxx_api.h>

class QueryEncoder {
public:
    QueryEncoder(const std::string& model_path)
      : env_(ORT_LOGGING_LEVEL_WARNING, "encoder"),
        session_(env_, model_path.c_str(), Ort::SessionOptions{}) {}

    std::vector<float> encode(const std::vector<int64_t>& token_ids) {
        std::array<int64_t, 2> shape{1, static_cast<int64_t>(token_ids.size())};
        auto mem = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
        Ort::Value input = Ort::Value::CreateTensor<int64_t>(
            mem, const_cast<int64_t*>(token_ids.data()), token_ids.size(),
            shape.data(), shape.size());

        const char* input_names[] = {"input_ids"};
        const char* output_names[] = {"sentence_embedding"};
        auto outputs = session_.Run(Ort::RunOptions{nullptr},
            input_names, &input, 1, output_names, 1);
        const float* data = outputs[0].GetTensorData<float>();
        std::size_t n = outputs[0].GetTensorTypeAndShapeInfo().GetElementCount();
        return std::vector<float>(data, data + n);
    }

private:
    Ort::Env env_;
    Ort::Session session_;
};
```

Real production code adds tokenizer (HuggingFace tokenizers C++ binding), batching, and L2 normalization of the output if cosine similarity is used downstream.

### Bi-Encoder vs Cross-Encoder vs Late Interaction

Quality ranking on most benchmarks: cross-encoder > ColBERT > bi-encoder > BM25. Latency ranking: BM25 > bi-encoder + ANN > ColBERT > cross-encoder. Storage ranking (smallest first): BM25 > bi-encoder > ColBERT > cross-encoder (which has no precomputed representation).

Production search uses bi-encoder for retrieval (top-100 to top-1000), optionally ColBERT or cross-encoder for reranking the top candidates. This is multi-stage ranking, covered in chapter 13.

### Junior to FAANG

A junior fine-tunes an embedding model and ships it. A senior at Google or Pinecone runs the full hard-negative mining loop, tracks `MTEB` and domain-specific eval metrics, and knows that "good MTEB score" does not transfer to their production corpus, which has its own term distribution and intent mix. A staff engineer thinks at the system level: how often must the index be rebuilt when the embedding model is retrained, what is the cost of dual-running two model versions during migration, what guarantees does the ANN index give about result stability when vectors shift slightly with a new checkpoint. These are the questions that interview panels at Pinecone and Weaviate ask.

---
