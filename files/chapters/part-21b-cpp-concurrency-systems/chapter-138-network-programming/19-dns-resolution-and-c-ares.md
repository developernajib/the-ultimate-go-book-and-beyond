## DNS Resolution and c-ares

DNS is the slowest, flakiest dependency in your call graph. It is unencrypted by default, served by ancient code paths in glibc, and silently blocking. A senior network engineer treats DNS like any other RPC: bounded timeout, retries, caching, async, and observability. This chapter explains why `getaddrinfo` is unfit for production C++ services and how to replace it with c-ares plus a few patterns.

### 1. Why getaddrinfo is a trap

`getaddrinfo(3)` is synchronous: it blocks the calling thread until resolution completes. Implementation in glibc reads `/etc/nsswitch.conf`, dispatches to NSS modules (`files`, `dns`, `mdns`, `myhostname`, ...), each of which may itself block. Specific failure modes:

- A misconfigured `nss_ldap` or `nss_sss` blocks for the LDAP/SSSD timeout (5-30 s) on every call.
- glibc caches negative answers for 0 seconds by default, a brief outage yields per-request resolution storms.
- No way to set a timeout on the call. `getaddrinfo_a` exists but is rarely used and has its own bugs.
- The resolver reads `/etc/resolv.conf` once at process start in some glibc builds, restarting `systemd-resolved` or rotating DNS servers does not propagate.
- It blocks signals, if you run it on the main loop you stall every connection in flight.

Workarounds: pin a thread pool for resolutions, set a per-request deadline by `pthread_cancel` (terrible), or replace the whole resolver. The right answer is the last one.

### 2. c-ares overview

`c-ares` is an asynchronous DNS resolver written by Daniel Stenberg's team (the curl folks). Its API gives you:

- A `ares_channel` per "resolver context" (per worker thread or per process).
- Non-blocking sockets you integrate with your epoll / io_uring / Asio loop.
- Configurable timeouts and retries.
- Support for A, AAAA, SRV, TXT, NAPTR, CAA, and more.
- Optional EDNS0, DNS-over-TLS (since 1.27), DNS-over-HTTPS (out-of-tree experiments).

It is the resolver inside Node.js, gRPC C++ (`grpc_resolver_dns_ares`), and many language runtimes. Apache 2.0 + MIT-style license.

### 3. Minimal asynchronous lookup

```cpp
#include <ares.h>

class AresResolver {
 public:
  AresResolver() {
    ares_library_init(ARES_LIB_INIT_ALL);
    ares_options opts{};
    int mask = 0;
    opts.timeout = 2000;     mask |= ARES_OPT_TIMEOUTMS;
    opts.tries   = 3;        mask |= ARES_OPT_TRIES;
    opts.flags   = ARES_FLAG_STAYOPEN;
    mask |= ARES_OPT_FLAGS;
    if (ares_init_options(&ch_, &opts, mask) != ARES_SUCCESS)
      throw std::runtime_error("ares_init_options");
  }
  ~AresResolver() {
    if (ch_) ares_destroy(ch_);
    ares_library_cleanup();
  }
  // Returns fds c-ares wants to watch, with desired event masks.
  void poll(Reactor& r) {
    fd_set rd, wr; FD_ZERO(&rd); FD_ZERO(&wr);
    int nfds = ares_fds(ch_, &rd, &wr);
    timeval tv{}, *tvp;
    tvp = ares_timeout(ch_, nullptr, &tv);
    // integrate nfds + tvp with your loop - on each fd ready call
    // ares_process_fd(ch_, read_fd, write_fd);
  }

  using Cb = std::function<void(int status, std::vector<std::string> addrs)>;
  void resolve(const std::string& host, Cb cb) {
    auto* ctx = new Cb(std::move(cb));
    ares_gethostbyname(ch_, host.c_str(), AF_UNSPEC,
      [](void* arg, int status, int /*timeouts*/, hostent* he) {
        auto* c = static_cast<Cb*>(arg);
        std::vector<std::string> out;
        if (status == ARES_SUCCESS && he) {
          char buf[INET6_ADDRSTRLEN];
          for (char** p = he->h_addr_list; *p; ++p) {
            inet_ntop(he->h_addrtype, *p, buf, sizeof(buf));
            out.emplace_back(buf);
          }
        }
        (*c)(status, std::move(out));
        delete c;
      }, ctx);
  }
 private:
  ares_channel ch_ = nullptr;
};
```

