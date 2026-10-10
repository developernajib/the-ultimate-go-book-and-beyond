## Feature Flags Architecture

A production feature flag system has five distinct layers. Flag definitions flow down from the management layer through storage and distribution into client SDKs, where an evaluation engine resolves each flag against the current user context. The analytics layer records every evaluation to power experiment analysis and alerting.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                      FEATURE FLAG ARCHITECTURE                                   │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                         FLAG MANAGEMENT LAYER                           │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │     │
│  │  │   Admin UI   │  │    API       │  │   CLI        │  │  IaC (TF)   │  │     │
│  │  │  Dashboard   │  │  Management  │  │  Interface   │  │  GitOps     │  │     │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘  │     │
│  │         │                 │                 │                 │         │     │
│  │         └─────────────────┴─────────────────┴─────────────────┘         │     │
│  │                                   │                                     │     │
│  └───────────────────────────────────┼─────────────────────────────────────┘     │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                        FLAG STORAGE LAYER                               │     │
│  │  ┌────────────────────────────────────────────────────────────────────┐ │     │
│  │  │                      Flag Configuration Store                      │ │     │
│  │  │  ┌─────────────────────────────────────────────────────────────┐   │ │     │
│  │  │  │  Flag: "new-checkout-flow"                                  │   │ │     │
│  │  │  │  ├── enabled: true                                          │   │ │     │
│  │  │  │  ├── default_value: false                                   │   │ │     │
│  │  │  │  ├── rollout_percentage: 25                                 │   │ │     │
│  │  │  │  ├── targeting_rules:                                       │   │ │     │
│  │  │  │  │   ├── rule_1: {country: "US"} → true                     │   │ │     │
│  │  │  │  │   ├── rule_2: {plan: "premium"} → true                   │   │ │     │
│  │  │  │  │   └── rule_3: {beta_users: true} → true                  │   │ │     │
│  │  │  │  └── metadata: {owner: "team-a", created: "..."}            │   │ │     │
│  │  │  └─────────────────────────────────────────────────────────────┘   │ │     │
│  │  └────────────────────────────────────────────────────────────────────┘ │     │
│  │                                                                         │     │
│  │  Storage Options:                                                       │     │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │     │
│  │  │ PostgreSQL │  │  Redis     │  │  etcd      │  │ S3/GCS (static)    │ │     │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────────────┘ │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                       DISTRIBUTION LAYER                                │     │
│  │                                                                         │     │
│  │  ┌──────────────────────┐       ┌──────────────────────┐                │     │
│  │  │     Push Model       │       │     Pull Model       │                │     │
│  │  │  ┌────────────────┐  │       │  ┌────────────────┐  │                │     │
│  │  │  │  WebSocket     │  │       │  │  HTTP Polling  │  │                │     │
│  │  │  │  SSE Stream    │  │       │  │  SDK Fetch     │  │                │     │
│  │  │  │  gRPC Stream   │  │       │  │  CDN Edge      │  │                │     │
│  │  │  └────────────────┘  │       │  └────────────────┘  │                │     │
│  │  └──────────────────────┘       └──────────────────────┘                │     │
│  │                                                                         │     │
│  │  ┌──────────────────────────────────────────────────────────────────┐   │     │
│  │  │                     Edge/CDN Cache Layer                         │   │     │
│  │  │     Low-latency flag distribution at the edge                    │   │     │
│  │  │     ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐             │   │     │
│  │  │     │ US-E │  │ US-W │  │ EU   │  │ APAC │  │ ...  │             │   │     │
│  │  │     └──────┘  └──────┘  └──────┘  └──────┘  └──────┘             │   │     │
│  │  └──────────────────────────────────────────────────────────────────┘   │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                       CLIENT SDK LAYER                                  │     │
│  │                                                                         │     │
│  │  ┌───────────────────────────────────────────────────────────────────┐  │     │
│  │  │                        SDK Architecture                           │  │     │
│  │  │                                                                   │  │     │
│  │  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐    │  │     │
│  │  │  │  Local      │    │  Evaluation │    │  Event              │    │  │     │
│  │  │  │  Cache      │    │  Engine     │    │  Tracking           │    │  │     │
│  │  │  │  (in-memory)│ → │  (rules,    │ → │  (impressions,      │      │  │     │
│  │  │  │             │    │  targeting) │    │  assignments)       │    │  │     │
│  │  │  └─────────────┘    └─────────────┘    └─────────────────────┘    │  │     │
│  │  │         ↑                                        │                │  │     │
│  │  │         │         ┌──────────────────────────────┘                │  │     │
│  │  │         │         ▼                                               │  │     │
│  │  │  ┌─────────────┐  ┌─────────────────────────────────────────┐     │  │     │
│  │  │  │  Sync       │  │  Analytics Pipeline                     │     │  │     │
│  │  │  │  Manager    │  │  (Kafka → warehouse → dashboards)       │     │  │     │
│  │  │  └─────────────┘  └─────────────────────────────────────────┘     │  │     │
│  │  └───────────────────────────────────────────────────────────────────┘  │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                      │                                           │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                      EVALUATION LAYER                                   │     │
│  │                                                                         │     │
│  │  ┌───────────────────────────────────────────────────────────────────┐  │     │
│  │  │                    Flag Evaluation Flow                           │  │     │
│  │  │                                                                   │  │     │
│  │  │  Request Context         Evaluation Steps         Result          │  │     │
│  │  │  ┌─────────────┐        ┌──────────────┐        ┌─────────────┐   │  │     │
│  │  │  │ user_id     │   1.   │ Check if     │   →    │ enabled:    │   │  │     │
│  │  │  │ country     │   →    │ flag exists  │        │ true/false  │   │  │     │
│  │  │  │ platform    │        └──────┬───────┘        │             │   │  │     │
│  │  │  │ app_version │               │                │ variation:  │   │  │     │
│  │  │  │ plan_tier   │        ┌──────▼───────┐        │ "control"/  │   │  │     │
│  │  │  │ custom_attr │   2.   │ Evaluate     │        │ "treatment" │   │  │     │
│  │  │  └─────────────┘   →    │ targeting    │   →    │             │   │  │     │
│  │  │                         │ rules        │        │ metadata:   │   │  │     │
│  │  │                         └──────┬───────┘        │ {rule_id,   │   │  │     │
│  │  │                                │                │  bucket,    │   │  │     │
│  │  │                         ┌──────▼───────┐        │  timestamp} │   │  │     │
│  │  │                    3.   │ Calculate    │        └─────────────┘   │  │     │
│  │  │                    →    │ percentage   │   →                      │  │     │
│  │  │                         │ bucket       │                          │  │     │
│  │  │                         └──────┬───────┘                          │  │     │
│  │  │                                │                                  │  │     │
│  │  │                         ┌──────▼───────┐                          │  │     │
│  │  │                    4.   │ Return       │                          │  │     │
│  │  │                    →    │ default if   │                          │  │     │
│  │  │                         │ no match     │                          │  │     │
│  │  │                         └──────────────┘                          │  │     │
│  │  └───────────────────────────────────────────────────────────────────┘  │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                   ANALYTICS & EXPERIMENTATION                           │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │     │
│  │  │  Impression  │  │  Conversion  │  │  Statistical │  │  Alerting   │  │     │
│  │  │  Tracking    │  │  Tracking    │  │  Analysis    │  │  & Monitors │  │     │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘  │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### The 2026 Landscape: Managed Services and OpenFeature

