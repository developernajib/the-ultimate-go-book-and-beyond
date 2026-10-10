## 90I.5 LastPass - The Two-Stage Breach Through a Personal Plex Server (2022-2023)

### The Attack Timeline

The LastPass breach is remarkable not for its technical sophistication, but for its operational patience and the
extraordinary pivot point between the two attack phases. It demonstrates that even a security-focused company can
be compromised when the boundary between personal and corporate infrastructure becomes porous.

**Phase 1: Initial Breach (August 2022)**

On August 25, 2022, LastPass disclosed that an unauthorized party had accessed their development environment.
The attacker compromised a software engineer's corporate laptop through a vulnerable third-party software package,
gaining access to LastPass's source code repository and proprietary technical information. LastPass stated that
no customer data or encrypted vault data was accessed. They contained the breach, remediated the access vector,
and engaged Mandiant for forensic investigation.

What LastPass did not initially realize was that the attacker had obtained critical technical information during
this phase, including:
- Knowledge of the cloud storage architecture
- Access to cloud storage access keys and dual storage container decryption keys
- Understanding of the technical specification for accessing cloud backup storage

**Phase 2: The Plex Server Pivot (September-October 2022)**

The attacker identified that only four LastPass engineers had access to the decryption keys needed for the cloud
storage infrastructure containing encrypted vault backups. The attacker targeted one of these four engineers - a
senior DevOps engineer - through their home network.

The attack vector was extraordinary: the engineer was running an older, unpatched version of Plex Media Server on
their home computer. The attacker exploited CVE-2020-5741, a known Remote Code Execution vulnerability in Plex
that had been patched in May 2020 but which the engineer had not updated. Through the Plex exploit, the attacker
installed a keylogger on the engineer's personal computer.

