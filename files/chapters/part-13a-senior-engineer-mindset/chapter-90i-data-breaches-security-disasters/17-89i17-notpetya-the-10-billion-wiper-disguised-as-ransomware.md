## 90I.17 NotPetya: The $10 Billion Wiper Disguised as Ransomware

### The Supply Chain: M.E.Doc

NotPetya, unleashed on June 27, 2017, was not ransomware - it was a weapon of economic destruction disguised as
ransomware. The attack began through M.E.Doc, a Ukrainian tax accounting software used by virtually every company
doing business in Ukraine. Attackers - later identified as Russian GRU Unit 74455 ("Sandworm") - compromised the
M.E.Doc update server and pushed a malicious update to all users.

The supply chain compromise was surgical. The attackers modified a single DLL in the M.E.Doc update package,
`ZvitPublishedObjects.dll`, adding a backdoor that communicated with the command-and-control infrastructure using
the software's own legitimate update protocol. The poisoned update was signed with M.E.Doc's valid code signing
certificate, making it indistinguishable from a legitimate update.

### The Weapon: EternalBlue + Mimikatz + Credential Harvesting

Unlike WannaCry's blunt-force approach, NotPetya combined multiple propagation mechanisms:

1. **EternalBlue** - The same SMBv1 exploit, for unpatched systems
2. **EternalRomance** - A second SMB exploit from the Shadow Brokers leak
3. **Mimikatz-style credential harvesting** - NotPetya extracted Windows credentials from memory using techniques
   similar to the Mimikatz tool, then used those credentials to spread via legitimate Windows administration tools
   (WMI and PsExec)
4. **WMIC lateral movement** - Using harvested admin credentials to execute code on remote machines
5. **PsExec propagation** - Using stolen credentials to install itself on networked systems

This combination was devastating: even fully patched systems could be compromised if a single domain administrator
credential was harvested from an unpatched machine on the same network.

### The Destruction

NotPetya encrypted the Master Boot Record (MBR) and Master File Table (MFT) of infected systems using a Salsa20
stream cipher. Unlike real ransomware, the encryption key was generated randomly and never transmitted to the
attackers. The ransom demand was theater - there was no way to decrypt the data even if the ransom was paid. The
payment email address was hosted on a German email provider (Posteo) who immediately shut it down, confirming that
recovery was never the intent.

### Maersk: 49,000 Devices in 10 Days

The shipping giant Maersk was among the hardest hit. NotPetya destroyed 49,000 laptops, 4,000 servers, and 2,500
applications across 600 sites in 130 countries. The company was reduced to operating manually, with employees using
personal phones and WhatsApp to coordinate the movement of shipping containers.

Maersk's Active Directory infrastructure was completely destroyed - every domain controller was wiped. The company
was saved by a single domain controller in its Ghana office that had been offline during the attack due to a power
outage. This lone surviving domain controller allowed Maersk to rebuild its entire Windows infrastructure. Without
it, they would have had to rebuild from scratch - a process that could have taken months rather than the ten days
it actually required. Maersk estimated the total cost at $250-300 million.

### Go Code: Software Update Integrity Verification

The M.E.Doc attack worked because the update client trusted anything signed with the vendor's certificate, and the attackers had access to that certificate. The verifier below breaks this assumption by pinning Ed25519 public keys at compile time inside the client binary, completely decoupled from the update server. Even if an attacker compromises the update server and re-signs a malicious package with a stolen key, the embedded public key will not match and `VerifyManifest` will reject the update before a single file is written to disk.

