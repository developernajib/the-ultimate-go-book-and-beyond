## 42D.6 HATEOAS & Hypermedia APIs

### HATEOAS in Practice vs on Paper

Roy Fielding's dissertation makes HATEOAS (Hypermedia as the Engine of Application State) the defining constraint of REST: clients should discover available actions by following links in responses, not by reading an SDK. In practice almost no internal API hits that bar, teams generate typed clients from OpenAPI and hardcode the URL templates, and hypermedia adds round trips a mobile app cannot afford. What survives is a pragmatic middle: response bodies carry a `_links` object with state-dependent actions (`cancel` only appears when `status == "pending"`), so the *server* owns the state machine and the client does not reimplement it. That is where HAL, JSON:API, and Siren each earn their keep. Treat full HATEOAS as aspirational. Ship hypermedia controls in the responses where the state machine is non-trivial and reward yourself with fewer client-side bugs when a new state is added server-side.

### HAL Response Builder

HAL (Hypertext Application Language) embeds hyperlinks directly in JSON responses so clients can discover available actions without hardcoding URLs. The following builder attaches links dynamically based on the resource's current state. An order that is "pending" offers cancel and pay links, while a "delivered" order offers a return link.

```go
// HAL (Hypertext Application Language) response builder
type HALResponse struct {
	Links    map[string]HALLink     `json:"_links,omitempty"`
	Embedded map[string]any `json:"_embedded,omitempty"`
}

type HALLink struct {
	Href      string `json:"href"`
	Method    string `json:"method,omitempty"`
	Templated bool   `json:"templated,omitempty"`
	Title     string `json:"title,omitempty"`
}

type OrderHALResponse struct {
	HALResponse
	ID         string `json:"id"`
	Status     string `json:"status"`
	TotalCents int64  `json:"total_cents"`
}

func NewOrderHALResponse(order *Order, baseURL string) *OrderHALResponse {
	resp := &OrderHALResponse{
		ID:         order.ID,
		Status:     order.Status,
		TotalCents: order.TotalCents,
	}

	resp.Links = map[string]HALLink{
		"self": {Href: fmt.Sprintf("%s/orders/%s", baseURL, order.ID)},
	}

	// Dynamic links based on order state machine
	switch order.Status {
	case "pending":
		resp.Links["cancel"] = HALLink{
			Href:   fmt.Sprintf("%s/orders/%s/cancel", baseURL, order.ID),
			Method: "POST",
			Title:  "Cancel this order",
		}
		resp.Links["pay"] = HALLink{
			Href:   fmt.Sprintf("%s/orders/%s/payment", baseURL, order.ID),
			Method: "POST",
			Title:  "Pay for this order",
		}
	case "shipped":
		resp.Links["track"] = HALLink{
			Href:  fmt.Sprintf("%s/orders/%s/tracking", baseURL, order.ID),
			Title: "Track shipment",
		}
	case "delivered":
		resp.Links["return"] = HALLink{
			Href:   fmt.Sprintf("%s/orders/%s/returns", baseURL, order.ID),
			Method: "POST",
			Title:  "Initiate return",
		}
	}

	return resp
}
```

### When HATEOAS Makes Sense

HATEOAS adds complexity and is worth implementing when:
- Building a public API consumed by unknown third-party clients who benefit from discoverability
- The API workflow is state-machine-driven (e.g., order lifecycle) and you want clients to adapt to state changes without hardcoding URLs
- You're building a CMS, workflow system, or highly navigable API

Skip HATEOAS for internal APIs, mobile-first APIs, or when you control both client and server with a typed SDK.

---

### Junior → FAANG: What HATEOAS Actually Buys You

HATEOAS is one of those concepts that is heavily theorized in textbooks and rarely implemented fully in production. Understanding the pragmatic subset that survives real-world adoption is more useful than memorizing Fielding's dissertation.

**The state-machine insight.** The most concrete value HATEOAS delivers is moving state-machine logic from client code into server responses. Without hypermedia links, every client must hardcode the rules: show cancel only for pending orders, show track only for shipped orders. When you add a new status, every client breaks or misses the new affordance. With `_links`, the server returns only the actions valid for the current state, and a generic client renders whatever links exist. One server change reaches all clients.

