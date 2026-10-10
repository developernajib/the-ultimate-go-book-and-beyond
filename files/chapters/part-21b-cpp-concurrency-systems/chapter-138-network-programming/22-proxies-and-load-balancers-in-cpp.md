## Proxies and Load Balancers in C++

The big three open-source C/C++ proxies -- Envoy, HAProxy, NGINX -- own most of the public internet's east-west and north-south traffic. Their architectures are different enough that learning all three is genuinely educational. This chapter is the architecture, not the operator's manual.

### 1. Envoy

Envoy (Lyft, 2017, now CNCF) is a modern L4/L7 proxy built around three ideas:

1. **Thread-per-core, share-nothing**: each worker thread owns its own listeners, its own clusters' connection pools, its own stats. No locks on the data path.
2. **Filter chains**: connections flow through a sequence of network filters (L4) and the HTTP filter chain (L7). Each filter is a small composable unit -- rate limiting, JWT validation, RBAC, observability, routing.
3. **xDS configuration**: a dynamic config protocol (LDS, RDS, CDS, EDS, SDS, ADS) over gRPC. The control plane pushes new listeners, routes, clusters, endpoints, and secrets without restart.

#### Threading

The main thread runs the xDS client and config dispatch. Worker threads each run a `Dispatcher` (one libevent loop) plus a copy of the listener and cluster data. Cross-thread state (stats, runtime) uses thread-local storage with periodic batched merges, avoiding atomic contention.

#### Filter chain shape

```
Listener
  -> Listener filters  (TLS inspector, original_dst, proxy_protocol)
  -> Network filters   (rate_limit, rbac, tcp_proxy / http_connection_manager)
       -> HTTP filters (router is always last; preceded by jwt_authn, ext_authz, lua, wasm, ...)
            -> Cluster -> ConnPool -> upstream
```

A custom L7 filter looks like:

```cpp
class HelloFilter : public Http::PassThroughFilter {
 public:
  Http::FilterHeadersStatus decodeHeaders(Http::RequestHeaderMap& h, bool) override {
    if (h.getPathValue() == "/hello") {
      decoder_callbacks_->sendLocalReply(Http::Code::OK,
        "Hello from C++ filter\n", nullptr, std::nullopt, "");
      return Http::FilterHeadersStatus::StopIteration;
    }
    return Http::FilterHeadersStatus::Continue;
  }
};
```

Compile as a shared library or link statically, register through the factory protocol. Filters can be written in C++, Lua, or WebAssembly (WAMR/V8 host). For hot paths, only C++ is fast enough.

#### Health checking and outlier detection

Envoy has both:

- **Active**: per-cluster gRPC/HTTP/TCP probe at a configured interval. Result drives `HEALTHY` / `UNHEALTHY`.
- **Passive (outlier)**: counts consecutive errors, ejects host for a base ejection time scaled by ejection count.

Combined, these implement the standard "circuit breaker per host" pattern without the application thinking about it.

#### Connection pool

Envoy's `ConnectionPool::Instance` is the production reference for everything in Connection Pooling and Backpressure. Important features:

- HTTP/1, HTTP/2, and HTTP/3 pools differ (HTTP/2 multiplexes, pool size = max concurrent connections, not max concurrent requests).
- `prefetchPolicy` warms connections.
- `maxConcurrentStreams` per HTTP/2 connection -- balances multiplexing vs server-side fairness.

### 2. HAProxy

HAProxy (Willy Tarreau, since 2002) is a single-binary, event-driven L4/L7 proxy famous for hand-tuned C and very low latency overhead. The architecture:

- **Multi-process, master/workers**: one master manages config + signals. N workers handle traffic. Workers share nothing, sockets are bound with `SO_REUSEPORT`.
- **One-shot configuration**: legacy, but the runtime API (`stats socket`) lets you mutate weights, enable/disable servers, add servers in newer versions.
- **Event loop**: polling (`epoll`/`kqueue`) + a state machine per connection. No coroutines, no threads-per-conn.

Connection state is encoded in a `struct stream`: front-end conn, back-end conn, two analyzer pipelines, two buffers (input/output). A small set of bits track which analyzers must run on the next iteration. This compact state machine is why HAProxy's per-connection memory is so small (~8-16 KiB).

HAProxy 2.4+ added native multi-threading, before that, "scale" meant multiple processes with `nbproc` and shared `peers` for stick tables. Modern deploys use `nbthread = ncpus` and a single process.

L7 features: ACL language for routing (`acl is_api path_beg /api`, `use_backend api if is_api`), header rewriting, `http-check`, sticky sessions. SSL termination via OpenSSL. HTTP/2 frontends since 1.8, HTTP/3 in 2.6+ via `quictls` or `wolfSSL`.

When to pick HAProxy: pure-performance L4 / L7, lightweight binary, low-latency overhead, dead-simple configuration. When to skip: dynamic, programmable filter chains -- HAProxy's Lua and SPOE (Stream Processing Offload Engine) are not as ergonomic as Envoy filters.

