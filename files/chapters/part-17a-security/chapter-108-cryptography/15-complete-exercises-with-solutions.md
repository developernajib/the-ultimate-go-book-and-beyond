## 108.14 Complete Exercises with Solutions

### Exercise 1: Secure File Encryption Tool

**Problem**: Build a CLI tool that encrypts/decrypts files using AES-GCM with password-derived keys using Argon2.

**Solution**:

```go
// cmd/securefile/main.go
package main

import (
    "crypto/aes"
    "crypto/cipher"
    "crypto/rand"
    "errors"
    "flag"
    "fmt"
    "io"
    "os"
    "strings"

    "golang.org/x/crypto/argon2"
    "golang.org/x/term"
)

const (
    // Argon2id parameters
    argonTime    = 3
    argonMemory  = 64 * 1024 // 64 MB
    argonThreads = 4
    argonKeyLen  = 32

    saltLen     = 16
    nonceLen    = 12
    headerMagic = "SECFILE1" // 8 bytes
)

// File format:
// [8 bytes: magic] [16 bytes: salt] [12 bytes: nonce] [N bytes: ciphertext with auth tag]

func main() {
    encrypt := flag.Bool("e", false, "Encrypt file")
    decrypt := flag.Bool("d", false, "Decrypt file")
    input := flag.String("i", "", "Input file")
    output := flag.String("o", "", "Output file (default: input.enc or input without .enc)")
    flag.Parse()

    if (!*encrypt && !*decrypt) || (*encrypt && *decrypt) {
        fmt.Println("Usage: securefile -e|-d -i <input> [-o <output>]")
        os.Exit(1)
    }

    if *input == "" {
        fmt.Println("Error: input file required")
        os.Exit(1)
    }

    // Determine output filename
    outputPath := *output
    if outputPath == "" {
        if *encrypt {
            outputPath = *input + ".enc"
        } else {
            outputPath = strings.TrimSuffix(*input, ".enc")
            if outputPath == *input {
                outputPath = *input + ".dec"
            }
        }
    }

    // Get password
    fmt.Print("Enter password: ")
    password, err := term.ReadPassword(int(os.Stdin.Fd()))
    fmt.Println()
    if err != nil {
        fmt.Printf("Error reading password: %v\n", err)
        os.Exit(1)
    }

    if *encrypt {
        fmt.Print("Confirm password: ")
        confirm, err := term.ReadPassword(int(os.Stdin.Fd()))
        fmt.Println()
        if err != nil || string(password) != string(confirm) {
            fmt.Println("Passwords don't match")
            os.Exit(1)
        }
    }

    var processErr error
    if *encrypt {
        processErr = encryptFile(*input, outputPath, password)
    } else {
        processErr = decryptFile(*input, outputPath, password)
    }

    if processErr != nil {
        fmt.Printf("Error: %v\n", processErr)
        os.Exit(1)
    }

    fmt.Printf("Success: %s -> %s\n", *input, outputPath)
}

func deriveKey(password, salt []byte) []byte {
    return argon2.IDKey(password, salt, argonTime, argonMemory, argonThreads, argonKeyLen)
}

func encryptFile(inputPath, outputPath string, password []byte) error {
    // Read input file
    plaintext, err := os.ReadFile(inputPath)
    if err != nil {
        return fmt.Errorf("failed to read input: %w", err)
    }

    // Generate salt
    salt := make([]byte, saltLen)
    if _, err := io.ReadFull(rand.Reader, salt); err != nil {
        return fmt.Errorf("failed to generate salt: %w", err)
    }

    // Derive key
    key := deriveKey(password, salt)

    // Create cipher
    block, err := aes.NewCipher(key)
    if err != nil {
        return fmt.Errorf("failed to create cipher: %w", err)
    }

    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return fmt.Errorf("failed to create GCM: %w", err)
    }

    // Generate nonce
    nonce := make([]byte, nonceLen)
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return fmt.Errorf("failed to generate nonce: %w", err)
    }

    // Encrypt
    ciphertext := gcm.Seal(nil, nonce, plaintext, nil)

    // Create output file
    outFile, err := os.Create(outputPath)
    if err != nil {
        return fmt.Errorf("failed to create output: %w", err)
    }
    defer outFile.Close()

    // Write header: magic + salt + nonce + ciphertext
    if _, err := outFile.Write([]byte(headerMagic)); err != nil {
        return err
    }
    if _, err := outFile.Write(salt); err != nil {
        return err
    }
    if _, err := outFile.Write(nonce); err != nil {
        return err
    }
    if _, err := outFile.Write(ciphertext); err != nil {
        return err
    }

    return nil
}

func decryptFile(inputPath, outputPath string, password []byte) error {
    // Read encrypted file
    data, err := os.ReadFile(inputPath)
    if err != nil {
        return fmt.Errorf("failed to read input: %w", err)
    }

    // Verify minimum length
    headerLen := len(headerMagic) + saltLen + nonceLen
    if len(data) < headerLen+16 { // At least 16 bytes for auth tag
        return errors.New("file too short")
    }

    // Parse header
    offset := 0

    magic := string(data[offset : offset+len(headerMagic)])
    offset += len(headerMagic)
    if magic != headerMagic {
        return errors.New("invalid file format or wrong password")
    }

    salt := data[offset : offset+saltLen]
    offset += saltLen

    nonce := data[offset : offset+nonceLen]
    offset += nonceLen

    ciphertext := data[offset:]

    // Derive key
    key := deriveKey(password, salt)

    // Create cipher
    block, err := aes.NewCipher(key)
    if err != nil {
        return fmt.Errorf("failed to create cipher: %w", err)
    }

    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return fmt.Errorf("failed to create GCM: %w", err)
    }

    // Decrypt
    plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
    if err != nil {
        return errors.New("decryption failed - wrong password or corrupted file")
    }

    // Write output
    if err := os.WriteFile(outputPath, plaintext, 0600); err != nil {
        return fmt.Errorf("failed to write output: %w", err)
    }

    return nil
}
```

