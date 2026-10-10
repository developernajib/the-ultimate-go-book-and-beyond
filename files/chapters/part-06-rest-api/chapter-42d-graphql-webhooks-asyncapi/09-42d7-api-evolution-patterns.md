## 42D.7 API Evolution Patterns

### The Rules of Additive Evolution

Three rules keep an API evolvable without a `v2`:

1. **Additive is safe.** New optional fields, new endpoints, and new enum values (when the client has an `unknown` fallback) never break a conforming client. Design schemas so enum additions and new optional fields are backward-compatible from day one.
2. **Tombstone fields, don't delete them.** When a field must disappear, keep it in the schema with a `deprecated` marker and a pointer in the docs to the replacement. Remove only after logs show zero traffic against it for a full deprecation window (typically 2 sunset cycles). Deletions are the single most common cause of production outages from API changes.
3. **Gate behavior changes behind feature flags.** A *behavior* change (`GET /orders` now returns only non-archived orders by default) is a silent break: the shape is identical, but callers see a different world. Ship it behind a flag (`?include_archived=true` or an `X-Api-Version: 2026-04-01` header) so new clients opt in and old clients keep their existing behavior. Stripe's dated API versions are the canonical implementation.

These three rules plus the expand-contract sequence below cover 90% of schema evolution without ever cutting a `/v2` URL.

### Expand-Contract Pattern

The expand phase populates both the original `name` field and the new structured `first_name`/`last_name` fields simultaneously so old clients continue to parse `name` while new clients read the structured version. Once all known consumers have migrated, the contract phase removes `name` in a new version. That yields two discrete deployable steps rather than one atomic breaking change.

```go
// Phase 1 (Expand): Add new fields alongside old fields
// Never remove fields - only add
type UserResponseV2 struct {
	// Original field (kept for backward compat)
	Name      string `json:"name"`
	// New structured fields
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	// New optional field - nil if not set
	Phone     *string `json:"phone,omitempty"`
}

// Handler populates both old and new fields during migration period
func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
	user := h.repo.Get(chi.URLParam(r, "id"))
	resp := UserResponseV2{
		Name:      user.FirstName + " " + user.LastName, // backward compat
		FirstName: user.FirstName,
		LastName:  user.LastName,
	}
	json.NewEncoder(w).Encode(resp)
}

// Phase 3 (Contract): Remove old field - ONLY after confirming zero usage
// Monitor `name` field reads in API logs before removing
type UserResponseV3 struct {
	FirstName string  `json:"first_name"`
	LastName  string  `json:"last_name"`
	Phone     *string `json:"phone,omitempty"`
}
```

### Sunset Header Middleware (RFC 8594)

RFC 8594 defines a `Sunset` HTTP header that tells clients when an endpoint will stop working. The middleware below checks each incoming request against a map of deprecated paths and injects the `Sunset`, `Deprecation`, and `Link` headers automatically. It also logs every call to a deprecated endpoint so you can monitor which clients still depend on old versions.

```go
type DeprecationConfig struct {
	SunsetDate   time.Time
	SuccessorURL string
}

var deprecatedPaths = map[string]DeprecationConfig{
	"/api/v1/users": {
		SunsetDate:   time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		SuccessorURL: "https://api.example.com/api/v2/users",
	},
	"/api/v1/orders": {
		SunsetDate:   time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC),
		SuccessorURL: "https://api.example.com/api/v2/orders",
	},
}

func DeprecationMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check path prefix matches
		for path, config := range deprecatedPaths {
			if strings.HasPrefix(r.URL.Path, path) {
				// RFC 8594 Sunset header
				w.Header().Set("Sunset", config.SunsetDate.Format(http.TimeFormat))
				// RFC 8288 Link header for successor
				w.Header().Set("Link", fmt.Sprintf(`<%s>; rel="successor-version"`, config.SuccessorURL))
				// Deprecation header
				w.Header().Set("Deprecation", config.SunsetDate.Format(time.RFC3339))

				slog.Warn("deprecated endpoint called",
					"path", r.URL.Path,
					"sunset", config.SunsetDate,
					"caller_ip", r.RemoteAddr,
					"user_agent", r.Header.Get("User-Agent"),
				)
				break
			}
		}

		next.ServeHTTP(w, r)
	})
}
```

