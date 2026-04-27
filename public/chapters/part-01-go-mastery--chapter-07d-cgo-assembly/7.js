export default `## 7D.6 Practical CGO: Wrapping libsodium (Encryption)

libsodium is a widely used C cryptography library. Wrapping it with CGO provides Go programs access to its high-performance, well-audited primitives while maintaining a safe, idiomatic Go API.

\`\`\`go
// file: crypto.go
// Wraps libsodium's secretbox for symmetric encryption
package crypto

/*
#cgo pkg-config: libsodium
#include <sodium.h>
#include <stdlib.h>

// Initialize libsodium (idempotent, returns 0 on success)
int init_sodium() {
    return sodium_init();
}
*/
import "C"

import (
    "errors"
    "unsafe"
)

func init() {
    if C.init_sodium() < 0 {
        panic("libsodium initialization failed")
    }
}

const (
    KeySize   = 32 // crypto_secretbox_KEYBYTES
    NonceSize = 24 // crypto_secretbox_NONCEBYTES
    MACSize   = 16 // crypto_secretbox_MACBYTES
)

// GenerateKey generates a random 32-byte encryption key
func GenerateKey() [KeySize]byte {
    var key [KeySize]byte
    C.randombytes_buf(unsafe.Pointer(&key[0]), C.size_t(KeySize))
    return key
}

// Encrypt encrypts plaintext using secretbox (XSalsa20 + Poly1305)
func Encrypt(plaintext []byte, key [KeySize]byte) ([]byte, error) {
    if len(plaintext) == 0 {
        return nil, errors.New("empty plaintext")
    }

    // Generate random nonce
    var nonce [NonceSize]byte
    C.randombytes_buf(unsafe.Pointer(&nonce[0]), C.size_t(NonceSize))

    // Output: nonce + MAC + ciphertext
    output := make([]byte, NonceSize+MACSize+len(plaintext))
    copy(output[:NonceSize], nonce[:])

    ciphertextPtr := (*C.uchar)(unsafe.Pointer(&output[NonceSize]))
    plaintextPtr := (*C.uchar)(unsafe.Pointer(&plaintext[0]))
    noncePtr := (*C.uchar)(unsafe.Pointer(&nonce[0]))
    keyPtr := (*C.uchar)(unsafe.Pointer(&key[0]))

    C.crypto_secretbox_easy(
        ciphertextPtr,
        plaintextPtr,
        C.ulonglong(len(plaintext)),
        noncePtr,
        keyPtr,
    )

    return output, nil
}

// Decrypt decrypts a message encrypted with Encrypt
func Decrypt(ciphertext []byte, key [KeySize]byte) ([]byte, error) {
    if len(ciphertext) < NonceSize+MACSize {
        return nil, errors.New("ciphertext too short")
    }

    nonce := ciphertext[:NonceSize]
    enc := ciphertext[NonceSize:]

    plaintext := make([]byte, len(enc)-MACSize)

    ret := C.crypto_secretbox_open_easy(
        (*C.uchar)(unsafe.Pointer(&plaintext[0])),
        (*C.uchar)(unsafe.Pointer(&enc[0])),
        C.ulonglong(len(enc)),
        (*C.uchar)(unsafe.Pointer(&nonce[0])),
        (*C.uchar)(unsafe.Pointer(&key[0])),
    )

    if ret != 0 {
        return nil, errors.New("decryption failed: invalid MAC")
    }

    return plaintext, nil
}
\`\`\`

### Testing Discipline for CGO Wrappers

For a senior engineer maintaining a CGO wrapper:

1. **Round-trip tests on every entry point.** Encrypt then decrypt, serialise then parse. Validates the boundary in both directions.
2. **Memory leak tests.** Run the test suite 10,000 times and check RSS. CGO leaks are subtle.
3. **Nil and empty input tests.** The C library's behaviour on nil/empty often differs from Go's.
4. **Concurrency tests.** The C library may not be thread-safe. Document and enforce the contract.

---
`;
