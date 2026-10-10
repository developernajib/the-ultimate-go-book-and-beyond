## Precision Time: PTP, PHC, Hardware Timestamping

You cannot improve what you cannot measure, and at sub-microsecond latencies you cannot measure with `clock_gettime` alone. The kernel clock on a typical Linux box has tens of microseconds of error against the true wall clock unless it is disciplined by PTP. The NIC has a separate hardware clock, the PHC, that with proper config is accurate to tens of nanoseconds. This chapter walks through getting your timestamps right.

### The Precision Time Protocol (IEEE 1588)

PTP is the network-clock-discipline protocol for sub-microsecond synchronization. The fundamental idea: a grandmaster clock (typically a GPS-disciplined oscillator in the rack) emits Sync messages on the network. Followers measure the one-way delay using Delay_Req/Delay_Resp exchanges, account for it, and slew their local clock toward the master.

The two profiles in production:

- **Default profile (E2E).** Every endpoint exchanges with the master directly. Works on any Ethernet network. Microsecond accuracy.
- **Telecom profile / G.8275.1.** Hop-by-hop with boundary clocks at every switch. Sub-100ns accuracy on a properly engineered fabric.

For HFT, you want G.8275.1 with hardware boundary clocks (Cisco Nexus 3550, Mellanox SN switches, Arista 7130). For most cloud and CDN, default profile is sufficient.

### PHC: The NIC's Hardware Clock

Modern NICs (Intel I210/I225/E810, Mellanox CX-5/6/7, Solarflare X2/X3) have an on-chip clock called the PHC (PTP Hardware Clock). PTP daemons (`ptp4l`) discipline the PHC, not the system clock. Then a second daemon (`phc2sys`) slews the system clock to follow the PHC, or you read PHC directly via `clock_gettime(CLOCK_PHC0, ...)`.

Setup on Ubuntu 24.04:

```bash
sudo apt install linuxptp
# Verify the NIC supports PHC
ethtool -T eth0
# Expected: hardware-transmit, hardware-receive, hardware-raw-clock all listed.
```

`/etc/ptp4l.conf` for an HFT-grade slave:

```
[global]
twoStepFlag             1
slaveOnly               1
priority1               128
priority2               128
domainNumber            0
clock_class_threshold   135
network_transport       L2
delay_mechanism         E2E
time_stamping           hardware
tx_timestamp_timeout    50
[eth0]
```

Run:

```bash
sudo ptp4l -i eth0 -f /etc/ptp4l.conf -m
sudo phc2sys -s eth0 -c CLOCK_REALTIME -O 0 -m
```

After convergence (a few seconds), `pmc -u -b 0 'GET CURRENT_DATA_SET'` shows the offset from master. Anything <100 ns is good for HFT.

### ts2phc: GPS-Disciplined PHC

If you have a 1PPS source (a GPS card with a hardware PPS output), use `ts2phc` to discipline the PHC directly from the PPS, bypassing PTP entirely. This gives the lowest jitter (sub-10 ns) at the cost of needing a wired PPS input on the NIC's SDP pin.

```
[global]
[/dev/pps0]
ts2phc.master 1
[eth0]
```

```bash
sudo ts2phc -f /etc/ts2phc.conf -m
```

Then the PHC follows the GPS PPS, ptp4l in master mode broadcasts the PHC on the network, and the rest of the rack follows.

### Hardware Timestamping in C++ (SO_TIMESTAMPING)

For kernel-stack sockets, ask the kernel to attach hardware timestamps to received packets:

```cpp
#include <linux/net_tstamp.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <linux/errqueue.h>
#include <cstring>

int sock = socket(AF_INET, SOCK_DGRAM, 0);
int flags = SOF_TIMESTAMPING_RX_HARDWARE
          | SOF_TIMESTAMPING_TX_HARDWARE
          | SOF_TIMESTAMPING_RAW_HARDWARE
          | SOF_TIMESTAMPING_OPT_CMSG;
setsockopt(sock, SOL_SOCKET, SO_TIMESTAMPING, &flags, sizeof(flags));

// Receive with cmsg
struct mmsghdr msgs[32];
struct iovec iov[32];
char data[32][2048];
char ctrl[32][512];
for (int i = 0; i < 32; i++) {
    iov[i] = { data[i], sizeof(data[i]) };
    msgs[i].msg_hdr = { nullptr, 0, &iov[i], 1, ctrl[i], sizeof(ctrl[i]), 0 };
    msgs[i].msg_len = 0;
}
int n = recvmmsg(sock, msgs, 32, 0, nullptr);
for (int i = 0; i < n; i++) {
    for (cmsghdr* c = CMSG_FIRSTHDR(&msgs[i].msg_hdr); c;
         c = CMSG_NXTHDR(&msgs[i].msg_hdr, c)) {
        if (c->cmsg_level == SOL_SOCKET
            && c->cmsg_type == SO_TIMESTAMPING) {
            auto* t = reinterpret_cast<const scm_timestamping*>(CMSG_DATA(c));
            // t->ts[2] is the hardware (raw) timestamp
            const auto& hw = t->ts[2];
            printf("rx hw ts: %ld.%09ld\n", hw.tv_sec, hw.tv_nsec);
        }
    }
}
```