c-ares uses `ares_fds` (legacy fd_set API) or the newer `ares_socket_state_callback` for event-driven integration. Modern integrations use the callback:

```cpp
ares_options opts{};
opts.sock_state_cb = [](void* data, ares_socket_t fd, int readable, int writable) {
  auto* loop = static_cast<Reactor*>(data);
  if (readable || writable) loop->arm(fd, /*ev*/);
  else                       loop->del(fd);
};
opts.sock_state_cb_data = &reactor;
ares_init_options(&ch, &opts, ARES_OPT_SOCK_STATE_CB);
```

### 4. Happy Eyeballs (RFC 8305)

When a hostname has both A and AAAA records, you want to attempt IPv6 first but fall back to IPv4 quickly if v6 is broken. The naive sequential approach (try v6, wait for connect timeout, try v4) gives you 75 s of stall on broken-v6 networks. RFC 8305 / 6555 says:

1. Issue A and AAAA queries in parallel.
2. As answers arrive, sort by ACL preference but generally prefer AAAA.
3. Start TCP connect to the first address, after a short delay (recommended 250 ms), start a second connect to the next address (typically the v4 if v6 was first).
4. Whichever connects first wins, cancel the others.

Sketch:

```cpp
struct HappyEyeballs {
  void start(const std::string& host, uint16_t port, Cb cb) {
    resolver_.resolve(host, AF_INET6, [=](int s, auto v6) { on_addrs(s, v6); });
    resolver_.resolve(host, AF_INET,  [=](int s, auto v4) { on_addrs(s, v4); });
    timer_.start(250ms, [this]{ try_next(); });
  }
  void try_next() {
    if (queue_.empty()) return;
    auto addr = queue_.front(); queue_.pop_front();
    int fd = ::socket(addr.family, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (::connect(fd, &addr.sa, addr.salen) < 0 && errno != EINPROGRESS)
      return retry();
    arm_writable(fd, [this, fd] { on_connected(fd); });
    timer_.start(250ms, [this]{ try_next(); });   // race the next address
  }
  void on_connected(int fd) {
    if (winner_) { ::close(fd); return; }   // someone else won
    winner_ = fd;
    cb_(fd);
  }
};
```

This is what curl, Chrome, Firefox, Go's `net.Dialer`, and gRPC C++ resolvers all do. If your client connects from a mobile device or any environment with flaky v6, ship Happy Eyeballs.

### 5. Caching strategy

c-ares does *not* cache results between queries by default (each query goes on the wire). For a server doing thousands of resolutions per second this is unacceptable. You need an application cache:

```cpp
struct Entry {
  std::vector<sockaddr_in6> addrs;
  std::chrono::steady_clock::time_point expires;
};
class DnsCache {
 public:
  std::optional<std::vector<sockaddr_in6>> lookup(std::string_view h) {
    std::shared_lock l(m_);
    auto it = map_.find(h);
    if (it == map_.end()) return std::nullopt;
    if (std::chrono::steady_clock::now() > it->second.expires) return std::nullopt;
    return it->second.addrs;
  }
  void insert(std::string h, std::vector<sockaddr_in6> a, std::chrono::seconds ttl) {
    std::unique_lock l(m_);
    map_.insert_or_assign(std::move(h),
      Entry{std::move(a), std::chrono::steady_clock::now() + ttl});
  }
 private:
  mutable std::shared_mutex m_;
  std::unordered_map<std::string, Entry, StringHash, std::equal_to<>> map_;
};
```

TTL handling rules:

- Honor the DNS TTL but cap at a sane max (e.g., 60 s) so you do not pin a stale RR for an hour.
- Cap minimum at 1 s so you do not hammer the resolver on TTL=0.
- Cache negative answers for a short window (5-10 s) -- prevents resolution storms when a domain is briefly down.
- Stale-while-revalidate: serve the expired entry while a background refresh runs. Cuts p99 dramatically for steady-state traffic.

### 6. DNS-over-TLS and DNS-over-HTTPS

