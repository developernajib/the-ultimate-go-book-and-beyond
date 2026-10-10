## 107.15 Exercises with Solutions

### Exercise 1: Implement Secure File Upload

**Problem**: Build a secure file upload endpoint that validates file type, size, and content.

```go
// Solution: Secure file upload handler
package uploads

import (
    "bytes"
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "net/http"
    "path/filepath"
    "strings"
    "time"
)

// FileUploadConfig defines upload constraints
type FileUploadConfig struct {
    MaxSize           int64
    AllowedTypes      map[string][]byte // MIME type -> magic bytes
    AllowedExtensions []string
    StoragePath       string
}

func DefaultConfig() FileUploadConfig {
    return FileUploadConfig{
        MaxSize: 10 << 20, // 10MB
        AllowedTypes: map[string][]byte{
            "image/jpeg": {0xFF, 0xD8, 0xFF},
            "image/png":  {0x89, 0x50, 0x4E, 0x47},
            "image/gif":  {0x47, 0x49, 0x46, 0x38},
            "application/pdf": {0x25, 0x50, 0x44, 0x46},
        },
        AllowedExtensions: []string{".jpg", ".jpeg", ".png", ".gif", ".pdf"},
        StoragePath:       "/var/uploads",
    }
}

// SecureFileUploader handles file uploads securely
type SecureFileUploader struct {
    config FileUploadConfig
}

func NewSecureFileUploader(config FileUploadConfig) *SecureFileUploader {
    return &SecureFileUploader{config: config}
}

// HandleUpload processes a file upload securely
func (u *SecureFileUploader) HandleUpload(w http.ResponseWriter, r *http.Request) {
    // Step 1: Limit request body size
    r.Body = http.MaxBytesReader(w, r.Body, u.config.MaxSize)

    // Step 2: Parse multipart form
    if err := r.ParseMultipartForm(u.config.MaxSize); err != nil {
        http.Error(w, "file too large", http.StatusBadRequest)
        return
    }

    // Step 3: Get file from form
    file, header, err := r.FormFile("file")
    if err != nil {
        http.Error(w, "no file provided", http.StatusBadRequest)
        return
    }
    defer file.Close()

    // Step 4: Validate file extension
    ext := strings.ToLower(filepath.Ext(header.Filename))
    if !u.isAllowedExtension(ext) {
        http.Error(w, "file type not allowed", http.StatusBadRequest)
        return
    }

    // Step 5: Read file content (for validation)
    content, err := io.ReadAll(file)
    if err != nil {
        http.Error(w, "error reading file", http.StatusInternalServerError)
        return
    }

    // Step 6: Validate content type by magic bytes (not Content-Type header!)
    detectedType, err := u.detectContentType(content)
    if err != nil {
        http.Error(w, "invalid file content", http.StatusBadRequest)
        return
    }

    // Step 7: Verify detected type matches expected extension
    if !u.typeMatchesExtension(detectedType, ext) {
        http.Error(w, "file content does not match extension", http.StatusBadRequest)
        return
    }

    // Step 8: Scan for malicious content (basic checks)
    if err := u.scanContent(content); err != nil {
        http.Error(w, "file contains potentially malicious content", http.StatusBadRequest)
        return
    }

    // Step 9: Generate safe filename (prevent path traversal)
    safeFilename := u.generateSafeFilename(header.Filename)

    // Step 10: Store file
    storagePath, err := u.storeFile(safeFilename, content)
    if err != nil {
        http.Error(w, "error storing file", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{
        "filename": safeFilename,
        "path":     storagePath,
        "size":     fmt.Sprintf("%d", len(content)),
        "type":     detectedType,
    })
}

// detectContentType identifies file type by magic bytes
func (u *SecureFileUploader) detectContentType(content []byte) (string, error) {
    for mimeType, magicBytes := range u.config.AllowedTypes {
        if len(content) >= len(magicBytes) {
            if bytes.Equal(content[:len(magicBytes)], magicBytes) {
                return mimeType, nil
            }
        }
    }
    return "", errors.New("unrecognized file type")
}

// scanContent checks for malicious patterns
func (u *SecureFileUploader) scanContent(content []byte) error {
    contentStr := string(content)

    // Check for script tags (in case of disguised HTML)
    maliciousPatterns := []string{
        "<script", "<?php", "<%", "javascript:",
        "onerror=", "onload=", "onclick=",
    }

    lower := strings.ToLower(contentStr)
    for _, pattern := range maliciousPatterns {
        if strings.Contains(lower, pattern) {
            return errors.New("potentially malicious content detected")
        }
    }

    return nil
}

// generateSafeFilename creates a safe filename using hash
func (u *SecureFileUploader) generateSafeFilename(original string) string {
    // Hash original filename to prevent path traversal
    hash := sha256.Sum256([]byte(original + time.Now().String()))
    hashStr := hex.EncodeToString(hash[:8]) // First 8 bytes = 16 chars

    // Keep original extension (already validated)
    ext := filepath.Ext(original)

    return hashStr + ext
}

func (u *SecureFileUploader) isAllowedExtension(ext string) bool {
    for _, allowed := range u.config.AllowedExtensions {
        if ext == allowed {
            return true
        }
    }
    return false
}

func (u *SecureFileUploader) typeMatchesExtension(mimeType, ext string) bool {
    validCombos := map[string][]string{
        "image/jpeg":      {".jpg", ".jpeg"},
        "image/png":       {".png"},
        "image/gif":       {".gif"},
        "application/pdf": {".pdf"},
    }

    if exts, ok := validCombos[mimeType]; ok {
        for _, e := range exts {
            if ext == e {
                return true
            }
        }
    }
    return false
}

func (u *SecureFileUploader) storeFile(filename string, content []byte) (string, error) {
    target := filepath.Join(u.config.StoragePath, filename)
    return target, nil
}
```

