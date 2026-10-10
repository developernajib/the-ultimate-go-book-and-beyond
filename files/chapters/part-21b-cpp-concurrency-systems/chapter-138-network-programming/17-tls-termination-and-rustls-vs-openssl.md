## TLS Termination: OpenSSL, BoringSSL, and rustls in C++

Every serious network service eventually terminates TLS. The interesting choices are which library, how you wrap it in safe C++ idioms, and which TLS 1.3 features you turn on without breaking interoperability. This chapter is a fast tour of production realities.

### 1. Library landscape

| Library | Origin | API stability | Notable users |
|------------|--------------|---------------|----------------------------------------|
| OpenSSL | community | bumpy (1.0 -> 1.1 -> 3.0 broke ABIs) | almost everyone |
| BoringSSL | Google fork | no stability promise, vendored | Chromium, gRPC, Envoy, Cloudflare |
| rustls | Rust | stable C API via `rustls-ffi` | Cloudflare's pingora, AWS s2n-quic |
| s2n-tls | AWS, C | stable | AWS internal, Kubernetes ingress |
| wolfSSL | commercial | stable | embedded, IoT |
| GnuTLS | GNU | stable | curl alt, gnome stack |

For a new C++ service in 2026 the realistic choices are BoringSSL (if you can vendor) or OpenSSL 3.x (if you must dynamically link a distro version). rustls via `rustls-ffi` is increasingly viable and has the best memory-safety story.

### 2. OpenSSL `SSL_CTX` configuration -- production preset

```cpp
class TlsServerCtx {
 public:
  TlsServerCtx(const std::string& cert, const std::string& key) {
    ctx_ = SSL_CTX_new(TLS_server_method());
    if (!ctx_) throw_ossl("SSL_CTX_new");

    // TLS 1.2 floor - 1.3 preferred. Drop 1.0/1.1 entirely.
    SSL_CTX_set_min_proto_version(ctx_, TLS1_2_VERSION);
    SSL_CTX_set_max_proto_version(ctx_, TLS1_3_VERSION);

    // Modern cipher list (Mozilla "intermediate" 5.7).
    SSL_CTX_set_ciphersuites(ctx_,
      "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256");
    SSL_CTX_set_cipher_list(ctx_,
      "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:"
      "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:"
      "ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305");
    SSL_CTX_set_options(ctx_,
        SSL_OP_NO_COMPRESSION |
        SSL_OP_CIPHER_SERVER_PREFERENCE |
        SSL_OP_NO_TICKET /* set only if you do not implement rotation */);

    // ECDH curves
    SSL_CTX_set1_groups_list(ctx_, "X25519:P-256:P-384");

    if (SSL_CTX_use_certificate_chain_file(ctx_, cert.c_str()) <= 0)
      throw_ossl("use_certificate_chain_file");
    if (SSL_CTX_use_PrivateKey_file(ctx_, key.c_str(), SSL_FILETYPE_PEM) <= 0)
      throw_ossl("use_PrivateKey_file");
    if (!SSL_CTX_check_private_key(ctx_))
      throw_ossl("check_private_key");

    // ALPN
    static const unsigned char alpn[] = {
      2,'h','2',  8,'h','t','t','p','/','1','.','1'
    };
    SSL_CTX_set_alpn_select_cb(ctx_, &TlsServerCtx::alpn_cb, nullptr);

    // Session tickets with rotated keys
    SSL_CTX_set_tlsext_ticket_key_evp_cb(ctx_, &TlsServerCtx::ticket_cb);
  }
  ~TlsServerCtx() { if (ctx_) SSL_CTX_free(ctx_); }
  TlsServerCtx(const TlsServerCtx&) = delete;
  SSL_CTX* native() const { return ctx_; }

 private:
  SSL_CTX* ctx_ = nullptr;
  static int alpn_cb(SSL* /*s*/, const unsigned char** out, unsigned char* outlen,
                     const unsigned char* in, unsigned int inlen, void*) {
    static const unsigned char srv[] = {2,'h','2', 8,'h','t','t','p','/','1','.','1'};
    if (SSL_select_next_proto((unsigned char**)out, outlen, srv, sizeof(srv),
                              in, inlen) != OPENSSL_NPN_NEGOTIATED)
      return SSL_TLSEXT_ERR_ALERT_FATAL;
    return SSL_TLSEXT_ERR_OK;
  }
  static int ticket_cb(SSL*, unsigned char[16], unsigned char[16],
                       EVP_CIPHER_CTX*, EVP_MAC_CTX*, int /*enc*/) {
    /* fetch keys from ring buffer; rotate every 6h; previous keys live 24h */
    return 1;
  }
  [[noreturn]] static void throw_ossl(const char* fn) {
    char b[256];
    ERR_error_string_n(ERR_get_error(), b, sizeof(b));
    throw std::runtime_error(std::string(fn) + ": " + b);
  }
};
```

