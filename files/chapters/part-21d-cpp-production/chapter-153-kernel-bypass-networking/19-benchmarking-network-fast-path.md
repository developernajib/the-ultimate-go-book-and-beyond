## Benchmarking the Network Fast Path

A claim of "sub-microsecond latency" without measurement methodology is meaningless. Latency varies by load, by traffic mix, by time of day, by neighbor noise. The honest engineer produces a histogram and a methodology document. This chapter covers how.

### What To Measure

For a network fast path, the canonical metrics:

- **Latency at percentiles.** p50, p99, p99.9, p99.99, max. Average is misleading, never quote it for HFT or CDN.
- **Throughput.** Mpps and Gbit/s. Both, because small-packet pps is the harder regime.
- **Tail-jitter under load.** Max latency when the box is at 80% use rather than idle.
- **Cold-start latency.** First packet after a 100ms idle (caches and TLBs cold).

### HdrHistogram

`HdrHistogram` (Hartford Distributed Real-time Histogram, Gil Tene) is the standard for latency histograms. It records samples at a fixed precision (typically 3 significant digits) over a wide range (1 ns to hours), with constant-time recording and constant-memory output. The C++ port (`hdrhistogram_c` plus a thin C++ wrapper) is the production choice.

```cpp
#include <hdr/hdr_histogram.h>

hdr_histogram* h;
hdr_init(/*lowest=*/1, /*highest=*/3600ull*1000*1000*1000, /*sig_digits=*/3, &h);

for (uint64_t i = 0; i < N; i++) {
    const uint64_t t0 = now_ns();
    do_thing();
    const uint64_t t1 = now_ns();
    hdr_record_value(h, int64_t(t1 - t0));
}

hdr_percentiles_print(h, stdout, 5, 1.0, CLASSIC);
```

Sample output:

```
       Value     Percentile     TotalCount    1/(1-Percentile)
      152.000  0.0000000000             1         1.00
      201.000  0.5000000000        500000         2.00
      284.000  0.9000000000        900000        10.00
      349.000  0.9900000000        990000       100.00
      512.000  0.9990000000        999000      1000.00
     2048.000  0.9999000000        999900     10000.00
   190464.000  0.9999900000        999990    100000.00
```

The line at p99.99 = 190us is the actual story: not the p50 = 201ns. That spike happened maybe ten times, and ten 200us spikes ruin a microsecond budget.

### Coordinated Omission

Coordinated omission is the most common mistake in latency benchmarking. The naive loop:

```cpp
while (true) {
    auto t0 = now();
    send_request();
    wait_for_response();
    auto t1 = now();
    record(t1 - t0);
    sleep(target_interval - (t1 - t0));
}
```

The bug: when a response is slow, the next request is issued late, and its delay is invisible. You measure the latency of requests that completed but not the requests that were never sent because the loop was stuck.

The fix: drive at fixed rate, regardless of completion timing.

```cpp
auto deadline = now();
while (true) {
    deadline += target_interval;
    sleep_until(deadline);    // schedule strictly
    const auto issue_time = now();
    send_request_async([issue_time] (auto resp_time) {
        record(resp_time - issue_time);
    });
}
```

Now if the system stalls, the queued requests pile up and their measured latencies reflect the stall.