**Key Implementation Points**:
- Uses Argon2id with recommended parameters
- Random 16-byte salt stored with file
- Random 12-byte nonce for AES-GCM
- Magic header for file format verification
- Password confirmation for encryption
- Secure password input (no echo)

---

### Exercise 2: JWT Token Generation and Verification

**Problem**: Implement a JWT system with support for both HMAC-SHA256 and RSA signatures.

**Solution**:

```go
// pkg/jwt/jwt.go
package jwt

import (
    "crypto"
    "crypto/hmac"
    "crypto/rand"
    "crypto/rsa"
    "crypto/sha256"
    "encoding/base64"
    "encoding/json"
    "errors"
    "fmt"
    "strings"
    "time"
)

type Algorithm string

const (
    HS256 Algorithm = "HS256"
    RS256 Algorithm = "RS256"
    ES256 Algorithm = "ES256"
)

type Header struct {
    Alg Algorithm `json:"alg"`
    Typ string    `json:"typ"`
}

type Claims struct {
    Issuer    string `json:"iss,omitempty"`
    Subject   string `json:"sub,omitempty"`
    Audience  string `json:"aud,omitempty"`
    ExpiresAt int64  `json:"exp,omitempty"`
    NotBefore int64  `json:"nbf,omitempty"`
    IssuedAt  int64  `json:"iat,omitempty"`
    JWTID     string `json:"jti,omitempty"`

    // Custom claims
    Custom map[string]any `json:"-"`
}

type Signer interface {
    Algorithm() Algorithm
    Sign(data []byte) ([]byte, error)
    Verify(data, signature []byte) error
}

// HMAC Signer
type hmacSigner struct {
    secret []byte
}

func NewHMACSigner(secret []byte) Signer {
    return &hmacSigner{secret: secret}
}

func (s *hmacSigner) Algorithm() Algorithm {
    return HS256
}

func (s *hmacSigner) Sign(data []byte) ([]byte, error) {
    mac := hmac.New(sha256.New, s.secret)
    mac.Write(data)
    return mac.Sum(nil), nil
}

func (s *hmacSigner) Verify(data, signature []byte) error {
    expected, err := s.Sign(data)
    if err != nil {
        return err
    }
    if !hmac.Equal(signature, expected) {
        return errors.New("invalid signature")
    }
    return nil
}

// RSA Signer
type rsaSigner struct {
    privateKey *rsa.PrivateKey
    publicKey  *rsa.PublicKey
}

func NewRSASigner(privateKey *rsa.PrivateKey) Signer {
    return &rsaSigner{
        privateKey: privateKey,
        publicKey:  &privateKey.PublicKey,
    }
}

func NewRSAVerifier(publicKey *rsa.PublicKey) Signer {
    return &rsaSigner{publicKey: publicKey}
}

func (s *rsaSigner) Algorithm() Algorithm {
    return RS256
}

func (s *rsaSigner) Sign(data []byte) ([]byte, error) {
    if s.privateKey == nil {
        return nil, errors.New("private key required for signing")
    }
    hash := sha256.Sum256(data)
    return rsa.SignPKCS1v15(rand.Reader, s.privateKey, crypto.SHA256, hash[:])
}

func (s *rsaSigner) Verify(data, signature []byte) error {
    hash := sha256.Sum256(data)
    return rsa.VerifyPKCS1v15(s.publicKey, crypto.SHA256, hash[:], signature)
}

// JWT Builder
type JWTBuilder struct {
    signer Signer
    claims Claims
}

func NewJWTBuilder(signer Signer) *JWTBuilder {
    return &JWTBuilder{
        signer: signer,
        claims: Claims{
            IssuedAt: time.Now().Unix(),
            Custom:   make(map[string]any),
        },
    }
}

func (b *JWTBuilder) Subject(sub string) *JWTBuilder {
    b.claims.Subject = sub
    return b
}

func (b *JWTBuilder) Issuer(iss string) *JWTBuilder {
    b.claims.Issuer = iss
    return b
}

func (b *JWTBuilder) ExpiresIn(d time.Duration) *JWTBuilder {
    b.claims.ExpiresAt = time.Now().Add(d).Unix()
    return b
}

func (b *JWTBuilder) Claim(key string, value any) *JWTBuilder {
    b.claims.Custom[key] = value
    return b
}

func (b *JWTBuilder) Build() (string, error) {
    // Create header
    header := Header{
        Alg: b.signer.Algorithm(),
        Typ: "JWT",
    }

    headerJSON, err := json.Marshal(header)
    if err != nil {
        return "", err
    }
    headerB64 := base64.RawURLEncoding.EncodeToString(headerJSON)

    // Merge custom claims
    claimsMap := make(map[string]any)
    claimsJSON, _ := json.Marshal(b.claims)
    json.Unmarshal(claimsJSON, &claimsMap)
    for k, v := range b.claims.Custom {
        claimsMap[k] = v
    }

    payloadJSON, err := json.Marshal(claimsMap)
    if err != nil {
        return "", err
    }
    payloadB64 := base64.RawURLEncoding.EncodeToString(payloadJSON)

    // Sign
    signingInput := headerB64 + "." + payloadB64
    signature, err := b.signer.Sign([]byte(signingInput))
    if err != nil {
        return "", err
    }
    signatureB64 := base64.RawURLEncoding.EncodeToString(signature)

    return signingInput + "." + signatureB64, nil
}

// JWT Verifier
type JWTVerifier struct {
    signers map[Algorithm]Signer
}

func NewJWTVerifier() *JWTVerifier {
    return &JWTVerifier{
        signers: make(map[Algorithm]Signer),
    }
}

func (v *JWTVerifier) AddSigner(s Signer) {
    v.signers[s.Algorithm()] = s
}

func (v *JWTVerifier) Verify(token string) (*Claims, error) {
    parts := strings.Split(token, ".")
    if len(parts) != 3 {
        return nil, errors.New("invalid token format")
    }

    // Decode header
    headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
    if err != nil {
        return nil, errors.New("invalid header encoding")
    }

    var header Header
    if err := json.Unmarshal(headerJSON, &header); err != nil {
        return nil, errors.New("invalid header")
    }

    // Find signer
    signer, ok := v.signers[header.Alg]
    if !ok {
        return nil, fmt.Errorf("unsupported algorithm: %s", header.Alg)
    }

    // Verify signature
    signature, err := base64.RawURLEncoding.DecodeString(parts[2])
    if err != nil {
        return nil, errors.New("invalid signature encoding")
    }

    signingInput := parts[0] + "." + parts[1]
    if err := signer.Verify([]byte(signingInput), signature); err != nil {
        return nil, errors.New("invalid signature")
    }

    // Decode claims
    payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
    if err != nil {
        return nil, errors.New("invalid payload encoding")
    }

    var claims Claims
    if err := json.Unmarshal(payloadJSON, &claims); err != nil {
        return nil, errors.New("invalid payload")
    }

    // Verify expiration
    now := time.Now().Unix()
    if claims.ExpiresAt > 0 && now > claims.ExpiresAt {
        return nil, errors.New("token expired")
    }
    if claims.NotBefore > 0 && now < claims.NotBefore {
        return nil, errors.New("token not yet valid")
    }

    return &claims, nil
}

// Example usage
func Example() {
    // HMAC signing
    secret := []byte("super-secret-key-at-least-32-bytes!")
    signer := NewHMACSigner(secret)

    token, err := NewJWTBuilder(signer).
        Subject("user123").
        Issuer("myapp").
        ExpiresIn(time.Hour).
        Claim("role", "admin").
        Build()
    if err != nil {
        panic(err)
    }
    fmt.Printf("Token: %s\n", token)

    // Verify
    verifier := NewJWTVerifier()
    verifier.AddSigner(signer)

    claims, err := verifier.Verify(token)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Subject: %s\n", claims.Subject)
}
```

