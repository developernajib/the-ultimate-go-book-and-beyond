## 102B.12 Interview Questions

### Q1: What happens when you type `https://www.google.com` in a browser?

**Answer:**

1. **URL parsing**: browser parses scheme (`https`), host (`www.google.com`), path (`/`)
2. **DNS resolution**:
   - Check browser cache (TLL-aware)
   - Check OS cache (`/etc/hosts` first, then OS DNS cache)
   - Query recursive resolver (ISP or configured DNS: 8.8.8.8)
   - Recursive resolver queries root → .com TLD → google.com authoritative
   - Returns A/AAAA records (multiple IPs for load balancing)
3. **TCP connection**: three-way handshake to one of the returned IPs (Happy Eyeballs: tries IPv4 and IPv6 in parallel, uses whichever connects first)
4. **TLS handshake**:
   - ClientHello (with SNI: `www.google.com`, ALPN: `h2,http/1.1`)
   - Server responds with certificate, key exchange
   - TLS session established (TLS 1.3: 1 RTT)
5. **HTTP/2 request**: browser sends GET / with headers (over the multiplexed HTTP/2 connection)
6. **Response**: Google's edge servers return HTML, with multiple streams in parallel for HTML, CSS, JS, images
7. **Browser rendering**: parse HTML, fetch subresources (parallel streams over existing HTTP/2 connection or new connections with h3/QUIC where available)

---

### Q2: What is TCP head-of-line blocking? Does HTTP/2 solve it?

**Answer:** TCP delivers bytes to the application in order. If a packet is lost, all subsequent packets - even if they have arrived - are buffered until the lost packet is retransmitted and received. This blocks all consumers of the TCP stream, including every HTTP/2 stream multiplexed over it.

HTTP/2 solves *HTTP-level* head-of-line blocking (one slow HTTP request no longer blocks others). But it does not solve *TCP-level* head-of-line blocking. On a lossy network, a single dropped TCP packet stalls all HTTP/2 streams on the connection.

HTTP/3 (QUIC) solves TCP-level head-of-line blocking by implementing its own transport over UDP, where stream ordering is independent per stream.

---

### Q3: Explain TCP three-way handshake and why we need it.

**Answer:** The three-way handshake serves two purposes:
1. **Synchronize sequence numbers**: both sides advertise their initial sequence numbers (ISN), which are random to prevent sequence number prediction attacks
2. **Establish connection state**: both sides confirm each other can send and receive

The three steps:
- **SYN**: "I want to connect, my ISN is X"
- **SYN-ACK**: "Accepted. My ISN is Y. I've received up to X+1"
- **ACK**: "I've received up to Y+1. Connection established"

We need all three because TCP is full-duplex: each direction must independently acknowledge the other's sequence number. A two-way exchange would only confirm one direction.

---

### Q4: What is TLS 1.3 and what makes it better than TLS 1.2?

**Answer:**
- **Fewer round trips**: TLS 1.3 completes in 1 RTT (vs 2 RTT for TLS 1.2), and supports 0-RTT resumption for repeat connections
- **Forward secrecy by default**: RSA key exchange removed. Only ephemeral DH (ECDHE) is supported, so past sessions cannot be decrypted if the private key is later compromised
- **Removed weak crypto**: RC4, 3DES, SHA-1, MD5, export ciphers, RSA key transport all removed
- **Encrypted more of the handshake**: certificate, server extensions, and more are encrypted in TLS 1.3 vs plaintext in TLS 1.2
- **Simplified cipher suite negotiation**: only 5 supported cipher suites, all AEAD

---

### Q5: What is mTLS and when should you use it?

**Answer:** In standard TLS, only the server presents a certificate (client verifies server identity). In mutual TLS (mTLS), both parties present and verify certificates, giving cryptographic proof of identity in both directions.

Use mTLS for:
- **Service-to-service authentication** in a zero-trust architecture (Istio, Linkerd use mTLS for all service mesh traffic)
- **API clients** where a shared secret (API key) is insufficient (e.g., high-value financial operations)
- **Webhook receivers** that need to verify the sender's identity

Do not use mTLS for:
- Browser-to-server communication (browsers cannot easily present client certificates)
- High-volume public APIs (certificate management overhead)

