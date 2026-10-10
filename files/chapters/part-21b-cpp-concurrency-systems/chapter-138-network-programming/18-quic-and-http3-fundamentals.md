## QUIC and HTTP/3 Fundamentals

QUIC (RFC 9000, May 2021) is a UDP-based, encrypted, multiplexed transport that subsumes TLS 1.3 (RFC 9001) and replaces TCP for HTTP/3 (RFC 9114). Google deployed an experimental QUIC ("gQUIC") at scale in 2013, the IETF version stabilized in 2021. Today >30% of internet traffic to Google, Meta, and Cloudflare runs over QUIC. This chapter covers the wire layer, the C++ libraries, and the operational realities.

### 1. Why QUIC won at Google

The motivating problems with TCP+TLS+HTTP/2:

- 1-3 RTTs to start: TCP handshake (1 RTT) + TLS (1-2 RTT) before the first byte of HTTP.
- Head-of-line blocking on the TCP segment: if one packet is lost in an HTTP/2 stream, *all* multiplexed streams stall waiting for retransmit, defeating the multiplexing.
- Connections are pinned to `(srcip, srcport, dstip, dstport)`: any NAT rebinding or IP change drops the connection.
- TCP middlebox ossification: any new TCP feature is blocked by middleboxes that "know" what TCP looks like.

QUIC solves them by:

- Encrypting most of the header so middleboxes cannot inspect the protocol -- ossification is avoided by design.
- Doing TLS 1.3 handshake inside the first packet flight -- 1-RTT typical, 0-RTT for resumed connections.
- Per-stream loss recovery: a lost packet stalls only its streams.
- Connection IDs decouple the connection from the 4-tuple, enabling migration across IP changes (Wi-Fi -> LTE).

Operationally, QUIC also gives userspace full control over congestion control without kernel patches, you can ship CUBIC, BBRv2, or your own.

### 2. Packet types and the wire format

QUIC packets carry one of two header forms:

- **Long header**: used during handshake, contains version, source/destination connection IDs, packet number, and a type field. Long-header packet types: `Initial` (carries the ClientHello and ServerHello inside CRYPTO frames), `0-RTT`, `Handshake`, `Retry`.
- **Short header (1-RTT)**: post-handshake, minimal -- destination connection ID + masked packet number. Most application traffic is short-header.

A QUIC packet contains one or more **frames**. The important ones:

| Frame | Purpose |
|--------------------|--------------------------------------------------|
| `CRYPTO` | TLS handshake bytes |
| `STREAM` | application data on a numbered stream |
| `ACK` | acknowledgments with up to 64 ack ranges |
| `RESET_STREAM` | abort one stream |
| `STOP_SENDING` | request peer to stop sending on a stream |
| `MAX_DATA` | flow control: connection-level credit |
| `MAX_STREAM_DATA` | per-stream credit |
| `MAX_STREAMS` | concurrent stream limit |
| `NEW_CONNECTION_ID`| supplies CIDs for migration |
| `PATH_CHALLENGE` / `PATH_RESPONSE` | validates a new network path |
| `CONNECTION_CLOSE` | terminates the connection |
| `PING` | keepalive |

Stream IDs encode direction and initiator: low two bits = `00` client-bidi, `01` server-bidi, `10` client-uni, `11` server-uni. HTTP/3 uses bidi for requests and uni for control / push.

### 3. Connection migration

Each QUIC connection is identified by a destination connection ID (DCID), not the 4-tuple. After a path change (new source IP/port), the receiver issues `PATH_CHALLENGE`, if the peer answers with `PATH_RESPONSE`, the connection survives. This is the feature that makes mobile QUIC work across Wi-Fi handoffs and is why "0% drop rate during commute" is a marketed metric.

Server-side, you must:

- Issue multiple CIDs to the client up front (`NEW_CONNECTION_ID`).
- Not pin connection state to the source 4-tuple in your dispatcher.
- Validate new paths before fully migrating, until validated, send only with the old path's congestion controller.

### 4. 0-RTT in QUIC

After resumption, the client can encrypt application data with keys derived from the cached PSK and send it in the very first flight. Same caveats as TLS 1.3 0-RTT: replay-safe ops only. QUIC frames the early data inside `0-RTT` packets that the server discards if the resumption fails.

### 5. Multiplexed streams without HoL blocking