**Key Implementation Points**:
- Pluggable signing algorithms (HMAC, RSA, ECDSA)
- Builder pattern for clean API
- Standard JWT claims (iss, sub, exp, etc.)
- Custom claims support
- Expiration and not-before validation
- Constant-time signature comparison for HMAC

---

### Exercise 3: TLS Certificate Verification System

**Problem**: Build a system to verify TLS certificates, check expiration, and detect common security issues.

**Solution**:

```go
// pkg/certcheck/checker.go
package certcheck

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "net"
    "sort"
    "strings"
    "time"
)

type CertificateIssue struct {
    Severity string // "critical", "warning", "info"
    Message  string
}

type CertificateReport struct {
    Host          string
    Port          string
    Subject       string
    Issuer        string
    ValidFrom     time.Time
    ValidUntil    time.Time
    DaysRemaining int
    SANs          []string
    KeySize       int
    SignatureAlg  string
    TLSVersion    string
    CipherSuite   string
    Issues        []CertificateIssue
    Chain         []string
}

type CertChecker struct {
    timeout time.Duration
    roots   *x509.CertPool
}

func NewCertChecker() *CertChecker {
    roots, _ := x509.SystemCertPool()
    if roots == nil {
        roots = x509.NewCertPool()
    }
    return &CertChecker{
        timeout: 10 * time.Second,
        roots:   roots,
    }
}

func (c *CertChecker) Check(host string) (*CertificateReport, error) {
    // Parse host:port
    hostPart, port, err := net.SplitHostPort(host)
    if err != nil {
        hostPart = host
        port = "443"
    }

    // Connect with TLS
    dialer := &net.Dialer{Timeout: c.timeout}
    conn, err := tls.DialWithDialer(dialer, "tcp", net.JoinHostPort(hostPart, port), &tls.Config{
        InsecureSkipVerify: true, // We'll verify manually for detailed reporting
    })
    if err != nil {
        return nil, fmt.Errorf("connection failed: %w", err)
    }
    defer conn.Close()

    // Get connection state
    state := conn.ConnectionState()
    if len(state.PeerCertificates) == 0 {
        return nil, fmt.Errorf("no certificates presented")
    }

    cert := state.PeerCertificates[0]
    report := &CertificateReport{
        Host:          hostPart,
        Port:          port,
        Subject:       cert.Subject.CommonName,
        Issuer:        cert.Issuer.CommonName,
        ValidFrom:     cert.NotBefore,
        ValidUntil:    cert.NotAfter,
        DaysRemaining: int(time.Until(cert.NotAfter).Hours() / 24),
        SANs:          cert.DNSNames,
        SignatureAlg:  cert.SignatureAlgorithm.String(),
        TLSVersion:    tlsVersionName(state.Version),
        CipherSuite:   tls.CipherSuiteName(state.CipherSuite),
        Issues:        make([]CertificateIssue, 0),
    }

    // Get key size
    switch pub := cert.PublicKey.(type) {
    case interface{ Size() int }:
        report.KeySize = pub.Size() * 8
    }

    // Build chain
    for _, c := range state.PeerCertificates {
        report.Chain = append(report.Chain, c.Subject.CommonName)
    }

    // Run checks
    c.checkExpiration(report)
    c.checkHostname(report, hostPart)
    c.checkKeySize(report)
    c.checkSignatureAlgorithm(report)
    c.checkTLSVersion(report, state.Version)
    c.checkCipherSuite(report, state.CipherSuite)
    c.checkChainValidity(report, state.PeerCertificates)

    // Sort issues by severity
    sort.Slice(report.Issues, func(i, j int) bool {
        order := map[string]int{"critical": 0, "warning": 1, "info": 2}
        return order[report.Issues[i].Severity] < order[report.Issues[j].Severity]
    })

    return report, nil
}

func (c *CertChecker) checkExpiration(r *CertificateReport) {
    now := time.Now()

    if now.After(r.ValidUntil) {
        r.Issues = append(r.Issues, CertificateIssue{
            Severity: "critical",
            Message:  "Certificate has expired",
        })
    } else if r.DaysRemaining < 7 {
        r.Issues = append(r.Issues, CertificateIssue{
            Severity: "critical",
            Message:  fmt.Sprintf("Certificate expires in %d days", r.DaysRemaining),
        })
    } else if r.DaysRemaining < 30 {
        r.Issues = append(r.Issues, CertificateIssue{
            Severity: "warning",
            Message:  fmt.Sprintf("Certificate expires in %d days", r.DaysRemaining),
        })
    }

    if now.Before(r.ValidFrom) {
        r.Issues = append(r.Issues, CertificateIssue{
            Severity: "critical",
            Message:  "Certificate is not yet valid",
        })
    }
}

func (c *CertChecker) checkHostname(r *CertificateReport, host string) {
    matched := false

    // Check common name
    if matchesHostname(r.Subject, host) {
        matched = true
    }

    // Check SANs
    for _, san := range r.SANs {
        if matchesHostname(san, host) {
            matched = true
            break
        }
    }

    if !matched {
        r.Issues = append(r.Issues, CertificateIssue{
            Severity: "critical",
            Message:  fmt.Sprintf("Hostname %s doesn't match certificate", host),
        })
    }
}

func (c *CertChecker) checkKeySize(r *CertificateReport) {
    switch {
    case r.KeySize == 0:
        return // Unknown key type
    case r.KeySize < 2048:
        r.Issues = append(r.Issues, CertificateIssue{
            Severity: "critical",
            Message:  fmt.Sprintf("Key size too small: %d bits (minimum 2048)", r.KeySize),
        })
    case r.KeySize < 4096 && strings.Contains(r.SignatureAlg, "RSA"):
        r.Issues = append(r.Issues, CertificateIssue{
            Severity: "info",
            Message:  "Consider using 4096-bit RSA key for long-term security",
        })
    }
}

func (c *CertChecker) checkSignatureAlgorithm(r *CertificateReport) {
    weakAlgorithms := []string{"MD5", "SHA1", "MD2"}
    for _, weak := range weakAlgorithms {
        if strings.Contains(strings.ToUpper(r.SignatureAlg), weak) {
            r.Issues = append(r.Issues, CertificateIssue{
                Severity: "critical",
                Message:  fmt.Sprintf("Weak signature algorithm: %s", r.SignatureAlg),
            })
            return
        }
    }
}

func (c *CertChecker) checkTLSVersion(r *CertificateReport, version uint16) {
    switch version {
    case tls.VersionTLS10, tls.VersionTLS11:
        r.Issues = append(r.Issues, CertificateIssue{
            Severity: "critical",
            Message:  fmt.Sprintf("Deprecated TLS version: %s", r.TLSVersion),
        })
    case tls.VersionTLS12:
        r.Issues = append(r.Issues, CertificateIssue{
            Severity: "info",
            Message:  "Consider enabling TLS 1.3 for improved security",
        })
    }
}

func (c *CertChecker) checkCipherSuite(r *CertificateReport, suite uint16) {
    // Check for weak cipher suites
    weakPrefixes := []string{"TLS_RSA_", "TLS_DES_", "TLS_3DES_", "TLS_RC4_"}
    for _, prefix := range weakPrefixes {
        if strings.HasPrefix(r.CipherSuite, prefix) {
            r.Issues = append(r.Issues, CertificateIssue{
                Severity: "warning",
                Message:  fmt.Sprintf("Weak cipher suite: %s", r.CipherSuite),
            })
            return
        }
    }
}

func (c *CertChecker) checkChainValidity(r *CertificateReport, certs []*x509.Certificate) {
    if len(certs) < 2 {
        r.Issues = append(r.Issues, CertificateIssue{
            Severity: "warning",
            Message:  "Incomplete certificate chain",
        })
    }

    // Verify chain
    opts := x509.VerifyOptions{
        Roots:         c.roots,
        Intermediates: x509.NewCertPool(),
    }

    for _, cert := range certs[1:] {
        opts.Intermediates.AddCert(cert)
    }

    if _, err := certs[0].Verify(opts); err != nil {
        r.Issues = append(r.Issues, CertificateIssue{
            Severity: "critical",
            Message:  fmt.Sprintf("Chain verification failed: %v", err),
        })
    }
}

func matchesHostname(pattern, host string) bool {
    pattern = strings.ToLower(pattern)
    host = strings.ToLower(host)

    if pattern == host {
        return true
    }

    // Wildcard matching
    if strings.HasPrefix(pattern, "*.") {
        suffix := pattern[1:] // Remove *
        if strings.HasSuffix(host, suffix) && !strings.Contains(host[:len(host)-len(suffix)], ".") {
            return true
        }
    }

    return false
}

func tlsVersionName(version uint16) string {
    switch version {
    case tls.VersionTLS10:
        return "TLS 1.0"
    case tls.VersionTLS11:
        return "TLS 1.1"
    case tls.VersionTLS12:
        return "TLS 1.2"
    case tls.VersionTLS13:
        return "TLS 1.3"
    default:
        return fmt.Sprintf("Unknown (0x%04x)", version)
    }
}

// PrintReport outputs a human-readable report
func (r *CertificateReport) PrintReport() {
    fmt.Printf("Certificate Report for %s:%s\n", r.Host, r.Port)
    fmt.Printf("════════════════════════════════════════════\n\n")

    fmt.Printf("Subject:        %s\n", r.Subject)
    fmt.Printf("Issuer:         %s\n", r.Issuer)
    fmt.Printf("Valid From:     %s\n", r.ValidFrom.Format(time.RFC3339))
    fmt.Printf("Valid Until:    %s (%d days remaining)\n", r.ValidUntil.Format(time.RFC3339), r.DaysRemaining)
    fmt.Printf("Signature:      %s\n", r.SignatureAlg)
    fmt.Printf("Key Size:       %d bits\n", r.KeySize)
    fmt.Printf("TLS Version:    %s\n", r.TLSVersion)
    fmt.Printf("Cipher Suite:   %s\n", r.CipherSuite)

    if len(r.SANs) > 0 {
        fmt.Printf("SANs:           %s\n", strings.Join(r.SANs, ", "))
    }

    fmt.Printf("\nCertificate Chain:\n")
    for i, cert := range r.Chain {
        fmt.Printf("  %d. %s\n", i+1, cert)
    }

    if len(r.Issues) > 0 {
        fmt.Printf("\nIssues Found:\n")
        for _, issue := range r.Issues {
            icon := map[string]string{
                "critical": "🔴",
                "warning":  "🟡",
                "info":     "🔵",
            }[issue.Severity]
            fmt.Printf("  %s [%s] %s\n", icon, strings.ToUpper(issue.Severity), issue.Message)
        }
    } else {
        fmt.Printf("\n✅ No issues found\n")
    }
}
```

