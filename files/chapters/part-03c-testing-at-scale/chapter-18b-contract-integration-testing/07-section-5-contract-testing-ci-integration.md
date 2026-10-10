## Section 5: Contract Testing CI Integration

### 5.1 Pact Broker Workflow

The Pact Broker is a central repository for contract definitions and verification results that enables consumer and provider CI pipelines to coordinate without direct communication between teams. Consumers publish contracts after their tests pass. Providers fetch and verify those contracts as part of their CI. The broker records the verification result and provides a `can-i-deploy` query that prevents deployment of incompatible versions. The pipeline configuration below shows how to integrate Pact Broker publishing into a GitHub Actions consumer workflow and contract fetching into the provider's verification job.

```go
package pact_ci

// PactPublishConfig holds Pact Broker publication settings.
type PactPublishConfig struct {
	BrokerURL       string
	BrokerToken     string
	ConsumerName    string
	ProviderName    string
	ConsumerVersion string
	BranchName      string
	PactDir         string
}

// PactCIScript generates a shell script for Pact CI integration.
func PactCIScript() string {
	return `#!/bin/bash
# pact-ci.sh - runs consumer tests, publishes pacts, runs provider verification

set -euo pipefail

# Step 1: Run consumer contract tests (generates pact files)
go test ./consumer/... -run TestContract -v

# Step 2: Publish pacts to Pact Broker
go run ./tools/pact-publish \
  --broker-url="$PACT_BROKER_URL" \
  --broker-token="$PACT_BROKER_TOKEN" \
  --consumer-version="$GIT_SHA" \
  --branch="$GIT_BRANCH" \
  --pact-dir="./pacts"

# Step 3: Can-I-Deploy check (is it safe to deploy?)
docker run --rm \
  -e PACT_BROKER_BASE_URL="$PACT_BROKER_URL" \
  -e PACT_BROKER_TOKEN="$PACT_BROKER_TOKEN" \
  pactfoundation/pact-cli \
  broker can-i-deploy \
  --pacticipant OrderService \
  --version "$GIT_SHA" \
  --to-environment production

# Step 4: Provider verification (runs against latest consumer pacts).
# Configure via environment, not custom go test flags: go test rejects flags
# the test binary has not registered, and env vars keep this consistent with
# the GitHub Actions job below.
PACT_BROKER_URL="$PACT_BROKER_URL" \
PACT_BROKER_TOKEN="$PACT_BROKER_TOKEN" \
PACT_PUBLISH_RESULTS=true \
PROVIDER_VERSION="$GIT_SHA" \
  go test ./provider/... -run TestProviderContractVerification -v
`
}

// GitHubActionsWorkflow generates a GitHub Actions workflow for Pact.
func GitHubActionsWorkflow() string {
	return `name: Contract Tests

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  consumer-contract-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - name: Run consumer contract tests
        run: go test ./consumer/... -run TestContract -v
        env:
          PACT_DIR: ./pacts
      - name: Publish pacts to broker
        run: |
          go run ./tools/pact-publish \
            --consumer-version=${{ github.sha }} \
            --branch=${{ github.ref_name }}
        env:
          PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
          PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}

  provider-verification:
    runs-on: ubuntu-latest
    needs: consumer-contract-tests
    services:
      postgres:
        # Same major version as production, per the fidelity rule in section 2.4.
        image: postgres:18-alpine
        env:
          POSTGRES_DB: testdb
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports: ['5432:5432']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - name: Run provider contract verification
        run: go test ./provider/... -run TestProviderContractVerification -v
        env:
          PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
          PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}
          PACT_PUBLISH_RESULTS: "true"
          PROVIDER_VERSION: ${{ github.sha }}
          DATABASE_URL: postgres://test:test@localhost:5432/testdb?sslmode=disable
`
}
```

### 5.2 Deployment Gating with can-i-deploy

The `can-i-deploy` tool is the linchpin of safe contract-driven deployments. Before promoting a build to staging or production, the deploy pipeline queries the broker: *is the consumer version X compatible with every provider currently in environment E?* If any verification is missing or failed, deployment is blocked. This is the workflow the Pact documentation itself recommends, and it is the reason the broker exists at all: without a deploy gate that consults it, a broker is just a filing cabinet for JSON.

> **Senior track**: Tag consumer and provider versions with environment names (`production`, `staging`) via `record-deployment` and `record-release` instead of version matching. Matrix-based verification, meaning "verify every consumer in prod against every provider in prod", grows combinatorially and becomes the slowest step in CI well before your service count gets interesting. Use branch-based contracts (WIP pacts) to surface breaking changes at PR time rather than at deploy time.

### 5.3 The rollout plan: consumer-first vs provider-first

Adopting contract testing across a team of services is a rollout question, and the two common shapes are consumer-first and provider-first. **Consumer-first**: start by writing consumer pacts for every service you own. Publish them to the broker. Do not require provider verification yet. This produces immediate value (consumer tests running locally as part of normal unit test flow) with low coordination cost. Over time, as provider teams see their consumer contracts in the broker, they opt into verification. **Provider-first**: the provider team publishes an OpenAPI spec and wires up `kin-openapi` validation in their test suite. Consumers point their tests at the provider's spec. This is simpler to adopt within a single team but does not give independent deploy safety. Pick consumer-first for genuine multi-team adoption. Pick provider-first for single-team internal APIs. Mixing the two on a single API is the worst of both worlds and creates confusion about which contract is authoritative.

### 5.4 Junior → FAANG: the `can-i-deploy` moment

The first time you watch `can-i-deploy` block a deploy because a contract verification failed is the moment contract testing stops being theoretical. Practice this scenario once end-to-end. Create a consumer and provider locally with passing Pact verification. Break the provider's response (rename a field, change a status code). Run `can-i-deploy`. Watch it report that deployment would break a consumer. Fix the provider. Run `can-i-deploy` again. Watch it succeed. That five-minute exercise teaches more about contract testing than reading every Pact blog post, and it gives you a concrete story for any FAANG interview that asks "how do you catch breaking API changes before they reach production."

### 5.5 Senior @ FAANG: the deploy-gate contract with the platform team

At scale, `can-i-deploy` is a deployment platform integration, not a per-team script. Write a contract with the platform team that covers: (1) every deploy pipeline must query `can-i-deploy` before promotion to each environment. (2) the query timeout must be bounded (say, 30 seconds), with a documented fallback path for broker outages (block deploy, or allow deploy with audit log, depending on your risk tolerance). (3) the broker's uptime is tracked and has an SLO. (4) the policy for what to do when a verification is missing (block until a consumer publishes, or auto-pass after N days). (5) the escalation path when a genuine emergency deploy must bypass the gate. Without this contract, every team writes their own integration and the cumulative inconsistency breaks the deploy-safety property that contract testing was supposed to provide. With it, contract testing scales across arbitrary team count, and staff engineers can point at a single document that explains the entire gate behavior.

---
