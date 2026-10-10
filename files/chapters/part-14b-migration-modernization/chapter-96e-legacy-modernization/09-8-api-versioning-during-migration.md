## 8. API Versioning During Migration

API versioning allows old and new clients to coexist during migration without forcing simultaneous upgrades. When you modernize a service, the new implementation often changes the API contract: fields get renamed, response shapes evolve, and new capabilities are added. Without versioning, every client must upgrade simultaneously, which is impractical for external APIs. The versioned router below supports two mechanisms: URL path versioning (for example `/v1/users` vs `/v2/users`) and an `API-Version` header for clients that prefer content negotiation. Old versions receive deprecation headers so that client teams know the sunset timeline and can plan their migration accordingly.

```go
// file: internal/apiversion/router.go
package apiversion

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"
)

// Version represents a semantic API version.
type Version struct {
	Major int
	Minor int
}

func (v Version) String() string {
	return fmt.Sprintf("v%d.%d", v.Major, v.Minor)
}

// ParseVersion parses "v1", "v2", or "v1.2" from a path segment or header.
func ParseVersion(s string) (Version, error) {
	s = strings.TrimPrefix(s, "v")
	parts := strings.SplitN(s, ".", 2)
	var v Version
	if _, err := fmt.Sscanf(parts[0], "%d", &v.Major); err != nil {
		return Version{}, fmt.Errorf("parse version major: %w", err)
	}
	if len(parts) > 1 {
		if _, err := fmt.Sscanf(parts[1], "%d", &v.Minor); err != nil {
			return Version{}, fmt.Errorf("parse version minor: %w", err)
		}
	}
	return v, nil
}

// Handler is an http.Handler for a specific API version.
type Handler struct {
	Version Version
	Handler http.Handler
}

// VersionedRouter routes requests to the appropriate handler based on URL path version prefix.
type VersionedRouter struct {
	handlers       []Handler
	defaultVersion Version
	logger         *slog.Logger
	mux            *http.ServeMux
}

// NewVersionedRouter creates a router with registered version handlers.
func NewVersionedRouter(handlers []Handler, defaultVersion Version, logger *slog.Logger) *VersionedRouter {
	vr := &VersionedRouter{
		handlers:       handlers,
		defaultVersion: defaultVersion,
		logger:         logger,
		mux:            http.NewServeMux(),
	}
	for _, h := range handlers {
		prefix := "/" + h.Version.String()
		stripped := http.StripPrefix(prefix, h.Handler)
		vr.mux.Handle(prefix+"/", stripped)
		logger.Info("registered API version", "version", h.Version.String(), "prefix", prefix)
	}
	return vr
}

// ServeHTTP dispatches to the version-specific handler.
func (vr *VersionedRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Support version in path (/v1/users) or header (API-Version: v2).
	version, err := vr.extractVersion(r)
	if err != nil {
		http.Error(w, "invalid API version", http.StatusBadRequest)
		return
	}

	vr.logger.Debug("API version resolved",
		"path", r.URL.Path,
		"version", version.String(),
	)

	w.Header().Set("API-Version", version.String())
	w.Header().Set("Deprecation", vr.getDeprecationNotice(version))

	vr.mux.ServeHTTP(w, r)
}

// extractVersion determines the API version from the path or header.
func (vr *VersionedRouter) extractVersion(r *http.Request) (Version, error) {
	// Try header first for non-path-versioned clients.
	if h := r.Header.Get("API-Version"); h != "" {
		return ParseVersion(h)
	}
	// Extract from path prefix /v1/, /v2/, etc.
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 2)
	if len(parts) > 0 && strings.HasPrefix(parts[0], "v") {
		v, err := ParseVersion(parts[0])
		if err == nil {
			return v, nil
		}
	}
	return vr.defaultVersion, nil
}

// getDeprecationNotice returns a deprecation header value for old versions.
func (vr *VersionedRouter) getDeprecationNotice(v Version) string {
	// In production, drive this from a config, not hardcode.
	if v.Major == 1 {
		return `true; sunset="2025-12-31T00:00:00Z"`
	}
	return ""
}

// VersionNegotiatingMiddleware wraps a handler to rewrite old request shapes
// into the canonical new format, enabling backward compatibility.
func VersionNegotiatingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// In a real migration, transform old request payloads here.
		// Example: rename field "user_name" -> "name" for v1 callers.
		next.ServeHTTP(w, r)
	})
}
```

### Junior → FAANG: API Versioning as a Backward-Compatibility Contract

API versioning during migration is the mechanism that prevents the "flag day" problem: the requirement that all clients upgrade simultaneously when the API changes. For internal clients at a single company, flag day is annoying but manageable. For external APIs, flag day is a customer relationship problem that can destroy trust.

The deprecation header approach in this implementation is worth adopting as a standard practice even outside migration contexts. Sending `Deprecation` and `Sunset` headers on responses from old API versions gives client teams the information they need to plan their upgrades without requiring you to track down every client and tell them individually. It is the machine-readable equivalent of a formal deprecation notice.

For Go engineers: the content negotiation approach using the `API-Version` header is slightly more complex to implement than URL path versioning but is more semantically correct for APIs where the version represents a negotiated format rather than a fundamentally different resource path. Understanding the tradeoffs between the two approaches and being able to articulate them is an entry-level API design competency.

### Senior @ FAANG: API Versioning Governance and the Sunset Timeline

At senior level, API versioning is a governance discipline that extends across organizational boundaries. The technical implementation in this section is straightforward. The governance challenge is defining and enforcing the sunset timeline: when is an old API version actually removed, and how is that timeline communicated to and enforced across all clients.

The governance framework: before releasing a new API version, define the sunset date for the old version. This date must be published in the API documentation, communicated to all known clients, and enforced by a sunset monitoring process that tracks which clients are still calling old versions as the sunset date approaches. The deprecation header is the technical mechanism. The governance process is the combination of the header, the client tracking, the communication plan, and the enforcement mechanism.

At senior level, the API versioning strategy is an ADR-level decision. The choice between URL path versioning and header-based versioning has long-term implications for how clients discover and negotiate versions, how the router scales to multiple versions, and how versions are tested and deployed. These implications extend beyond any single migration and should be documented as an organizational standard.

---
