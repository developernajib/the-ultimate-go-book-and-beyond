## AI-Driven Trading and LLM Bots

Machine learning has been part of crypto trading since 2017. The 2024-2025 wave is different in scale: LLM-driven signal generation, on-device inference for sub-millisecond decisions, and end-to-end ML pipelines that span from raw market data to order submission. A senior C++ engineer working in this space sits at the boundary between Python research stacks and C++ trading infrastructure.

This section covers four areas: sentiment pipelines, LLM-driven signals, on-chain ML inference (which is mostly impractical), and exchange bot architecture in C++.

### The Architecture of an ML Trading System

A typical setup:

- **Data layer (Python or C++)**: ingests market data, on-chain data, social media, news.
- **Feature engineering layer (C++ or Numpy/Polars)**: computes features at multiple time scales.
- **Model serving layer (C++ with ONNX Runtime or TensorRT)**: runs inference on every tick.
- **Decision layer (C++)**: combines model outputs with risk constraints into orders.
- **Order management (C++)**: submits, monitors, and cancels orders.

The hot path (model inference and decision) must be in C++. The training is in Python with PyTorch or JAX. The bridge is ONNX or TorchScript exported models, loaded by ONNX Runtime in production.

### ONNX Runtime Inference

```cpp
#include <onnxruntime_cxx_api.h>
#include <vector>
#include <span>

class OnnxModel {
public:
    OnnxModel(const std::string& model_path)
        : env_(ORT_LOGGING_LEVEL_WARNING, "trading"),
          session_options_(),
          session_(env_, model_path.c_str(), session_options_) {
        session_options_.SetIntraOpNumThreads(1);  // single-threaded for predictable latency
        session_options_.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_EXTENDED);
        // Discover input/output names
        Ort::AllocatorWithDefaultOptions alloc;
        for (std::size_t i = 0; i < session_.GetInputCount(); ++i) {
            input_names_.push_back(session_.GetInputNameAllocated(i, alloc).get());
        }
        for (std::size_t i = 0; i < session_.GetOutputCount(); ++i) {
            output_names_.push_back(session_.GetOutputNameAllocated(i, alloc).get());
        }
    }

    std::vector<float> predict(std::span<const float> features) {
        std::array<std::int64_t, 2> shape{1, static_cast<std::int64_t>(features.size())};
        Ort::MemoryInfo mem("Cpu", OrtArenaAllocator, 0, OrtMemTypeDefault);
        auto input_tensor = Ort::Value::CreateTensor<float>(
            mem, const_cast<float*>(features.data()), features.size(),
            shape.data(), shape.size());

        std::vector<const char*> input_ptrs;
        for (auto& s : input_names_) input_ptrs.push_back(s.c_str());
        std::vector<const char*> output_ptrs;
        for (auto& s : output_names_) output_ptrs.push_back(s.c_str());

        auto outputs = session_.Run(
            Ort::RunOptions{nullptr},
            input_ptrs.data(), &input_tensor, 1,
            output_ptrs.data(), output_ptrs.size());

        const float* out_data = outputs[0].GetTensorData<float>();
        std::size_t n = outputs[0].GetTensorTypeAndShapeInfo().GetElementCount();
        return std::vector<float>(out_data, out_data + n);
    }

private:
    Ort::Env env_;
    Ort::SessionOptions session_options_;
    Ort::Session session_;
    std::vector<std::string> input_names_;
    std::vector<std::string> output_names_;
};
```

Key details:

- Single-threaded inference for predictable latency. Multi-threaded ORT introduces variance.
- Pre-allocated input buffers. Allocations on the hot path are forbidden.
- Graph optimization level set to extended at session creation.

For a small MLP (5-20 inputs, 2-3 hidden layers), ONNX Runtime inference is roughly 2 to 10 microseconds per call on a single core. For larger models (transformers, deep CNNs), use TensorRT or write custom CUDA kernels.

### Feature Engineering on the Hot Path

Features for high-frequency crypto trading are typically:

- **Price-based**: log returns at multiple horizons, volatility, mean reversion indicators.
- **Order book**: bid-ask imbalance, queue position, microprice.
- **Volume**: trade volume at multiple time scales, OFI (order flow imbalance).
- **Cross-venue**: spread between two exchanges, latency-adjusted price differences.
- **On-chain**: gas price, mempool depth, recent large transfers.

Computing these features in C++ on every market data tick:

```cpp
class FeatureExtractor {
public:
    void on_book_update(const BookUpdate& u) {
        update_microprice(u);
        update_imbalance(u);
        update_ofi(u);
    }

    void on_trade(const Trade& t) {
        update_volume(t);
        update_volatility(t);
    }

    [[nodiscard]] std::array<float, 16> snapshot() const noexcept {
        return {
            microprice_,
            imbalance_,
            ofi_,
            log_return_1s_,
            log_return_10s_,
            volatility_1s_,
            volume_1s_,
            volume_10s_,
            // ...
        };
    }

private:
    void update_microprice(const BookUpdate& u) {
        if (u.bids.empty() || u.asks.empty()) return;
        float bid_price = u.bids[0].price_ticks;
        float ask_price = u.asks[0].price_ticks;
        float bid_qty = u.bids[0].quantity_units;
        float ask_qty = u.asks[0].quantity_units;
        microprice_ = (bid_price * ask_qty + ask_price * bid_qty) / (bid_qty + ask_qty);
    }

    float microprice_{};
    float imbalance_{};
    float ofi_{};
    float log_return_1s_{}, log_return_10s_{};
    float volatility_1s_{};
    float volume_1s_{}, volume_10s_{};
    // ... rolling-window state ...
};
```

