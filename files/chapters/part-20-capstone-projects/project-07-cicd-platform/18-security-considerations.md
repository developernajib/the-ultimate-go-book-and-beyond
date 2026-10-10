## Security Considerations

Security is especially critical in a CI/CD platform because it executes arbitrary code from repositories and handles sensitive secrets like API keys, database passwords, and deployment credentials. A compromised CI/CD system can give attackers access to your entire infrastructure. This section covers secret encryption at rest using AES-GCM, which provides both confidentiality and integrity. You should never store secrets in plaintext in the database. Instead, encrypt them before storage and decrypt them only when injecting them into a job's environment.

### Secret Encryption

Create `internal/crypto/encryption.go`:

```go
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
)

// Encryptor handles secret encryption/decryption
type Encryptor struct {
	key []byte
}

// NewEncryptor creates a new encryptor
func NewEncryptor(key string) (*Encryptor, error) {
	// Key should be 32 bytes for AES-256
	keyBytes := []byte(key)
	if len(keyBytes) != 32 {
		return nil, fmt.Errorf("encryption key must be 32 bytes")
	}

	return &Encryptor{key: keyBytes}, nil
}

// Encrypt encrypts plaintext using AES-256-GCM
func (e *Encryptor) Encrypt(plaintext string) (string, error) {
	block, err := aes.NewCipher(e.key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create gcm: %w", err)
	}

	// Create nonce
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}

	// Encrypt
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)

	// Encode to base64
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// Decrypt decrypts ciphertext using AES-256-GCM
func (e *Encryptor) Decrypt(ciphertext string) (string, error) {
	// Decode from base64
	data, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", fmt.Errorf("decode base64: %w", err)
	}

	block, err := aes.NewCipher(e.key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create gcm: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertextBytes := data[:nonceSize], data[nonceSize:]

	// Decrypt
	plaintext, err := gcm.Open(nil, nonce, ciphertextBytes, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}

	return string(plaintext), nil
}
```

### Container Sandboxing Key security measures for container execution:
1. **Resource Limits**: CPU, memory, disk I/O limits
2. **Network Isolation**: Separate Docker networks per job
3. **No Privileged Mode**: Never run containers with `--privileged`
4. **Read-Only Filesystem**: Mount sensitive directories as read-only
5. **User Namespaces**: Run containers as non-root users
6. **Seccomp Profiles**: Restrict system calls
7. **AppArmor/SELinux**: Mandatory access control Example secure container configuration:

```go
hostConfig := &container.HostConfig{
	Resources: container.Resources{
		Memory:     2 * 1024 * 1024 * 1024, // 2GB
		MemorySwap: 2 * 1024 * 1024 * 1024, // No swap
		NanoCPUs:   2 * 1000000000,         // 2 CPUs
		PidsLimit:  100,                    // Limit processes
	},
	SecurityOpt: []string{
		"no-new-privileges",
		"seccomp=default",
	},
	CapDrop: []string{"ALL"}, // Drop all capabilities
	CapAdd:  []string{"NET_BIND_SERVICE"}, // Add only what's needed
	ReadonlyRootfs: false, // Set to true for stricter security
	NetworkMode: "none",  // Or use custom network
}
```

---