### Consumer-Driven Contract Testing

In consumer-driven contracts, the consuming service defines what it expects from the provider, and the provider verifies those expectations in its own CI pipeline. The `pact-go` library automates this: the consumer test records interactions against a mock provider, and the provider test replays those interactions against the real service to confirm compatibility.

```go
// pact-go: consumer writes the contract, provider verifies it
// go get github.com/pact-foundation/pact-go/v2

func TestNotificationServiceConsumer(t *testing.T) {
	mockProvider, err := NewV2Pact(MockHTTPProviderConfig{
		Consumer: "notification-service",
		Provider: "order-service",
	})
	require.NoError(t, err)

	t.Run("get order for notification", func(t *testing.T) {
		mockProvider.
			AddInteraction().
			Given("order order-123 exists and is confirmed").
			UponReceiving("notification service requests order order-123").
			WithRequest(Request{
				Method: "GET",
				Path:   S("/orders/order-123"),
			}).
			WillRespondWith(Response{
				Status: 200,
				Body: Map{
					"id":          S("order-123"),
					"status":      S("confirmed"),
					"customer_id": S("cust-456"),
					"total_cents": Like(9999),
				},
			})

		// Run test against mock
		err := mockProvider.ExecuteTest(t, func(config MockServerConfig) error {
			client := NewOrderClient(config.Host)
			order, err := client.GetOrder("order-123")
			if err != nil {
				return err
			}
			assert.Equal(t, "order-123", order.ID)
			assert.Equal(t, "confirmed", order.Status)
			return nil
		})
		assert.NoError(t, err)
	})
}

// Provider verification (run by order-service CI)
func TestOrderServiceProvider(t *testing.T) {
	verifier := HTTPReverseProxyProviderVerifier{}
	_, err := verifier.VerifyProvider(t, VerifyRequest{
		ProviderBaseURL:            "http://localhost:8080",
		BrokerURL:                  "https://pact-broker.internal",
		PublishVerificationResults: true,
		ProviderVersion:            os.Getenv("GIT_SHA"),
		StateHandlers: StateHandlers{
			"order order-123 exists and is confirmed": func(setup bool, s ProviderStateV3) (ProviderStateV3Response, error) {
				if setup {
					testDB.Exec("INSERT INTO orders ... WHERE id = 'order-123'")
				}
				return ProviderStateV3Response{}, nil
			},
		},
	})
	assert.NoError(t, err)
}
```

---

### Junior → FAANG: Breaking API Changes and Why They Cost More Than You Think

Most early-career engineers think of API versioning as a URL prefix problem. The actual challenge is behavioral compatibility over time, which is subtler and more expensive to get wrong.

**Additive versus breaking changes: the field-level view.** Adding a new optional field to a JSON response is safe for existing clients that ignore unknown fields. Removing a field breaks any client that reads it. Renaming a field is a remove plus an add, so it breaks clients on the remove side. Changing a field's type (string to integer) breaks parsing. Adding a required field to a request body breaks clients that do not send it. Memorize this table. You will need it to answer "is this change backward compatible?" in code reviews for the rest of your career.

**The expand-contract sequence prevents big-bang migrations.** Instead of releasing `v2` with a renamed field and immediately removing `name` from `v1`, the expand phase populates both `name` and `first_name`/`last_name` simultaneously. Clients migrate at their own pace. The contract phase removes `name` only after logs confirm zero reads. This is how you evolve a schema without coordinating releases across all consumers simultaneously.