Rolling windows are typically maintained as fixed-size circular buffers, with O(1) updates. For exponentially weighted moving averages, the state is two floats.

### LLM-Driven Signals

LLMs are slow (50 to 500 ms per call for a midsize model) and stochastic. They are not used in the inner loop of HFT. They are used at slower time scales:

- **News-driven trading**. Process incoming news headlines, extract entities and sentiment, generate signals at minute-to-hour scales.
- **Social sentiment**. Aggregate Twitter/X, Telegram, Discord, and Reddit posts. Identify coordinated behavior.
- **On-chain narrative tracking**. Summarize what is happening in DeFi protocols, NFT markets, governance forums.
- **Code analysis**. Auto-audit new smart contracts before considering them safe to interact with.

The C++ layer in these pipelines is the orchestrator: receive LLM outputs (typically as JSON over HTTP), translate them into trading signals, and gate them with risk constraints.

```cpp
class LlmSignalSubscriber {
public:
    void on_signal(const LlmSignal& s) {
        // s.entity = "BTC", s.direction = +1, s.confidence = 0.7, s.horizon_seconds = 3600
        if (s.confidence < confidence_threshold_) return;
        if (!risk_check(s.entity, s.direction)) return;

        Order o;
        o.symbol = s.entity;
        o.side = (s.direction > 0) ? Side::Bid : Side::Ask;
        o.size = compute_size(s);
        o.tif = Tif::IOC;
        order_manager_->submit(o);
    }

private:
    bool risk_check(const std::string& entity, int direction);
    Quantity compute_size(const LlmSignal& s);

    float confidence_threshold_{0.6f};
    OrderManager* order_manager_;
};
```

The LLM itself runs as a separate microservice (Python with vLLM or sglang, or a managed API). The C++ trading process subscribes to its output stream over WebSocket or gRPC.

### On-Chain ML Inference

Running ML inference inside an EVM contract is technically possible but rarely practical. A small MLP forward pass costs millions of gas. The exception is verifiable inference via zk-ML:

- **EZKL**: zkSNARK proof that a specific ONNX model produced a specific output for given inputs.
- **Modulus Labs**: production zk-ML with provers for popular models.
- **Giza**: zk-ML for DeFi.

The use case is "I claim my model recommends this trade": post the proof on-chain, the contract verifies the inference happened, and acts on the verified output. The C++ relevance is again the prover infrastructure (section 14 and 15).

### Exchange Bot Architecture

A market-making or stat-arb bot in C++ has the structure:

```cpp
class TradingBot {
public:
    void run() {
        // Connect to data feeds
        coinbase_feed_->subscribe([this](auto u) { on_book_update("COINBASE", u); });
        binance_feed_->subscribe([this](auto u) { on_book_update("BINANCE", u); });

        // Connect to order endpoints
        coinbase_oms_->connect();
        binance_oms_->connect();

        // Main event loop runs in feed callbacks (no separate thread)
        feed_thread_.join();
    }

private:
    void on_book_update(const std::string& venue, const BookUpdate& u) {
        features_.update(venue, u);
        auto pred = model_.predict(features_.snapshot());
        decide(pred);
    }

    void decide(std::span<const float> pred) {
        // Risk check
        if (current_position_ + pred[0] > max_position_) return;
        // Compute target quote
        Order target = compute_target_quote(pred);
        // Reconcile with existing orders
        order_manager_.reconcile(target);
    }

    FeatureExtractor features_;
    OnnxModel model_;
    OrderManager order_manager_;
    Position current_position_{};
    Position max_position_{};
};
```

The architecture must be **single-threaded on the hot path**. Multi-threading introduces non-determinism in event ordering, which makes debugging and replay impossible. Production bots run one thread per data feed (handled by the feed library) plus one decision thread that processes all events serially.

### Senior Track Notes

- **Latency variance is the killer**. A bot with median 50us latency and p99 of 5ms loses money to bots with median 80us and p99 of 200us. Keep p99 small even at the cost of median.
- **Backtest fidelity matters**. Most bot strategies look profitable in backtest because the backtest does not model market impact, queue position, or partial fills accurately. A senior quant engineer's biggest contribution is often a more honest backtest harness.
- **GPU inference for trading is rare**. The 100us round trip to GPU memory plus kernel launch overhead is too slow for HFT. CPU inference with ONNX Runtime or hand-tuned C++ wins.
- **AI-driven trading is operationally expensive**. The model retraining pipeline, feature stores, and monitoring infrastructure dwarf the trading-engine code. Budget 80 percent of engineering time for the offline data plumbing.

The next section looks at where the field is heading: account abstraction, restaking, modular blockchains, and parallel EVMs.

---