Self-hosting is only one option. Many teams use a managed feature flag platform behind a vendor-neutral SDK abstraction. Knowing the landscape matters for interviews and for build-vs-buy decisions. Treat the descriptions below as orientation, not endorsement, and check current licensing and pricing yourself before committing:

- **LaunchDarkly**: commercial, the most widely deployed of the managed platforms, with a mature targeting and segment engine.
- **Split**: acquired by Harness in June 2024 and now sold as Harness Feature Management & Experimentation. Its differentiator was always the statistics engine attached to the flag system.
- **Unleash**: open-core. The core server is Apache-2.0, some enterprise features are not.
- **Flagsmith**: open-core, self-hostable or managed, with an API-compatible hybrid deployment.
- **Flipt**: open-source, Go-native, designed to run as a single self-hosted binary close to your services. Worth knowing precisely because it is written in Go, so its evaluation code reads like the code in this chapter.
- **GrowthBook**: open-core, oriented around running experiment analysis directly against your own data warehouse rather than shipping events to a vendor.
- **OpenFeature (CNCF, Incubating since November 2023)**: not a flag service. It is a vendor-neutral specification and SDK suite (Go, Java, .NET, Node, Python, Ruby, and others) that lets you write `client.BooleanValue(ctx, "new-checkout", false, evalCtx)` once and swap the backing provider (LaunchDarkly, Flagsmith, Flipt, a local file, an in-house service) without touching application code. Code against the OpenFeature API and plug in a concrete provider. This keeps migration cost low and avoids SDK lock-in, the same reason teams code against OpenTelemetry rather than a single vendor's tracing SDK.

```go
// OpenFeature Go SDK usage (vendor-neutral)
import (
    "github.com/open-feature/go-sdk/openfeature"
)

func setup() error {
    // Register any compliant provider (LaunchDarkly, Flagsmith, Flipt, noop, etc.).
    // SetProvider returns an error: provider registration can fail, and a
    // silently unregistered provider means every flag falls back to its
    // default forever. Check it.
    return openfeature.SetProvider(myProvider)
}

func handler(ctx context.Context, userID string) {
    client := openfeature.NewClient("checkout-service")
    enabled, _ := client.BooleanValue(
        ctx,
        "new-checkout-flow",
        false, // default if evaluation fails
        openfeature.NewEvaluationContext(userID, map[string]any{
            "country": "US",
            "plan":    "premium",
        }),
    )
    if enabled {
        // new path
    }
}
```

> **Senior track**: Expect the interview question "why not just call LaunchDarkly's SDK directly?" The answer is provider-neutral code, testability (swap in a noop provider in unit tests), and the option to migrate vendors without a code rewrite. This is a concrete application of the Dependency Inversion Principle.

### Staff Lens: OpenFeature as Abstraction

The build-vs-buy decision is rarely about the evaluation engine. Bucketing a user into a percentage is a hash and a comparison, and you will write it in this chapter in about thirty lines. What you are actually buying is the surrounding system: an audit trail of who flipped what, an approval workflow for production changes, per-environment segment management, and an experiment analysis pipeline that someone else keeps statistically honest. Teams that build in-house usually rebuild those pieces badly over two years.

The counter-argument is the failure domain. A vendor SDK that fetches its ruleset over the network puts a third party in the availability path of your application. Every mature SDK answers this the same way you will: evaluate in-process against a cached ruleset, treat the network as a background refresh, and serve the last known-good ruleset when the refresh fails. Verify that property before you adopt any provider, because it is the difference between the vendor being a dependency and the vendor being a single point of failure.

---