When the engineer later authenticated to the LastPass corporate AWS environment from their personal computer (a
practice enabled by the company's remote work policies), the keylogger captured their master password and MFA
credentials. This gave the attacker access to the LastPass corporate vault and, critically, to the shared folders
containing the decryption keys for the cloud storage infrastructure.

**Phase 3: Vault Data Exfiltration (October-November 2022)**

Using the stolen decryption keys, the attacker accessed LastPass's AWS S3 buckets containing customer vault
backups. They copied:
- Encrypted customer vault data (URLs, usernames, encrypted passwords, secure notes, form-fill data)
- Unencrypted metadata including company names, end-user names, billing addresses, email addresses, telephone
  numbers, and IP addresses
- Customer vault backup snapshots

LastPass's second disclosure on December 22, 2022, revealed this second phase. A more detailed disclosure on
March 1, 2023, revealed the Plex server attack vector.

**The Ongoing Impact**

In 2023 and 2024, blockchain researchers at ZachXBT documented over $35 million in cryptocurrency stolen from
victims whose seed phrases were stored in LastPass vaults. The pattern was consistent: all victims were long-term
LastPass users who had stored cryptocurrency wallet recovery phrases in their vaults. The attackers were
systematically cracking the stolen vault data, focusing on vaults with weak master passwords.

### Technical Root Cause Analysis

1. **Personal device as corporate access point**: A personal computer with outdated software was used to access
   the most sensitive corporate infrastructure. No device posture verification existed.

2. **Shared static decryption keys**: Four engineers shared access to decryption keys that protected all customer
   data. These keys were stored in a corporate vault accessible from personal devices.

3. **Insufficient key derivation for weak master passwords**: While LastPass used PBKDF2-HMAC-SHA256, accounts
   created before 2018 used only 5,000 iterations (later increased to 100,100 for new accounts, then 600,000).
   This meant vaults with weak master passwords were crackable.

4. **Unencrypted vault metadata**: URLs, company names, and other metadata were stored unencrypted, providing
   attackers with targeting information even before cracking vault passwords.

### Go Code: Envelope Encryption with Key Hierarchy

Envelope encryption is the pattern that would have limited the LastPass breach's impact. Instead of a single
set of keys protecting all vault data, each vault gets its own data encryption key (DEK), and the DEKs are
encrypted with a key encryption key (KEK) that itself requires multiple factors to reconstruct:

```go
package envelope

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
)

// EncryptedBlob represents data encrypted with a specific key identifier,
// enabling key rotation without re-encrypting all data.
type EncryptedBlob struct {
	KeyID      string `json:"keyId"`
	Algorithm  string `json:"algorithm"`
	Nonce      []byte `json:"nonce"`
	Ciphertext []byte `json:"ciphertext"`
	CreatedAt  int64  `json:"createdAt"`
}

// DataEncryptionKey (DEK) is a per-record symmetric key used to encrypt
// the actual sensitive data. DEKs are never stored in plaintext - they
// are always encrypted by a KEK (wrapped).
type DataEncryptionKey struct {
	ID        string    `json:"id"`
	Key       []byte    `json:"-"` // Never serialized in plaintext.
	CreatedAt time.Time `json:"createdAt"`
	RotatedAt time.Time `json:"rotatedAt,omitempty"`
}

// WrappedDEK is a DEK encrypted by a KEK, safe to store persistently.
type WrappedDEK struct {
	DEKID     string        `json:"dekId"`
	KEKID     string        `json:"kekId"`
	Wrapped   EncryptedBlob `json:"wrapped"`
	CreatedAt time.Time     `json:"createdAt"`
}

// KeyEncryptionKey (KEK) is derived from multiple inputs and used only to
// encrypt/decrypt DEKs - never to encrypt user data directly.
type KeyEncryptionKey struct {
	ID  string
	Key []byte
}

// DeriveKEK derives a Key Encryption Key from a user's master password and a
// server-side secret using Argon2id. This two-factor derivation means that
// stealing either the vault backup OR the server-side secret is insufficient
// to decrypt data - an attacker needs both.
func DeriveKEK(
	masterPassword []byte,
	serverSecret []byte,
	salt []byte,
	kekID string,
) (*KeyEncryptionKey, error) {
	if len(masterPassword) == 0 {
		return nil, errors.New("master password cannot be empty")
	}
	if len(serverSecret) == 0 {
		return nil, errors.New("server secret cannot be empty")
	}
	if len(salt) < 16 {
		return nil, errors.New("salt must be at least 16 bytes")
	}

	// Combine master password and server secret so both are required.
	combined := make([]byte, len(masterPassword)+len(serverSecret))
	copy(combined, masterPassword)
	copy(combined[len(masterPassword):], serverSecret)
	defer clearBytes(combined)

	// Argon2id with strong parameters: 64MB memory, 3 iterations, 4 threads.
	key := argon2.IDKey(combined, salt, 3, 64*1024, 4, 32)

	return &KeyEncryptionKey{
		ID:  kekID,
		Key: key,
	}, nil
}

// GenerateDEK creates a new random Data Encryption Key.
func GenerateDEK(id string) (*DataEncryptionKey, error) {
	key := make([]byte, 32) // 256-bit key for AES-256 or XChaCha20.
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, fmt.Errorf("generating DEK: %w", err)
	}

	return &DataEncryptionKey{
		ID:        id,
		Key:       key,
		CreatedAt: time.Now(),
	}, nil
}

// WrapDEK encrypts a DEK with a KEK, producing a WrappedDEK safe for storage.
func WrapDEK(dek *DataEncryptionKey, kek *KeyEncryptionKey) (*WrappedDEK, error) {
	encrypted, err := encryptAESGCM(kek.Key, dek.Key, kek.ID)
	if err != nil {
		return nil, fmt.Errorf("wrapping DEK: %w", err)
	}

	return &WrappedDEK{
		DEKID:     dek.ID,
		KEKID:     kek.ID,
		Wrapped:   *encrypted,
		CreatedAt: time.Now(),
	}, nil
}

// UnwrapDEK decrypts a WrappedDEK using the KEK, recovering the plaintext DEK.
func UnwrapDEK(wrapped *WrappedDEK, kek *KeyEncryptionKey) (*DataEncryptionKey, error) {
	if wrapped.KEKID != kek.ID {
		return nil, fmt.Errorf(
			"KEK ID mismatch: wrapped expects %s, provided %s",
			wrapped.KEKID, kek.ID,
		)
	}

	keyBytes, err := decryptAESGCM(kek.Key, &wrapped.Wrapped)
	if err != nil {
		return nil, fmt.Errorf("unwrapping DEK: %w", err)
	}

	return &DataEncryptionKey{
		ID:        wrapped.DEKID,
		Key:       keyBytes,
		CreatedAt: wrapped.CreatedAt,
	}, nil
}

// EncryptData encrypts plaintext data using a DEK. Each record gets its own
// DEK, so compromising one record's key does not expose other records.
func EncryptData(plaintext []byte, dek *DataEncryptionKey) (*EncryptedBlob, error) {
	return encryptXChaCha20(dek.Key, plaintext, dek.ID)
}

// DecryptData decrypts an EncryptedBlob using the appropriate DEK.
func DecryptData(blob *EncryptedBlob, dek *DataEncryptionKey) ([]byte, error) {
	if blob.KeyID != dek.ID {
		return nil, fmt.Errorf(
			"DEK ID mismatch: blob expects %s, provided %s",
			blob.KeyID, dek.ID,
		)
	}

	switch blob.Algorithm {
	case "xchacha20-poly1305":
		return decryptXChaCha20(dek.Key, blob)
	case "aes-256-gcm":
		return decryptAESGCM(dek.Key, blob)
	default:
		return nil, fmt.Errorf("unsupported algorithm: %s", blob.Algorithm)
	}
}

func encryptAESGCM(key, plaintext []byte, keyID string) (*EncryptedBlob, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)

	return &EncryptedBlob{
		KeyID:      keyID,
		Algorithm:  "aes-256-gcm",
		Nonce:      nonce,
		Ciphertext: ciphertext,
		CreatedAt:  time.Now().Unix(),
	}, nil
}

func decryptAESGCM(key []byte, blob *EncryptedBlob) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	return gcm.Open(nil, blob.Nonce, blob.Ciphertext, nil)
}

func encryptXChaCha20(key, plaintext []byte, keyID string) (*EncryptedBlob, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	ciphertext := aead.Seal(nil, nonce, plaintext, nil)

	return &EncryptedBlob{
		KeyID:      keyID,
		Algorithm:  "xchacha20-poly1305",
		Nonce:      nonce,
		Ciphertext: ciphertext,
		CreatedAt:  time.Now().Unix(),
	}, nil
}

func decryptXChaCha20(key []byte, blob *EncryptedBlob) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}

	return aead.Open(nil, blob.Nonce, blob.Ciphertext, nil)
}

// clearBytes zeroes a byte slice to prevent key material from lingering in memory.
func clearBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// VaultEntry demonstrates the full envelope encryption flow for a single
// vault record, showing how each entry gets independent encryption.
type VaultEntry struct {
	ID           string        `json:"id"`
	WrappedDEK   WrappedDEK    `json:"wrappedDek"`
	EncryptedURL EncryptedBlob `json:"encryptedUrl"`  // Metadata is also encrypted.
	EncryptedUser EncryptedBlob `json:"encryptedUser"`
	EncryptedPass EncryptedBlob `json:"encryptedPass"`
	EncryptedNotes EncryptedBlob `json:"encryptedNotes"`
}

// CreateVaultEntry encrypts all fields of a vault entry using a fresh DEK,
// then wraps the DEK with the user's KEK.
func CreateVaultEntry(
	id string,
	url, username, password, notes []byte,
	kek *KeyEncryptionKey,
) (*VaultEntry, error) {
	dek, err := GenerateDEK(fmt.Sprintf("dek-%s-%d", id, time.Now().UnixNano()))
	if err != nil {
		return nil, err
	}
	defer clearBytes(dek.Key)

	wrapped, err := WrapDEK(dek, kek)
	if err != nil {
		return nil, err
	}

	encURL, err := EncryptData(url, dek)
	if err != nil {
		return nil, err
	}
	encUser, err := EncryptData(username, dek)
	if err != nil {
		return nil, err
	}
	encPass, err := EncryptData(password, dek)
	if err != nil {
		return nil, err
	}
	encNotes, err := EncryptData(notes, dek)
	if err != nil {
		return nil, err
	}

	return &VaultEntry{
		ID:             id,
		WrappedDEK:     *wrapped,
		EncryptedURL:   *encURL,
		EncryptedUser:  *encUser,
		EncryptedPass:  *encPass,
		EncryptedNotes: *encNotes,
	}, nil
}

// DecryptVaultEntry recovers all fields of a vault entry using the user's KEK.
func DecryptVaultEntry(entry *VaultEntry, kek *KeyEncryptionKey) (
	url, username, password, notes []byte, err error,
) {
	dek, err := UnwrapDEK(&entry.WrappedDEK, kek)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("unwrapping DEK: %w", err)
	}
	defer clearBytes(dek.Key)

	url, err = DecryptData(&entry.EncryptedURL, dek)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("decrypting URL: %w", err)
	}
	username, err = DecryptData(&entry.EncryptedUser, dek)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("decrypting username: %w", err)
	}
	password, err = DecryptData(&entry.EncryptedPass, dek)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("decrypting password: %w", err)
	}
	notes, err = DecryptData(&entry.EncryptedNotes, dek)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("decrypting notes: %w", err)
	}

	return url, username, password, notes, nil
}

// SerializeVaultEntry produces a JSON representation safe for storage.
// All sensitive data is already encrypted - only EncryptedBlobs are serialized.
func SerializeVaultEntry(entry *VaultEntry) ([]byte, error) {
	return json.Marshal(entry)
}
```

### Engineering Lessons

1. **Personal devices must never access critical infrastructure without device posture verification.** The
   unpatched Plex server was the pivot point. Zero-trust network access (ZTNA) with device health attestation
   would have prevented the second phase entirely.

2. **Encrypt everything, including metadata.** LastPass stored URLs in plaintext, which gave attackers targeting
   information. The envelope encryption pattern above encrypts every field, including metadata.

3. **Key derivation must use modern parameters.** PBKDF2 with 5,000 iterations was inadequate in 2022. Use
   Argon2id with memory-hard parameters that make GPU-based cracking economically infeasible.

4. **Limit the blast radius of any single compromise.** Per-record DEKs mean that cracking one entry's key does
   not help crack any other entry. The KEK/DEK hierarchy creates layered defense.

---

### Junior → FAANG: Envelope Encryption and Zero-Trust Device Access as Interview Topics

The LastPass breach is the interview answer to "how do you design an encryption architecture that limits blast radius?" LastPass stored vault URLs in plaintext and used weak PBKDF2 key derivation, so when the vault backup was stolen, attackers could target high-value accounts first and crack passwords with GPU acceleration. The `VaultEntry` implementation in this section demonstrates envelope encryption: each record has a unique DEK (data encryption key), the DEK is wrapped with the user's KEK (key encryption key) derived from their master password using Argon2id, and all fields including metadata are encrypted. Cracking one record's DEK does not help crack any other. For FAANG interviews, the key derivation question is specific: know the difference between PBKDF2 (iteration-based, parallelizable on GPUs) and Argon2id (memory-hard, resistant to GPU acceleration) and why the latter is the current standard for password-based key derivation.

### Senior @ FAANG: Personal Device Security and Zero-Trust Network Access as Platform Standards

At L6, the LastPass breach reveals that personal devices accessing production infrastructure are a significant attack surface that most organizations under-govern. The attacker pivoted from a DevOps engineer's personal Plex server (running on his home network, unpatched) to LastPass's production environment. The staff-level response is a Zero-Trust Network Access policy with device posture verification: no device accesses production resources without attestation that it is enrolled in device management, running a supported OS version, has disk encryption enabled, and has no high-severity CVEs in its patch status. This policy applies to personal devices accessing production through VPN as strictly as it applies to corporate-issued devices. The technology investment is a device health attestation service (Google BeyondCorp, Okta Device Trust, or equivalent) integrated with your VPN and production access controls. At staff level, you define the device posture requirements, enforce them at the network access layer rather than relying on policy acknowledgments, and audit compliance quarterly. The LastPass breach could have been stopped at the network layer if the home network device had been required to pass posture checks before accessing production Kubernetes clusters.

