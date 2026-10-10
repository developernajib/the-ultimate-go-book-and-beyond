## QUIC Userspace Implementations: msquic, lsquic, picoquic, quiche

QUIC is a userspace-by-design transport. Unlike TCP, where the kernel owns the protocol, QUIC runs in the application. This makes QUIC a natural fit for kernel-bypass: the protocol logic is already where you want it, you just need to feed it packets without going through the kernel network stack. This chapter covers the major C/C++ QUIC stacks, their integration with kernel-bypass paths, and the UDP send/recv batching tricks that matter at scale.

### Why QUIC Is Different

TCP runs in the kernel because the kernel sits between the application and the wire and needs to enforce protocol invariants (sequence numbers, retransmits) regardless of what the application does. The cost: every TCP packet pays for kernel-user crossings, locks, and skbs.

QUIC runs over UDP. UDP is "send these bytes to that address" with no protocol logic. All the protocol state (streams, flow control, congestion control, encryption) is in the application. This makes the kernel's UDP layer a thin pipe, replace it with AF_XDP, DPDK, or io_uring with zerocopy and you get the full benefit of bypass with no protocol rewrite.

The numbers: a typical QUIC server using kernel UDP sockets is bottlenecked on `sendmsg` and `recvmsg` syscall cost at around 200K req/s/core. The same server on AF_XDP or DPDK pushes to 1.5M req/s/core. The CPU saved is real and the latency improvement is real.

### msquic (Microsoft)

msquic is Microsoft's QUIC implementation, used in Windows Server, IIS, and Edge. It is C, MIT-licensed, and the most production-hardened open-source QUIC stack as of 2024-2025.

Architecture:

- Single library, callback-based API.
- Native multi-thread design with per-worker connection sharding.
- Zero-copy receive on Windows (RIO) and Linux (io_uring with msg_zerocopy / GSO).
- HTTP/3 layered on top via the `MsH3` library.

Skeleton C++ wrapper around msquic for a server:

```cpp
#include <msquic.h>

const QUIC_API_TABLE* api;
HQUIC reg, conf, listener;

QUIC_STATUS QUIC_API conn_cb(HQUIC c, void* ctx, QUIC_CONNECTION_EVENT* e) {
    switch (e->Type) {
        case QUIC_CONNECTION_EVENT_CONNECTED:
            // handshake complete
            break;
        case QUIC_CONNECTION_EVENT_PEER_STREAM_STARTED:
            api->SetCallbackHandler(e->PEER_STREAM_STARTED.Stream,
                (void*)stream_cb, nullptr);
            break;
    }
    return QUIC_STATUS_SUCCESS;
}

QUIC_STATUS QUIC_API listener_cb(HQUIC l, void* ctx, QUIC_LISTENER_EVENT* e) {
    if (e->Type == QUIC_LISTENER_EVENT_NEW_CONNECTION) {
        api->SetCallbackHandler(e->NEW_CONNECTION.Connection,
            (void*)conn_cb, nullptr);
        api->ConnectionSetConfiguration(e->NEW_CONNECTION.Connection, conf);
    }
    return QUIC_STATUS_SUCCESS;
}

void start_server() {
    MsQuicOpen2(&api);
    QUIC_REGISTRATION_CONFIG rcfg{ "myserver", QUIC_EXECUTION_PROFILE_LOW_LATENCY };
    api->RegistrationOpen(&rcfg, &reg);

    QUIC_SETTINGS s{};
    s.IsSet.PeerBidiStreamCount = 1;
    s.PeerBidiStreamCount = 100;
    s.IsSet.IdleTimeoutMs = 1;
    s.IdleTimeoutMs = 60000;

    const QUIC_BUFFER alpn { 2, (uint8_t*)"h3" };
    api->ConfigurationOpen(reg, &alpn, 1, &s, sizeof(s), nullptr, &conf);
    // load TLS cert here
    api->ConfigurationLoadCredential(conf, &cred_cfg);

    api->ListenerOpen(reg, listener_cb, nullptr, &listener);
    QUIC_ADDR addr{};
    QuicAddrSetFamily(&addr, QUIC_ADDRESS_FAMILY_INET);
    QuicAddrSetPort(&addr, 4433);
    api->ListenerStart(listener, &alpn, 1, &addr);
}
```

Build:

```bash
sudo apt install libmsquic
g++ -O3 -std=c++20 server.cpp -o server -lmsquic
```

msquic on Linux uses a "datapath" abstraction. Default is kernel sockets via `recvmmsg/sendmmsg`. Higher-performance datapaths exist as plug-ins:

- **io_uring with GSO/UDP-segmentation.** The default high-perf path on modern kernels (5.15+).
- **AF_XDP.** Experimental in some forks.
- **Custom DPDK datapath.** Available via patches, not upstream.

### lsquic (LiteSpeed)

lsquic is LiteSpeed's QUIC stack, used in OpenLiteSpeed and LiteSpeed Web Server. Also C, MIT-licensed. Focus is HTTP/3 server performance. It has a clean engine API where the application supplies UDP I/O callbacks, making it easy to integrate with non-kernel transports.

```c
struct lsquic_engine_settings settings;
lsquic_engine_init_settings(&settings, LSENG_SERVER);
struct lsquic_engine_api api{};
api.ea_packets_out = my_send_packets;   // your AF_XDP / DPDK send
api.ea_get_ssl_ctx = my_ssl_ctx;
api.ea_stream_if   = &my_stream_if;
lsquic_engine_t* eng = lsquic_engine_new(LSENG_SERVER, &api);
```