```go
package updateverify

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"
)

// UpdateManifest describes a software update with cryptographic integrity guarantees.
type UpdateManifest struct {
	Version     string      `json:"version"`
	ReleaseDate time.Time   `json:"release_date"`
	Files       []FileEntry `json:"files"`
	Signature   string      `json:"signature"` // Ed25519 signature over canonical JSON of Files
	PublisherID string      `json:"publisher_id"`
}

// FileEntry describes a single file in the update with its expected hash.
type FileEntry struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// IntegrityVerifier validates software update authenticity and integrity.
// This prevents NotPetya-style attacks where a malicious update is pushed through
// a compromised update server.
type IntegrityVerifier struct {
	logger      *slog.Logger
	trustedKeys map[string]ed25519.PublicKey // publisherID -> public key
}

// NewIntegrityVerifier creates a verifier with pinned publisher public keys.
// Keys are embedded at build time, NOT fetched from the update server.
// This is critical: if the update server is compromised (as in NotPetya),
// keys fetched from it cannot be trusted.
func NewIntegrityVerifier(logger *slog.Logger, trustedKeys map[string]ed25519.PublicKey) *IntegrityVerifier {
	return &IntegrityVerifier{
		logger:      logger,
		trustedKeys: trustedKeys,
	}
}

// VerifyManifest checks that the manifest is signed by a trusted publisher.
func (v *IntegrityVerifier) VerifyManifest(manifest *UpdateManifest) error {
	pubKey, ok := v.trustedKeys[manifest.PublisherID]
	if !ok {
		return fmt.Errorf("unknown publisher: %s", manifest.PublisherID)
	}

	// Compute canonical representation for signature verification
	// Only sign the files list - not the signature field itself
	canonical, err := json.Marshal(manifest.Files)
	if err != nil {
		return fmt.Errorf("failed to marshal files for verification: %w", err)
	}

	sigBytes, err := hex.DecodeString(manifest.Signature)
	if err != nil {
		return fmt.Errorf("invalid signature encoding: %w", err)
	}

	if !ed25519.Verify(pubKey, canonical, sigBytes) {
		v.logger.Error("UPDATE SIGNATURE VERIFICATION FAILED",
			"publisher", manifest.PublisherID,
			"version", manifest.Version,
		)
		return errors.New("signature verification failed - update may be compromised")
	}

	v.logger.Info("Update signature verified",
		"publisher", manifest.PublisherID,
		"version", manifest.Version,
		"files", len(manifest.Files),
	)
	return nil
}

// VerifyFile checks that a downloaded file matches the expected hash from the manifest.
func (v *IntegrityVerifier) VerifyFile(ctx context.Context, filePath string, expected FileEntry) error {
	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("failed to open file: %w", err)
	}
	defer f.Close()

	// Verify size first (fast check)
	stat, err := f.Stat()
	if err != nil {
		return fmt.Errorf("failed to stat file: %w", err)
	}
	if stat.Size() != expected.Size {
		return fmt.Errorf("size mismatch: got %d, expected %d", stat.Size(), expected.Size)
	}

	// Compute SHA-256 hash
	hasher := sha256.New()
	if _, err := io.Copy(hasher, f); err != nil {
		return fmt.Errorf("failed to hash file: %w", err)
	}

	actualHash := hex.EncodeToString(hasher.Sum(nil))
	if actualHash != expected.SHA256 {
		v.logger.Error("FILE INTEGRITY CHECK FAILED",
			"file", filePath,
			"expected_hash", expected.SHA256,
			"actual_hash", actualHash,
		)
		return fmt.Errorf("hash mismatch for %s: possible supply chain compromise", filePath)
	}

	v.logger.Info("File integrity verified",
		"file", filePath,
		"sha256", actualHash,
	)
	return nil
}

// VerifyUpdate performs complete validation of an update package.
func (v *IntegrityVerifier) VerifyUpdate(ctx context.Context, manifest *UpdateManifest, downloadDir string) error {
	// Step 1: Verify the manifest signature
	if err := v.VerifyManifest(manifest); err != nil {
		return fmt.Errorf("manifest verification failed: %w", err)
	}

	// Step 2: Verify each file's integrity
	for _, entry := range manifest.Files {
		filePath := downloadDir + "/" + entry.Path
		if err := v.VerifyFile(ctx, filePath, entry); err != nil {
			return fmt.Errorf("file verification failed: %w", err)
		}
	}

	v.logger.Info("Complete update verification passed",
		"version", manifest.Version,
		"files_verified", len(manifest.Files),
	)
	return nil
}
```

### Lessons for Go Engineers

1. **Supply chain attacks bypass all perimeter defenses** - NotPetya entered through a legitimate, signed software
   update. Pin signing keys at build time. Never fetch them from the same server that delivers updates.
2. **Credential harvesting turns one breach into total compromise** - A single harvested domain admin credential
   allowed NotPetya to spread to fully patched systems. Implement tiered administration with separate credentials
   for different security zones.
3. **Offline backups saved Maersk** - The Ghana domain controller survived because it was offline. Your disaster
   recovery plan must include air-gapped or immutable backups that cannot be reached by network-propagating malware.
4. **"Ransomware" may be destruction in disguise** - NotPetya proves that payment guarantees nothing. Design your
   recovery procedures assuming the data is gone, not encrypted.

---

### Junior → FAANG: Software Update Integrity and Air-Gapped Backups as Interview Topics

NotPetya is the interview answer to "how do you secure your software update pipeline against supply chain attacks?" The NotPetya infection vector was a backdoored update to M.E.Doc, a Ukrainian accounting software. Any system running M.E.Doc that accepted the compromised update became patient zero for one of the most destructive cyberattacks in history. For FAANG interviews, the update integrity answer combines two mechanisms: signed updates with a signing key that is not stored on the update server (so that compromising the update server does not allow signing malicious updates), and hash pinning at build time (the expected hash of each update is embedded in the client and verified before installation). The Maersk recovery story (one offline domain controller in Ghana rebuilt the entire global directory) is the interview answer to "why must disaster recovery plans include offline, air-gapped backups?" The backup that saved Maersk was offline not because of good planning but by accident: Ghana experienced a power outage at the critical moment. Plan the accident on purpose.

### Senior @ FAANG: Tiered Administration and Immutable Backup Architecture as Platform Standards

At L6, NotPetya's propagation via harvested domain admin credentials reveals a credential architecture failure. A single domain admin credential, once harvested by Mimikatz from memory, provided lateral movement across the entire domain, including systems that were fully patched against EternalBlue. Tiered administration prevents this: Tier 0 (domain controllers and identity infrastructure) uses credentials that are never used on Tier 1 or Tier 2 systems. Tier 1 (servers) uses credentials that are never used on Tier 2 (workstations). An attacker who compromises a workstation and harvests credentials from memory only gets credentials valid for that tier. At platform level, tiered administration requires an identity architecture investment: separate accounts for each tier, PAM (privileged access management) tools that enforce the tier boundaries, and session recording for all privileged access. The second platform investment is immutable backup architecture: write-once storage (S3 Object Lock, Azure Immutable Blob Storage) that cannot be deleted or modified by any account in the production network, with offline copies replicated off-site on a schedule that matches your RPO. NotPetya proved that ransomware recovery depends entirely on having backups that the ransomware cannot reach.

