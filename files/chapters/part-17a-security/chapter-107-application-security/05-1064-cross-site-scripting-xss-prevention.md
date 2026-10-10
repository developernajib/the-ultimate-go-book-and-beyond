## 107.4 Cross-Site Scripting (XSS) Prevention

XSS attacks inject malicious JavaScript into web pages. Go's `html/template` package provides automatic escaping.

### XSS Protection in Templates

Go's `html/template` package provides context-aware escaping that automatically applies the correct encoding based on where the value appears in the document: HTML entity encoding inside element content, attribute encoding inside tag attributes, and JavaScript string encoding inside `<script>` blocks. Unlike `text/template`, which performs no escaping, `html/template` treats all template variables as untrusted by default and requires explicit use of `template.HTML` or `template.JS` to inject pre-sanitized safe content. This design makes XSS the exceptional case that requires deliberate effort, rather than the default outcome of forgetting to escape.

```go
package main

import (
    "html/template"
    "net/http"
)

// WRONG: Using text/template for HTML (no escaping)
// import "text/template" // DON'T USE FOR HTML

// RIGHT: Use html/template for automatic escaping
var templates = template.Must(template.ParseFiles(
    "templates/base.html",
    "templates/profile.html",
))

type UserProfile struct {
    Name    string
    Bio     string
    Website string
}

func ProfileHandler(w http.ResponseWriter, r *http.Request) {
    profile := UserProfile{
        Name:    `<script>alert('XSS')</script>`,
        Bio:     "I love coding & security!",
        Website: `javascript:alert('XSS')`,
    }

    // html/template automatically escapes dangerous content
    templates.ExecuteTemplate(w, "profile.html", profile)

    // Output will be safe:
    // &lt;script&gt;alert(&#39;XSS&#39;)&lt;/script&gt;
}

// Safe HTML when needed (use with extreme caution)
func SafeHTMLExample(w http.ResponseWriter, r *http.Request) {
    data := struct {
        Content  string
        SafeHTML template.HTML // Marks content as safe (use carefully!)
    }{
        Content:  "<script>alert('XSS')</script>", // Will be escaped
        SafeHTML: template.HTML("<strong>This is safe HTML</strong>"), // Won't be escaped
    }

    // Only use template.HTML for content you completely control
    templates.ExecuteTemplate(w, "page.html", data)
}

func main() {
    http.HandleFunc("/profile", ProfileHandler)
    http.HandleFunc("/safe", SafeHTMLExample)
    _ = http.ListenAndServe(":8080", nil)
}
```

### JSON API XSS Protection

For JSON APIs that do not render HTML, XSS prevention shifts from output encoding to security headers: `X-Content-Type-Options: nosniff` prevents browsers from interpreting a JSON response as HTML if the content type is missing or wrong, while `Content-Security-Policy` restricts which scripts can execute if the API response is ever embedded in a page. The `X-Frame-Options: DENY` header prevents the API from being loaded in an `<iframe>` used for clickjacking attacks. These headers complement rather than replace proper content-type headers on every JSON response.

```go
// SetSecurityHeaders adds headers to prevent XSS in JSON APIs
func SetSecurityHeaders(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Prevent MIME type sniffing
        w.Header().Set("X-Content-Type-Options", "nosniff")

        // Set proper content type for JSON
        w.Header().Set("Content-Type", "application/json; charset=utf-8")

        next.ServeHTTP(w, r)
    })
}

// SanitizeUserInput removes dangerous characters before storage
func SanitizeUserInput(input string) string {
    // Remove null bytes
    input = strings.ReplaceAll(input, "\x00", "")

    // Limit length to prevent DoS
    if len(input) > 10000 {
        input = input[:10000]
    }

    return strings.TrimSpace(input)
}
```

### Junior → FAANG: Understanding Why html/template Protects You (and When It Does Not)

Juniors often believe that using `html/template` instead of `text/template` is sufficient XSS protection. It is a strong defense but not unconditional.

**Gap to close:** `html/template` applies context-aware escaping based on where a value is inserted: inside an HTML element, inside an attribute, inside a script block, or inside a URL. But it cannot protect you in every context. If you use `template.HTML(userInput)` to mark content as safe, you have bypassed the protection entirely. If you insert user-controlled data into a JavaScript string literal, you need JS-context escaping. Know the escape contexts and know which ones `html/template` handles automatically versus which require additional care.

**First-job habit:** Never use `template.HTML`, `template.JS`, or `template.URL` with data that comes from user input. These types tell the template engine "I have already sanitized this, trust it." Using them with unsanitized input is the most common XSS mistake in Go web applications.

**Interview framing:** When asked about XSS in Go, explain the two layers: `html/template` for server-side rendering with automatic escaping, and Content Security Policy (CSP) as a browser-level backstop that blocks injected scripts even if a gap exists in your server-side escaping. Two layers is a stronger answer than one.

### Senior @ FAANG: XSS Defense as a Frontend-Backend Contract

At senior level, XSS defense spans the backend, the CDN, the browser, and the API design. A backend-only perspective is incomplete.

**Content Security Policy governance:** A strict CSP (`default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'`) blocks most XSS exploits even when server-side escaping fails. But adopting a strict CSP on an established application requires an audit of all inline scripts, event handlers, and dynamically generated script tags. This is a multi-week project on a large codebase. Plan it as a phased migration: start with CSP in report-only mode, collect violation reports for 30 days, fix each violation, then switch to enforce mode.

**API design and XSS:** If your Go service exposes a REST API consumed by a JavaScript frontend, the frontend is responsible for its own XSS defense (using a framework like React that escapes by default, never using `dangerouslySetInnerHTML` with API data). But the backend controls what the frontend has to work with. Reject rich text inputs that your application does not need. If you must accept HTML (a rich text editor use case), use a server-side HTML sanitizer (`bluemonday` in Go) before storing and before serving. Never store and serve unsanitized HTML.

**Stored vs reflected vs DOM-based:** Senior engineers distinguish between XSS types in their threat models. Stored XSS (malicious payload saved in the database and rendered later) has the highest impact because it affects all users who view the content. Reflected XSS (payload in the URL, rendered in a response without storage) requires a victim to click a crafted link. DOM-based XSS happens entirely in the browser and cannot be prevented by server-side controls: it requires frontend-side fixes. Threat model each type separately and apply controls at the right layer.

**ADR for rich text:** Write an ADR for any feature that requires accepting and rendering user-provided HTML. Document the sanitization library chosen, the allowed element and attribute allowlist, how the allowlist is maintained, and how you test for bypass attempts. This ADR becomes the reference point for all future changes to the allowed elements. Without it, the allowlist grows informally and eventually permits dangerous elements.

**Measurement:** Track CSP violation reports in your observability stack. A spike in violations after a deployment indicates a regression. A sustained low rate of violations from a single endpoint warrants investigation for active probing.

---