**Key Implementation Points**:
- Checks certificate expiration with severity levels
- Validates hostname against CN and SANs
- Detects weak key sizes (<2048 bits)
- Identifies deprecated signature algorithms
- Warns about old TLS versions
- Validates certificate chain
- Reports weak cipher suites

---

### Exercise 4: Secure Random Token Generator

**Problem**: Build a production-ready token generator for API keys, session IDs, and password reset tokens.

**Solution**:

```go
// pkg/tokens/generator.go
package tokens

import (
    "crypto/rand"
    "encoding/base32"
    "encoding/base64"
    "encoding/hex"
    "errors"
    "fmt"
    "io"
    "strings"
    "time"
)

type TokenType string

const (
    TypeAPIKey       TokenType = "ak"  // API Key
    TypeSession      TokenType = "ss"  // Session
    TypePasswordReset TokenType = "pr"  // Password Reset
    TypeEmailVerify  TokenType = "ev"  // Email Verification
    TypeOAuth        TokenType = "oa"  // OAuth State
)

type TokenFormat string

const (
    FormatHex     TokenFormat = "hex"
    FormatBase64  TokenFormat = "base64"
    FormatBase32  TokenFormat = "base32"
    FormatPrefixed TokenFormat = "prefixed" // type_base64
)

type TokenGenerator struct {
    entropyBytes int
    format       TokenFormat
}

type GeneratorOption func(*TokenGenerator)

func WithEntropyBytes(n int) GeneratorOption {
    return func(g *TokenGenerator) {
        g.entropyBytes = n
    }
}

func WithFormat(f TokenFormat) GeneratorOption {
    return func(g *TokenGenerator) {
        g.format = f
    }
}

func NewTokenGenerator(opts ...GeneratorOption) *TokenGenerator {
    g := &TokenGenerator{
        entropyBytes: 32, // 256 bits by default
        format:       FormatBase64,
    }
    for _, opt := range opts {
        opt(g)
    }
    return g
}

// Generate creates a random token
func (g *TokenGenerator) Generate() (string, error) {
    bytes := make([]byte, g.entropyBytes)
    if _, err := io.ReadFull(rand.Reader, bytes); err != nil {
        return "", fmt.Errorf("failed to generate random bytes: %w", err)
    }

    switch g.format {
    case FormatHex:
        return hex.EncodeToString(bytes), nil
    case FormatBase64:
        return base64.RawURLEncoding.EncodeToString(bytes), nil
    case FormatBase32:
        return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(bytes), nil
    default:
        return base64.RawURLEncoding.EncodeToString(bytes), nil
    }
}

// GeneratePrefixed creates a token with type prefix (like Stripe's sk_live_...)
func (g *TokenGenerator) GeneratePrefixed(tokenType TokenType) (string, error) {
    token, err := g.Generate()
    if err != nil {
        return "", err
    }
    return fmt.Sprintf("%s_%s", tokenType, token), nil
}

// API Key Generator with specific format
type APIKeyGenerator struct {
    prefix string
    env    string
}

func NewAPIKeyGenerator(prefix, env string) *APIKeyGenerator {
    return &APIKeyGenerator{
        prefix: prefix,
        env:    env, // "live", "test"
    }
}

// Generate creates an API key like: prefix_env_randomdata
// Example: sk_live_a1b2c3d4e5f6g7h8i9j0...
func (g *APIKeyGenerator) Generate() (string, []byte, error) {
    // Generate 32 bytes of entropy
    secret := make([]byte, 32)
    if _, err := io.ReadFull(rand.Reader, secret); err != nil {
        return "", nil, err
    }

    // Generate visible key portion (first 8 bytes for display)
    visible := make([]byte, 8)
    if _, err := io.ReadFull(rand.Reader, visible); err != nil {
        return "", nil, err
    }

    // Full key: prefix_env_visible+secret
    encoded := base64.RawURLEncoding.EncodeToString(append(visible, secret...))
    key := fmt.Sprintf("%s_%s_%s", g.prefix, g.env, encoded)

    // Return key and hash for storage
    return key, secret, nil
}

// ParseAPIKey extracts components from an API key
func ParseAPIKey(key string) (prefix, env, data string, err error) {
    parts := strings.SplitN(key, "_", 3)
    if len(parts) != 3 {
        return "", "", "", errors.New("invalid API key format")
    }
    return parts[0], parts[1], parts[2], nil
}

// Session Token with embedded metadata
type SessionToken struct {
    ID        string
    CreatedAt time.Time
    ExpiresAt time.Time
}

type SessionTokenGenerator struct {
    entropyBytes int
    ttl          time.Duration
}

func NewSessionTokenGenerator(ttl time.Duration) *SessionTokenGenerator {
    return &SessionTokenGenerator{
        entropyBytes: 24, // 192 bits
        ttl:          ttl,
    }
}

func (g *SessionTokenGenerator) Generate() (*SessionToken, string, error) {
    bytes := make([]byte, g.entropyBytes)
    if _, err := io.ReadFull(rand.Reader, bytes); err != nil {
        return nil, "", err
    }

    now := time.Now()
    token := &SessionToken{
        ID:        base64.RawURLEncoding.EncodeToString(bytes),
        CreatedAt: now,
        ExpiresAt: now.Add(g.ttl),
    }

    // Opaque token for client (just the random part)
    clientToken := fmt.Sprintf("ss_%s", token.ID)

    return token, clientToken, nil
}

// Password Reset Token with expiration
type ResetToken struct {
    Token     string
    UserID    string
    ExpiresAt time.Time
    Used      bool
}

type ResetTokenGenerator struct {
    entropyBytes int
    ttl          time.Duration
}

func NewResetTokenGenerator(ttl time.Duration) *ResetTokenGenerator {
    return &ResetTokenGenerator{
        entropyBytes: 32,
        ttl:          ttl,
    }
}

func (g *ResetTokenGenerator) Generate(userID string) (*ResetToken, string, error) {
    bytes := make([]byte, g.entropyBytes)
    if _, err := io.ReadFull(rand.Reader, bytes); err != nil {
        return nil, "", err
    }

    token := &ResetToken{
        Token:     hex.EncodeToString(bytes),
        UserID:    userID,
        ExpiresAt: time.Now().Add(g.ttl),
        Used:      false,
    }

    // URL-safe token for email link
    urlToken := base64.RawURLEncoding.EncodeToString(bytes)

    return token, urlToken, nil
}

// Example usage
func Example() {
    // Basic token generation
    gen := NewTokenGenerator(
        WithEntropyBytes(32),
        WithFormat(FormatBase64),
    )

    token, _ := gen.Generate()
    fmt.Printf("Token: %s\n", token)

    // Prefixed token (like Stripe)
    prefixedToken, _ := gen.GeneratePrefixed(TypeAPIKey)
    fmt.Printf("Prefixed: %s\n", prefixedToken)

    // API Key
    apiGen := NewAPIKeyGenerator("sk", "live")
    apiKey, _, _ := apiGen.Generate()
    fmt.Printf("API Key: %s\n", apiKey)

    // Session token
    sessGen := NewSessionTokenGenerator(24 * time.Hour)
    session, clientToken, _ := sessGen.Generate()
    fmt.Printf("Session: %s (expires: %s)\n", clientToken, session.ExpiresAt)

    // Reset token
    resetGen := NewResetTokenGenerator(1 * time.Hour)
    reset, urlToken, _ := resetGen.Generate("user123")
    fmt.Printf("Reset URL token: %s\n", urlToken)
    fmt.Printf("Reset expires: %s\n", reset.ExpiresAt)
}
```