Important details:

- `TLS_server_method()` (not `TLSv1_2_server_method`), the latter is deprecated and pins one version.
- `SSL_OP_NO_TICKET` only if you have not implemented rotation. Disabling tickets entirely costs full handshakes for resumption -- expensive.
- `SSL_CTX_set1_groups_list` lets you offer X25519 first, on Intel without AVX-512, X25519 is faster than P-256.
- `SSL_OP_CIPHER_SERVER_PREFERENCE` -- in TLS 1.2 the server picks, in 1.3 the client picks from negotiated set, this flag is mostly moot for 1.3.

### 3. RAII for the per-connection `SSL*`

```cpp
struct SslDeleter { void operator()(SSL* s) const noexcept { if (s) SSL_free(s); } };
using SslPtr = std::unique_ptr<SSL, SslDeleter>;

class TlsConn {
 public:
  TlsConn(SSL_CTX* ctx, int fd) : fd_(fd), ssl_(SSL_new(ctx)) {
    if (!ssl_) throw std::runtime_error("SSL_new");
    SSL_set_fd(ssl_.get(), fd);
    SSL_set_accept_state(ssl_.get());
  }
  // Non-blocking handshake driven by epoll/io_uring
  enum class Want { Done, Read, Write, Error };
  Want progress_handshake() {
    int rc = SSL_do_handshake(ssl_.get());
    if (rc == 1) return Want::Done;
    int err = SSL_get_error(ssl_.get(), rc);
    if (err == SSL_ERROR_WANT_READ)  return Want::Read;
    if (err == SSL_ERROR_WANT_WRITE) return Want::Write;
    return Want::Error;
  }
  ssize_t read(void* buf, size_t n) {
    int r = SSL_read(ssl_.get(), buf, (int)n);
    if (r > 0) return r;
    int e = SSL_get_error(ssl_.get(), r);
    if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) {
      errno = EAGAIN; return -1;
    }
    if (e == SSL_ERROR_ZERO_RETURN) return 0;
    errno = EIO; return -1;
  }
  ssize_t write(const void* buf, size_t n) {
    int r = SSL_write(ssl_.get(), buf, (int)n);
    if (r > 0) return r;
    int e = SSL_get_error(ssl_.get(), r);
    if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) {
      errno = EAGAIN; return -1;
    }
    errno = EIO; return -1;
  }
  ~TlsConn() {
    if (ssl_) SSL_shutdown(ssl_.get());   // bidirectional close-notify
    if (fd_ >= 0) ::close(fd_);
  }
 private:
  int fd_;
  SslPtr ssl_;
};
```

The handshake is driven from the same epoll loop as raw I/O: `SSL_do_handshake` returns `WANT_READ` or `WANT_WRITE`, and you arm the corresponding event. Same pattern for `SSL_read` / `SSL_write` post-handshake. This is exactly what Boost.Asio's `ssl::stream` does internally.

### 4. SNI -- routing by hostname

The server callback runs after ClientHello but before certificate selection:

```cpp
SSL_CTX_set_tlsext_servername_callback(ctx_, [](SSL* s, int*, void*) {
  const char* sni = SSL_get_servername(s, TLSEXT_NAMETYPE_host_name);
  if (!sni) return SSL_TLSEXT_ERR_NOACK;
  auto* per_host_ctx = lookup_ctx(sni);
  if (!per_host_ctx) return SSL_TLSEXT_ERR_ALERT_FATAL;
  SSL_set_SSL_CTX(s, per_host_ctx);     // swap cert/key
  return SSL_TLSEXT_ERR_OK;
});
```

This is how Envoy's `tls_context` `match_subject_alt_names`, NGINX `server_name`, and HAProxy `crt-list` route a single listener to many certs.

### 5. Session tickets and 0-RTT

TLS 1.2 session tickets: server-side stateless resumption. You hold a rotating set of keys, the client presents an encrypted blob, you decrypt and resume. Three keys live at once: current (encrypt + decrypt), previous (decrypt only), next (preloaded). Rotate hourly or every few hours.

TLS 1.3 0-RTT (early data): client can send application data with the first flight if it has a recent ticket. Wins one RTT but allows replay. Three rules:

1. Application protocol must be replay-safe (idempotent GET, no `POST /transfer`).
2. Server must enforce a small `max_early_data` and reject excess.
3. Use anti-replay (`SSL_CTX_set_max_early_data` + a Bloom filter or strict per-ticket use).

```cpp
SSL_CTX_set_max_early_data(ctx_, 16384);
// per-connection:
size_t readbytes = 0;
char early[16384];
int rc = SSL_read_early_data(ssl, early, sizeof(early), &readbytes);
// rc: SSL_READ_EARLY_DATA_ERROR / SUCCESS / FINISH
```