Plain DNS leaks every hostname your service contacts. For services in security-sensitive environments (financial, healthcare, multi-tenant SaaS):

- **DoT** (RFC 7858): TLS over port 853. c-ares 1.27 added native support via `ARES_OPT_TCP_PORT` and `ares_set_servers_csv("tls://1.1.1.1")`.
- **DoH** (RFC 8484): HTTPS POST/GET to `/dns-query`. No native c-ares support yet -- use `nghttp2` or libcurl to construct the HTTP/2 request, then feed the wire-format response to `ares_parse_*` functions.

In-process resolvers using DoH usually pool one HTTP/2 connection to the resolver and multiplex many queries on it -- much cheaper than per-query TCP+TLS.

```cpp
// DoH via libcurl + ares parser
auto wire = ares_create_query("example.com", C_IN, T_A, qid, 0, &qbuf, &qlen, 0);
curl_easy_setopt(curl, CURLOPT_URL, "https://1.1.1.1/dns-query");
curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);   // Content-Type: application/dns-message
curl_easy_setopt(curl, CURLOPT_POSTFIELDS, qbuf);
curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, qlen);
// ... after response:
hostent* he = nullptr;
ares_parse_a_reply(resp, resp_len, &he, nullptr, nullptr);
```

Cloudflare, Google, and Quad9 all run public DoH/DoT endpoints. For internal services use a private resolver (Unbound, dnsdist) terminating DoT for you.

### 7. SRV records for service discovery

Before Kubernetes, plain SRV records were the lightweight way to do service discovery: `_grpc._tcp.payments.svc.cluster.local` returns multiple `(priority, weight, port, target)` tuples, where the client weights by `weight` within the lowest `priority`.

c-ares parses these:

```cpp
ares_query(ch, "_grpc._tcp.payments", C_IN, T_SRV,
  [](void* a, int s, int, unsigned char* abuf, int alen) {
    ares_srv_reply* r = nullptr;
    if (ares_parse_srv_reply(abuf, alen, &r) == ARES_SUCCESS) {
      for (auto* p = r; p; p = p->next) {
        // p->host, p->port, p->priority, p->weight
      }
      ares_free_data(r);
    }
  }, nullptr);
```

gRPC C++'s `dns:///` resolver supports SRV via this exact path. Useful when you cannot adopt a dedicated discovery service like Consul or etcd.

### 8. Operational pitfalls

- glibc `getaddrinfo` calls outside of c-ares: any third-party C/C++ library you link may call it and re-introduce the blocking pathology. `LD_PRELOAD` shims (`nss-cares`) exist but are awkward.
- IPv6 / IPv4 sort order from `gai.conf` does not apply when you bypass NSS. Re-implement RFC 6724 if you care about exact OS parity (most services do not).
- Truncated responses: a UDP DNS answer >512 B (or >EDNS0 size) sets the TC bit, resolver must retry over TCP. c-ares handles this transparently if you call `ares_init_options` with default flags.
- DNS amplification: never run a recursive resolver inside a public server. c-ares is a stub resolver, not a recursive one, so this is naturally safe.
- IDN (international domain names): use `libidn2` to encode to Punycode before passing to c-ares.
- Host alias loops in `/etc/hosts`: c-ares can be configured to consult `/etc/hosts` (`ARES_FLAG_USEVC` and friends) but the default skips it. Decide whether you want that, for production servers consulting `/etc/hosts` is usually wrong (fragile across container images).

### 9. Observability

Every resolve should emit:

- duration histogram (p50/p95/p99/p999),
- error code histogram (`ARES_ETIMEOUT`, `ARES_ENOTFOUND`, `ARES_ECONNREFUSED`, ...),
- per-resolver-server counters when you have multiple in `resolv.conf`,
- cache hit/miss/stale-served ratio.

If you do not have these, you will not notice when the corporate DNS server starts replying in 800 ms instead of 8 ms, your service just gets slower.

> Senior @ FAANG: gRPC C++ resolves through `grpc_resolver_dns_ares`. If you are integrating gRPC into a service that already has a c-ares pool, you can register a custom resolver to share the cache and avoid the duplicate `ares_channel`. Look at `src/core/ext/filters/client_channel/resolver/dns/c_ares/dns_resolver_ares.cc` for the integration shape.

