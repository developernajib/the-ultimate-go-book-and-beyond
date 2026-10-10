## Solarflare/AMD-Pensando: OpenOnload and ef_vi

Solarflare (acquired by Xilinx in 2019, now part of AMD/Pensando) made the canonical low-latency exchange-grade NIC for HFT for over a decade. The X2 series and the newer X3 (Alveo X3522) are the cards installed in trading floor cabinets at NYSE, Nasdaq, Cboe, CME. The differentiator was not raw bandwidth but consistency of sub-microsecond latency on commodity Ethernet plus a userspace TCP/UDP stack (OpenOnload) that was binary-compatible with BSD sockets. You could take an unmodified application linked against `libc` socket calls, run it under `onload`, and observe its TCP latency drop from 8 microseconds to 1.5.

This chapter covers the two product layers Solarflare exposes: OpenOnload (the LD_PRELOAD socket emulator) and ef_vi (the raw verb-style API for users who need to go below TCP). It also names the canonical reference points (Cisco Nexus 3550 Fusion, the sub-100ns switch) so that the latency budget makes sense.

### OpenOnload: The Easy Path

OpenOnload runs the entire TCP and UDP stack in userspace, in the application's address space, served from hugepages, with packet delivery via Solarflare's hardware. There are two invocation modes:

```bash
onload --profile=latency ./my_trading_app
```

This is the LD_PRELOAD form. Onload intercepts socket calls (`socket`, `bind`, `connect`, `listen`, `accept`, `send`, `recv`, `epoll_wait`, etc.) and routes them through its userspace stack. Unmodified C++ code that calls `recv()` gets a packet pulled from the NIC RX ring without a syscall when the data is already there.

```bash
onload_stackdump lots
```

prints per-stack statistics: pps, latency histograms, polled vs interrupted receives. This is your primary diagnostic.

#### Profiles

OpenOnload ships profiles tuned for different tradeoffs:

- `latency`: spin in `recv()` for up to 50 microseconds before falling back to interrupt. Preferred for HFT.
- `latency-best`: same plus EF_HIGH_THROUGHPUT off, EF_PIO on (programmed I/O for tx), most aggressive.
- `throughput`: optimized for bulk transfer, spin disabled.
- `latency-balanced`: spin for a few microseconds.

Set via env: `EF_PROFILE=latency-best onload ./app`. Or via the `--profile=` flag.

#### What Onload Actually Does

For TCP, Onload runs a complete TCP state machine (3WHS, congestion control, retransmit, SACK, RTT estimation). It maintains its own socket table, its own protocol control blocks, its own timer wheels, all in userspace. The kernel is involved only for things Onload deliberately leaves there (control plane, ARP resolution).

For UDP, the path is simpler: a UDP socket binds an endpoint, the NIC's flow-steering directs matching packets to the userspace ring, the application reads them with no syscall.

The trick is binary compatibility. From the application's perspective, every standard call works. `epoll_wait` even composes correctly across Onload sockets and kernel sockets. Onload's epoll synthesizes events from both sources.

#### Latency Numbers (Approximate, X2522 series)

```
Operation                    Kernel     Onload     ef_vi
udp recv (warm)               2.8 us    0.6 us    0.3 us
udp send                      3.2 us    0.7 us    0.2 us
tcp recv (warm)               4.5 us    1.4 us    n/a
tcp send                      5.0 us    1.5 us    n/a
ping-pong half-RTT (UDP)      6.0 us    1.3 us    0.5 us
```

ef_vi gives up TCP and saves another ~700 ns vs Onload UDP. That gap is the cost of the userspace TCP state machine plus the BSD socket facade.

### ef_vi: The Raw API

When 1.4us TCP is too slow, you drop to ef_vi. ef_vi is a thin C API directly over the NIC's hardware ring, similar in spirit to DPDK but with Solarflare-specific primitives.

The model:

- A **virtual interface (VI)** is an instance of a NIC ring pair (TX + RX) plus an event queue.
- A **packed-stream VI** is a higher-density variant where multiple small packets share a buffer, useful for absorbing bursts.
- A **filter** is an in-NIC steering rule (5-tuple, MAC, VLAN, etc.) that directs matching packets to a VI.
- An **event** describes a completion (TX done, RX with offset/length, or hardware error).

A minimal RX-only ef_vi user looks like:

