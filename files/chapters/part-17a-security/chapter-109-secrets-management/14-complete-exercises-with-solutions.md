## 109.14 Complete Exercises with Solutions

### Exercise 1: Multi-Cloud Secrets Provider

**Problem**: Build a secrets provider that abstracts AWS Secrets Manager, GCP Secret Manager, and HashiCorp Vault behind a common interface.

**Solution**:

```go
// pkg/secrets/provider.go
package secrets

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "os"
    "strconv"
    "sync"
    "time"

    "cloud.google.com/go/secretmanager/apiv1"
    "cloud.google.com/go/secretmanager/apiv1/secretmanagerpb"
    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/secretsmanager"
    vault "github.com/hashicorp/vault/api"
)

// Provider defines the interface for secret providers
type Provider interface {
    GetSecret(ctx context.Context, name string) (string, error)
    GetSecretWithVersion(ctx context.Context, name, version string) (string, error)
    Close() error
}

// ProviderType identifies the secret provider
type ProviderType string

const (
    ProviderAWS   ProviderType = "aws"
    ProviderGCP   ProviderType = "gcp"
    ProviderVault ProviderType = "vault"
)

// Config holds provider configuration
type Config struct {
    Provider   ProviderType
    AWSRegion  string
    GCPProject string
    VaultAddr  string
    VaultToken string
}

// NewProvider creates a provider based on configuration
func NewProvider(ctx context.Context, cfg Config) (Provider, error) {
    switch cfg.Provider {
    case ProviderAWS:
        return NewAWSProvider(ctx, cfg.AWSRegion)
    case ProviderGCP:
        return NewGCPProvider(ctx, cfg.GCPProject)
    case ProviderVault:
        return NewVaultProvider(cfg.VaultAddr, cfg.VaultToken)
    default:
        return nil, fmt.Errorf("unknown provider type: %s", cfg.Provider)
    }
}

// NewProviderFromEnv creates a provider from environment variables
func NewProviderFromEnv(ctx context.Context) (Provider, error) {
    providerType := ProviderType(os.Getenv("SECRETS_PROVIDER"))

    switch providerType {
    case ProviderAWS:
        return NewAWSProvider(ctx, os.Getenv("AWS_REGION"))
    case ProviderGCP:
        return NewGCPProvider(ctx, os.Getenv("GCP_PROJECT"))
    case ProviderVault:
        return NewVaultProvider(
            os.Getenv("VAULT_ADDR"),
            os.Getenv("VAULT_TOKEN"),
        )
    default:
        return nil, fmt.Errorf("SECRETS_PROVIDER not set or invalid")
    }
}

// AWSProvider implements Provider for AWS Secrets Manager
type AWSProvider struct {
    client *secretsmanager.Client
}

func NewAWSProvider(ctx context.Context, region string) (*AWSProvider, error) {
    cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
    if err != nil {
        return nil, fmt.Errorf("failed to load AWS config: %w", err)
    }

    return &AWSProvider{
        client: secretsmanager.NewFromConfig(cfg),
    }, nil
}

func (p *AWSProvider) GetSecret(ctx context.Context, name string) (string, error) {
    return p.GetSecretWithVersion(ctx, name, "AWSCURRENT")
}

func (p *AWSProvider) GetSecretWithVersion(ctx context.Context, name, version string) (string, error) {
    input := &secretsmanager.GetSecretValueInput{
        SecretId:     aws.String(name),
        VersionStage: aws.String(version),
    }

    result, err := p.client.GetSecretValue(ctx, input)
    if err != nil {
        return "", fmt.Errorf("failed to get secret %s: %w", name, err)
    }

    if result.SecretString == nil {
        return "", fmt.Errorf("secret %s has no string value", name)
    }

    return *result.SecretString, nil
}

func (p *AWSProvider) Close() error {
    return nil // AWS SDK handles cleanup
}

// GCPProvider implements Provider for GCP Secret Manager
type GCPProvider struct {
    client    *secretmanager.Client
    projectID string
}

func NewGCPProvider(ctx context.Context, projectID string) (*GCPProvider, error) {
    client, err := secretmanager.NewClient(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to create GCP client: %w", err)
    }

    return &GCPProvider{
        client:    client,
        projectID: projectID,
    }, nil
}

func (p *GCPProvider) GetSecret(ctx context.Context, name string) (string, error) {
    return p.GetSecretWithVersion(ctx, name, "latest")
}

func (p *GCPProvider) GetSecretWithVersion(ctx context.Context, name, version string) (string, error) {
    secretName := fmt.Sprintf("projects/%s/secrets/%s/versions/%s",
        p.projectID, name, version)

    req := &secretmanagerpb.AccessSecretVersionRequest{
        Name: secretName,
    }

    result, err := p.client.AccessSecretVersion(ctx, req)
    if err != nil {
        return "", fmt.Errorf("failed to access secret %s: %w", name, err)
    }

    return string(result.Payload.Data), nil
}

func (p *GCPProvider) Close() error {
    return p.client.Close()
}

// VaultProvider implements Provider for HashiCorp Vault
type VaultProvider struct {
    client *vault.Client
}

func NewVaultProvider(addr, token string) (*VaultProvider, error) {
    config := vault.DefaultConfig()
    config.Address = addr

    client, err := vault.NewClient(config)
    if err != nil {
        return nil, fmt.Errorf("failed to create Vault client: %w", err)
    }

    client.SetToken(token)

    return &VaultProvider{
        client: client,
    }, nil
}

func (p *VaultProvider) GetSecret(ctx context.Context, name string) (string, error) {
    secret, err := p.client.KVv2("secret").Get(ctx, name)
    if err != nil {
        return "", fmt.Errorf("failed to get secret %s: %w", name, err)
    }

    // Assume secret is stored as JSON
    data, err := json.Marshal(secret.Data)
    if err != nil {
        return "", fmt.Errorf("failed to marshal secret data: %w", err)
    }

    return string(data), nil
}

func (p *VaultProvider) GetSecretWithVersion(ctx context.Context, name, version string) (string, error) {
    v, err := strconv.Atoi(version)
    if err != nil {
        return "", fmt.Errorf("invalid version %q: %w", version, err)
    }

    secret, err := p.client.KVv2("secret").GetVersion(ctx, name, v)
    if err != nil {
        return "", fmt.Errorf("failed to get secret %s: %w", name, err)
    }

    data, err := json.Marshal(secret.Data)
    if err != nil {
        return "", fmt.Errorf("failed to marshal secret data: %w", err)
    }

    return string(data), nil
}

func (p *VaultProvider) Close() error {
    return nil // Vault client doesn't require explicit cleanup
}

// CachedProvider wraps a Provider with caching
type CachedProvider struct {
    provider Provider
    cache    sync.Map
    ttl      time.Duration
}

type cachedSecret struct {
    value     string
    expiresAt time.Time
}

func NewCachedProvider(provider Provider, ttl time.Duration) *CachedProvider {
    return &CachedProvider{
        provider: provider,
        ttl:      ttl,
    }
}

func (p *CachedProvider) GetSecret(ctx context.Context, name string) (string, error) {
    // Check cache
    if cached, ok := p.cache.Load(name); ok {
        cs := cached.(*cachedSecret)
        if time.Now().Before(cs.expiresAt) {
            return cs.value, nil
        }
        p.cache.Delete(name)
    }

    // Fetch from provider
    value, err := p.provider.GetSecret(ctx, name)
    if err != nil {
        return "", err
    }

    // Cache result
    p.cache.Store(name, &cachedSecret{
        value:     value,
        expiresAt: time.Now().Add(p.ttl),
    })

    return value, nil
}

func (p *CachedProvider) GetSecretWithVersion(ctx context.Context, name, version string) (string, error) {
    key := fmt.Sprintf("%s@%s", name, version)

    if cached, ok := p.cache.Load(key); ok {
        cs := cached.(*cachedSecret)
        if time.Now().Before(cs.expiresAt) {
            return cs.value, nil
        }
        p.cache.Delete(key)
    }

    value, err := p.provider.GetSecretWithVersion(ctx, name, version)
    if err != nil {
        return "", err
    }

    p.cache.Store(key, &cachedSecret{
        value:     value,
        expiresAt: time.Now().Add(p.ttl),
    })

    return value, nil
}

func (p *CachedProvider) Close() error {
    return p.provider.Close()
}

// Example usage
func Example() {
    ctx := context.Background()

    // Create provider from environment
    provider, err := NewProviderFromEnv(ctx)
    if err != nil {
        log.Fatal(err)
    }
    defer provider.Close()

    // Wrap with caching
    cachedProvider := NewCachedProvider(provider, 5*time.Minute)

    // Get secret
    dbPassword, err := cachedProvider.GetSecret(ctx, "database/production")
    if err != nil {
        log.Fatal(err)
    }

    fmt.Printf("Got secret: %s...\n", dbPassword[:4])
}
```