**HAL is the pragmatic choice.** HAL is the most widely supported hypermedia format for JSON APIs. It is simple: a `_links` object at the root level, each key being a relation name and each value being an object with at minimum an `href`. `_embedded` is for inline sub-resources. You do not need a full hypermedia framework to implement it. A struct with `_links map[string]HALLink` is enough to start.

**When to skip it.** If you own both the client and server, generate a typed client from your OpenAPI spec instead. HATEOAS adds a round trip and parsing overhead that typed clients avoid. For mobile applications where every byte and millisecond matters, the latency cost of discovering links at runtime versus having them compiled in is measurable.

**Interview entry point.** "What is HATEOAS and have you used it?" is a mid-level API design question. The correct answer covers the state-machine argument, names HAL or JSON:API as practical formats, and honestly acknowledges the adoption tradeoffs. Claiming full Fielding-compliant REST for an API that uses hardcoded URL templates is a credibility risk.

**First-job habits.** If you add `_links` to responses, include the `self` link on every resource. It is the lowest-overhead hypermedia addition and immediately useful for logging and debugging.

---

### Senior @ FAANG: HATEOAS Adoption Strategy and API Discoverability at Scale

Full HATEOAS is rarely the right investment for internal microservices. The senior-level conversation is about where hypermedia controls deliver disproportionate value and how to sequence their adoption without disrupting existing integrations.

**Architectural Decision Record: HAL vs. JSON:API vs. Siren.**
HAL is the simplest and most widely understood. JSON:API is more opinionated: it standardizes pagination, sparse fieldsets, and compound documents, making it valuable when you have complex resource graphs and multiple client types. Siren adds `actions` (form-like structures with method, fields, and encoding type) that describe write operations, not just navigation. For a state-machine-heavy API like an order lifecycle or a loan application workflow, Siren's actions solve a real problem that HAL's read-only links do not. The decision should be driven by the complexity of the state machine and the diversity of clients, not by familiarity.

**Hypermedia as a versioning escape hatch.** One underappreciated benefit of `_links` at scale is that you can change endpoint URL structure without a versioned breaking change, provided clients discover URLs from links rather than constructing them from templates. This is the mechanism Stripe and GitHub use to evolve their API URL structure over years. The precondition is that clients actually follow links. Enforce this in your API style guide by explicitly prohibiting clients from constructing URLs for link-rel relations that appear in responses.

**State machine governance.** At L6/L7, the HAL response builder is not owned by the API handler developer. The valid transitions of a domain object's state machine are business logic and belong in the domain layer. The handler's job is to serialize the available transitions into `_links`, not to decide which transitions are valid. Coupling state machine logic to the HTTP layer makes it unavailable to background jobs, CLI tools, and event handlers that need the same rules. Model the state machine as a pure function `func AvailableTransitions(status string) []Transition` and call it from both the domain layer and the HAL builder.

**Client adoption measurement.** Before removing a hypermedia link relation, confirm that no live client is constructing the deprecated URL directly (not following the link). This requires access log analysis on the server side, not just searching client codebases. At large organizations, there are always undiscovered consumers. The combination of access log metrics, the `Deprecation` header with a `Link: successor-version` relation, and a sunset date enforced in the middleware covers the known risk.

**Performance considerations for link generation.** In high-throughput APIs, generating `_links` per response adds CPU overhead that compounds under load. Profile the link generation path under realistic concurrency. If link generation requires database reads (for example, checking whether a related resource exists before including a link to it), cache those reads aggressively or redesign the link generation to be purely stateless from the in-memory object. Links that require database round trips per response will become your bottleneck at scale.

**Integration with API gateways.** A mature platform exposes HATEOAS links that reference the gateway's canonical URL, not the internal service URL. This requires the link builder to be aware of the `X-Forwarded-Host` and `X-Forwarded-Proto` headers injected by the gateway, or to read the base URL from configuration rather than constructing it from the incoming request. Hardcoding internal service addresses into `_links` is a security and operational defect: internal URLs leaked to external clients expose network topology and break when the service moves.