---

### Exercise 2: Build SSRF Protection

**Problem**: Implement protection against Server-Side Request Forgery (SSRF) attacks.

```go
// Solution: SSRF-safe URL fetcher
package security

import (
    "context"
    "errors"
    "io"
    "net"
    "net/http"
    "net/url"
    "strconv"
    "strings"
    "time"
)

var (
    ErrInvalidURL      = errors.New("invalid URL")
    ErrBlockedHost     = errors.New("host is blocked")
    ErrPrivateIP       = errors.New("private IP addresses not allowed")
    ErrInvalidScheme   = errors.New("only http and https allowed")
    ErrBlockedPort     = errors.New("port not allowed")
)

// SSRFProtector validates URLs to prevent SSRF attacks
type SSRFProtector struct {
    allowedHosts   []string // Explicit allowlist
    blockedHosts   []string // Explicit blocklist
    allowedPorts   []int
    allowPrivateIP bool
    client         *http.Client
}

func NewSSRFProtector() *SSRFProtector {
    return &SSRFProtector{
        allowedPorts:   []int{80, 443},
        allowPrivateIP: false,
        client: &http.Client{
            Timeout: 10 * time.Second,
            CheckRedirect: func(req *http.Request, via []*http.Request) error {
                // Limit redirects and validate each hop
                if len(via) >= 3 {
                    return errors.New("too many redirects")
                }
                return nil
            },
        },
    }
}

// ValidateURL checks if a URL is safe to fetch
func (p *SSRFProtector) ValidateURL(rawURL string) error {
    // Step 1: Parse URL
    parsed, err := url.Parse(rawURL)
    if err != nil {
        return ErrInvalidURL
    }

    // Step 2: Validate scheme
    if parsed.Scheme != "http" && parsed.Scheme != "https" {
        return ErrInvalidScheme
    }

    // Step 3: Extract and validate host
    host := parsed.Hostname()
    if host == "" {
        return ErrInvalidURL
    }

    // Step 4: Check blocklist
    for _, blocked := range p.blockedHosts {
        if strings.EqualFold(host, blocked) || strings.HasSuffix(host, "."+blocked) {
            return ErrBlockedHost
        }
    }

    // Step 5: Check dangerous hostnames
    dangerousHosts := []string{
        "localhost", "127.0.0.1", "::1",
        "0.0.0.0", "169.254.169.254", // AWS metadata
        "metadata.google.internal",    // GCP metadata
        "metadata.azure.com",          // Azure metadata
    }
    for _, dangerous := range dangerousHosts {
        if strings.EqualFold(host, dangerous) {
            return ErrPrivateIP
        }
    }

    // Step 6: Resolve hostname and check IP
    ips, err := net.LookupIP(host)
    if err != nil {
        return ErrInvalidURL
    }

    for _, ip := range ips {
        if !p.allowPrivateIP && isPrivateIP(ip) {
            return ErrPrivateIP
        }
    }

    // Step 7: Validate port
    port := parsed.Port()
    if port != "" {
        portNum, _ := strconv.Atoi(port)
        if !p.isAllowedPort(portNum) {
            return ErrBlockedPort
        }
    }

    return nil
}

// SafeFetch retrieves content from a URL after validation
func (p *SSRFProtector) SafeFetch(ctx context.Context, rawURL string) ([]byte, error) {
    // Validate URL before fetching
    if err := p.ValidateURL(rawURL); err != nil {
        return nil, err
    }

    req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
    if err != nil {
        return nil, err
    }

    // Custom transport that validates IPs on connection
    transport := &http.Transport{
        DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
            host, port, _ := net.SplitHostPort(addr)

            // Resolve again just before connecting (TOCTOU protection)
            ips, err := net.LookupIP(host)
            if err != nil {
                return nil, err
            }

            for _, ip := range ips {
                if !p.allowPrivateIP && isPrivateIP(ip) {
                    return nil, ErrPrivateIP
                }
            }

            // Connect to resolved IP
            dialer := &net.Dialer{Timeout: 10 * time.Second}
            return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
        },
    }

    client := &http.Client{
        Transport: transport,
        Timeout:   30 * time.Second,
        CheckRedirect: func(req *http.Request, via []*http.Request) error {
            // Validate each redirect URL
            if err := p.ValidateURL(req.URL.String()); err != nil {
                return err
            }
            if len(via) >= 3 {
                return errors.New("too many redirects")
            }
            return nil
        },
    }

    resp, err := client.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    // Limit response size
    limitedReader := io.LimitReader(resp.Body, 10<<20) // 10MB
    return io.ReadAll(limitedReader)
}

// isPrivateIP checks if an IP is private/internal
func isPrivateIP(ip net.IP) bool {
    if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
        return true
    }

    privateBlocks := []string{
        "10.0.0.0/8",     // Private
        "172.16.0.0/12",  // Private
        "192.168.0.0/16", // Private
        "169.254.0.0/16", // Link-local
        "fc00::/7",       // IPv6 private
        "fe80::/10",      // IPv6 link-local
    }

    for _, block := range privateBlocks {
        _, cidr, _ := net.ParseCIDR(block)
        if cidr.Contains(ip) {
            return true
        }
    }

    return false
}

func (p *SSRFProtector) isAllowedPort(port int) bool {
    for _, allowed := range p.allowedPorts {
        if port == allowed {
            return true
        }
    }
    return false
}
```