For DPDK, enable RX timestamp offload (`RTE_ETH_RX_OFFLOAD_TIMESTAMP`) and read `mbuf->timestamp` (or use the dynamic field `rte_mbuf_timestamp_t`, which is the modern DPDK 23.11+ API).

For ef_vi, `EF_VI_FLAGS_RX_TIMESTAMPS` enables hardware timestamps in the RX event metadata.

### tcpdump with Hardware Timestamps

`tcpdump -j adapter_unsynced -i eth0 -n -tt -w trace.pcap`

`-j adapter_unsynced` requests hardware timestamps from the NIC. The pcap-ng output contains nanosecond-resolution times. Wireshark and tshark display them.

Comparing host clock vs PHC clock in a packet trace immediately shows whether your PTP discipline is working: deltas should be sub-microsecond.

### Leap Seconds

A leap second is one of the worst events in a low-latency shop. The traditional handling jumps the clock by a second, causing every TSC-correlation, every order-timestamp, every audit-log to either go backwards or stall. Two industry-standard fixes:

- **Leap smearing (Google's approach).** Apply 1/86400 second of slew per second over a 24-hour window centered on the leap. Clock never jumps, nothing ever notices. The catch: your clock and your peers' clocks disagree by up to 0.5s during the smear window.
- **Reject the leap.** Some HFT firms tell their PTP source to ignore leaps entirely and run TAI internally. Time displayed to humans is converted at the edge.

Whichever you do, it must be coordinated with the exchange (which has its own policy) and with audit/compliance. Get this wrong and you have a market open with timestamps that disagree with the exchange's books.

### Sub-100-ns Timestamps in C++

The TSC (Time Stamp Counter) on modern x86 ticks at the nominal CPU frequency invariantly. With `tsc=reliable` and `clocksource=tsc` on the kernel command line, plus a calibrated offset from PHC, you can read time in 25 cycles (~6 ns).

```cpp
#include <x86intrin.h>

struct TscClock {
    uint64_t tsc_at_zero;     // TSC value when wall clock was 0 (ns since epoch)
    double   ns_per_tick;
};
TscClock g_clk;

uint64_t now_ns() {
    return uint64_t((__rdtsc() - g_clk.tsc_at_zero) * g_clk.ns_per_tick);
}
```

Calibrate `g_clk` periodically by reading both PHC and TSC and fitting a line. A drift of a few ppm is normal, recalibrate every minute. The fancy version uses `MSR_PLATFORM_INFO` to read the nominal frequency directly.

For sub-cycle ordering on the same core, `__rdtscp()` includes a serializing semantic (after AMD/Intel quirks) that prevents the OoO engine from reordering a TSC read across surrounding loads. For cross-core comparisons, only use `__rdtscp` and confirm `tsc_invariant` is set in `/proc/cpuinfo`.

### Realistic Numbers

```
Source                         Resolution   Stability
clock_gettime(CLOCK_REALTIME)  1 ns         microseconds (NTP-disciplined)
clock_gettime(CLOCK_MONOTONIC) 1 ns         microseconds (system-clock based)
PHC via ts2phc + GPS PPS       1 ns         <10 ns
PTP G.8275.1 boundary-clocked  1 ns         <100 ns
PTP default profile            1 ns         <1 us in well-engineered network
Hardware RX/TX timestamp       1 ns         depends on PHC discipline
TSC (calibrated)               1 ns         <100 ns over a minute
```

> Junior engineer pitfall: comparing nanosecond timestamps from `clock_gettime` across hosts and concluding messages traveled in 800 ns.
> Senior FAANG move: deploying ts2phc with a GPS PPS source, running ptp4l in slave mode disciplining the NIC PHC, taking hardware RX timestamps from the NIC, and emitting a pcap with `tcpdump -j adapter_unsynced` so latency claims are independently auditable.
