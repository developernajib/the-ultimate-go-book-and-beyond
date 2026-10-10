## GPU Memory Management (vLLM PagedAttention)

GPU memory is the scarcest resource in LLM serving, and naive memory allocation leads to severe fragmentation. PagedAttention, introduced by the vLLM project, solves this by borrowing the concept of virtual memory paging from operating systems. Instead of allocating one contiguous memory block per request, GPU VRAM is divided into small fixed-size pages that are assigned on demand. This approach eliminates fragmentation and allows 2-4x more concurrent requests to fit in the same GPU memory.

```
Traditional KV Cache Problem:
  Request 1: 1000 tokens → allocate 1000-token KV block
  Request 2: 500 tokens  → allocate 500-token KV block
  Result: fragmented GPU memory, 50% wasted

PagedAttention (vLLM):
  GPU memory divided into fixed-size "pages" (16-32 tokens each)
  KV cache grows dynamically, one page at a time
  Pages shared between beam search candidates
  Result: 2-4x more requests fit in GPU memory

Go integration:
  - Python inference backend (vLLM) handles GPU
  - Go service layer: routing, caching, auth, billing
  - Communication: gRPC with protobuf streaming
```

---
