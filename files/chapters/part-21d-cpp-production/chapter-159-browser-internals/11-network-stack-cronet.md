## 159.11 Network Stack and Cronet

Chrome's network stack lives in `net/` and is exposed to the rest of Chromium through the network service in `services/network/`. The same code, packaged as a library called Cronet, ships in Android apps (YouTube, Google Search, Snapchat) and iOS apps. It is the most-deployed user-mode HTTP/2 and HTTP/3 client in the world.

### The Layers

```
HTTP API layer:        URLLoader (Mojo interface)
                       URLLoaderFactory
                            |
                            v
                       URLRequest      (in-process)
                            |
                            v
HTTP layer:            HttpNetworkTransaction
                            |
                            v
                       HttpStream / HttpStreamFactory
                            |
                            v
Protocol:              HTTP/1.1 (HttpBasicStream) | HTTP/2 (SpdyStream)
                       | HTTP/3 (QuicStream)
                            |
                            v
Session:               HttpSession | SpdySession | QuicChromiumClientSession
                            |
                            v
TLS:                   SSLClientSocket  (BoringSSL)
                            |
                            v
TCP / UDP:             TCPClientSocket | UDPClientSocket
```

A `fetch()` call from JavaScript creates a `URLLoader` Mojo remote in the renderer that targets a `URLLoaderFactory` in the network service. The factory creates a `URLRequest`, which orchestrates connection acquisition, header negotiation, body upload, and response delivery.

### URLRequestContext

`URLRequestContext` is the singleton-ish object that owns the cookie store, HTTP cache, host resolver, transport security state, certificate verifier, proxy resolver, and channel ID store. One per profile (per tab in incognito).

```cpp
class URLRequestContext {
 public:
  CookieStore* cookie_store();
  HttpCache* http_cache();
  HostResolver* host_resolver();
  CertVerifier* cert_verifier();
  TransportSecurityState* transport_security_state();
  ProxyResolutionService* proxy_resolution_service();
  // ...
};
```

Code at this level is testable in isolation. `net/` has thousands of unit tests that build URLRequestContexts with mock sockets and assert on protocol behavior.

### HTTP/2

HTTP/2 is implemented in `net/spdy/`. Chromium maintained SPDY (the HTTP/2 predecessor) since 2009 and contributed the framing format directly to the HTTP/2 spec.

A SpdySession multiplexes many streams over one TCP+TLS connection. Each stream is a request/response pair. Frames are HEADERS, DATA, RST_STREAM, SETTINGS, WINDOW_UPDATE, PING, GOAWAY.

Header compression uses HPACK: a dynamic table of recently-sent headers, indexed for repeats, with Huffman coding for new strings. Chromium's HPACK implementation is at `net/third_party/quiche/src/quiche/http2/hpack/`.

### HTTP/3 and QUIC

HTTP/3 runs over QUIC, a UDP-based transport that combines TCP's reliability and TLS's encryption into one protocol. QUIC integrates congestion control, loss recovery, encryption, and stream multiplexing.

Chromium's QUIC stack is `net/third_party/quiche/`, used by Google servers and clients. The same C++ code runs in:

- Chromium (clients).
- Envoy (servers, via libquiche).
- gRPC (when configured for HTTP/3).
- Android Cronet.

A QUIC connection has multiple streams. Stream framing is in the QUIC layer, not on top of TCP, which means a packet loss on stream 5 does not block stream 7. This eliminates HTTP/2's head-of-line blocking, the defining motivation for HTTP/3.

QUIC also supports:

- **0-RTT.** Resume a previous session and send the first request in the same packet as the connection setup. Risky for replay-sensitive endpoints, fine for GETs.
- **Connection migration.** A client switching networks (Wi-Fi to cellular) keeps the same QUIC connection by tagging it with a connection ID rather than the 4-tuple. Drops one round trip vs reconnecting.

### HTTP Cache

`net::HttpCache` is a disk-backed cache keyed on URL plus origin (for cache partitioning, defending against cross-site cache attacks). Implemented over `disk_cache::Backend`, which has two production implementations:

- **Blockfile**: legacy, three index files plus block-allocated data files.
- **Simple**: newer, one file per entry, used on Android and ChromeOS for filesystem friendliness.

