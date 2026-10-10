## Hardware Timestamping

Software timestamps are collected by the CPU after the packet has already traveled through the NIC driver, interrupt handler, and kernel network stack. By the time your application calls `clock_gettime()`, the packet may have been sitting in a buffer for 10-100 μs. For HFT, this is useless. You need to know when the packet physically arrived at the NIC, to the nanosecond.

Hardware timestamping solves this: the NIC records the precise arrival time at the moment the first byte of the packet crosses the wire, using the NIC's onboard clock. No software jitter, no scheduling delay, no kernel overhead, just the physics of the wire.

### Why Software Timestamps Lie

Consider a market data packet that arrives at 12:00:00.000001000 (1 μs into the second). The packet sits in the NIC's RX FIFO while the kernel handles an unrelated interrupt. The kernel processes it at 12:00:00.000050000 (50 μs later). Your application reads it with a software timestamp of 12:00:00.000052000.

Your software thinks the packet arrived at 52 μs. It actually arrived at 1 μs. That 51 μs error completely distorts your latency measurement and, worse, your strategy's view of market timing. When you are trying to determine whether a signal arrived before or after a price move, 51 μs of timestamp jitter makes the analysis meaningless.

### Linux Hardware Timestamping: `SO_TIMESTAMPING`

Linux provides hardware timestamp access through the `SO_TIMESTAMPING` socket option. The NIC must support hardware timestamping (Mellanox ConnectX, Intel X710, Solarflare SFN series all do):

```cpp
#include <linux/net_tstamp.h>
#include <linux/sockios.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <cstring>
#include <cerrno>
#include <cstdio>

// Enable hardware RX timestamps on a UDP socket.
// The NIC will stamp each packet at the wire - we retrieve
// the timestamp via ancillary data in recvmsg().
bool enable_hw_timestamps(int sockfd, const char* iface_name) {
    // Tell the NIC to generate hardware timestamps for RX packets
    struct hwtstamp_config hwconfig{};
    hwconfig.rx_filter = HWTSTAMP_FILTER_ALL;
    hwconfig.tx_type   = HWTSTAMP_TX_OFF;

    struct ifreq ifr{};
    std::strncpy(ifr.ifr_name, iface_name, IFNAMSIZ - 1);
    ifr.ifr_data = reinterpret_cast<char*>(&hwconfig);

    if (ioctl(sockfd, SIOCSHWTSTAMP, &ifr) < 0) {
        perror("SIOCSHWTSTAMP failed -- NIC may not support HW timestamps");
        return false;
    }

    // Request hardware timestamps on this socket
    int flags = SOF_TIMESTAMPING_RX_HARDWARE    // Use NIC hardware clock
              | SOF_TIMESTAMPING_RAW_HARDWARE    // Return raw NIC time
              | SOF_TIMESTAMPING_SOFTWARE        // Also get software fallback
              | SOF_TIMESTAMPING_OPT_CMSG        // Deliver via cmsg
              | SOF_TIMESTAMPING_OPT_TSONLY;     // Timestamps only (no payload copy)

    if (setsockopt(sockfd, SOL_SOCKET, SO_TIMESTAMPING, &flags, sizeof(flags)) < 0) {
        perror("setsockopt SO_TIMESTAMPING");
        return false;
    }

    return true;
}
```

### Receiving Packets with Hardware Timestamps

Hardware timestamps are delivered as ancillary data in `recvmsg()`. Three `timespec` values are delivered in a `scm_timestamping` struct: software timestamp, deprecated hardware timestamp, and raw hardware timestamp:

```cpp
#include <linux/net_tstamp.h>
#include <sys/socket.h>
#include <cstdint>
#include <cstring>

struct PacketWithTimestamp {
    uint8_t  data[2048];
    uint16_t len;
    timespec hw_timestamp;   // From NIC hardware clock
    timespec sw_timestamp;   // From kernel software clock (fallback)
    bool     has_hw_ts;
};

bool receive_with_timestamp(int sockfd, PacketWithTimestamp& pkt) {
    // Control message buffer -- must be large enough for SO_TIMESTAMPING cmsg
    alignas(16) char control_buf[1024];

    iovec iov{};
    iov.iov_base = pkt.data;
    iov.iov_len  = sizeof(pkt.data);

    msghdr msg{};
    msg.msg_iov        = &iov;
    msg.msg_iovlen     = 1;
    msg.msg_control    = control_buf;
    msg.msg_controllen = sizeof(control_buf);

    ssize_t n = recvmsg(sockfd, &msg, 0);
    if (n < 0) return false;

    pkt.len       = static_cast<uint16_t>(n);
    pkt.has_hw_ts = false;

    // Walk ancillary data to find the timestamp
    for (cmsghdr* cmsg = CMSG_FIRSTHDR(&msg);
         cmsg != nullptr;
         cmsg = CMSG_NXTHDR(&msg, cmsg))
    {
        if (cmsg->cmsg_level == SOL_SOCKET &&
            cmsg->cmsg_type  == SO_TIMESTAMPING)
        {
            const auto* ts = reinterpret_cast<scm_timestamping*>(CMSG_DATA(cmsg));
            // ts[0] = software timestamp
            // ts[1] = deprecated (zero)
            // ts[2] = raw hardware timestamp
            pkt.sw_timestamp = ts[0].ts[0];
            pkt.hw_timestamp = ts[0].ts[2];
            pkt.has_hw_ts    = (pkt.hw_timestamp.tv_sec != 0 ||
                                pkt.hw_timestamp.tv_nsec != 0);
            break;
        }
    }

    return true;
}

// Compute processing latency: time from hardware stamp to now
int64_t compute_processing_latency_ns(const timespec& hw_ts) {
    timespec now;
    clock_gettime(CLOCK_REALTIME, &now);  // Must be PTP-synced to NIC clock

    int64_t hw_ns  = hw_ts.tv_sec * 1'000'000'000LL  + hw_ts.tv_nsec;
    int64_t now_ns = now.tv_sec  * 1'000'000'000LL  + now.tv_nsec;

    return now_ns - hw_ns;
}
```