`wrk2` (Gil Tene's fork) and `tperf` get this right. `wrk` (the original) does not. `iperf` does not. For honest results, use a generator that explicitly accounts for coordinated omission.

### Hardware-Timestamped Pcap

The most rigorous external measurement of a fast path is to capture packets at the wire with hardware timestamps and compute deltas in the captured trace.

```bash
# On a port spanning the device under test
sudo tcpdump -j adapter_unsynced -i eth1 -n -tt -w trace.pcap "port 4433"

# Convert to text with nanosecond timestamps
sudo tcpdump -tt --nano -r trace.pcap | head
```

Then in Python with `dpkt` or `scapy`, compute per-flow latencies between request and response packets. Independent of any clock on the device under test.

For continuous validation in production, install a tap port on the trading floor switch (Cisco Nexus 3550 has a dedicated tap output that mirrors with hardware timestamps), feed to a recorder, and run latency analytics offline.

### Packet Generation: TRex, MoonGen, pktgen-dpdk

Three traffic generators worth knowing:

- **TRex (Cisco).** DPDK-based stateful generator. Replays pcap, generates synthetic flows, scales to 200 Gbit per box. Has a Python API for traffic profiles. The standard for L4-L7 testing.
- **MoonGen.** Lua-scripted DPDK generator. Lower-level than TRex, gives precise control over packet shape and timing. Used in academic research and detailed measurement.
- **pktgen-dpdk.** Older Intel-origin DPDK tool. Simpler, line-rate at small sizes. Good for "is the device under test capable of line rate?" tests.

For an HFT-style test (replay an exchange feed file at recorded rate, measure consumer latency), MoonGen with the file-replay extension is the right tool.

```bash
# MoonGen: replay a pcap on port 0
sudo build/MoonGen examples/pcap-replay.lua 0 /tmp/itch_open.pcap
```

For a CDN-style test (1M concurrent QUIC connections), TRex with its HTTP profile.

### Wireshark with Hardware Timestamps

Wireshark reads pcap-ng files with nanosecond hardware timestamps. The "Time Reference" feature lets you measure delta between two packets directly in the GUI, useful for per-packet debugging.

For programmatic analysis, `tshark -t e -T fields -e frame.time_epoch -e ip.src -e ip.dst -e tcp.seq` gives a CSV of timestamped packets you can pipe into analysis scripts.

### Microbenchmark Frameworks

Within a single process, Google Benchmark is the production choice:

```cpp
#include <benchmark/benchmark.h>

static void BM_OrderAdd(benchmark::State& s) {
    OrderIdBook book;
    init_book(book);
    uint64_t ref = 0;
    for (auto _ : s) {
        book.on_add(++ref, 'B', 100, 5000);
        benchmark::DoNotOptimize(book);
    }
}
BENCHMARK(BM_OrderAdd);
BENCHMARK_MAIN();
```

```bash
g++ -O3 -march=native bench.cpp -lbenchmark -o bench
./bench --benchmark_min_time=10s
```

Cross-process or cross-host benchmarks need an external generator or harness. Google Benchmark is for in-process work.

### Profiling with perf

For finding the hot spot inside the fast path:

```bash
sudo perf record -F 999 -g -p $(pidof feed_handler) -- sleep 30
sudo perf report --stdio | head -30
```

Look for: top-N functions by self time, percentage of cycles in user vs kernel (should be ~99% user for a bypass app), evidence of cache misses (`perf stat -e cache-misses,LLC-load-misses`).

Flame graphs:

```bash
git clone https://github.com/brendangregg/FlameGraph
sudo perf record -F 999 -g -p $PID -- sleep 30
sudo perf script | ./FlameGraph/stackcollapse-perf.pl > out.folded
./FlameGraph/flamegraph.pl out.folded > out.svg
```

Open the SVG in a browser. Click to zoom. The flame graph shows where time is spent, for a well-tuned fast path, the inner loop should be a single tall column.

### perf c2c for False Sharing

```bash
sudo perf c2c record -- sleep 30
sudo perf c2c report
```

The output ranks cache lines by HITM (modified-line transfer between cores). Top entries are your false sharing victims. Pad them.

### Tail Latency Discipline

A real measurement methodology for an HFT-style claim "p99.9 < 800ns":

1. Specify the workload: ITCH 5.0 replay at 6 Mpps with realistic message mix.
2. Specify the host: BIOS settings, kernel command line, NIC firmware version.
3. Run for at least 1 hour after warm-up.
4. Capture HdrHistogram per-symbol with 3-sigfig precision.
5. Provide raw histograms (not just summaries) so the auditor can recompute.
6. Repeat across at least 3 hosts and 3 days, show variance.

Anything short of this is marketing. The serious shops do this every release.

> Junior engineer pitfall: reporting p50 average latency as "the latency" of a system.
> Senior FAANG move: HdrHistogram-driven measurement, coordinated-omission-aware load generation, hardware-timestamped pcap as the external ground truth, and a published methodology document so the numbers are reproducible.