Cache validation supports `If-None-Match`, `If-Modified-Since`, and the new range-request and partial-content paths. Service workers can intercept cache decisions through the Cache API.

### DNS and DoH

`HostResolverManager` resolves hostnames. Sources:

- System resolver (`getaddrinfo` on POSIX, `DnsQuery` on Windows).
- Built-in async resolver: speaks the DNS wire protocol directly to a configured server.
- DoH (DNS over HTTPS): wraps DNS in HTTPS to a DoH provider.
- mDNS for `.local` names.

DoH is significant for security: DNS plaintext exposes browsing to network observers and to coffee-shop hijacking. Chrome auto-upgrades to DoH when the configured DNS server is on a known DoH provider list.

### Certificate Verification

TLS uses BoringSSL (Google's fork of OpenSSL) for the handshake. Certificate path building and validation goes through `net::CertVerifier`. Implementations:

- Platform verifier: Windows CryptoAPI, macOS Security framework. Used on Apple platforms.
- Built-in: Chromium's own path builder using a Mozilla-derived root store (`Chrome Root Store`, rolled out 2022 to 2024).

Validation includes CT (Certificate Transparency) log verification: every cert must have signed timestamps from at least two CT logs, or it is rejected. This is enforced for all certs issued after 2018.

HSTS preload list is compiled into Chrome: roughly 70,000 hostnames that always require HTTPS. The list is in `net/http/transport_security_state_static.json` and generates a perfect-hash structure at build time.

### The Network Service Process

Since 2019 the network stack runs out of process. Reasons:

1. **Security.** Network parsers are a top source of CVEs (HTTP header parsing, cert chain validation). Isolating them in a sandboxed process limits the blast radius.
2. **Reliability.** The network process can crash and restart, renderers reconnect. The browser process keeps running.
3. **Future-proofing.** Easier to swap implementations (Cronet on Android can use the same architecture).

Mojo interfaces between the renderer (or any client) and the network service are defined in `services/network/public/mojom/`. The main ones:

- `URLLoaderFactory`: create a loader for a request.
- `URLLoader`: drive a single request (set priority, follow redirects).
- `URLLoaderClient`: receive response head, body data pipe, and completion.
- `CookieManager`: read and write cookies.
- `RestrictedCookieManager`: subset for renderers (subject to SameSite, partitioning).

### Body Streaming

Response bodies stream through Mojo data pipes (shared memory ring buffers). The renderer attaches the data pipe consumer to the HTML parser, which feeds bytes into the tokenizer as they arrive. The whole path from socket to tokenizer is zero-copy past the kernel boundary.

For very large responses (multi-gigabyte downloads), the data pipe back-pressures: when the consumer is slow, the producer (network service) stops reading from the socket, which propagates back-pressure into the TCP/QUIC flow control.

### Reporting and NEL

Network Error Logging and Reporting API let sites collect failures (DNS errors, certificate errors, HTTP errors) and report them back via separate endpoints. Implemented in `net/reporting/` and `net/network_error_logging/`. Used heavily by sites operating CDNs to detect ISP-level issues.

### Performance Numbers

- DNS resolution (cached): ~0 ms.
- DNS resolution (cold, system resolver): 5 to 100 ms typical.
- TCP+TLS 1.3 handshake: 1 RTT (resumption) or 2 RTT (cold).
- QUIC 0-RTT handshake: 0 RTT for resumed.
- HTTP/2 first byte from a multiplexed connection: bound by RTT plus server time, no extra connection setup.
- HTTP/3 head-of-line blocking on a 1% packet loss network: roughly 30% better median latency than HTTP/2.

### Senior Interview Material

- "Why does the network stack run out of process? Walk through the trust boundary."
- "Compare HTTP/2 and HTTP/3 head-of-line blocking. What does QUIC change?"
- "What is QUIC connection migration and what threat model does it address?"
- "How does the HTTP cache key requests, and why is partitioning important post-2020?"
- "Explain how a `fetch()` call gets from JS to the wire, listing each thread and process boundary."

The next section walks through the storage stack: cookies, IndexedDB, Cache Storage, Service Workers.

---