**Key Implementation Points**:
- Common interface for all providers
- Factory pattern for provider creation
- Environment-based configuration
- TTL-based caching layer
- Version support for all providers

---

### Exercise 2: Secret Rotation Webhook Handler

**Problem**: Build a webhook handler that receives rotation notifications and updates application secrets without restart.

**Solution**:

```go
// pkg/rotation/webhook.go
package rotation

import (
    "context"
    "crypto/hmac"
    "crypto/sha256"
    "database/sql"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "io"
    "log"
    "net/http"
    "sync"
    "time"

    _ "github.com/lib/pq"
)

// Provider and DBCredentials are the secrets provider interface and
// credential struct from Exercise 1.
type Provider interface {
    GetSecret(ctx context.Context, name string) (string, error)
    GetSecretWithVersion(ctx context.Context, name, version string) (string, error)
    Close() error
}

func NewProviderFromEnv(ctx context.Context) (Provider, error) {
    return nil, nil
}

type DBCredentials struct {
    Username string `json:"username"`
    Password string `json:"password"`
}

// RotationEvent represents a secret rotation notification
type RotationEvent struct {
    SecretName    string    `json:"secret_name"`
    Version       string    `json:"version"`
    RotatedAt     time.Time `json:"rotated_at"`
    ExpiresAt     time.Time `json:"expires_at"`
    Source        string    `json:"source"` // vault, aws, gcp
}

// SecretReloader handles secret refresh on rotation
type SecretReloader interface {
    Reload(ctx context.Context, secretName string) error
}

// RotationWebhook handles rotation webhook notifications
type RotationWebhook struct {
    webhookSecret string
    reloaders     map[string]SecretReloader
    mu            sync.RWMutex
    events        chan RotationEvent
    handlers      []RotationHandler
}

// RotationHandler is called when a secret is rotated
type RotationHandler func(ctx context.Context, event RotationEvent) error

// NewRotationWebhook creates a new webhook handler
func NewRotationWebhook(webhookSecret string) *RotationWebhook {
    rw := &RotationWebhook{
        webhookSecret: webhookSecret,
        reloaders:     make(map[string]SecretReloader),
        events:        make(chan RotationEvent, 100),
        handlers:      make([]RotationHandler, 0),
    }

    go rw.processEvents()

    return rw
}

// RegisterReloader registers a reloader for a specific secret
func (rw *RotationWebhook) RegisterReloader(secretPattern string, reloader SecretReloader) {
    rw.mu.Lock()
    defer rw.mu.Unlock()
    rw.reloaders[secretPattern] = reloader
}

// OnRotation registers a handler called on any rotation
func (rw *RotationWebhook) OnRotation(handler RotationHandler) {
    rw.mu.Lock()
    defer rw.mu.Unlock()
    rw.handlers = append(rw.handlers, handler)
}

// ServeHTTP handles incoming webhook requests
func (rw *RotationWebhook) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }

    // Read body
    body, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, "Failed to read body", http.StatusBadRequest)
        return
    }

    // Verify signature
    signature := r.Header.Get("X-Webhook-Signature")
    if !rw.verifySignature(body, signature) {
        http.Error(w, "Invalid signature", http.StatusUnauthorized)
        return
    }

    // Parse event
    var event RotationEvent
    if err := json.Unmarshal(body, &event); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    // Queue event for processing
    select {
    case rw.events <- event:
        w.WriteHeader(http.StatusAccepted)
        json.NewEncoder(w).Encode(map[string]string{
            "status": "accepted",
            "secret": event.SecretName,
        })
    default:
        http.Error(w, "Event queue full", http.StatusServiceUnavailable)
    }
}

func (rw *RotationWebhook) verifySignature(body []byte, signature string) bool {
    mac := hmac.New(sha256.New, []byte(rw.webhookSecret))
    mac.Write(body)
    expected := hex.EncodeToString(mac.Sum(nil))

    return hmac.Equal([]byte(signature), []byte(expected))
}

func (rw *RotationWebhook) processEvents() {
    for event := range rw.events {
        ctx := context.Background()

        // Find matching reloader
        rw.mu.RLock()
        reloader, ok := rw.reloaders[event.SecretName]
        handlers := rw.handlers
        rw.mu.RUnlock()

        // Reload secret
        if ok {
            if err := reloader.Reload(ctx, event.SecretName); err != nil {
                fmt.Printf("error: failed to reload secret %s: %v\n", event.SecretName, err)
            } else {
                fmt.Printf("info: reloaded secret %s\n", event.SecretName)
            }
        }

        // Call handlers
        for _, handler := range handlers {
            if err := handler(ctx, event); err != nil {
                fmt.Printf("error: handler failed for %s: %v\n", event.SecretName, err)
            }
        }
    }
}

// DatabaseReloader reloads database connections on credential rotation
type DatabaseReloader struct {
    secretsProvider Provider
    pool            *ManagedDBPool
}

func NewDatabaseReloader(provider Provider, pool *ManagedDBPool) *DatabaseReloader {
    return &DatabaseReloader{
        secretsProvider: provider,
        pool:            pool,
    }
}

func (r *DatabaseReloader) Reload(ctx context.Context, secretName string) error {
    // Fetch new credentials
    secret, err := r.secretsProvider.GetSecret(ctx, secretName)
    if err != nil {
        return fmt.Errorf("failed to fetch new credentials: %w", err)
    }

    var creds DBCredentials
    if err := json.Unmarshal([]byte(secret), &creds); err != nil {
        return fmt.Errorf("failed to parse credentials: %w", err)
    }

    // Update pool with new credentials
    return r.pool.UpdateCredentials(creds.Username, creds.Password)
}

// ManagedDBPool manages database connections with credential rotation
type ManagedDBPool struct {
    host     string
    port     int
    database string
    sslMode  string

    mu       sync.RWMutex
    db       *sql.DB
    username string
    password string
}

func NewManagedDBPool(host string, port int, database, sslMode string) *ManagedDBPool {
    return &ManagedDBPool{
        host:     host,
        port:     port,
        database: database,
        sslMode:  sslMode,
    }
}

func (p *ManagedDBPool) Connect(ctx context.Context, username, password string) error {
    p.mu.Lock()
    defer p.mu.Unlock()

    dsn := fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=%s",
        username, password, p.host, p.port, p.database, p.sslMode)

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return err
    }

    if err := db.PingContext(ctx); err != nil {
        db.Close()
        return err
    }

    if p.db != nil {
        p.db.Close()
    }

    p.db = db
    p.username = username
    p.password = password

    return nil
}

func (p *ManagedDBPool) UpdateCredentials(username, password string) error {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    return p.Connect(ctx, username, password)
}

func (p *ManagedDBPool) DB() *sql.DB {
    p.mu.RLock()
    defer p.mu.RUnlock()
    return p.db
}

func (p *ManagedDBPool) Close() error {
    p.mu.Lock()
    defer p.mu.Unlock()
    if p.db != nil {
        return p.db.Close()
    }
    return nil
}

// Example usage
func ExampleRotation() {
    // Create webhook handler
    webhook := NewRotationWebhook("webhook-secret-123")

    // Create managed database pool
    dbPool := NewManagedDBPool("localhost", 5432, "myapp", "require")

    // Create secrets provider
    provider, _ := NewProviderFromEnv(context.Background())

    // Register database reloader
    reloader := NewDatabaseReloader(provider, dbPool)
    webhook.RegisterReloader("database/production", reloader)

    // Add logging handler
    webhook.OnRotation(func(ctx context.Context, event RotationEvent) error {
        log.Printf("Secret rotated: %s version=%s", event.SecretName, event.Version)
        return nil
    })

    // Start HTTP server
    http.Handle("/webhook/rotation", webhook)
    http.ListenAndServe(":8080", nil)
}
```

