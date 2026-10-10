## The Go Engineer's Perspective

HFT engineering involves techniques unfamiliar to most Go engineers: polling NICs directly in tight busy loops, manipulating CPU cycle counters, writing to FPGA memory-mapped registers, and building lock-free data structures out of raw atomics. Before concluding, it is worth being explicit about where Go fits in the trading ecosystem and where it does not.

### Why HFT Cannot Use Go on the Critical Path

The incompatibilities are architectural, not superficial:

**Garbage collection pauses.** Go's GC has improved dramatically, modern versions achieve sub-millisecond pause times in most workloads. But "sub-millisecond" means "sometimes 500 μs." An HFT system targeting 2 μs latency cannot tolerate a 500 μs pause happening even once per hour. Stop-the-world events are fundamentally incompatible with nanosecond latency targets. The `GOGC=off` option disables GC entirely, but then your process will eventually run out of memory unless you never allocate, at which point you are writing C++ in Go syntax.

**Goroutine scheduler preemption.** Go's scheduler can preempt goroutines at any safe point (function call boundary). This introduces scheduling jitter in the same way OS thread preemption does, but at the goroutine level. You cannot `isolcpu` a goroutine the way you can a kernel thread.

**No `rdtsc` intrinsic.** Go provides no built-in access to the CPU's Time Stamp Counter. You can access it via assembly:

```asm
// rdtsc.s
#include "textflag.h"
TEXT ·Rdtsc(SB),NOSPLIT,$0-8
    RDTSC
    SHLQ    $32, DX
    ADDQ    DX, AX
    MOVQ    AX, ret+0(FP)
    RET
```

```go
// rdtsc.go
package rdtsc

//go:noescape
func Rdtsc() uint64
```

This works, but Go's scheduler may preempt your goroutine between the `RDTSC` and the code that uses the result, invalidating the timing measurement.

**No kernel bypass.** DPDK requires taking ownership of a NIC at the kernel level and spinning on it from a dedicated thread pinned to an isolated core. Go's runtime model, where goroutines are multiplexed across OS threads by the scheduler, is incompatible with the single-threaded ownership model DPDK requires. A CGo wrapper exists but every CGo call has ~100 ns overhead and the Go scheduler does not know about the DPDK polling loop, leading to goroutine starvation.

**No FPGA integration.** FPGA communication requires `mmap`'ing PCIe BAR regions, writing to volatile memory-mapped registers, and managing DMA buffers with physically contiguous memory. Go's memory model, escape analysis, and GC are incompatible with manually managed physical memory. CGo is the only option, and again, the overhead and complexity defeat the purpose.

**No hardware timestamp API.** `SO_TIMESTAMPING` requires `ioctl` calls with C struct layouts that Go's `syscall` package does not expose conveniently. `golang.org/x/sys/unix` can do it, but you are effectively writing C.

### Where Go IS Used at Trading Firms

Go is genuinely useful, and widely used, at the same firms that run C++ on the critical path. The key insight is that a trading firm is not just its trading algorithm. It is a large distributed system with many components at different latency tiers:

**Strategy research and backtesting.** Backtesting runs at historical data speed, not market speed. Latency is irrelevant. Throughput, correctness, and developer productivity matter. Go is an excellent choice.

**Order management systems (OMS).** The OMS tracks open orders, fills, positions, and P&L across all strategies. It does not need to react in microseconds, it needs to be reliable, auditable, and easy to monitor. Go's concurrency model (goroutines, channels) is a natural fit.

**Risk reporting and monitoring.** Reading atomic counters from the risk engine (as shown in the previous section) and publishing them to a dashboard is a warm/cold path task. Go's HTTP server, gRPC client, and `prometheus` integration make this straightforward.

**Market data persistence.** Storing raw feed data to disk for later analysis. Go's I/O model handles this efficiently.

**Infrastructure tooling.** Deployment, configuration management, circuit breaker UIs, PnL dashboards, all cold path, all well-suited to Go.

```
                     THE TRADING FIRM LATENCY STACK
    ┌──────────────────────────────────────────────────────┐
    │  HOT PATH  ( < 10 μs )      C++ / FPGA               │
    │  Market data reception      DPDK, lock-free book     │
    │  Signal generation          Cache-resident, no GC    │
    │  Order submission           Atomic risk checks       │
    ├──────────────────────────────────────────────────────┤
    │  WARM PATH ( < 1 ms )       C++                      │
    │  OMS order tracking         Mutex-based, queued      │
    │  Fill processing            Position reconciliation  │
    │  Intraday risk monitoring   Threshold alerts         │
    ├──────────────────────────────────────────────────────┤
    │  COLD PATH ( > 1 ms )       Go, Python, Java         │
    │  Backtesting engines        Research workflows       │
    │  Risk reporting dashboards  Compliance systems       │
    │  Data pipelines             Strategy analytics       │
    │  Infrastructure tooling     Deployment, monitoring   │
    └──────────────────────────────────────────────────────┘
```

### Go Packages Relevant to Trading

For Go engineers working in trading at the warm/cold path level:

```go
// FIX protocol: the industry standard for order routing
// github.com/quickfixgo/quickfix
// Full FIX 4.x and 5.0 implementation, session management, store/log

import (
    "github.com/quickfixgo/quickfix"
    "github.com/quickfixgo/fix44/newordersingle"
)

type OrderRouter struct {
    initiator *quickfix.Initiator
}

func (r *OrderRouter) SendOrder(symbol string, side quickfix.Side,
    qty decimal.Decimal, price decimal.Decimal) error {
    order := newordersingle.New(
        quickfix.ClOrdID(generateClOrdID()),
        side,
        quickfix.TransactTime(time.Now()),
        quickfix.OrdType(quickfix.OrdType_LIMIT),
    )
    order.Set(quickfix.Symbol(symbol))
    order.Set(quickfix.OrderQty(qty))
    order.Set(quickfix.Price(price))

    return quickfix.Send(order)
}
```

For market data APIs (non-exchange-native, for research and backtesting):

```text
// Alpaca Markets API (equities, options)
// github.com/alpacahq/alpaca-trade-api-go

// Interactive Brokers TWS API  
// github.com/hadrienk/ibapi

// Polygon.io websocket feed
// github.com/polygon-io/client-go
```

For high-performance data processing in Go (analytics, backtesting):

```text
// Apache Arrow for columnar data (OHLCV bars, tick data)
// github.com/apache/arrow/go/v14

// gonum for numerical computation
// gonum.org/v1/gonum

// InfluxDB for time-series storage of market data
// github.com/influxdata/influxdb-client-go
```

### The Practical Career Advice

If you are a Go engineer transitioning into quantitative finance or trading systems, the most valuable thing you can do is learn which layer of the stack you are working on. For most roles, strategy development, backtesting, OMS, risk systems, data engineering, Go is excellent and C++ is unnecessary. For the narrow set of roles building the actual trading infrastructure at latency-sensitive firms, C++ (and increasingly FPGA design) is required. The techniques in this chapter represent the primary engineering standard for that narrow but well-compensated set of problems.

---
