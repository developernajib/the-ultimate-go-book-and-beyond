## Exercises

These exercises are hands-on labs. Each is a non-trivial multi-day project. Equipment requirements range from "two cabled Linux boxes with stock NICs" to "two boxes with Mellanox CX-6 or Solarflare X2522." Where specialized hardware is needed, an alternative path using virtual interfaces (veth, VFIO-pci on a VM, AF_XDP generic mode) is suggested.

---

### Lab 1: Measure the Kernel TCP Tax (1-2 days, any hardware)

**Goal.** Quantify, on your specific hardware, the cost of every step in `recv()` for kernel TCP. Produce a histogram.

**Steps.**

1. Set up two hosts with kernel TCP, run a constant-rate UDP and TCP echo workload between them. Use `iperf3 -u -b 1G -l 64` for UDP, `iperf3 -P 1` for TCP.

2. Use `bpftrace` to histogram per-call `tcp_recvmsg` latency:

```bash
sudo bpftrace -e '
kprobe:tcp_recvmsg { @start[tid] = nsecs; }
kretprobe:tcp_recvmsg /@start[tid]/ {
    @ns = hist(nsecs - @start[tid]); delete(@start[tid]);
}'
```

3. Capture per-step latencies using `perf record` with detailed function tracing on `__softirq_entry`, `napi_poll`, `__build_skb`, `tcp_v4_rcv`, `tcp_rcv_established`, `sk_data_ready`, `tcp_recvmsg`, `copy_user_enhanced_fast_string`. Compute median and p99 per step.

4. Repeat with `mitigations=off` on the kernel command line. Measure how much KPTI/Spectre cost.

5. Write a report comparing your numbers to chapter 02's table.

**Deliverable.** A markdown report with histograms, per-step costs, and an explanation of why your numbers differ from the chapter's reference numbers (different CPU, different kernel version, different load).

---

### Lab 2: Build a DPDK Bouncer With NUMA Awareness (3-5 days, DPDK-capable hardware or VM)

**Goal.** Implement, build, and benchmark the DPDK packet bouncer from chapter 03. Extend it to multi-queue and NUMA-aware.

**Steps.**

1. Set up DPDK 23.11 LTS on Ubuntu 24.04. Allocate hugepages, bind a NIC to vfio-pci.

2. Implement the bouncer with one RX queue, one TX queue, one lcore. Verify line rate at 1 GbE (148 kpps for 64 byte frames).

3. Extend to 8 RX queues and 8 TX queues using symmetric Toeplitz RSS. Verify per-queue distribution under random-flow traffic.

4. Make NUMA-aware: query `rte_eth_dev_socket_id`, allocate per-NUMA mempool, pick lcores on the matching socket. Compare throughput before and after the NUMA fix.

5. Add per-lcore HdrHistogram of per-burst processing latency. Output histograms at shutdown.

**Deliverable.** Source code on Github plus a README documenting throughput, NUMA-fix improvement (typically 15-30%), and per-queue latency histograms.

**Notes.** If you do not have access to a DPDK-capable physical NIC, use VFIO-pci passthrough on a VM, or run DPDK testpmd in `pcap` PMD mode against a userspace virtio. Performance numbers will be lower but the structural lessons are the same.

---

### Lab 3: AF_XDP Zero-Copy Receiver (3-5 days, modern kernel + libxdp)

**Goal.** Build an AF_XDP receiver that consumes a 5-tuple-filtered UDP flow, using zero-copy mode.

**Steps.**

1. Write an XDP program in C that matches UDP packets to a target port and `bpf_redirect_map`s them to AF_XDP. Compile with clang.

2. In C++, set up libxdp, allocate hugepage-backed UMEM, create the AF_XDP socket with `XDP_ZEROCOPY`. Verify the socket bound in zero-copy mode (check ethtool counters or printed status).

3. Implement the FILL/RX/COMP/TX ring loop. Process each packet (extract a 4-byte sequence number from the payload, check for gaps).