---

### Q6: Explain DNS TTL and its implications for deployments.

**Answer:** DNS TTL (Time To Live) specifies how many seconds a DNS record should be cached by resolvers and clients. When you change an IP in DNS, caches must expire before clients see the new value - the maximum delay is the TTL.

Implications:
- **High TTL (e.g., 86400 = 1 day)**: efficient, fewer DNS queries, but DNS changes take up to a day to propagate
- **Low TTL (e.g., 60)**: DNS changes propagate quickly, but more DNS queries (potentially higher costs and latency)
- **Deployment strategy**: lower TTL to 60 seconds 24 hours before a migration, make the change, then raise TTL back after the migration

In Kubernetes, CoreDNS uses short TTLs (30 seconds) for service discovery to enable fast service updates.

---

### Q7: What is QUIC? Why was it built on UDP instead of TCP?

**Answer:** QUIC is a transport protocol developed by Google (standardized as RFC 9000) that provides the reliability and ordering of TCP plus TLS encryption, implemented over UDP.

Built on UDP because:
1. **Ossification**: TCP is implemented in OS kernels and network hardware (middleboxes). Changing TCP requires OS kernel updates across the entire internet - a process that takes years. UDP packets are treated as opaque by most middleboxes, so QUIC can evolve freely
2. **Kernel bypass**: QUIC can be implemented in userspace (as in quic-go), enabling faster iteration without kernel changes
3. **Stream independence**: UDP provides raw datagrams. QUIC implements its own stream multiplexing without TCP's ordering constraints
4. **Connection migration**: QUIC connection IDs are not bound to the 4-tuple, enabling connection migration across IP changes

---

### Q8: What is the difference between L4 and L7 load balancing?

**Answer:**

**L4 (Transport Layer)**:
- Routes based on IP address and TCP/UDP port
- Does not inspect application-layer content (HTTP headers, URL, gRPC method)
- Operates in kernel space (DPDK, XDP), extremely high throughput
- Connection-level: once a TCP connection is assigned to a backend, all packets follow
- Use case: raw TCP proxying, UDP load balancing, stateful connections
- Examples: AWS NLB, Linux IPVS, HAProxy TCP mode

**L7 (Application Layer)**:
- Parses HTTP/gRPC/WebSocket to make routing decisions
- Can route based on URL path, headers, content type, gRPC service name
- Enables TLS termination, retries, timeouts, circuit breaking, canary deployments
- More CPU overhead per connection (HTTP parsing, TLS decryption)
- Use case: microservices, API gateways, progressive deployments
- Examples: AWS ALB, Envoy, Nginx, Traefik

---

### Q9: What are TCP keepalives and why are they important?

**Answer:** TCP keepalives are periodic probe packets sent on idle connections to verify the remote end is still alive. Without them, a broken connection (remote host crashed, network cable unplugged) is not detected until the application tries to send data - which could be hours later.

Default OS keepalive timers are far too long for production services:
- Linux default: 2 hours idle before first probe, 75 seconds between probes, 9 probes before giving up = up to 2 hours + 11 minutes before detecting a dead connection

Production recommendation:
- `TCP_KEEPIDLE`: 30 seconds
- `TCP_KEEPINTVL`: 5 seconds
- `TCP_KEEPCNT`: 3 probes

This detects dead connections in ~45 seconds rather than ~2 hours.

In Go, use `net.Dialer.KeepAlive` or `(*net.TCPConn).SetKeepAlive()` and `SetKeepAlivePeriod()`.

---

### Q10: How does consistent hashing work and why is it used for load balancing?

**Answer:** Consistent hashing maps both requests (by a key, e.g., user ID or cache key) and backends to positions on a conceptual ring (typically a 360-degree circle or a uint64 range). A request is routed to the backend at the next position clockwise from the request's position.

When backends are added or removed:
- **Simple modulo hashing** (`hash(key) % N`): changing N causes ~N-1/N of all keys to be remapped - catastrophic for caches (all cache misses simultaneously)
- **Consistent hashing**: only `1/N` of keys are remapped on average

With virtual nodes (multiple positions per backend on the ring), load is distributed evenly even with few backends.

