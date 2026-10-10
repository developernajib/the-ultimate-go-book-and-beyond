## Cost Analysis

### Infrastructure Cost Estimates at Scale

**Assumptions**: 1B tokens/day generated, 100K requests/day, mix of 7B/70B/405B models, 99.9% uptime SLA. Note the deliberate scale-down from the trillion-token design point: this is a mid-size API provider, small enough to sanity-check every line against public AWS pricing, and the optimization levers scale linearly from here.

| Component | Specification | Monthly Cost |
|-----------|--------------|-------------|
| GPU Workers - 70B model (8x) | p4d.24xlarge (8x A100 80GB, on-demand) | $196,032 |
| GPU Workers - 7B model (4x) | g5.12xlarge (4x A10G 24GB) | $22,464 |
| GPU Workers - 405B (4x) | p5.48xlarge (8x H100 80GB) | $392,064 |
| Spot GPU Workers (8x burst) | p4d.24xlarge (spot, ~60% savings) | $78,413 |
| Request Router (4x) | c6i.4xlarge (16 vCPU, 32GB) | $2,160 |
| Redis (rate limiting + cache) | cache.r6g.2xlarge (3 nodes) | $3,240 |
| PostgreSQL (billing, users) | db.r6i.2xlarge multi-AZ | $2,800 |
| Kafka (events, metering) | i3.2xlarge (3 brokers) | $2,700 |
| NVMe Prompt Cache (per GPU node) | Included in instance (3.8TB NVMe) | $0 |
| Load Balancer + API Gateway | NLB + API Gateway | $2,500 |
| Monitoring (Prometheus + GPU) | m6i.2xlarge (2 nodes) + DCGM | $1,120 |
| Model Storage (S3) | 2TB model weights (multiple versions) | $46 |
| **Total** | | **~$703,539/mo** |

### Cost Optimization Strategies

1. **Prompt Caching**: Reuse KV cache for common system prompts. For API with standard system prompt, saves 30-50% of prefill compute.
2. **Spot Instances for Burst**: Use spot GPUs for batch/async workloads (60% savings). Migrate long-running requests on 2-minute interruption notice.
3. **Model Distillation**: Serve simple queries with the 7B model ($2.50/1M tokens at this fleet's utilization) instead of 70B ($13/1M tokens). Router classifies query complexity.
4. **Quantization**: INT8/INT4 quantization reduces GPU memory by 2-4x, serving same model on fewer/cheaper GPUs with <1% quality loss.
5. **Speculative Decoding**: Use 7B draft model to propose tokens, 70B model verifies in batch. 2-3x throughput improvement at ~20% extra compute.
6. **Reserved Capacity**: GPU instances on 1-year reserved for baseline load (40% savings on the ~$610K on-demand GPU baseline ≈ $244K/mo saved).
7. **Request Batching**: Continuous batching increases GPU utilization from ~40% to ~80%, effectively doubling throughput per dollar.

### Cost Per Token

- **70B model**: $196,032/mo / (500M tokens/day x 30) = **$13 per 1M tokens**
- **7B model**: $22,464/mo / (300M tokens/day x 30) = **$2.50 per 1M tokens**
- **405B model**: $392,064/mo / (200M tokens/day x 30) = **$65 per 1M tokens**

These unit costs sit far above the ~$5 per 1M tokens market rate for 70B-class output because this fleet is provisioned for roughly 4x peak traffic and averages about 25% utilization. That gap is the business case for the optimization list above: reserved capacity and spot cut the hourly rate, complexity routing and quantization shrink the fleet, and predictive scale-down raises average utilization. The trillion-token design point reaches about $2.78 per 1M output tokens on its 70B tier precisely because continuous batching keeps its 625 GPUs busy around the clock.