### PTP: Synchronizing Clocks Across Machines

Hardware timestamps are only useful if you can compare them across different machines, for example, to measure the latency from when the exchange sent a message to when you received it. This requires all machines to agree on absolute time to nanosecond accuracy. PTP (Precision Time Protocol, IEEE 1588) achieves < 100 ns accuracy across a local network when hardware-assisted.

```bash
# Install and configure ptp4l (PTP daemon) with hardware timestamping
# ptp4l syncs the NIC's hardware clock (PHC) to a grandmaster clock
ptp4l -i eth0 -f /etc/ptp4l.conf -m

# phc2sys syncs the system clock (CLOCK_REALTIME) to the NIC hardware clock
# This is what allows clock_gettime(CLOCK_REALTIME) to match hw timestamps
phc2sys -s eth0 -c CLOCK_REALTIME -O 0 -m

# Verify synchronization quality -- look for "rms" (RMS offset) < 100 ns
pmc -u -b 0 'GET CURRENT_DATA_SET'
```

The PTP grandmaster in a typical HFT setup is a GPS-disciplined atomic clock in the colocation facility. GPS provides < 100 ns absolute time accuracy. With a high-quality PTP-aware switch (e.g., Arista 7150, Cisco Nexus 3500 with PTP license) and hardware-timestamping NICs, end-to-end synchronization of < 50 ns is achievable.

### TSC-Based Timestamps in DPDK

When using DPDK, the NIC hardware timestamp is accessible without the `SO_TIMESTAMPING` syscall overhead:

```cpp
// DPDK: read hardware timestamp from the mbuf directly
// The NIC must be configured with RTE_ETH_RX_OFFLOAD_TIMESTAMP
uint64_t get_dpdk_hw_timestamp(rte_mbuf* mbuf) {
    // mbuf->timestamp is set by the PMD when RTE_MBUF_F_RX_TIMESTAMP is set
    if (mbuf->ol_flags & RTE_MBUF_F_RX_TIMESTAMP) {
        return mbuf->timestamp;  // Nanoseconds, NIC clock domain
    }
    // Fallback: use TSC converted to ns
    return static_cast<uint64_t>(tsc_to_ns(rdtsc_relaxed()));
}

// For DPDK ports that support hardware time sync:
void sync_dpdk_time(uint16_t port_id) {
    // Read a timestamp and the corresponding PTP time
    // to calibrate the NIC clock offset
    timespec spec;
    rte_eth_timesync_read_time(port_id, &spec);

    uint64_t nic_ts;
    rte_eth_timesync_read_rx_timestamp(port_id, &spec, 0);
}
```

### GPS-Disciplined Oscillators at Colocation

For the highest-precision time at a colocation facility, firms install GPS-disciplined oscillators (GPSDO) directly in their cabinets. A GPSDO receives GPS signals (which carry atomic clock time) and disciplines a local crystal oscillator to match. The result is a local time source accurate to < 10 ns that does not depend on network PTP propagation.

Common hardware: Trimble Thunderbolt, EndRun Technologies Sonoma D12, Meinberg GPS170PEX (PCI-E card). These provide a PPS (pulse-per-second) signal and often a 10 MHz reference clock that PTP grandmasters and NIC hardware clocks can lock onto.

### Go Comparison

Go provides no hardware timestamping API. Accessing `SO_TIMESTAMPING` requires the `syscall` package for the `ioctl` call and manual `cmsghdr` parsing, all of which is possible but amounts to writing C-style code in Go. More importantly, Go's `recvmsg` wrapper does not expose ancillary data in a convenient form. You must use `syscall.RawConn.Control` or write the entire socket loop using raw syscalls. This is not a fundamental language limitation, but it illustrates that Go was not designed for this use case. In practice, teams that need hardware timestamps in Go write a C shim and call it via CGo.

---
