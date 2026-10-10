## Security and Privacy

A social network stores sensitive personal data, so security must be built into every layer of the application. Rate limiting prevents abuse by capping the number of requests a single IP address can make per minute. Authentication middleware verifies JWT tokens on every protected route to ensure only logged-in users can access the API. CORS configuration restricts which domains can make requests to the backend, preventing cross-site attacks. Together, these middleware components form a security boundary that protects every endpoint in the application.

### Rate Limiting

Rate limiting prevents individual users or IP addresses from overwhelming the server with too many requests. The standard limiter allows 100 requests per minute for normal endpoints, while the strict limiter allows only 10 requests per minute for sensitive endpoints like login and registration. This protects against brute-force attacks and accidental denial-of-service from misbehaving clients.

```go
// internal/middleware/ratelimit.go
package middleware

import (
    "net/http"
    "time"

    "github.com/go-chi/httprate"
)

func RateLimit() func(next http.Handler) http.Handler {
    return httprate.LimitByIP(100, 1*time.Minute)
}

func RateLimitStrict() func(next http.Handler) http.Handler {
    return httprate.LimitByIP(10, 1*time.Minute)
}
```

### Authentication Middleware

The authentication middleware intercepts every request to protected routes, extracts the JWT token from the Authorization header, and verifies that it is valid and not expired. If the token is missing or invalid, the request is rejected with a 401 Unauthorized response before it ever reaches the handler. This ensures that all protected endpoints are secured without duplicating authentication logic in every handler.

```go
// internal/middleware/auth.go
package middleware

import (
    "net/http"

    "github.com/go-chi/jwtauth/v5"
)

func Authenticator(ja *jwtauth.JWTAuth) func(next http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return jwtauth.Verify(ja, jwtauth.TokenFromHeader)(
            jwtauth.Authenticator(ja)(next),
        )
    }
}
```

### CORS Configuration

Cross-Origin Resource Sharing (CORS) controls which web domains are allowed to make requests to your API. Without CORS configuration, browsers will block frontend applications hosted on a different domain from calling your backend. The configuration below explicitly lists the allowed origin, HTTP methods, and headers, which prevents unauthorized websites from making requests on behalf of your users.

```go
// internal/middleware/cors.go
package middleware

import (
    "github.com/go-chi/cors"
    "net/http"
)

func CORS() func(next http.Handler) http.Handler {
    return cors.Handler(cors.Options{
        AllowedOrigins:   []string{"https://yourdomain.com"},
        AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
        AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
        ExposedHeaders:   []string{"Link"},
        AllowCredentials: true,
        MaxAge:           300,
    })
}
```

---

### Junior → FAANG: Security and Privacy Fundamentals for Social Platforms

Security in a social network has unique properties compared to internal tooling: users control access to their own data, and the privacy model is a product feature as much as a technical requirement. Junior candidates frequently miss the difference between authentication (are you who you say you are) and authorization (are you allowed to see this post).

Build the habit of asking "who can see this?" for every endpoint you write. A post marked "friends only" must not be returned by the public API, not even with the content redacted. Returning the post ID leaks that the post exists. The authorization check must filter at the query level, not the serialization level, to prevent enumeration attacks.

Prerequisite gap: understand what CORS actually protects (same-origin policy in browsers) and what it does not protect (direct HTTP clients, mobile apps, curl). CORS is a browser safety net, not an API security boundary. Rate limiting and authentication are your actual defenses.

Entry-level interview framing: when asked about security for a social API, lead with authentication (JWT validation on every request), authorization (resource-level permission checks), input validation (reject malformed payloads at the boundary), and rate limiting (per-user, per-IP). These four give you a credible junior answer.

### Senior @ FAANG: Privacy Engineering and Security Governance at Scale

At FAANG, privacy is a regulated engineering discipline, not a checkbox. GDPR, CCPA, and platform-specific regulations create legal obligations that translate directly into architectural requirements. The L6 framing is: what are our data minimization obligations, how do we enforce them technically, and how do we audit compliance?

**Data classification system.** Before writing privacy controls, classify every data field. Common tiers: PII (name, email, phone, IP address), sensitive PII (biometric data, health data, political affiliation), content (posts, messages, media), behavioral (click streams, session events), and derived (model outputs, inferred interests). Each classification tier has different retention policies, access control requirements, and cross-border transfer restrictions. This classification schema must be maintained as a service-level data inventory, not ad-hoc documentation.

**Privacy-by-design in the data model.** Senior engineers enforce privacy at the data model level, not purely at the API layer. Pseudonymization separates user identity from behavioral data: behavioral tables reference an opaque user_token, not the user_id directly. A mapping table (user_id to user_token) is accessible only to the identity service. If behavioral data is leaked, it cannot be directly attributed to a real user without compromising the mapping table separately. This is a structural privacy control, not a policy control.

**Right-to-erasure implementation.** GDPR article 17 requires the ability to delete all data for a user on request within 30 days. This is architecturally non-trivial in an event-sourced or append-only system. The senior approach: define a user deletion pipeline that (1) anonymizes the user record (replace PII fields with tombstone values), (2) publishes a deletion event to all downstream consumers, (3) runs soft deletes on content tables with hard deletes after 30 days, (4) purges derived data from ML feature stores, (5) invalidates cached copies across the CDN and application caches, and (6) writes a deletion receipt to an audit log. The pipeline must be idempotent and resumable since it touches many systems.

**Security incident response posture.** At L6, you define the security posture before incidents occur: what is the blast radius of a compromised API key, how quickly can you rotate credentials, what is the detection time for an anomalous access pattern. Define these in a threat model document and map each threat to a detective control (alert), preventive control (rate limiting, ACL), and corrective control (key rotation procedure). FAANG engineering reviews expect candidates to have pre-defined runbooks for the top 5 security incident scenarios for their service.

**Authorization at the query layer.** The highest-risk authorization failure in social networks is fan-out enumeration: a user queries a public endpoint with slight variations to infer the existence of private resources. At staff level, the control is to enforce authorization predicates inside the database query (row-level security in PostgreSQL, or mandatory filter injection in the repository layer) so that unauthorized resources are never fetched from storage. Authorization at the serialization layer is insufficient because it still loads unauthorized data into memory, potentially exposing it through timing side-channels or error messages.