In HTTP/2 over TCP, all streams share one byte sequence in the kernel, a single dropped TCP segment delays delivery of every byte after it, regardless of which HTTP/2 stream owns those bytes. In QUIC, each stream has its own ordered byte sequence, but the loss-recovery unit is the QUIC packet (which may carry frames from one stream or many). A lost packet only blocks the streams whose frames it carried. For typical mixed traffic this nearly eliminates HoL blocking.

### 6. Congestion control in userspace

QUIC mandates a congestion controller, the spec defaults to NewReno, but every production stack ships at least CUBIC and BBR. The handshake does not negotiate which CC, each side runs its own for its sending direction. Implementations:

- `quiche` (Cloudflare, Rust with C bindings): NewReno, CUBIC, BBR.
- `lsquic` (LiteSpeed, C): CUBIC, BBR.
- `msquic` (Microsoft, C/C++): CUBIC, BBR, BBRv2.
- `quic-go` (Go): CUBIC, basic BBR.
- `MsQuic` ships in Windows kernel, userspace builds work cross-platform.

### 7. HTTP/3 frame layer

Once QUIC is up, HTTP/3 is "HTTP/2 minus the binary framing layer plus QPACK header compression". The frames:

| HTTP/3 frame | Purpose |
|---------------|--------------------------------------|
| `DATA` | request/response body |
| `HEADERS` | QPACK-compressed headers |
| `SETTINGS` | sent on the control stream |
| `PUSH_PROMISE`| server push (rarely used) |
| `GOAWAY` | graceful shutdown |
| `MAX_PUSH_ID` | bound on server push |

QPACK (RFC 9204) is HPACK redesigned for QUIC's lack of per-stream order: it splits the dynamic table updates onto a unidirectional encoder stream so they cannot block. Implementing QPACK from scratch is non-trivial, almost every team uses the QPACK from `nghttp3`, `quiche`, or `msquic`.

### 8. C++ library skeletons

#### `msquic` minimal server

```cpp
#include <msquic.h>
const QUIC_API_TABLE* MsQuic = nullptr;
HQUIC registration = nullptr, configuration = nullptr, listener = nullptr;

QUIC_STATUS QUIC_API ConnHandler(HQUIC c, void*, QUIC_CONNECTION_EVENT* ev) {
  switch (ev->Type) {
    case QUIC_CONNECTION_EVENT_CONNECTED: /* ready */ break;
    case QUIC_CONNECTION_EVENT_PEER_STREAM_STARTED:
      MsQuic->SetCallbackHandler(ev->PEER_STREAM_STARTED.Stream,
                                 (void*)StreamHandler, nullptr);
      break;
    case QUIC_CONNECTION_EVENT_SHUTDOWN_COMPLETE:
      MsQuic->ConnectionClose(c);
      break;
  }
  return QUIC_STATUS_SUCCESS;
}

QUIC_STATUS QUIC_API ListenerHandler(HQUIC, void*, QUIC_LISTENER_EVENT* ev) {
  if (ev->Type == QUIC_LISTENER_EVENT_NEW_CONNECTION) {
    MsQuic->SetCallbackHandler(ev->NEW_CONNECTION.Connection,
                               (void*)ConnHandler, nullptr);
    MsQuic->ConnectionSetConfiguration(ev->NEW_CONNECTION.Connection,
                                       configuration);
  }
  return QUIC_STATUS_SUCCESS;
}

void run() {
  MsQuicOpen2(&MsQuic);
  QUIC_REGISTRATION_CONFIG rc{"sample", QUIC_EXECUTION_PROFILE_LOW_LATENCY};
  MsQuic->RegistrationOpen(&rc, &registration);

  QUIC_SETTINGS s{};
  s.IdleTimeoutMs = 30000; s.IsSet.IdleTimeoutMs = 1;
  s.PeerBidiStreamCount = 100; s.IsSet.PeerBidiStreamCount = 1;

  const QUIC_BUFFER alpn = {3, (uint8_t*)"h3"};
  MsQuic->ConfigurationOpen(registration, &alpn, 1, &s, sizeof(s),
                            nullptr, &configuration);
  // load cert + key, then ConfigurationLoadCredential

  QUIC_ADDR addr{};
  QuicAddrSetFamily(&addr, QUIC_ADDRESS_FAMILY_UNSPEC);
  QuicAddrSetPort(&addr, 4433);
  MsQuic->ListenerOpen(registration, ListenerHandler, nullptr, &listener);
  MsQuic->ListenerStart(listener, &alpn, 1, &addr);
}
```

