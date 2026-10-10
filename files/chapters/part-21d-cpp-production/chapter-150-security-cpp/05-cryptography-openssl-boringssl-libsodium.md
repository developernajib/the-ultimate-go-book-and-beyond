## Cryptography: OpenSSL, BoringSSL, and libsodium

The first rule of cryptography in production code: never implement your own primitives. This rule has no exceptions. AES, ChaCha20, Poly1305, Ed25519, X25519, Argon2, these algorithms have been implemented and audited by cryptographers. Rolling your own produces code that appears correct, passes all your tests, and fails catastrophically when an attacker exploits a timing side-channel or a subtle key scheduling error you did not know to look for.

The three libraries you will encounter in C++ production systems are libsodium (high-level, misuse-resistant), BoringSSL (Google's conservative OpenSSL fork), and OpenSSL (industry-standard, used everywhere). Each serves a different purpose.

### libsodium

libsodium is the correct choice for most application-level cryptography. Its API is designed to be impossible to misuse: it selects strong algorithms by default, handles nonce generation, and combines encryption with authentication in every primitive.

```cpp
#include <sodium.h>
#include <vector>
#include <stdexcept>
#include <cstring>

// Initialize once at program startup
void init_libsodium() {
    if (sodium_init() < 0) {
        throw std::runtime_error("libsodium initialization failed");
    }
}

// Authenticated encryption: XSalsa20 stream cipher + Poly1305 MAC
// Confidentiality + integrity + authenticity in one call
std::vector<uint8_t> encrypt_message(
    const std::vector<uint8_t>& plaintext,
    const uint8_t key[crypto_secretbox_KEYBYTES])
{
    // Nonce: random, 24 bytes, never reused with the same key
    uint8_t nonce[crypto_secretbox_NONCEBYTES];
    randombytes_buf(nonce, sizeof(nonce));

    // Ciphertext is plaintext_len + MAC_BYTES (16 bytes for authentication tag)
    std::vector<uint8_t> ciphertext(crypto_secretbox_MACBYTES + plaintext.size());

    crypto_secretbox_easy(
        ciphertext.data(),
        plaintext.data(), plaintext.size(),
        nonce, key
    );

    // Prepend nonce to ciphertext for transmission (nonce is not secret)
    std::vector<uint8_t> output(sizeof(nonce) + ciphertext.size());
    std::memcpy(output.data(), nonce, sizeof(nonce));
    std::memcpy(output.data() + sizeof(nonce), ciphertext.data(), ciphertext.size());
    return output;
}

std::vector<uint8_t> decrypt_message(
    const std::vector<uint8_t>& input,
    const uint8_t key[crypto_secretbox_KEYBYTES])
{
    constexpr size_t NONCE_LEN = crypto_secretbox_NONCEBYTES;
    constexpr size_t MAC_LEN   = crypto_secretbox_MACBYTES;

    if (input.size() < NONCE_LEN + MAC_LEN) {
        throw std::invalid_argument("ciphertext too short");
    }

    const uint8_t* nonce      = input.data();
    const uint8_t* ciphertext = input.data() + NONCE_LEN;
    size_t         cipher_len = input.size() - NONCE_LEN;

    std::vector<uint8_t> plaintext(cipher_len - MAC_LEN);

    // Returns -1 if authentication fails, always check this
    if (crypto_secretbox_open_easy(
            plaintext.data(), ciphertext, cipher_len, nonce, key) != 0) {
        throw std::runtime_error("decryption failed: authentication tag mismatch");
    }

    return plaintext;
}

// Key generation
void generate_key(uint8_t key[crypto_secretbox_KEYBYTES]) {
    crypto_secretbox_keygen(key);  // cryptographically random
}
```

```cpp
// Ed25519 signatures: sign and verify
void sign_verify_example() {
    uint8_t pk[crypto_sign_PUBLICKEYBYTES];
    uint8_t sk[crypto_sign_SECRETKEYBYTES];
    crypto_sign_keypair(pk, sk);  // generate keypair

    const std::string message = "important document";
    std::vector<uint8_t> signed_msg(crypto_sign_BYTES + message.size());
    unsigned long long signed_len;

    crypto_sign(
        signed_msg.data(), &signed_len,
        reinterpret_cast<const uint8_t*>(message.data()), message.size(),
        sk
    );

    // Verify: returns 0 on success, -1 on forgery
    std::vector<uint8_t> verified(message.size());
    unsigned long long verified_len;
    if (crypto_sign_open(
            verified.data(), &verified_len,
            signed_msg.data(), signed_len, pk) != 0) {
        throw std::runtime_error("signature verification failed");
    }
}

// Password hashing with Argon2id
bool verify_password(const std::string& password, const char* stored_hash) {
    return crypto_pwhash_str_verify(
        stored_hash,
        password.c_str(), password.size()
    ) == 0;
}

std::string hash_password(const std::string& password) {
    char hash[crypto_pwhash_STRBYTES];
    if (crypto_pwhash_str(
            hash, password.c_str(), password.size(),
            crypto_pwhash_OPSLIMIT_INTERACTIVE,
            crypto_pwhash_MEMLIMIT_INTERACTIVE) != 0) {
        throw std::runtime_error("password hashing failed: out of memory");
    }
    return std::string(hash);
}
```

### BoringSSL

BoringSSL is Google's fork of OpenSSL, used in Chrome, Android, and gVisor. It removes deprecated algorithms (RC4, MD4, export-grade ciphers) and provides a more conservative API. It is not API-compatible with OpenSSL and is not designed for external distribution, but understanding its patterns matters if you work on Google-adjacent infrastructure.

```cpp
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/evp.h>

// TLS client connection with BoringSSL
class TlsClient {
    SSL_CTX* ctx_ = nullptr;
    SSL*     ssl_ = nullptr;

public:
    TlsClient() {
        ctx_ = SSL_CTX_new(TLS_method());
        if (!ctx_) throw std::runtime_error("SSL_CTX_new failed");

        // Require TLS 1.2 minimum, BoringSSL supports 1.3
        SSL_CTX_set_min_proto_version(ctx_, TLS1_2_VERSION);

        // Load system CA certificates for verification
        SSL_CTX_set_default_verify_paths(ctx_);

        // Require peer certificate verification
        SSL_CTX_set_verify(ctx_, SSL_VERIFY_PEER, nullptr);
    }

    ~TlsClient() {
        if (ssl_) SSL_free(ssl_);
        if (ctx_) SSL_CTX_free(ctx_);
    }

    void connect(int fd, const std::string& hostname) {
        ssl_ = SSL_new(ctx_);
        if (!ssl_) throw std::runtime_error("SSL_new failed");

        SSL_set_fd(ssl_, fd);
        SSL_set_tlsext_host_name(ssl_, hostname.c_str());  // SNI

        if (SSL_connect(ssl_) != 1) {
            unsigned long err = ERR_get_error();
            char buf[256];
            ERR_error_string_n(err, buf, sizeof(buf));
            throw std::runtime_error(std::string("TLS handshake failed: ") + buf);
        }

        // Verify: confirm the certificate matches the hostname
        if (SSL_get_verify_result(ssl_) != X509_V_OK) {
            throw std::runtime_error("certificate verification failed");
        }
    }
};
```

### OpenSSL: AES-256-GCM

AES-GCM is authenticated encryption, it provides both confidentiality and integrity. Using AES-CBC or AES-CTR without a MAC is a common mistake that produces unauthenticated ciphertext.

```cpp
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <vector>
#include <stdexcept>
#include <array>

constexpr int AES_KEY_LEN = 32;  // AES-256
constexpr int GCM_IV_LEN  = 12;  // 96-bit IV, recommended for GCM
constexpr int GCM_TAG_LEN = 16;  // 128-bit authentication tag

struct AesGcmResult {
    std::vector<uint8_t> ciphertext;
    std::array<uint8_t, GCM_IV_LEN>  iv;
    std::array<uint8_t, GCM_TAG_LEN> tag;
};

AesGcmResult aes256_gcm_encrypt(
    const uint8_t  key[AES_KEY_LEN],
    const uint8_t* plaintext,
    size_t         plaintext_len,
    const uint8_t* aad,      // additional authenticated data (may be null)
    size_t         aad_len)
{
    AesGcmResult result;
    result.ciphertext.resize(plaintext_len);

    // Random IV, never reuse with the same key
    if (RAND_bytes(result.iv.data(), GCM_IV_LEN) != 1) {
        throw std::runtime_error("RAND_bytes failed");
    }

    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    if (!ctx) throw std::runtime_error("EVP_CIPHER_CTX_new failed");

    // RAII wrapper to ensure ctx is always freed
    auto ctx_guard = [ctx]() { EVP_CIPHER_CTX_free(ctx); };

    if (EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr,
                           key, result.iv.data()) != 1) {
        ctx_guard();
        throw std::runtime_error("EVP_EncryptInit_ex failed");
    }

    int out_len = 0;

    // Authenticate additional data (not encrypted, but integrity-protected)
    if (aad && aad_len > 0) {
        if (EVP_EncryptUpdate(ctx, nullptr, &out_len, aad, aad_len) != 1) {
            ctx_guard();
            throw std::runtime_error("EVP_EncryptUpdate (AAD) failed");
        }
    }

    // Encrypt
    if (EVP_EncryptUpdate(ctx, result.ciphertext.data(), &out_len,
                          plaintext, plaintext_len) != 1) {
        ctx_guard();
        throw std::runtime_error("EVP_EncryptUpdate failed");
    }

    int final_len = 0;
    if (EVP_EncryptFinal_ex(ctx, result.ciphertext.data() + out_len,
                            &final_len) != 1) {
        ctx_guard();
        throw std::runtime_error("EVP_EncryptFinal_ex failed");
    }

    // Extract authentication tag
    if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG,
                            GCM_TAG_LEN, result.tag.data()) != 1) {
        ctx_guard();
        throw std::runtime_error("EVP_CTRL_GCM_GET_TAG failed");
    }

    ctx_guard();
    return result;
}

bool aes256_gcm_decrypt(
    const uint8_t  key[AES_KEY_LEN],
    const uint8_t  iv[GCM_IV_LEN],
    const uint8_t  tag[GCM_TAG_LEN],
    const uint8_t* ciphertext, size_t ciphertext_len,
    const uint8_t* aad, size_t aad_len,
    uint8_t*       plaintext_out)
{
    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    if (!ctx) throw std::runtime_error("EVP_CIPHER_CTX_new failed");

    bool success = false;
    do {
        if (EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, key, iv) != 1)
            break;
        int out_len = 0;
        if (aad && aad_len > 0) {
            if (EVP_DecryptUpdate(ctx, nullptr, &out_len, aad, aad_len) != 1)
                break;
        }
        if (EVP_DecryptUpdate(ctx, plaintext_out, &out_len,
                              ciphertext, ciphertext_len) != 1)
            break;
        // Set expected tag before Final
        if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG,
                                GCM_TAG_LEN, const_cast<uint8_t*>(tag)) != 1)
            break;
        int final_len = 0;
        // Returns 1 on success (tag matches), 0 on authentication failure
        success = EVP_DecryptFinal_ex(ctx, plaintext_out + out_len,
                                      &final_len) == 1;
    } while (false);

    EVP_CIPHER_CTX_free(ctx);
    return success;
}
```

### Common Cryptographic Mistakes

**Nonce reuse**: Reusing the same IV with the same key under AES-GCM allows an attacker to recover both plaintexts and the authentication key. Generate a fresh random IV for every encryption. Use libsodium's `randombytes_buf` or OpenSSL's `RAND_bytes`, never a counter unless you can guarantee it never resets.

**Not checking the authentication tag**: Calling `EVP_DecryptFinal_ex` and ignoring its return value means using unauthenticated, potentially tampered plaintext. Always check the return value.

**Weak algorithms**: MD5 and SHA-1 are broken for security purposes. Use SHA-256 minimum for hashing. Use AES-256-GCM or ChaCha20-Poly1305 for encryption. Avoid ECB mode, it leaks patterns in plaintext.

**Hardcoded keys**: Never store cryptographic keys in source code or configuration files. Use a secrets manager (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager).

In Go, `crypto/aes` and `crypto/cipher` provide GCM support with a simpler API and no manual memory management. `crypto/tls` handles TLS with sensible defaults. The tradeoff is less flexibility, Go's crypto packages expose fewer configuration surfaces, which means fewer ways to misconfigure them.

---