Use cases:
- Cache server selection: ensure cache hits on the same backend
- Session stickiness: route a user's requests to the same backend
- Shard-aware routing: route requests for the same data shard to the same backend

---

### Q11: What is HTTP/2 server push and why is it mostly disabled?

**Answer:** HTTP/2 server push allows the server to proactively send resources the client has not yet requested, before the client discovers it needs them. For example, after receiving a request for `index.html`, the server can immediately push `styles.css` and `app.js` without waiting for the client to parse HTML and request them.

**Why it is mostly disabled:**
1. **Cache collision**: the server cannot know whether the client already has the resource cached, so it may push resources the client does not need, wasting bandwidth
2. **Middlebox incompatibilities**: some proxies, CDNs, and browsers dropped push support
3. **Preload hints are better**: `<link rel="preload">` and `103 Early Hints` achieve similar benefits while respecting the cache
4. **HTTP/3 removes it**: QUIC's 0-RTT and better connection setup make push less necessary

Chrome dropped HTTP/2 server push support in Chrome 106 (2022).

---

### Q12: Explain the TCP slow start algorithm.

**Answer:** TCP slow start prevents a new connection from immediately flooding the network with data. It works by:

1. Starting with a small congestion window (`cwnd = 10 MSS` on modern Linux)
2. For each ACK received, increasing `cwnd` by 1 MSS (effectively doubling cwnd each RTT - this is exponential, not actually slow)
3. Continuing until `cwnd` reaches the slow start threshold (`ssthresh`)
4. Switching to congestion avoidance (linear increase) when `cwnd >= ssthresh`

**Implications for Go services:**
- New TCP connections are slow for the first few RTTs - critical for short-lived connections (reason to prefer long-lived connections / HTTP/2)
- After packet loss, `cwnd` resets - high packet loss environments benefit significantly from QUIC/HTTP/3
- TCP Fast Open (TFO) allows data to be sent in the SYN packet, saving one RTT for the first request

---

### Q13: What is HPACK and why does HTTP/2 use it?

**Answer:** HPACK (Header Compression for HTTP/2) reduces HTTP header overhead using two techniques:

1. **Static table**: 61 pre-defined header name/value pairs. Headers like `:method: GET` (index 2) or `:status: 200` (index 8) are represented as a single byte
2. **Dynamic table**: headers seen in previous frames on the same connection are indexed and referenced by index in subsequent frames. `Authorization: Bearer eyJ...` becomes a 1-2 byte reference after the first use

HPACK reduces typical header overhead by 80-90%. For an API making 1,000 requests/second with 1KB of headers each, this saves ~900KB/second of bandwidth.

**Security note**: HPACK is vulnerable to CRIME and BREACH attacks if secrets (CSRF tokens, session cookies) are compressed together with attacker-controlled data. TLS compression is disabled by default in TLS 1.3. HTTP/2 HPACK is theoretically vulnerable but in practice the attack requires specific conditions.

---

### Q14: What is SNI and why does it exist?

**Answer:** SNI (Server Name Indication, RFC 6066) is a TLS extension that includes the target hostname in the ClientHello message before the TLS handshake completes.

**Problem it solves**: TLS negotiation happens before HTTP headers are sent. In HTTP, the `Host` header identifies which virtual host the client is connecting to. But in HTTPS, the server must present a certificate before seeing the `Host` header, which means without SNI, a server can only have one TLS certificate per IP address.

**Solution**: SNI embeds the hostname in the TLS ClientHello (plaintext, before encryption). The server reads SNI to select the appropriate certificate from its collection.

**Privacy implication**: since SNI is sent in plaintext, network observers can see which hostname you are connecting to even on HTTPS. Encrypted Client Hello (ECH) encrypts the SNI to address this, but adoption is still limited.

---

### Q15: How would you debug a Go service that occasionally hangs on HTTP requests?

**Answer:** A systematic approach:

1. **Check for missing context/timeout**: ensure all outbound requests have a `context.WithTimeout` and the HTTP client has `Timeout` set. `curl -v` can verify if the upstream takes too long

2. **Check response body draining**: ensure `resp.Body` is always drained and closed. Missing this causes connection pool exhaustion, leading to hangs waiting for available connections

