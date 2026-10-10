## Colocation and Network Optimization

The fastest code in the world is worthless if it takes 5 milliseconds to receive a market data update because your servers are 100 km from the exchange. Geographic proximity is the most fundamental latency optimization in HFT, and it is not a software problem, it is a real estate and physics problem.

### Colocation: The Physical Edge

Colocation means renting rack space inside the same data center that hosts the exchange's matching engine. The wire latency from a server at NY4 (Equinix NY4, home to NYSE) to the NYSE matching engine is measured in nanoseconds across a direct fiber cross-connect. From a server 50 km away in a general-purpose data center, the same round trip is 500 μs.

Key colocation facilities:

| Facility | Exchanges | Location |
|---|---|---|
| Equinix NY4 | NYSE, Arca | Secaucus, NJ |
| Equinix NY5 | NASDAQ, BATS | Secaucus, NJ |
| Equinix LD4 | LSE, ICE | Slough, UK |
| CME Aurora | CME Group | Aurora, IL |
| Equinix TY3 | TSE, OSE | Tokyo, JP |

A **cross-connect** is a direct fiber connection between your cabinet and the exchange's cabinet within the same facility. A cross-connect at NY4 to NYSE latency is approximately 100 μs round-trip (limited by the exchange's matching engine processing time, not wire delay). Without a cross-connect, traffic traverses the facility's shared network and adds 5-20 μs.

### Microwave and Millimeter-Wave Networks

Speed of light in fiber (~200,000 km/s) is two-thirds the speed of light in vacuum. In air or vacuum, light travels at 300,000 km/s. Microwave networks exploit this: towers relay signals through the atmosphere at near-vacuum speed of light, giving a 30% latency advantage over fiber across the same geographic distance.

The Chicago-New York route is the canonical example:
- Fiber distance: ~1,300 km → ~6.5 ms one-way
- Straight-line distance: ~1,200 km → ~4.0 ms one-way
- Microwave network (Jump Trading, McKay Brothers): ~4.1 ms one-way

That 2.4 ms advantage means a Chicago firm using microwave receives New York price updates significantly before their competitors using fiber, and can trade on them before prices in Chicago update.

Millimeter-wave (E-band, 70-80 GHz) offers higher bandwidth than microwave but shorter range and more weather sensitivity. Laser (free-space optical) communication offers the best latency but is blocked by fog and rain. Top-tier trading firms combine multiple technologies with automatic failover.

### Network Interface Tuning

Even with colocation and cross-connects, the NIC-to-application path must be tuned. These are the key settings for minimum latency:

```bash
# Disable interrupt coalescing -- receive an interrupt for every packet,
# not batched. Costs CPU but eliminates up to 100 μs of coalescing delay.
ethtool -C eth0 rx-usecs 0 rx-frames 1 tx-usecs 0 tx-frames 1

# Bind NIC RX interrupt to an isolated core (not the cores running your app).
# Find the interrupt number:
grep eth0 /proc/interrupts
# Output: 45: ... eth0-rx-0
# Pin it:
echo 4 > /proc/irq/45/smp_affinity_list   # Core 4 handles NIC interrupts

# Disable Nagle's algorithm on TCP connections (order submission)
# Always set TCP_NODELAY on latency-sensitive sockets
int flag = 1;
setsockopt(sockfd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));

# Enable busy-polling on UDP receive sockets
# The socket will spin for up to 50 μs before sleeping, eliminating
# wakeup latency for packets that arrive within that window
int busy_poll_us = 50;
setsockopt(sockfd, SOL_SOCKET, SO_BUSY_POLL, &busy_poll_us, sizeof(busy_poll_us));

# Tune receive and send buffers (set before connect/bind)
int rcvbuf = 4 * 1024 * 1024;  // 4 MB
int sndbuf = 4 * 1024 * 1024;
setsockopt(sockfd, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof(rcvbuf));
setsockopt(sockfd, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));
```

### Multicast Market Data Receiver

Most US exchanges distribute market data via UDP multicast. All co-located participants join the same multicast group and receive every packet simultaneously, latency is determined only by NIC processing, not by any per-client queuing at the exchange.