**Key Implementation Points**:
- HMAC signature verification for webhook security
- Async event processing to not block webhook response
- Pluggable reloader interface
- Database connection pool refresh
- Handler chain for logging/alerting

---

### Exercise 3: Secret Audit Logger

**Problem**: Build an audit logger that tracks all secret access with tamper-evident hash chaining.

**Solution**:

```go
// pkg/audit/logger.go
package audit

import (
    "context"
    "crypto/rand"
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "net/http"
    "os"
    "sync"
    "time"

    "github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"
)

// Provider is the secrets provider interface from Exercise 1.
type Provider interface {
    GetSecret(ctx context.Context, name string) (string, error)
    GetSecretWithVersion(ctx context.Context, name, version string) (string, error)
    Close() error
}

// AccessType represents the type of secret access
type AccessType string

const (
    AccessRead   AccessType = "read"
    AccessWrite  AccessType = "write"
    AccessDelete AccessType = "delete"
    AccessList   AccessType = "list"
)

// AuditEntry represents a single audit log entry
type AuditEntry struct {
    ID            string            `json:"id"`
    Timestamp     time.Time         `json:"timestamp"`
    SecretName    string            `json:"secret_name"`
    SecretVersion string            `json:"secret_version,omitempty"`
    AccessType    AccessType        `json:"access_type"`
    Principal     string            `json:"principal"`
    ServiceName   string            `json:"service_name"`
    SourceIP      string            `json:"source_ip,omitempty"`
    Success       bool              `json:"success"`
    ErrorMessage  string            `json:"error_message,omitempty"`
    Metadata      map[string]string `json:"metadata,omitempty"`
    PreviousHash  string            `json:"previous_hash"`
    Hash          string            `json:"hash"`
}

// AuditLogger logs secret access events with chain verification
type AuditLogger struct {
    mu           sync.Mutex
    writer       AuditWriter
    previousHash string
    counter      uint64
}

// AuditWriter defines where audit logs are written
type AuditWriter interface {
    Write(entry *AuditEntry) error
    Close() error
}

// NewAuditLogger creates a new audit logger
func NewAuditLogger(writer AuditWriter) *AuditLogger {
    return &AuditLogger{
        writer:       writer,
        previousHash: "genesis",
    }
}

// Log records a secret access event
func (l *AuditLogger) Log(ctx context.Context, entry *AuditEntry) error {
    l.mu.Lock()
    defer l.mu.Unlock()

    // Set timestamp and ID
    entry.Timestamp = time.Now().UTC()
    entry.ID = fmt.Sprintf("%d-%s", l.counter, generateID())
    l.counter++

    // Set previous hash for chain verification
    entry.PreviousHash = l.previousHash

    // Calculate entry hash
    entry.Hash = l.calculateHash(entry)
    l.previousHash = entry.Hash

    // Write to underlying writer
    if err := l.writer.Write(entry); err != nil {
        return fmt.Errorf("failed to write audit entry: %w", err)
    }

    return nil
}

func (l *AuditLogger) calculateHash(entry *AuditEntry) string {
    // Create deterministic representation
    data := fmt.Sprintf("%s|%s|%s|%s|%s|%s|%s|%v|%s",
        entry.ID,
        entry.Timestamp.Format(time.RFC3339Nano),
        entry.SecretName,
        entry.AccessType,
        entry.Principal,
        entry.ServiceName,
        entry.PreviousHash,
        entry.Success,
        entry.ErrorMessage,
    )

    hash := sha256.Sum256([]byte(data))
    return hex.EncodeToString(hash[:])
}

// Close closes the audit logger
func (l *AuditLogger) Close() error {
    return l.writer.Close()
}

// FileAuditWriter writes audit logs to a file
type FileAuditWriter struct {
    file    *os.File
    encoder *json.Encoder
    mu      sync.Mutex
}

func NewFileAuditWriter(path string) (*FileAuditWriter, error) {
    file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
    if err != nil {
        return nil, err
    }

    return &FileAuditWriter{
        file:    file,
        encoder: json.NewEncoder(file),
    }, nil
}

func (w *FileAuditWriter) Write(entry *AuditEntry) error {
    w.mu.Lock()
    defer w.mu.Unlock()

    return w.encoder.Encode(entry)
}

func (w *FileAuditWriter) Close() error {
    return w.file.Close()
}

// CloudWatchAuditWriter writes to AWS CloudWatch Logs
type CloudWatchAuditWriter struct {
    client      *cloudwatchlogs.Client
    logGroup    string
    logStream   string
    sequenceToken *string
}

// SplunkAuditWriter writes to Splunk HEC
type SplunkAuditWriter struct {
    endpoint string
    token    string
    client   *http.Client
}

// AuditingProvider wraps a secrets provider with audit logging
type AuditingProvider struct {
    provider    Provider
    logger      *AuditLogger
    serviceName string
}

func NewAuditingProvider(provider Provider, logger *AuditLogger, serviceName string) *AuditingProvider {
    return &AuditingProvider{
        provider:    provider,
        logger:      logger,
        serviceName: serviceName,
    }
}

func (p *AuditingProvider) GetSecret(ctx context.Context, name string) (string, error) {
    // Extract principal from context
    principal := getPrincipal(ctx)
    sourceIP := getSourceIP(ctx)

    // Attempt to get secret
    value, err := p.provider.GetSecret(ctx, name)

    // Create audit entry
    entry := &AuditEntry{
        SecretName:  name,
        AccessType:  AccessRead,
        Principal:   principal,
        ServiceName: p.serviceName,
        SourceIP:    sourceIP,
        Success:     err == nil,
    }

    if err != nil {
        entry.ErrorMessage = err.Error()
    }

    // Log the access (even if it failed)
    if logErr := p.logger.Log(ctx, entry); logErr != nil {
        // Log logging failure but don't fail the request
        fmt.Printf("warning: failed to log audit entry: %v\n", logErr)
    }

    return value, err
}

func (p *AuditingProvider) GetSecretWithVersion(ctx context.Context, name, version string) (string, error) {
    principal := getPrincipal(ctx)
    sourceIP := getSourceIP(ctx)

    value, err := p.provider.GetSecretWithVersion(ctx, name, version)

    entry := &AuditEntry{
        SecretName:    name,
        SecretVersion: version,
        AccessType:    AccessRead,
        Principal:     principal,
        ServiceName:   p.serviceName,
        SourceIP:      sourceIP,
        Success:       err == nil,
    }

    if err != nil {
        entry.ErrorMessage = err.Error()
    }

    if logErr := p.logger.Log(ctx, entry); logErr != nil {
        fmt.Printf("warning: failed to log audit entry: %v\n", logErr)
    }

    return value, err
}

func (p *AuditingProvider) Close() error {
    if err := p.logger.Close(); err != nil {
        return err
    }
    return p.provider.Close()
}

// AuditVerifier verifies the integrity of audit logs
type AuditVerifier struct{}

func NewAuditVerifier() *AuditVerifier {
    return &AuditVerifier{}
}

// Verify checks the audit log chain for tampering
func (v *AuditVerifier) Verify(entries []*AuditEntry) (bool, []string) {
    var errors []string

    if len(entries) == 0 {
        return true, nil
    }

    // Verify first entry
    if entries[0].PreviousHash != "genesis" {
        errors = append(errors, fmt.Sprintf("entry %s: invalid genesis hash", entries[0].ID))
    }

    previousHash := "genesis"

    for i, entry := range entries {
        // Verify chain link
        if entry.PreviousHash != previousHash {
            errors = append(errors, fmt.Sprintf(
                "entry %s: chain broken, expected previous hash %s, got %s",
                entry.ID, previousHash, entry.PreviousHash))
        }

        // Verify entry hash
        expectedHash := v.calculateHash(entry)
        if entry.Hash != expectedHash {
            errors = append(errors, fmt.Sprintf(
                "entry %s: hash mismatch, expected %s, got %s",
                entry.ID, expectedHash, entry.Hash))
        }

        previousHash = entry.Hash

        // Verify timestamp order
        if i > 0 && entry.Timestamp.Before(entries[i-1].Timestamp) {
            errors = append(errors, fmt.Sprintf(
                "entry %s: timestamp out of order", entry.ID))
        }
    }

    return len(errors) == 0, errors
}

func (v *AuditVerifier) calculateHash(entry *AuditEntry) string {
    data := fmt.Sprintf("%s|%s|%s|%s|%s|%s|%s|%v|%s",
        entry.ID,
        entry.Timestamp.Format(time.RFC3339Nano),
        entry.SecretName,
        entry.AccessType,
        entry.Principal,
        entry.ServiceName,
        entry.PreviousHash,
        entry.Success,
        entry.ErrorMessage,
    )

    hash := sha256.Sum256([]byte(data))
    return hex.EncodeToString(hash[:])
}

func generateID() string {
    b := make([]byte, 8)
    rand.Read(b)
    return hex.EncodeToString(b)
}

func getPrincipal(ctx context.Context) string {
    if principal, ok := ctx.Value("principal").(string); ok {
        return principal
    }
    return "unknown"
}

func getSourceIP(ctx context.Context) string {
    if ip, ok := ctx.Value("source_ip").(string); ok {
        return ip
    }
    return ""
}
```

