## 99.13 Feature Flags in CI/CD

### Feature Flag Integration

Integrating a feature flag SDK like LaunchDarkly into Go uses `sync.Once` to initialize a singleton client at startup, guaranteeing the SDK's background goroutines and streaming connection are only created once regardless of how many goroutines call `Init`. When the `LAUNCHDARKLY_SDK_KEY` environment variable is absent, as in a local development environment, the client is created in offline mode, falling back to default values so the application still boots without network access. Evaluation calls are thread-safe and accept an `ldcontext` carrying the user key, enabling percentage rollouts and targeted rule matching on the LaunchDarkly dashboard without redeploying.

```go
// internal/features/flags.go
package features

import (
    "context"
    "os"
    "sync"

    "github.com/launchdarkly/go-sdk-common/v3/ldcontext"
    ld "github.com/launchdarkly/go-server-sdk/v7"
)

var (
    client *ld.LDClient
    once   sync.Once
)

func Init() error {
    var err error
    once.Do(func() {
        sdkKey := os.Getenv("LAUNCHDARKLY_SDK_KEY")
        if sdkKey == "" {
            // Use local file for development
            client, err = ld.MakeCustomClient(sdkKey, ld.Config{
                Offline: true,
            }, 5)
            return
        }
        client, err = ld.MakeClient(sdkKey, 5)
    })
    return err
}

func IsEnabled(ctx context.Context, flag string, userKey string) bool {
    if client == nil {
        return false
    }

    ldCtx := ldcontext.New(userKey)
    value, _ := client.BoolVariation(flag, ldCtx, false)
    return value
}

func Close() {
    if client != nil {
        client.Close()
    }
}
```

```yaml
# .github/workflows/feature-deploy.yaml
name: Feature Flag Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build and push
        run: |
          docker build -t myapp:${{ github.sha }} .
          docker push myapp:${{ github.sha }}

      - name: Deploy with feature flag
        run: |
          # Deploy to all pods
          kubectl set image deployment/myapp myapp=myapp:${{ github.sha }}

          # Feature is controlled by LaunchDarkly
          # New code is deployed but feature is off by default

      - name: Enable feature for beta users
        run: |
          curl -X PATCH \
            -H "Authorization: ${{ secrets.LD_API_KEY }}" \
            -H "Content-Type: application/json" \
            -d '{
              "patch": [{
                "op": "replace",
                "path": "/environments/production/on",
                "value": true
              }]
            }' \
            "https://app.launchdarkly.com/api/v2/flags/myproject/new-feature"
```

---

### Junior → FAANG: Feature Flags as Deployment Risk Reduction

Feature flags decouple code deployment from feature activation. Before feature flags, "deploy this feature" meant "deploy code AND activate the feature for all users simultaneously." With feature flags, "deploy this feature" means "deploy code with the feature disabled" and "activate the feature" is a separate, reversible configuration change.

This decoupling reduces deployment risk in two ways. First, deployments become smaller and safer because each deployment is just code (not code plus feature activation). Second, feature rollout becomes independently controllable: activate for 5% of users, monitor metrics, activate for 50%, monitor again, activate for 100%. Any problem found during this rollout can be resolved by disabling the flag, with no code change or deployment required.

For Go specifically, feature flag evaluation should be fast (sub-microsecond for in-memory evaluation) and the flag client should gracefully handle the case where the flag service is unavailable (default to a safe fallback value, not a crash). Both properties need to be tested explicitly.

### Senior @ FAANG: Feature Flags as a Platform Capability and Governance Concern

At staff level, feature flags are a platform capability with a governance model. An unmanaged feature flag system grows to have hundreds of flags with unclear owners, no expiry dates, and conditional code paths that no one is confident enough to remove. The cleanup cost of stale flags is significant. The risk of a flag that was supposed to be temporary becoming permanent is real.

The governance model for feature flags: every flag has an owner, a type (release flag, operational flag, experiment flag, kill switch), and an expiry date. Flags past their expiry date are reported as a compliance gap. The platform provides a dashboard of all flags, their current state, their last modification, and their expiry date. Engineers who create flags are notified when expiry approaches.

The operational flags category (kill switches, degraded mode flags, load shedding flags) are the highest-priority flags for reliability engineering. A properly designed kill switch can stop specific expensive operations immediately, without deployment, when the system is under stress. Designing a set of kill switches for a service's most expensive operations and testing them in game days before an incident is an L6/L7 reliability engineering contribution. The kill switch is only useful if it is documented, tested, and known to work under the exact conditions when it is needed.