The `ea_packets_out` callback hands the application a batch of UDP packets to put on the wire. You can implement it as a `sendmmsg` call (kernel) or as a DPDK TX burst (bypass). This pluggable I/O is exactly the right shape for kernel-bypass integration.

### picoquic

picoquic is the academic / research reference QUIC. Maintained by Christian Huitema, used in IETF interop testing. Plain C, BSD-licensed. Smaller and simpler than msquic or lsquic.

It is not the fastest production stack but it is the cleanest reference for understanding QUIC internals. If you are building your own implementation or learning, picoquic is the source to read.

### Cloudflare quiche

quiche is Cloudflare's Rust QUIC stack, with a C API. It is what powers Cloudflare's HTTP/3 edge. Production-grade, well-tested at internet scale. C++ projects can link against the C API.

```cpp
#include <quiche.h>

quiche_config* cfg = quiche_config_new(QUICHE_PROTOCOL_VERSION);
quiche_config_load_cert_chain_from_pem_file(cfg, "cert.pem");
quiche_config_load_priv_key_from_pem_file(cfg, "key.pem");
quiche_config_set_application_protos(cfg, (uint8_t*)"\x02h3", 3);
// ... per-connection setup ...
```

quiche's design separates connection state from I/O entirely. Your application reads UDP packets and calls `quiche_conn_recv`, you call `quiche_conn_send` to get bytes to put on the wire. Plug in any transport.

### UDP Batching: sendmmsg, recvmmsg, GSO, GRO

Even on kernel UDP, batching reduces syscall overhead substantially.

- **`recvmmsg`/`sendmmsg`.** Receive or send up to N datagrams in one syscall. Saves syscall entry per packet. Improves throughput 3-5x for small datagrams.

```cpp
struct mmsghdr msgs[64];
struct iovec  iovs[64];
char          bufs[64][1500];
for (int i = 0; i < 64; i++) {
    iovs[i] = { bufs[i], sizeof(bufs[i]) };
    msgs[i].msg_hdr = { nullptr, 0, &iovs[i], 1, nullptr, 0, 0 };
}
int n = recvmmsg(sock, msgs, 64, MSG_WAITFORONE, nullptr);
```

- **UDP GSO (Generic Segmentation Offload, kernel side).** Application sends one large UDP datagram with a `UDP_SEGMENT` cmsg specifying segment size, kernel splits into MTU-sized packets. NIC may further offload via hardware GSO.

```cpp
constexpr int GSO_SIZE = 1200;
char buf[64 * GSO_SIZE];
struct msghdr m{};
struct iovec  io = { buf, sizeof(buf) };
m.msg_iov = &io; m.msg_iovlen = 1;
char ctrl[CMSG_SPACE(sizeof(uint16_t))];
m.msg_control = ctrl; m.msg_controllen = sizeof(ctrl);
auto* cm = CMSG_FIRSTHDR(&m);
cm->cmsg_level = SOL_UDP; cm->cmsg_type = UDP_SEGMENT;
cm->cmsg_len = CMSG_LEN(sizeof(uint16_t));
*reinterpret_cast<uint16_t*>(CMSG_DATA(cm)) = GSO_SIZE;
sendmsg(sock, &m, 0);
```

GSO is critical for QUIC. Without it, sending a 1MB stream chunk requires 700 individual `sendmsg` calls. With GSO, it is one syscall plus kernel-side segmentation.

- **UDP GRO (receive side).** Kernel coalesces multiple incoming UDP datagrams from the same flow into one read. Application sees them as one large buffer with a cmsg indicating segment size.

- **io_uring zerocopy send.** With `IORING_OP_SEND_ZC`, the kernel borrows the application buffer for DMA without copying. The application receives a notification when DMA completes and the buffer can be reused. Saves the copy_from_user cost on every sendmsg.

### QUIC + AF_XDP: The Cloudflare Pattern

Cloudflare's edge has demonstrated the model. Each NIC queue has an AF_XDP socket, an XDP program redirects QUIC UDP to it. The application reads packets from the AF_XDP UMEM, hands them to quiche, gets reply packets back, writes them to the TX side of the AF_XDP socket.

Why this works: QUIC packets do not need any kernel network logic (no routing, no firewall, no congestion control in the kernel). The XDP program does a 5-tuple match on UDP/443 and redirects. Everything else is in userspace.

The performance benefit: roughly 3x req/sec/core vs kernel UDP. The operational benefit: kernel still handles non-QUIC traffic on the same NIC without disruption.

### Choosing a Stack

```
Need                                          Pick
----                                          ----
Production HTTP/3 server with active dev      msquic
Embeddable, callback-based, server side       lsquic
Research, IETF interop, learning              picoquic
Rust-friendly, edge-oriented                  quiche (Cloudflare)
Fastest pure throughput on Linux              msquic with io_uring datapath
```

> Junior engineer behavior: writing a QUIC application against `sendmsg/recvmsg` and being surprised at low throughput.
> Senior FAANG move: profile the syscall stack, switch to recvmmsg+sendmmsg as a baseline, add UDP GSO for write-side batching, and where 100 Gbit per host is the target, integrate AF_XDP or io_uring zero-copy as the I/O layer below the QUIC engine.