#### `quiche` (Cloudflare)

`quiche` is Rust with a C ABI (`quiche.h`). C++ usage:

```cpp
quiche_config* cfg = quiche_config_new(QUICHE_PROTOCOL_VERSION);
quiche_config_load_cert_chain_from_pem_file(cfg, "cert.pem");
quiche_config_load_priv_key_from_pem_file(cfg, "key.pem");
quiche_config_set_application_protos(cfg, (uint8_t*)"\x02h3", 3);
quiche_config_set_max_idle_timeout(cfg, 30000);
quiche_config_set_initial_max_data(cfg, 10'000'000);
quiche_config_set_cc_algorithm(cfg, QUICHE_CC_BBR);

quiche_conn* c = quiche_accept(scid, scid_len, odcid, odcid_len,
                               (sockaddr*)&local, local_len,
                               (sockaddr*)&peer,  peer_len, cfg);
// drive via quiche_conn_recv / quiche_conn_send + a UDP socket loop
```

`quiche` ships with `nghttp3` for HTTP/3 framing.

#### `lsquic`

Similar shape. LiteSpeed's stack, used in OpenLiteSpeed and reportedly Akamai.

### 9. UDP socket setup for QUIC servers

```cpp
int fd = ::socket(AF_INET6, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
int one = 1;
setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof(one));
// learn destination address per packet so server replies from same IP/port
setsockopt(fd, IPPROTO_IPV6, IPV6_RECVPKTINFO, &one, sizeof(one));
setsockopt(fd, IPPROTO_IP,   IP_PKTINFO,       &one, sizeof(one));
// generic segmentation offload for batched send (Linux 4.18+)
int gso = 1500;
setsockopt(fd, SOL_UDP, UDP_SEGMENT, &gso, sizeof(gso));
// generic receive offload for batched recv (Linux 5.0+)
setsockopt(fd, SOL_UDP, UDP_GRO, &one, sizeof(one));
```

`UDP_SEGMENT` lets you `sendmsg` a buffer larger than MTU with a control message specifying the segment size, the kernel chops it into MTU-sized datagrams. This dramatically cuts syscall overhead for QUIC pacing. `UDP_GRO` does the inverse for `recvmsg`. Both are essential to keep QUIC competitive with TCP throughput at high load -- without them, syscall rate, not bandwidth, becomes the bottleneck.

### 10. Connection ID dispatch

A QUIC server with `SO_REUSEPORT` workers needs to make sure all packets for the same connection land on the same worker, even after connection migration. Two strategies:

1. Encode the worker ID in the connection ID. The kernel BPF reuseport program (see SO_REUSEPORT and Kernel-Side Load Distribution) extracts those bits and routes accordingly.
2. Userspace re-routing: any worker accepts a packet, looks up CID -> owning worker in a shared map, and forwards via `eventfd` or shared-memory queue.

The first approach is what Cloudflare does (described in "QUIC at scale" 2022 blog). Tooling: `udpgrm` (eBPF program) decodes the CID, looks up the routing map, and selects the reuseport socket.

### 11. Operational caveats

- UDP is rate-limited or blocked by some networks. Production deployments must fall back to HTTP/2 over TCP. Serve `Alt-Svc: h3=":443"` only after you have a working TLS-over-TCP listener.
- ECN must be passed through, many home routers strip it, harming BBR.
- Amplification attacks: server must not send more than 3x what it has received from an unverified client, until handshake completes (RFC 9000 §8.1).
- DDoS surface: QUIC retry tokens (`Retry` packets) shift state to the client, required for production.
- Observability: TCP dumps in tcpdump are immediately readable. QUIC is encrypted. Use `qlog` (every major library supports it) and load into `qvis` for analysis.

> Senior @ FAANG: do not write a QUIC stack. Pick `msquic` (Apache 2.0), `quiche` (BSD-2), or `lsquic` (MIT) and own the integration. The implementation effort to ship a correct, performant QUIC is multiple engineer-years, the libraries above represent that investment by entire teams. Read the qlog format and integrate observability before you scale.