### 3. NGINX

NGINX (Igor Sysoev, 2004. OpenResty + nginx-plus + nginx-unit ecosystem) is the canonical event-driven web server. Worker model:

- **Master + N workers**: each worker is single-threaded, runs `epoll`/`kqueue`. Workers do not share connections.
- **`SO_REUSEPORT`**: since 1.9.1, all workers bind the listening port, kernel dispatches.
- **Modules**: compiled-in (nginx-the-binary) or dynamic (`load_module`). Custom modules in C are first-class but require deep familiarity with NGINX internals (`ngx_chain_t`, `ngx_buf_t`, sub-requests, request lifecycle phases).

NGINX phases (the request lifecycle):

```
POST_READ -> SERVER_REWRITE -> FIND_CONFIG -> REWRITE -> POST_REWRITE
  -> PREACCESS -> ACCESS -> POST_ACCESS -> PRECONTENT -> CONTENT -> LOG
```

Each module hooks into one or more phases. `proxy_pass` lives in CONTENT, rate limiting in PREACCESS, auth in ACCESS.

Content modules (the upstream half) implement the `ngx_http_upstream_t` API with callbacks: `create_request`, `process_header`, `input_filter`. The kernel-level fast path is `sendfile` (see Zero-Copy Techniques) for static files. NGINX shipped HTTP/2 in 1.9.5, native HTTP/3 in 1.25.

#### OpenResty

OpenResty embeds LuaJIT into NGINX with hooks for every phase. You write `access_by_lua_block`, `content_by_lua_block`, etc. Used by Cloudflare's edge until they replaced it with Rust (`pingora`). Combines C performance with Lua flexibility but the Lua-C boundary is a real cost (~microseconds per crossing).

### 4. L4 vs L7 routing

| Dimension | L4 (TCP) | L7 (HTTP) |
|-------------------------------|-----------------------|-------------------------|
| Cost per connection | very low | parse + framework cost |
| Routing key | (ip, port) / SNI | path, header, body |
| TLS termination | usually pass-through | typical |
| Observability | bytes, RTT | per-request, status |
| HTTP/2 multiplexing | impossible | yes |
| Examples | Katran, IPVS, HAProxy mode tcp | Envoy, NGINX, HAProxy mode http |

You usually layer them: L4 LB at the edge for raw throughput and DDoS, L7 LB inside for routing and observability. Cloudflare's stack: XDP-based L4 (`unimog` / `udpgrm` family) -> userspace TLS termination + L7 proxy.

### 5. Load balancing algorithms

#### Round-robin

Trivial. Useful when backends are identical and requests are uniform. Useless under heterogeneity.

#### Least connections / least outstanding

Track in-flight count per backend, send next request to the lowest. Self-balancing under heterogeneous request cost. Default in Envoy as `LEAST_REQUEST` with random subsetting.

#### Power of two choices (P2C)

Pick two random backends, send to the one with fewer in-flight. Performs comparably to least-connections at much lower coordination cost. Reference: "The Power of Two Random Choices" (Mitzenmacher, 2001). NGINX's "least_conn" with random sampling, Envoy's `LEAST_REQUEST`.

#### EWMA-based load balancing

Per-backend exponentially-weighted moving average of latency. Pick the backend with the lowest EWMA. Twitter's Finagle popularized this. Envoy implements it as `LEAST_REQUEST` with `active_request_bias`. EWMA captures slow backends quickly without triggering on a single outlier.

#### Consistent hashing

Map request key to a hash ring populated with backends, route by hash. Adding/removing backends moves only `1/N` of keys. Variants:

- **Ketama** (libmemcached): each backend gets ~160 ring positions, hash by MD5.
- **Maglev** (Google, NSDI 2016): O(N) lookup table, near-perfect distribution, minimal disruption on changes. Envoy supports it as `MAGLEV`.
- **Rendezvous (HRW)**: each request hashes against each backend, pick the highest. O(N) per lookup but trivial to implement and to reason about.

Use consistent hashing for cache locality (route same key to same shard), session affinity (sticky), or any stateful workload.

#### Session affinity

L7 LBs offer cookie-based or header-based stickiness: set a `Set-Cookie` on first response, route by that cookie thereafter. Useful for legacy stateful apps, avoid for stateless services.

### 6. xDS protocol (Envoy's control plane)

xDS = "X Discovery Service" where X = Listener / Route / Cluster / Endpoint / Secret / Runtime. The protocol:

- gRPC bidi stream from data plane (Envoy) to control plane.
- Data plane sends `DiscoveryRequest{type_url, resource_names, version_info, response_nonce, error_detail}`.
- Control plane replies with `DiscoveryResponse{type_url, resources[], version_info, nonce}`.
- Data plane ACKs by sending another `DiscoveryRequest` with the new `version_info`. NACKs by sending `error_detail`.