**Key Implementation Points**:
- Uses crypto/rand exclusively
- Multiple encoding formats (hex, base64, base32)
- Prefixed tokens like Stripe's format
- Configurable entropy (default 256 bits)
- Separation of storage token vs client token
- Built-in expiration handling
- URL-safe encoding for email links

### Junior → FAANG: Implementing Cryptographic Exercises Correctly

Cryptographic exercises are only valuable if you get the details right. A file encryption tool that generates the nonce incorrectly or skips authentication tag verification is worse than no encryption at all because it provides false confidence.

**Gap to close:** For the file encryption exercise, the most common mistake is generating the nonce once and using it for all encrypted files. Generate a fresh nonce with `crypto/rand` for each file, and store it in the encrypted file header alongside the salt. The reader can then extract both to decrypt correctly.

**Testing cryptographic exercises:** Write one test that encrypts and decrypts successfully (happy path), one test that verifies decryption fails when the ciphertext is modified (authentication tag verification), and one test that verifies decryption fails with the wrong key. These three tests validate the security properties, not just the functional correctness.

### Senior @ FAANG: Evaluating Cryptographic Exercise Quality in Interviews

When a candidate presents a cryptographic solution in an interview, evaluate it against the same criteria you would use in a code review: not just "does it encrypt?" but "does it encrypt correctly with correct key management, nonce handling, error handling, and authentication?"

**Evaluation rubric:** The correct AES-GCM implementation includes: fresh `crypto/rand` nonce for each operation, nonce prepended to ciphertext, authentication tag verification on decryption, error return (not panic) on decryption failure, and no hardcoded keys. A solution that passes a functional test but fails any of these criteria has a security defect. In an interview, point out the defect specifically and ask how the candidate would fix it. Their response to feedback is as informative as the initial solution.

**Escalating complexity:** After a candidate solves the basic encryption exercise, escalate: "Now your service runs as 50 instances. How do you handle key rotation without downtime?" This escalation tests whether the candidate understands production cryptographic system design or just cryptographic primitive usage. The answer should include key versioning, concurrent support for old and new key versions during rotation, and a mechanism to track which version was used to encrypt each item.

---