3. **Use `net/http/httptrace`**: instrument requests to see where time is spent (DNS, connect, TLS, first byte, body transfer)

4. **Check `pprof` goroutine dump**: `curl http://localhost:6060/debug/pprof/goroutine?debug=2` shows all goroutines and their stacks. Goroutines blocked on `net/http.(*Transport).getConn` indicate connection pool exhaustion

5. **Check DNS**: if DNS resolution is slow or failing, add DNS caching. Use `dig +trace` to verify resolution times. Check if `GODNS=go` is set (pure-Go resolver)

6. **Check TIME_WAIT**: `ss -tan | grep TIME_WAIT | wc -l` - high count indicates connection pool misconfiguration (MaxIdleConnsPerHost too low)

7. **tcpdump/Wireshark**: capture traffic to see if TCP connection is established but data is not flowing, or if there are retransmissions indicating packet loss

---

### Q16: What is the difference between HTTP keep-alive and TCP keepalive?

**Answer:**

**HTTP keep-alive** (`Connection: keep-alive`): an HTTP-level feature that keeps the TCP connection open after a response is delivered, allowing subsequent HTTP requests to reuse the same connection. The connection is closed either explicitly (`Connection: close`) or after an idle timeout configured on the HTTP server.

**TCP keepalive** (`TCP_KEEPALIVE`): an OS-level mechanism that sends probe packets on idle TCP connections to detect dead connections (where the remote end crashed without sending FIN). It operates at the TCP layer, independent of the application protocol.

They are complementary: HTTP keep-alive reuses connections for multiple requests (performance), while TCP keepalive detects broken connections (reliability). In Go, `net/http` handles HTTP keep-alive automatically, while TCP keepalive is configured on the `net.Dialer` or `net.TCPConn`.

---

### Q17: Explain connection draining in the context of zero-downtime deployments.

**Answer:** Connection draining ensures that in-flight requests are completed before a server instance is terminated during a deployment or scale-down.

The sequence:
1. **Deregister from load balancer**: the health check endpoint returns 503 (or the instance is marked unhealthy). The LB stops routing new requests to this instance
2. **Wait for LB propagation**: health checks run on an interval (e.g., every 5 seconds with a 2-failure threshold = 10 seconds). Wait 15-30 seconds to be safe
3. **Stop accepting new connections**: `server.Shutdown(ctx)` stops accepting new connections
4. **Drain in-flight requests**: `Shutdown` waits for active handlers to complete, up to the context deadline (e.g., 30 seconds)
5. **Close remaining connections**: after drain timeout, forcefully close remaining connections

In Go, `(*http.Server).Shutdown(ctx)` implements steps 3-5. Steps 1-2 must be implemented by the application.

```go
signal.Notify(quit, syscall.SIGTERM)
<-quit
health.SetHealthy(false, "shutting down") // step 1
time.Sleep(15 * time.Second)              // step 2
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()
srv.Shutdown(ctx)                          // steps 3-5
```

---

### Q18: What is anycast routing and how do CDNs use it?

**Answer:** Anycast is a routing topology where the same IP address is advertised from multiple physical locations. BGP (Border Gateway Protocol) - the internet's routing protocol - routes traffic to the topologically nearest (lowest BGP cost) instance advertising that IP.

CDNs announce their anycast IP blocks from hundreds of PoPs worldwide. A user in Tokyo connecting to `1.1.1.1` (Cloudflare) is automatically routed to the Tokyo PoP, while a user in London is routed to the London PoP - without any application-layer routing logic.

Benefits:
- **Automatic geographic routing**: users connect to the nearest edge with no DNS-based steering overhead
- **DDoS mitigation**: traffic is spread across all PoPs, absorbing volumetric attacks
- **Failure isolation**: if a PoP fails, BGP withdraws its announcement and traffic routes to the next-nearest PoP automatically

Limitation: anycast is best-effort - the "nearest" PoP in BGP terms is not always the closest geographically or by latency. Unicast with GeoDNS provides more precise routing for latency-critical workloads.

---

### Q19: How does TLS session resumption work?

**Answer:** Full TLS handshakes are expensive (1-2 RTTs, asymmetric cryptography). Session resumption allows subsequent connections from the same client to skip the full handshake.