Aggregated Discovery Service (ADS) collapses all type_urls onto one stream so updates are ordered (`CDS` before `EDS`, `LDS` before `RDS`). Without ADS you can have a brief window where Envoy has new clusters but no endpoints, dropping requests.

Implementations of the control plane in C++ are rare, most are Go (Istio's pilot, Kuma) or Java. If you write one, the data model is just the protobuf definitions in `envoyproxy/data-plane-api`. Conformance is verified by `envoy --config-yaml` integration tests.

### 7. Hot restart and zero-downtime config

Envoy's hot restart: the parent process spawns a child with the same config, the child begins accepting on `SO_REUSEPORT` listeners, the parent stops accepting and drains. Connection count goes to zero, parent exits. Stats are passed through a Unix socket so counters do not jump. NGINX has the same idea (`SIGUSR2` -> spawn new master, `SIGWINCH` -> drain old workers).

Custom proxy: implement the same. Listen socket inheritance via `fork` + `exec` and a fd-passing handshake, `SO_REUSEPORT` keeps both processes serving during the overlap.

### 8. Skeleton: a minimal L4 TCP proxy in C++

```cpp
class TcpProxy : IHandler {
 public:
  TcpProxy(int listen_fd, sockaddr_in upstream, Reactor& r) : r_(r), up_(upstream) {
    r.add(listen_fd, EPOLLIN | EPOLLET, this);
  }
  void handle(uint32_t events) override {
    if (events & EPOLLIN) accept_loop();
  }
 private:
  void accept_loop() {
    while (true) {
      sockaddr_storage ss; socklen_t sl = sizeof(ss);
      int c = ::accept4(listen_fd_, (sockaddr*)&ss, &sl, SOCK_NONBLOCK | SOCK_CLOEXEC);
      if (c < 0) { if (errno == EAGAIN) return; throw_errno("accept4"); }
      int u = ::socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
      ::connect(u, (sockaddr*)&up_, sizeof(up_));
      auto* sess = new Session(c, u, r_);
      sess->arm();
    }
  }
};

class Session {
 public:
  Session(int c, int u, Reactor& r)
    : client_(c), upstream_(u), r_(r) {
    ::pipe2(c2u_, O_NONBLOCK | O_CLOEXEC);
    ::pipe2(u2c_, O_NONBLOCK | O_CLOEXEC);
  }
  void arm() {
    r_.add(client_,   EPOLLIN | EPOLLET, &client_h_);
    r_.add(upstream_, EPOLLIN | EPOLLET, &upstream_h_);
  }
  void on_client_readable() { splice_pump(client_, c2u_, upstream_); }
  void on_upstream_readable() { splice_pump(upstream_, u2c_, client_); }
 private:
  void splice_pump(int from, int pipe[2], int to) {
    for (;;) {
      ssize_t in = ::splice(from, nullptr, pipe[1], nullptr, 65536,
                            SPLICE_F_MOVE | SPLICE_F_NONBLOCK);
      if (in <= 0) break;
      ssize_t out = 0;
      while (out < in) {
        ssize_t n = ::splice(pipe[0], nullptr, to, nullptr, in - out,
                             SPLICE_F_MOVE | SPLICE_F_NONBLOCK);
        if (n <= 0) break;
        out += n;
      }
    }
  }
  int client_, upstream_;
  int c2u_[2], u2c_[2];
  Reactor& r_;
  // ... handlers, lifetime tracking, error path teardown
};
```

This is what HAProxy's `option splice-auto` does on the fast path. Add health checking, connection pooling, EWMA load balancing, observability, hot restart, and you have a real proxy. The full implementation is several thousand lines, which is exactly why Envoy and HAProxy exist.

### 9. Common pitfalls in custom proxies

- Bidirectional half-close: client may `shutdown(SHUT_WR)` while still expecting reads. The proxy must propagate the half-close to the upstream and continue forwarding the other direction.
- Slowloris: attacker opens a connection and sends one byte per minute. Without `TCP_USER_TIMEOUT` and per-request deadlines, you accumulate connections forever. HAProxy's `timeout client-fin`, Envoy's `idle_timeout`, NGINX's `client_body_timeout` exist for this.
- Memory amplification: a 1 KiB request that fans out to 10 backends with 100 KiB responses each. Without per-request memory accounting, you run out of memory before you run out of CPU.
- Connection dust: client opens 1 M short-lived connections per second, even at 0 ms per connection, you eat the conntrack table. Tune `nf_conntrack_max` and `nf_conntrack_tcp_timeout_time_wait`.
- Stats explosion: per-cluster + per-host + per-status-code metrics yield millions of unique label combos. Aggregate or sample.

> Senior @ FAANG: the right answer is almost never "write our own proxy". It is "configure Envoy". The right answer becomes "fork Envoy" only when you cannot satisfy a requirement with a filter, then a forked Envoy with a custom filter is far cheaper than a greenfield proxy. Cloudflare's `pingora` is the rare counter-example, justified by very specific scale economics.