**Key Implementation Points**:
- Hash chain for tamper detection
- Wraps any Provider with audit logging
- Multiple output destinations (file, CloudWatch, Splunk)
- Chain verification for integrity checking
- Logs both successes and failures
- Principal and IP tracking for forensics

### Junior → FAANG: Building the Exercises Correctly

The exercises in this section are calibrated to reflect real production integration patterns. Completing them correctly is equivalent to demonstrating secrets management competency in a take-home interview.

**Gap to close:** The multi-cloud provider exercise is the most important for interview preparation. Building a clean `SecretProvider` interface with multiple implementations (Vault, AWS, GCP) demonstrates interface-driven design applied to infrastructure code. This is exactly the kind of abstraction that FAANG interviewers look for: clean separation of contract from implementation, testable design.

**Testing approach:** For each exercise, write one test with a mock secrets provider that returns known values, and one integration test that connects to a real Vault dev server. The mock test runs in CI. The integration test runs locally or in a dedicated integration test environment. This two-tier testing strategy is production-grade.

### Senior @ FAANG: Using These Exercises to Evaluate Candidates

These exercises can be used as take-home interview problems for L5/L6 candidates.

**L5 evaluation criteria:** The multi-cloud provider exercise should produce: a clean interface, at least two implementations, context propagation throughout (no context.Background()), proper error wrapping, caching with TTL, and unit tests using a mock implementation. Missing any of these is a finding.

**L6 escalation:** For L6 candidates, escalate: "Your secrets provider is used by 50 services. How would you add audit logging to every secrets access without modifying each service's code?" The answer should involve middleware wrapping the interface, not modifying each implementation. This tests interface composition and platform thinking.

---