**Sunset headers are a communication protocol, not a nicety.** RFC 8594 `Sunset` headers tell automated clients (not just human developers reading docs) when an endpoint will stop working. API clients built on platforms like Zapier, Make, or internal automation tools can inspect these headers and surface alerts. Implement them from the first day of deprecation, not the week before sunset.

**Interview entry point.** "How do you deprecate an API without breaking clients?" is a standard system design interview question. Cover: sunset headers, expand-contract migration, consumer-driven contract tests to detect breakage early, and access log monitoring to confirm zero traffic before removal. Candidates who can walk through all four stages demonstrate operational maturity.

**First-job habits.** Before merging any schema change, ask "what happens to a client running the current version that receives this new response?" and "what happens to a server running the current version that receives a request from a client using the new schema?" Both directions matter.

---

### Senior @ FAANG: API Evolution as Platform Governance

API evolution at FAANG scale involves hundreds of internal consumers, dozens of external partners, and contracts that span years. The patterns in this section are the operational reality of maintaining that surface.

**Architectural Decision Record: URL versioning vs. header versioning vs. dated versions.**
URL versioning (`/v1/`, `/v2/`) is explicit, easy to route in proxies, and visible in logs. The cost is that it creates a full copy of the API surface that must be maintained in parallel. Header versioning (`Accept: application/vnd.api+json;version=2`) keeps URLs clean but is invisible to proxies and CDNs, complicating cache key design. Dated versions (Stripe's `Stripe-Version: 2024-06-20`) are the most granular: each breaking change gets its own date, clients pin to a date, and the server applies the behavioral delta for that date's contract. Dated versions are operationally complex to implement correctly (each date creates a new behavioral fork in the request handler) but give clients the finest-grained migration control. Choose URL versioning for public APIs where developer experience matters most. Choose dated versions when your customers are large enterprises with long migration timelines and you need to be able to tell them exactly which date's contract they are pinned to.

**Consumer-driven contract testing as a deployment gate.** Pact contracts published to a broker should be a required check in the provider's CI pipeline before any deploy to production. When a provider change would break a registered consumer contract, the build fails. This shifts contract breakage detection from "production incident reported by a customer" to "CI failure before merge." The precondition is that all significant consumers have published their contracts to the shared broker. Making this a team expectation (not just a recommendation) is a governance decision that requires engineering leadership sponsorship.

**Behavioral deprecation is harder than schema deprecation.** Removing a field is detectable by linters and type systems. Changing the meaning of an existing field (the `status` field now excludes archived orders) is invisible to all static analysis. This is the class of change most likely to cause a silent production incident. Senior engineers treat behavioral changes as breaking changes and gate them behind feature flags or dated version headers, never deploying them to all callers simultaneously.

**Access log-based deprecation monitoring.** Before any sunset date, build a dashboard that shows request volume to each deprecated endpoint or field, broken down by caller identity (API key, service name, user agent). This answers the critical question: "who is still using this?" without requiring you to find and contact every consumer manually. At L6/L7, you present this dashboard to your skip-level before confirming a sunset date. Surprises at sunset time are a process failure, not just a technical one.

**Multi-team deprecation coordination.** When a deprecated endpoint has consumers across ten teams, the engineering work of coordinating the migration is often larger than the technical work of the change itself. Mature platform teams build self-service tooling: a migration guide with code samples, an automated scanner that identifies usages in internal codebases, a Slack bot that alerts teams when their service calls a sunset-approaching endpoint, and a migration tracker in the developer portal. The cost of building this tooling is repaid the first time you complete a major deprecation without a production incident.

**Staff-level concern: API contract as a legal artifact.** For external partners and enterprise customers, API contracts are referenced in SLAs and sometimes in contracts. A behavioral change that breaks a partner integration is not just a technical problem. Before any sunset, confirm with your legal and partnerships teams whether the affected consumers have contractual protections that constrain your timeline. This is a dimension of API evolution that is never mentioned in technical interviews but surfaces immediately at staff level and above.
