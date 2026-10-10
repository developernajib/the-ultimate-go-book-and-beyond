## 109.6 Secret Rotation Patterns

Automatic rotation minimizes the impact of secret compromise.

### Rotation Strategy

The `SecretRotator` below generates a new secret on a fixed interval, writes it to the secret store, and updates an in-memory copy guarded by a mutex, so callers always read the current value through `GetCurrent`. A production rotation coordinator adds two things this minimal version omits. First, an overlap window between provisioning the new credential and revoking the old one: it must be long enough for all running service instances to reload the new credential before the old one becomes invalid. Second, durable per-phase state (initiated, new credential provisioned, services notified, old credential revoked), so a crash during rotation resumes from the correct phase rather than restarting from scratch. Notifying dependent services via an event rather than a direct RPC call means the coordinator does not need to know which services depend on the secret and does not block waiting for slow or offline services.

```go
// pkg/rotation/rotator.go
package rotation

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// SecretProvider defines interface for secret providers
type SecretProvider interface {
    GetSecret(ctx context.Context, name string) (string, error)
    UpdateSecret(ctx context.Context, name, value string) error
}

// SecretRotator handles automatic secret rotation
type SecretRotator struct {
    provider      SecretProvider
    secretName    string
    rotationInterval time.Duration
    generator     func() (string, error)
    stopCh        chan struct{}
    mu            sync.RWMutex
    currentSecret string
}

// NewSecretRotator creates a new secret rotator
func NewSecretRotator(provider SecretProvider, secretName string, interval time.Duration, generator func() (string, error)) *SecretRotator {
    return &SecretRotator{
        provider:         provider,
        secretName:       secretName,
        rotationInterval: interval,
        generator:        generator,
        stopCh:           make(chan struct{}),
    }
}

// Start begins automatic rotation
func (r *SecretRotator) Start(ctx context.Context) error {
    // Load initial secret
    secret, err := r.provider.GetSecret(ctx, r.secretName)
    if err != nil {
        return fmt.Errorf("failed to load initial secret: %w", err)
    }

    r.mu.Lock()
    r.currentSecret = secret
    r.mu.Unlock()

    go r.rotationLoop(ctx)

    return nil
}

// Stop stops rotation
func (r *SecretRotator) Stop() {
    close(r.stopCh)
}

// GetCurrent returns the current secret value
func (r *SecretRotator) GetCurrent() string {
    r.mu.RLock()
    defer r.mu.RUnlock()
    return r.currentSecret
}

// rotationLoop performs periodic rotation
func (r *SecretRotator) rotationLoop(ctx context.Context) {
    ticker := time.NewTicker(r.rotationInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            if err := r.rotate(ctx); err != nil {
                fmt.Printf("error: rotation failed: %v\n", err)
                // In production, trigger alerts
            }
        case <-r.stopCh:
            return
        }
    }
}

// rotate performs a single rotation
func (r *SecretRotator) rotate(ctx context.Context) error {
    // Generate new secret
    newSecret, err := r.generator()
    if err != nil {
        return fmt.Errorf("failed to generate new secret: %w", err)
    }

    // Update in secret store
    if err := r.provider.UpdateSecret(ctx, r.secretName, newSecret); err != nil {
        return fmt.Errorf("failed to update secret: %w", err)
    }

    // Update local cache
    r.mu.Lock()
    r.currentSecret = newSecret
    r.mu.Unlock()

    fmt.Printf("info: rotated secret %s\n", r.secretName)
    return nil
}
```

### Junior → FAANG: Designing Services to Support Rotation

The most common gap in junior secret rotation implementations is building services that require a restart to pick up rotated secrets. This makes rotation operationally expensive and therefore infrequent, which increases the exposure window when a secret is compromised.

**Gap to close:** Understand the in-memory cache with TTL pattern: fetch the secret at startup, cache it with a TTL slightly shorter than the rotation period, refresh it in the background before the TTL expires. The service never restarts to pick up a new secret. Implement this pattern for every secret your service uses, even if the rotation period is long.

**Common mistake:** Using a global variable for the secret value and reading it once at startup. If the secret is rotated, the global still holds the old value and the service fails when the old secret is revoked. Use a struct with a mutex and a refresh goroutine instead. The code in this section demonstrates this pattern.

**Interview framing:** When asked "how do you rotate a database password with zero downtime?", describe: (1) create the new password in the database, (2) update the secret in the secrets manager with both old and new password (or use a versioning scheme), (3) services pick up the new password via their cache refresh cycle, (4) after all services have refreshed (configurable grace period), revoke the old password from the database. This two-version approach avoids the window where the secret has been rotated in the manager but not yet picked up by the service.

### Senior @ FAANG: Rotation as a First-Class Engineering Requirement

At senior level, rotation is a first-class requirement, not an afterthought. Services that cannot support rotation without downtime are flagged in design review and required to be redesigned before shipping.

**Design review gate:** Include rotation compatibility as an explicit question in design review: "How does this service pick up a rotated secret without restarting?" If the answer is "it restarts," that is a finding that requires a design change. Document the rotation compatibility requirement in your service template and flag services that do not meet it in your secrets hygiene metrics.

**Rotation frequency policy:** Define rotation frequencies per secret type based on sensitivity and operational cost. Database credentials: 30 days (Vault dynamic secrets: every connection lifetime). API keys: 90 days. TLS certificates: certificate lifetime (typically 90 days for Let's Encrypt, shorter for internal CA). Root signing keys: annually. Shorter rotation periods reduce the exposure window for compromised secrets. Document the policy and the rationale for each period.

**Testing rotation:** Rotation must be tested in staging before being enabled in production. The rotation test procedure should simulate the full rotation lifecycle: trigger rotation, verify the service continues to serve traffic (no 5xx errors during rotation), verify the old secret is revoked after the grace period, verify the service is using the new secret. Automate this test as part of your reliability testing suite. If rotation has never been tested, assume it does not work correctly.

**Emergency rotation runbook:** For suspected compromise, rotation must happen faster than the normal schedule. The emergency rotation runbook specifies: who has the authority to trigger emergency rotation, how to initiate it in each secrets manager, how to verify that the compromised secret has been revoked, and how to notify dependent services that rotation has occurred so they can force a cache refresh immediately rather than waiting for the TTL. The runbook is tested annually.

---