```cpp
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <cstring>
#include <cstdio>
#include <stdexcept>

class MulticastReceiver {
    int sockfd_{-1};

public:
    // Join a multicast group and bind to the specified port.
    // iface_ip: IP address of the NIC to receive on (important in multi-NIC setups)
    // group_ip: multicast group (e.g., "233.54.12.111" for NASDAQ ITCH)
    MulticastReceiver(const char* iface_ip, const char* group_ip, uint16_t port) {
        sockfd_ = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (sockfd_ < 0) throw std::runtime_error("socket failed");

        // Allow multiple processes to bind the same port (for A/B feed redundancy)
        int reuse = 1;
        setsockopt(sockfd_, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
        setsockopt(sockfd_, SOL_SOCKET, SO_REUSEPORT, &reuse, sizeof(reuse));

        // Disable Nagle (no-op for UDP but good practice for TCP order sockets)
        // For UDP: ensure kernel does not fragment large packets
        int pmtud = IP_PMTUDISC_DO;
        setsockopt(sockfd_, IPPROTO_IP, IP_MTU_DISCOVER, &pmtud, sizeof(pmtud));

        // Maximize socket receive buffer
        int rcvbuf = 16 * 1024 * 1024;  // 16 MB
        setsockopt(sockfd_, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof(rcvbuf));

        // Bind to the multicast port on INADDR_ANY
        sockaddr_in local{};
        local.sin_family      = AF_INET;
        local.sin_port        = htons(port);
        local.sin_addr.s_addr = INADDR_ANY;
        if (bind(sockfd_, reinterpret_cast<sockaddr*>(&local), sizeof(local)) < 0) {
            throw std::runtime_error("bind failed");
        }

        // Join the multicast group on the specified interface
        ip_mreq mreq{};
        mreq.imr_multiaddr.s_addr = inet_addr(group_ip);
        mreq.imr_interface.s_addr = inet_addr(iface_ip);
        if (setsockopt(sockfd_, IPPROTO_IP, IP_ADD_MEMBERSHIP,
                       &mreq, sizeof(mreq)) < 0) {
            throw std::runtime_error("IP_ADD_MEMBERSHIP failed");
        }

        // Enable hardware timestamps
        enable_hw_timestamps(sockfd_, "eth0");

        // Enable busy-polling: spin for up to 50 μs before sleeping
        int busy_us = 50;
        setsockopt(sockfd_, SOL_SOCKET, SO_BUSY_POLL, &busy_us, sizeof(busy_us));
    }

    ~MulticastReceiver() { if (sockfd_ >= 0) close(sockfd_); }

    // Receive one UDP datagram with hardware timestamp.
    // Returns payload length, fills buf, sets hw_ts_ns.
    ssize_t receive(uint8_t* buf, size_t buflen, uint64_t& hw_ts_ns) {
        alignas(16) char ctrl[512];

        iovec iov{buf, buflen};
        msghdr msg{};
        msg.msg_iov        = &iov;
        msg.msg_iovlen     = 1;
        msg.msg_control    = ctrl;
        msg.msg_controllen = sizeof(ctrl);

        ssize_t n = recvmsg(sockfd_, &msg, MSG_DONTWAIT);
        if (n < 0) return n;

        hw_ts_ns = 0;
        for (cmsghdr* cm = CMSG_FIRSTHDR(&msg); cm; cm = CMSG_NXTHDR(&msg, cm)) {
            if (cm->cmsg_level == SOL_SOCKET && cm->cmsg_type == SO_TIMESTAMPING) {
                auto* ts = reinterpret_cast<scm_timestamping*>(CMSG_DATA(cm));
                const timespec& hw = ts->ts[2];
                if (hw.tv_sec || hw.tv_nsec) {
                    hw_ts_ns = static_cast<uint64_t>(hw.tv_sec) * 1'000'000'000ULL
                             + static_cast<uint64_t>(hw.tv_nsec);
                }
            }
        }

        return n;
    }
};
```

### Feed Redundancy: A and B Feeds

Exchanges transmit market data on two independent multicast groups, the A feed and the B feed, over separate network paths. This provides redundancy against packet loss. The feed handler must deduplicate based on sequence number: if the same message arrives on both feeds, process it only once.

```cpp
class RedundantFeedReceiver {
    MulticastReceiver feed_a_;
    MulticastReceiver feed_b_;
    uint64_t          next_seq_{1};

public:
    RedundantFeedReceiver(/* ... */)
        : feed_a_("10.0.0.1", "233.54.12.111", 26477)
        , feed_b_("10.0.0.1", "233.54.12.112", 26477)
    {}

    // Process whichever feed delivers the packet first.
    // The sequence number in the payload is the deduplication key.
    void poll(MarketDataHandler& handler) {
        uint8_t  buf[4096];
        uint64_t hw_ts_ns;

        auto try_feed = [&](MulticastReceiver& feed) {
            ssize_t n = feed.receive(buf, sizeof(buf), hw_ts_ns);
            if (n <= 0) return;

            uint64_t seq = extract_sequence(buf, n);
            if (seq == next_seq_) {
                handler.on_message(buf, n, hw_ts_ns);
                ++next_seq_;
            } else if (seq > next_seq_) {
                // Gap detected -- request retransmit from recovery feed
                request_gap_fill(next_seq_, seq - 1);
            }
            // seq < next_seq_: duplicate from redundant feed, discard
        };

        try_feed(feed_a_);
        try_feed(feed_b_);
    }
};
```

### Go Comparison

Go's `net` package adds an abstraction layer over raw sockets. For most use cases this is fine, but the `SO_BUSY_POLL`, `SO_TIMESTAMPING`, and `IP_MTU_DISCOVER` socket options shown above require `syscall.SetsockoptInt` or `golang.org/x/sys/unix` calls. The multicast join (`IP_ADD_MEMBERSHIP`) is available via `net.ListenMulticastUDP` but does not expose the low-level NIC interface selection needed for multi-NIC colocation setups. Go is perfectly usable for non-latency-critical feed consumers (persistence, reporting, risk monitoring), but the sub-microsecond path stays in C++.

---
