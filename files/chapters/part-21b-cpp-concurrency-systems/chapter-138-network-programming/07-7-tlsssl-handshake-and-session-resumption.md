## 7. TLS/SSL: Handshake and Session Resumption

### The TLS 1.3 Handshake

TLS 1.3 completes in a single round trip (1-RTT), down from two in TLS 1.2:

```
Client                              Server
  | --- ClientHello + KeyShare ---->  |
  | <-- ServerHello + KeyShare -----  |
  |     {EncryptedExtensions}         |
  |     {Certificate}                 |
  |     {CertificateVerify}           |
  |     {Finished}                    |
  | --- {Finished} ---------------->  |
  |     Application Data              |
```

After the first flight, the server has enough information to derive the shared secret via ECDHE (Elliptic Curve Diffie-Hellman Ephemeral) and begins sending encrypted data immediately.

### TLS in C++ with OpenSSL

`TlsContext` wraps an OpenSSL `SSL_CTX` with RAII, calling `SSL_CTX_free` in the destructor. `SSL_CTX_set_min_proto_version(ctx_, TLS1_3_VERSION)` enforces TLS 1.3 as the floor, rejecting legacy negotiation attempts. The certificate and private key are loaded from files. In production these would be read from a secrets manager and rotated without process restart by creating a new `SSL_CTX` and swapping it atomically.
```cpp
#include <openssl/ssl.h>
#include <openssl/err.h>

class TlsContext {
public:
    TlsContext(bool is_server) {
        const SSL_METHOD* method = is_server
            ? TLS_server_method()
            : TLS_client_method();
        ctx_ = SSL_CTX_new(method);
        if (!ctx_) throw std::runtime_error("SSL_CTX_new failed");

        // Enforce TLS 1.3 minimum
        SSL_CTX_set_min_proto_version(ctx_, TLS1_3_VERSION);

        // Enable session tickets for 0-RTT resumption
        if (is_server) {
            SSL_CTX_set_session_ticket_cb(ctx_, nullptr, nullptr, nullptr);
        }
    }

    void load_certificate(const char* cert_path, const char* key_path) {
        if (SSL_CTX_use_certificate_file(ctx_, cert_path,
                                          SSL_FILETYPE_PEM) <= 0) {
            throw std::runtime_error("Failed to load certificate");
        }
        if (SSL_CTX_use_PrivateKey_file(ctx_, key_path,
                                         SSL_FILETYPE_PEM) <= 0) {
            throw std::runtime_error("Failed to load private key");
        }
        if (!SSL_CTX_check_private_key(ctx_)) {
            throw std::runtime_error("Certificate/key mismatch");
        }
    }

    // Wrap a connected socket with TLS
    SSL* wrap_socket(int fd) {
        SSL* ssl = SSL_new(ctx_);
        SSL_set_fd(ssl, fd);
        return ssl;
    }

    ~TlsContext() { SSL_CTX_free(ctx_); }

private:
    SSL_CTX* ctx_;
};

// TLS server accept
void tls_accept(TlsContext& ctx, int client_fd) {
    SSL* ssl = ctx.wrap_socket(client_fd);

    if (SSL_accept(ssl) <= 0) {
        ERR_print_errors_fp(stderr);
        SSL_free(ssl);
        close(client_fd);
        return;
    }

    // Read and write through SSL
    char buf[4096];
    int n = SSL_read(ssl, buf, sizeof(buf));
    if (n > 0) {
        SSL_write(ssl, buf, n);  // echo
    }

    SSL_shutdown(ssl);
    SSL_free(ssl);
    close(client_fd);
}
```

### Session Resumption and 0-RTT

TLS 1.3 supports two resumption mechanisms:

1. **Session tickets**: The server encrypts session state into a ticket sent to the client. On reconnection, the client presents the ticket, avoiding a full handshake.
2. **0-RTT (Early Data)**: The client sends application data in the first flight using a pre-shared key from a previous session. This eliminates the handshake latency entirely but is vulnerable to replay attacks. Use only for idempotent operations.

```cpp
// Enable 0-RTT on the server
void enable_early_data(SSL_CTX* ctx) {
    SSL_CTX_set_max_early_data(ctx, 16384);  // max 16KB early data
}

// Client sends early data
void send_early_data(SSL* ssl, const void* data, size_t len) {
    size_t written = 0;
    int result = SSL_write_early_data(ssl, data, len, &written);
    if (result <= 0) {
        // Early data rejected - fall back to normal handshake
        SSL_connect(ssl);
        SSL_write(ssl, data, len);
    }
}
```

---