CDNs (Cloudflare, Fastly) use 0-RTT extensively for static GETs. Internal RPC services usually do not bother, the wire savings are minimal once you have connection pooling.

### 6. OCSP stapling

The server fetches the CA's OCSP response periodically and staples it into the handshake (`status_request` extension). Client avoids a side-channel OCSP fetch.

```cpp
SSL_CTX_set_tlsext_status_cb(ctx_, [](SSL* s, void*) -> int {
  auto resp = ocsp_cache_lookup_for(SSL_get_certificate(s));
  if (!resp) return SSL_TLSEXT_ERR_NOACK;
  auto* der = OPENSSL_malloc(resp->size());
  std::memcpy(der, resp->data(), resp->size());
  SSL_set_tlsext_status_ocsp_resp(s, der, resp->size());
  return SSL_TLSEXT_ERR_OK;
});
```

OCSP must stay current: stapling a stale response is worse than no stapling because clients cache the staple. Refresh at half the response's `nextUpdate` interval. Must-Staple X.509 extension makes this mandatory, if your responder is down, your service is down.

### 7. ALPN -- HTTP/2 vs HTTP/1.1 selection

Modern servers offer `h2` and `http/1.1`. The callback in section 2 chooses. Envoy and NGINX let you order preference. For gRPC-only services, advertise only `h2` -- if a client cannot negotiate, fail loudly rather than fall back to a protocol you do not actually serve.

### 8. kTLS hand-off

After the handshake, you can transfer the session to the kernel for `sendfile`-style zero-copy:

```cpp
// after SSL_do_handshake returns 1
if (SSL_get_max_send_fragment(ssl) >= 16384) {
  if (BIO_set_ktls(SSL_get_wbio(ssl), 1) > 0) {
    // kernel now does AES-GCM for all writes - sendfile() works
  }
}
```

Requires kernel 4.13+ for TX, 4.17+ for RX, and OpenSSL 3.0+ with `--enable-ktls`. BoringSSL has its own kTLS hooks.

### 9. BoringSSL differences worth knowing

- No `OPENSSL_init_ssl` / `OPENSSL_cleanup` -- thread-local init is automatic.
- Different ABIs for some structs (`SSL_CIPHER`, `SSL_SESSION`), link-time only, no source compatibility.
- BoringSSL ships its own `bssl::UniquePtr<SSL>` -- use it instead of writing your own deleter.
- BoringSSL deliberately removes APIs that Google considers hazardous (renegotiation, weak ciphers). Code that depends on them will not link.

### 10. rustls via `rustls-ffi`

Modern alternative for greenfield C++ services: you link `librustls.a`, get a memory-safe TLS implementation, and bypass the OpenSSL-CVE-of-the-month treadmill. API is C, designed to feel familiar to OpenSSL users:

```cpp
struct rustls_server_config_builder* b = rustls_server_config_builder_new();
rustls_server_config_builder_load_native_roots(b);
rustls_server_config_builder_set_alpn_protocols(b, alpn, count);
const rustls_server_config* cfg = rustls_server_config_builder_build(b);

rustls_connection* conn = nullptr;
rustls_server_connection_new(cfg, &conn);
// drive via rustls_connection_read_tls / write_tls / process_new_packets
```

You still drive I/O yourself, rustls only does the TLS state machine. Cloudflare's pingora and Linkerd2 ship rustls in production. AWS s2n-quic is in the same neighborhood (s2n-tls is C, s2n-quic is Rust).

### 11. Common production traps

- Linking `libssl` and `libcrypto` from different versions across shared libs causes silent symbol clashes, static-link or pin a single version.
- `SSL_shutdown` returns 0 on the first call ("close-notify sent, waiting for peer"). Calling it once and closing the fd is fine for most servers, calling it twice with epoll integration is correct but rarely necessary.
- `ERR_get_error` is a per-thread queue. If you do not drain it, error messages from old failures appear in unrelated logs. Always call `ERR_clear_error` before crossing API boundaries you do not own.
- `SSL_CTX_set_verify` on a server with no `SSL_CTX_set_client_CA_list` produces an empty `certificate_authorities` extension, some clients reject. If you do mTLS, set the CA list.
- Certificate chain order matters: leaf, then intermediates, then no root. OpenSSL is forgiving, rustls and Go's `crypto/tls` are not.
- TLS 1.3 `KeyUpdate` after long-lived connections (>1 day) requires no application action with OpenSSL 1.1.1+, but make sure your wrapper does not fall over on the new keys.

> Senior @ FAANG: you will inherit a TLS stack and a rotation-key story. Spend a week reading the existing rotation pipeline, the OCSP cache, the ALPN policy, and the SNI routing. Do not "modernize" it on day one. Modernize after you have telemetry showing the actual handshake mix in production.