### Junior → FAANG: Getting Maximum Value From Security Exercises

Security exercises are most valuable when you do not look at the solution first. The act of attempting the problem independently, then comparing your approach to the solution, reveals your gaps more clearly than reading the solution alone.

**Gap to close:** After completing each exercise, ask: does my solution handle error cases securely? Does it log the right information? Does it reject invalid input before processing? Is it testable? These four questions applied to every exercise build the habits that carry into production code.

**First-job habit:** Implement each exercise solution in a running Go project and write at least two tests: one for the happy path and one for an adversarial input (oversized payload, malicious characters, path traversal attempt). The adversarial test is what separates security-aware code from functional-but-insecure code.

### Senior @ FAANG: Using Exercises to Build Team Security Competency

At senior level, these exercises are training material for your team, not just personal practice. Running a team exercise session where engineers implement a secure file upload handler and then review each other's solutions produces more learning than a security lecture.

**Code review as a teaching tool:** Assign these exercises as part of a security-focused sprint. Conduct structured code reviews with a security lens: "What happens if the file extension is `.php.jpg`? What happens if the Content-Type header lies about the file type? What is the maximum file size and what happens when it is exceeded?" Walking the team through these questions builds the security review instinct that produces safer code in all contexts.

**Difficulty gradient:** Use these exercises to calibrate team competency. If the team struggles with file upload validation, that signals a training need in input validation. If they solve it easily but miss rate limiting on the upload endpoint, that signals a gap in thinking about abuse scenarios. Use the results to target your security training investment.

---
