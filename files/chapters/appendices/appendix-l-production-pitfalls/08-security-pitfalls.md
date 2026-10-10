## Security Pitfalls

Writing secure Go services requires understanding how language ergonomics and standard library primitives interact with security boundaries. Go is immune to classic buffer overflows, but web application vulnerabilities—timing attacks, SQL injection, path traversal, and SSRF—frequently compromise production deployments.

---

### 1. Timing Attacks on Secret Token Comparison

#### Root Cause Mechanics
Comparing secrets (API keys, password hashes, HMAC signatures, webhook tokens) with the standard `==` operator or `bytes.Equal` performs byte-by-byte comparison that **terminates early** upon encountering the first non-matching byte. An attacker measuring request response latency with microsecond precision over thousands of requests can deduce the secret character-by-character.

#### Vulnerable Code
```go
// DANGEROUS: Early-exit comparison leaks timing information!
func VerifyWebhookSignature(clientSig, expectedSig string) bool {
    return clientSig == expectedSig // Timing attack vulnerability!
}
```

#### Production-Grade Solution
```go
import "crypto/subtle"

// FIX: Always use crypto/subtle.ConstantTimeCompare
func VerifyWebhookSignature(clientSig, expectedSig string) bool {
    // ConstantTimeCompare takes execution time proportional to length, regardless of content
    if len(clientSig) != len(expectedSig) {
        return false
    }
    return subtle.ConstantTimeCompare([]byte(clientSig), []byte(expectedSig)) == 1
}
```

---

### 2. Path Traversal & Unsafe `filepath.Join`

#### Root Cause Mechanics
A common misconception is that `filepath.Clean` or `filepath.Join` prevents directory traversal attacks. In Go, `filepath.Join("/var/www/uploads", userInput)` can resolve to `"/etc/passwd"` if `userInput` is `"../../../../etc/passwd"`.

#### Vulnerable Code
```go
// DANGEROUS: Allows reading arbitrary system files!
func ServeFile(w http.ResponseWriter, r *http.Request) {
    fileName := r.URL.Query().Get("file") // e.g., "../../../../etc/passwd"
    targetPath := filepath.Join("/var/www/uploads", fileName)
    data, _ := os.ReadFile(targetPath)
    w.Write(data)
}
```

#### Production-Grade Solution
```go
func ServeFileSafe(w http.ResponseWriter, r *http.Request) {
    baseDir := "/var/www/uploads"
    fileName := r.URL.Query().Get("file")

    // 1. Clean path
    cleaned := filepath.Clean(fileName)

    // 2. Combine and resolve absolute path
    fullPath := filepath.Join(baseDir, cleaned)

    // 3. Verify that the resolved path is strictly within the allowed base directory
    rel, err := filepath.Rel(baseDir, fullPath)
    if err != nil || strings.HasPrefix(rel, "..") || strings.HasPrefix(rel, string(filepath.Separator)) {
        http.Error(w, "access denied: directory traversal attempt", http.StatusForbidden)
        return
    }

    http.ServeFile(w, r, fullPath)
}
```

---

### 3. Server-Side Request Forgery (SSRF) in HTTP Clients

#### Root Cause Mechanics
If your application accepts a URL from a user (e.g. avatar import, webhook endpoint) and makes an outbound HTTP request, an attacker can pass `http://169.254.169.254/latest/meta-data/` (AWS instance metadata) or `http://127.0.0.1:6379` (internal Redis) to extract cloud credentials or pivot into internal networks.

#### Production-Grade Solution
Validate the resolved IP address before dialing:
```go
var safeTransport = &http.Transport{
    DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
        host, port, err := net.SplitHostPort(addr)
        if err != nil {
            return nil, err
        }

        ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
        if err != nil {
            return nil, err
        }

        for _, ip := range ips {
            // Block private, loopback, and link-local IP addresses
            if ip.IP.IsPrivate() || ip.IP.IsLoopback() || ip.IP.IsLinkLocalUnicast() {
                return nil, fmt.Errorf("SSRF blocked: address %s is private", ip.IP)
            }
        }

        return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
    },
}
```