**Session IDs (TLS 1.2)**: the server generates a session ID for each connection. The client stores it. On reconnection, the client sends the session ID in ClientHello. The server looks it up in its session cache and, if found, resumes the session in 1 RTT (vs 2 RTT).

**Session tickets (TLS 1.2 and 1.3)**: the server encrypts the session state with a server-only key and sends it to the client as a session ticket. On reconnection, the client sends the ticket in ClientHello. The server decrypts it to resume the session. This is stateless on the server (no session cache needed) but requires secure ticket key rotation.

**0-RTT resumption (TLS 1.3)**: using a Pre-Shared Key (PSK) from a previous connection, the client can send application data in the first packet (0 RTT). Security caveat: 0-RTT data is not replay-safe (it can be replayed by an attacker), so it should only be used for idempotent operations (GET requests, not POST).

In Go, session resumption is handled automatically by `crypto/tls`. Configure `tls.Config.SessionTicketKey` for consistent ticket keys across multiple server instances (required for resumption with load balancers).

---

### Q20: What is the difference between `MaxIdleConns` and `MaxIdleConnsPerHost` in Go's http.Transport?

**Answer:**

- `MaxIdleConns`: the total number of idle (keep-alive) connections across all hosts in the connection pool. Default: 100
- `MaxIdleConnsPerHost`: the maximum idle connections to any single host. Default: `DefaultMaxIdleConnsPerHost = 2`

The critical point: `MaxIdleConnsPerHost` defaults to **2**, which is dangerously low for production services. Under moderate concurrency, all 2 idle connections are in use, causing new connections to be created. These new connections go through TCP + TLS handshake (adding 50-200ms latency), accumulate in TIME_WAIT after completion, and eventually exhaust the local port range.

**Always configure `MaxIdleConnsPerHost` explicitly:**

```go
transport := &http.Transport{
    MaxIdleConns:        1000,
    MaxIdleConnsPerHost: 100,  // MUST set this, default of 2 is insufficient
}
```

A rule of thumb: set `MaxIdleConnsPerHost` to your expected peak concurrent requests to a single host multiplied by 1.5.

---

### Junior → FAANG: Networking Interview Questions as Self-Assessment

The "what happens when you type a URL" question is the classic networking interview question at all levels. The depth of the expected answer scales with seniority: entry-level is expected to cover DNS, TCP, HTTP, TLS at a conceptual level. Mid-level covers the same topics with specific details (ALPN for protocol negotiation, SNI for virtual hosting, DNS record types). Senior covers performance implications (where latency is introduced, how each step can be optimized) and implementation details (Go's connection pool interaction with keep-alive).

Practice this answer out loud until it is smooth. Being able to deliver a clear, organized explanation of a complex technical system under interview pressure is a skill that requires practice, not just knowledge.

The connection pool question is a Go-specific differentiator in networking interviews. Knowing that `MaxIdleConnsPerHost` defaults to 2 and why that is almost always wrong for production services demonstrates genuine Go production experience that separates candidates who have shipped production code from those who have only built toy services.

### Senior @ FAANG: Bar-Raiser Networking Interview Signals

At staff level, networking interview questions test the ability to reason about trade-offs and design systems for specific constraints. "Design a global API gateway for 1 billion requests per day" requires reasoning about: the geographic distribution of traffic, the protocol selection at each layer (TLS termination at the edge, HTTP/2 to the origin), the load balancing algorithm (consistent hashing for session affinity, least-connections for CPU-bound workloads), the caching strategy (CDN for static, edge compute for dynamic personalization), and the observability model (distributed tracing across CDN and origin, latency attribution by layer).

The bar-raiser signal is quantitative reasoning at every step: "1 billion requests per day is approximately 11,574 requests per second average, with 10x peak factor that is 115,740 RPS peak. At 100KB average response size, that is 11.5 GB/s peak bandwidth. We need at least 20 edge PoPs to keep P99 latency below 50ms for a globally distributed user base, assuming 30ms last-mile and 20ms between PoPs..." This kind of back-of-the-envelope calculation demonstrates the quantitative foundation of a senior networking architect.