```cpp
#include <etherfabric/vi.h>
#include <etherfabric/pd.h>
#include <etherfabric/memreg.h>
#include <etherfabric/pio.h>
#include <etherfabric/ef_vi.h>
#include <cstdio>
#include <cstring>

struct EfRx {
    ef_driver_handle dh;
    ef_pd            pd;
    ef_vi            vi;
    ef_memreg        memreg;
    void*            buf;
    size_t           buf_size;
    uint32_t         frame_size = 2048;
    uint32_t         num_frames = 4096;
};

static EfRx open_rx(const char* iface) {
    EfRx r{};
    if (ef_driver_open(&r.dh) < 0) std::abort();
    if (ef_pd_alloc_by_name(&r.pd, r.dh, iface, EF_PD_DEFAULT) < 0) std::abort();
    if (ef_vi_alloc_from_pd(&r.vi, r.dh, &r.pd, r.dh,
                            -1, 4096, 4096, nullptr, -1,
                            EF_VI_FLAGS_DEFAULT) < 0) std::abort();

    r.buf_size = size_t(r.frame_size) * r.num_frames;
    posix_memalign(&r.buf, 4096, r.buf_size);
    if (ef_memreg_alloc(&r.memreg, r.dh, &r.pd, r.dh,
                        r.buf, r.buf_size) < 0) std::abort();

    // Post all frames into the RX ring
    for (uint32_t i = 0; i < r.num_frames; i++) {
        const ef_addr addr =
            ef_memreg_dma_addr(&r.memreg, i * r.frame_size);
        ef_vi_receive_init(&r.vi, addr, i);
    }
    ef_vi_receive_push(&r.vi);
    return r;
}

static void rx_loop(EfRx& r) {
    ef_event evs[16];
    while (true) {
        const int n = ef_eventq_poll(&r.vi, evs, 16);
        for (int i = 0; i < n; i++) {
            switch (EF_EVENT_TYPE(evs[i])) {
            case EF_EVENT_TYPE_RX: {
                const int      id   = EF_EVENT_RX_RQ_ID(evs[i]);
                const unsigned len  = EF_EVENT_RX_BYTES(evs[i]);
                uint8_t* pkt = static_cast<uint8_t*>(r.buf)
                             + size_t(id) * r.frame_size;
                process_packet(pkt, len);
                // Repost the buffer
                const ef_addr addr =
                    ef_memreg_dma_addr(&r.memreg, size_t(id) * r.frame_size);
                ef_vi_receive_init(&r.vi, addr, id);
                break;
            }
            case EF_EVENT_TYPE_RX_DISCARD:
                fprintf(stderr, "rx discard subtype %d\n",
                    EF_EVENT_RX_DISCARD_TYPE(evs[i]));
                break;
            }
        }
        ef_vi_receive_push(&r.vi);
    }
}
```

Build with the Solarflare-provided libraries:

```bash
g++ -O3 -std=c++20 ef_rx.cpp -o ef_rx -lciul1
sudo ./ef_rx eth0
```

The hot loop is two operations: poll the event queue, dispatch on event type. No syscall. Latency from packet arrival on the wire to `process_packet` running is ~300 ns including PCIe.

### PIO: Programmed I/O for TX

Solarflare's killer feature for send latency is PIO. Instead of writing a TX descriptor that points the NIC at a buffer (DMA fetch), the application writes the packet directly into a PCIe MMIO region on the NIC. The NIC sends the moment the write commits. This trades CPU cycles for round trips: PIO sends are limited to small packets (typically 256 bytes, sometimes 2KB on newer cards) but they save ~150 ns vs DMA-based TX.

```cpp
ef_pio pio;
ef_pio_alloc(&pio, dh, &pd, -1, dh);
ef_pio_link_vi(&pio, dh, &vi, dh);

uint8_t pkt[256] = {/* fully formed Ethernet/IP/UDP frame */};
const size_t len = build_frame(pkt);
const int rc = ef_vi_transmit_pio(&vi, 0, len, /*dma_id=*/42);
```

PIO is the reason exchange feed handlers and order entry paths run on Solarflare. The few hundred nanoseconds matter.

### The Cisco Nexus 3550 Fusion Baseline

When discussing HFT latency, the Cisco Nexus 3550 (formerly Exablaze, acquired by Cisco) is the baseline switch. It cuts through frames in ~95 nanoseconds end to end (port to port). Compare that to typical 1us Mellanox SN5400, 600 ns Mellanox Spectrum-3 cut-through, 5+ us standard datacenter switches. The 3550 is what colocation cabinets at exchange data centers actually contain because it is the only switch fast enough not to dominate the budget when the NIC does its job in 300 ns.

Knowing this matters for tradeoff analysis. If your switch chain adds 10 microseconds, optimizing the NIC from 1.4us to 0.3us is rounding error. Spend the budget where the latency is.

### Onload Tuning Cheat Sheet

```bash
# The full list of env vars OnLoad respects
onload_tool show all_vars

# Common HFT settings
export EF_PROFILE=latency-best
export EF_POLL_USEC=100000        # spin up to 100ms before any sleep
export EF_INT_DRIVEN=0            # disable interrupts on data path
export EF_TCP_FASTSTART=0         # skip slow start for known good paths
export EF_HIGH_THROUGHPUT=0       # latency-favored
export EF_TX_PUSH=1               # PIO-style tx push
export EF_PACKET_BUFFER_MODE=2    # huge packet buffers
export EF_RX_TIMESTAMPING=1       # hw rx timestamps in cmsg
export EF_TX_TIMESTAMPING=1       # hw tx timestamps via SO_TIMESTAMPING
```

Run with `onload_stackdump lots` and look for `recv_polled_pkts_high` close to total recv count: this confirms you are hitting the polled fast path, not the interrupt fallback.

### Choosing Between OpenOnload and ef_vi

- **Use OpenOnload** when the application uses BSD sockets and you need the speed-up without a rewrite. UDP receive is already at 600 ns. TCP receive is 1.4us. Most market data feed handlers and order management systems live here.
- **Use ef_vi** when 600 ns is too slow, you need <500 ns, and you can encode your own frames. Tick-to-trade hot paths sit here. The cost is hand-rolled wire format encoding/decoding and your own session/recovery logic.

Mixed deployments are common: market data on ef_vi, drop copies and acks via Onload, control plane via kernel sockets.

> Junior engineer behavior: declaring "we use OpenOnload" without verifying which sockets actually accelerated.
> Senior FAANG move: `onload_stackdump` shows polled-recv hit rate per stack, EF_PROFILE chosen per workload, ef_vi used for the inner loop where the budget demands it, and the switch chain measured separately so the latency budget reads correctly.