4. Compare CPU usage and per-packet latency vs an equivalent kernel UDP recvmmsg implementation under matched load.

5. Test fallback to copy mode by running on a NIC or driver that does not support zero-copy.

**Deliverable.** Source code, README, latency comparison plot.

---

### Lab 4: RDMA RPC Over UD (5-7 days, RDMA-capable hardware or Soft-RoCE)

**Goal.** Build a minimal RDMA RPC client and server using UD QPs, with software-implemented reliability.

**Steps.**

1. Install rdma-core. If no RDMA NIC, set up Soft-RoCE on a regular NIC: `sudo rdma link add rxe0 type rxe netdev eth0`.

2. Implement an RDMA UD send/recv loop in C++. Establish QP via librdmacm or out-of-band TCP exchange of QPN + GID. Post 256 RECVs upfront on the server. Send a request, receive a response, measure round-trip.

3. Add software sequence numbers and ack tracking on top of UD to handle the unreliable delivery (resend on timeout, dedupe on receiver).

4. Measure round-trip latency with HdrHistogram, compare to TCP echo on the same hardware.

5. Stress-test with concurrent client connections (1, 10, 100, 1000) and observe scaling vs one QP per peer using RC.

**Deliverable.** Source code plus a writeup comparing UD-with-software-reliability vs RC-per-peer at different scales.

---

### Lab 5: Order Book + ITCH Replay (5-10 days, any hardware)

**Goal.** Implement the deterministic order book from chapter 13, verify it against a captured ITCH replay file, benchmark per-message latency.

**Steps.**

1. Obtain a Nasdaq TotalView ITCH 5.0 sample file (Nasdaq publishes daily samples for protocol testing).

2. Implement the order book with tick-array-indexed price levels, open-addressed hash for order IDs, slab-allocated orders, intrusive lists per level.

3. Implement the ITCH 5.0 message parser (Add, Cancel, Delete, Execute, Replace, Trade). Verify against the replay file.

4. Run the replay through your book at full speed, recording per-message processing time in HdrHistogram.

5. Output the final book state at end of replay, compare to a reference implementation (or to your own implementation under different ordering to test determinism).

**Deliverable.** Source code, parser, book, replay tool, and a histogram of per-message latency. Goal: median <120 ns, p99.9 <500 ns on a typical workstation CPU.

---

### Lab 6: End-to-End Tick-to-Trade Latency (10-15 days, full kernel-bypass setup)

**Goal.** Build a small but complete tick-to-trade simulator: feed handler reads UDP multicast (DPDK), order book updates, strategy decides to send order via TCP (Onload or DPDK with userspace TCP), measure end-to-end latency from "packet on wire" to "order on wire."

**Steps.**

1. Set up two hosts with DPDK or AF_XDP. One acts as the exchange (synthesizes ITCH messages, accepts OUCH orders), the other acts as the trader.

2. Trader process: DPDK feed handler -> shared memory ring (chapter 10) -> strategy thread -> shared memory ring -> order entry process -> DPDK TX or kernel TCP (configurable).

3. Use hardware timestamps on both sides to measure the wire-to-wire latency.

4. Vary configurations: kernel TCP send vs DPDK send, busy-polling vs eventfd-notified consumers, sync vs async strategy/send. Compare.

5. Tune everything in chapter 20 (BIOS, kernel command line, IRQ affinity, NIC settings). Measure improvement at each step.

**Deliverable.** A complete reproducible tick-to-trade benchmark with documented configurations and final latency histograms. Goal: p99 wire-to-wire <2 microseconds with full bypass, p99 <5 microseconds with kernel TCP send. Document the hardware and configuration that achieved each number.

**Notes.** This is the capstone. It exercises every chapter in this book. A successful Lab 6 with documented results is worth showing in interviews, it demonstrates exactly the breadth and depth that L5+ HFT and FAANG networking-track roles look for.
