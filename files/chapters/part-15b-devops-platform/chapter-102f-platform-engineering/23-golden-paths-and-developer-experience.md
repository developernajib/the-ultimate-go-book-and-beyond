## 102F.21 Golden Paths and Developer Experience

A golden path is an opinionated, paved road for building and shipping software. It is not a mandate - it is the path of least resistance that happens to be the safest, most reliable way to get from idea to production. Teams that deviate can do so, but they must carry the operational burden themselves.

### Platform CLI in Go

The `platform` CLI is the primary interface between developers and the platform. It abstracts Backstage, ArgoCD, Kubernetes, and Terraform behind a single ergonomic tool:

```go
// cmd/platform/main.go
package main

import (
	"os"

	"github.com/acme-corp/platform-cli/internal/cmd"
	"github.com/acme-corp/platform-cli/internal/config"
)

func main() {
	cfg := config.Load()
	root := cmd.NewRootCmd(cfg)
	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}
```

```go
// internal/cmd/root.go
package cmd

import (
	"github.com/acme-corp/platform-cli/internal/config"
	"github.com/spf13/cobra"
)

// NewRootCmd assembles the full platform CLI command tree.
func NewRootCmd(cfg *config.Config) *cobra.Command {
	root := &cobra.Command{
		Use:   "platform",
		Short: "Acme Corp internal developer platform CLI",
		Long: `platform - your single interface to the Acme engineering platform.

Scaffold services, deploy to Kubernetes, check health, manage secrets,
and query the catalog - all from one tool.`,
		SilenceUsage: true,
	}

	root.AddCommand(
		newCreateCmd(cfg),
		newDeployCmd(cfg),
		newStatusCmd(cfg),
		newLogsCmd(cfg),
		newSecretsCmd(cfg),
		newCatalogCmd(cfg),
		newDoraCmd(cfg),
	)

	root.PersistentFlags().StringVar(&cfg.Environment, "env", "staging",
		"Target environment (staging|production)")
	root.PersistentFlags().BoolVar(&cfg.Verbose, "verbose", false, "Enable verbose output")
	return root
}
```

```go
// internal/cmd/create.go
package cmd

import (
	"fmt"
	"os"
	"text/template"

	"github.com/acme-corp/platform-cli/internal/config"
	"github.com/acme-corp/platform-cli/internal/scaffold"
	"github.com/acme-corp/platform-cli/internal/validate"
	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

func newCreateCmd(cfg *config.Config) *cobra.Command {
	var (
		team      string
		withDB    string
		withKafka bool
		withGRPC  bool
		dryRun    bool
	)

	cmd := &cobra.Command{
		Use:   "create service NAME",
		Short: "Scaffold a new Go microservice from the golden path template",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if args[0] != "service" {
				return fmt.Errorf("unknown resource type %q (supported: service)", args[0])
			}
			serviceName := args[1]

			if err := validate.ServiceName(serviceName); err != nil {
				return fmt.Errorf("invalid service name: %w", err)
			}
			if team == "" {
				return fmt.Errorf("--team is required")
			}

			color.Cyan("Scaffolding service: %s (team: %s)\n", serviceName, team)

			opts := scaffold.Options{
				Name:      serviceName,
				Team:      team,
				Database:  withDB,
				Kafka:     withKafka,
				GRPC:      withGRPC,
				OutputDir: serviceName,
			}

			if dryRun {
				color.Yellow("[dry-run] Would create:")
				for _, f := range scaffold.ListFiles(opts) {
					fmt.Printf("  %s\n", f)
				}
				return nil
			}

			if err := scaffold.Generate(opts); err != nil {
				return fmt.Errorf("scaffold: %w", err)
			}

			color.Green("Service scaffolded at ./%s\n", serviceName)
			printNextSteps(serviceName)
			return nil
		},
	}

	cmd.Flags().StringVar(&team, "team", "", "Owning team (required)")
	cmd.Flags().StringVar(&withDB, "with-db", "", "Database: postgres|mysql|redis")
	cmd.Flags().BoolVar(&withKafka, "with-kafka", false, "Add Kafka consumer/producer boilerplate")
	cmd.Flags().BoolVar(&withGRPC, "with-grpc", false, "Add gRPC server alongside HTTP")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would be created without writing files")
	return cmd
}

func printNextSteps(name string) {
	tmpl := template.Must(template.New("").Parse(`
Next steps:
  cd {{.Name}}
  go mod tidy
  make test                                  # run test suite
  make run                                   # run locally on :8080
  platform deploy {{.Name}} --env=staging    # deploy to staging
  platform catalog register                  # register in Backstage
`))
	_ = tmpl.Execute(os.Stdout, map[string]string{"Name": name})
}
```

```go
// internal/cmd/deploy.go
package cmd

import (
	"context"
	"fmt"
	"time"

	"github.com/acme-corp/platform-cli/internal/argocd"
	"github.com/acme-corp/platform-cli/internal/config"
	"github.com/acme-corp/platform-cli/internal/git"
	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

func newDeployCmd(cfg *config.Config) *cobra.Command {
	var (
		imageTag string
		wait     bool
		timeout  time.Duration
	)

	cmd := &cobra.Command{
		Use:  "deploy SERVICE",
		Short: "Deploy a service to the target environment",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			service := args[0]
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()

			if imageTag == "" {
				tag, err := git.CurrentSHA()
				if err != nil {
					return fmt.Errorf("resolve image tag: %w", err)
				}
				imageTag = tag[:8]
			}

			color.Cyan("Deploying %s:%s to %s...\n", service, imageTag, cfg.Environment)

			client := argocd.NewClient(cfg.ArgoCDURL, cfg.ArgoCDToken)
			if err := client.UpdateImageTag(ctx, service, cfg.Environment, imageTag); err != nil {
				return fmt.Errorf("update image tag in GitOps repo: %w", err)
			}

			color.Green("Image tag updated. ArgoCD will sync within 3 minutes.\n")

			if wait {
				color.Cyan("Waiting for ArgoCD sync...\n")
				if err := client.WaitForSync(ctx, service, cfg.Environment); err != nil {
					return fmt.Errorf("sync failed: %w", err)
				}
				color.Green("Deployment complete. Service is healthy.\n")
			}

			fmt.Printf("ArgoCD: %s/applications/%s-%s\n", cfg.ArgoCDURL, service, cfg.Environment)
			return nil
		},
	}

	cmd.Flags().StringVar(&imageTag, "tag", "", "Image tag to deploy (default: current git SHA)")
	cmd.Flags().BoolVar(&wait, "wait", false, "Wait for ArgoCD sync to complete")
	cmd.Flags().DurationVar(&timeout, "timeout", 10*time.Minute, "Timeout for --wait")
	return cmd
}
```

```go
// internal/cmd/status.go
package cmd

import (
	"context"
	"fmt"
	"os"
	"text/tabwriter"
	"time"

	"github.com/acme-corp/platform-cli/internal/catalog"
	"github.com/acme-corp/platform-cli/internal/config"
	"github.com/acme-corp/platform-cli/internal/k8s"
	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

func newStatusCmd(cfg *config.Config) *cobra.Command {
	return &cobra.Command{
		Use:   "status SERVICE",
		Short: "Show the operational status of a service",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			service := args[0]
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()

			type result struct {
				pods   []k8s.PodStatus
				health catalog.HealthStatus
				err    error
			}
			ch := make(chan result, 1)
			go func() {
				pods, err := k8s.GetPods(ctx, cfg, service)
				if err != nil {
					ch <- result{err: err}
					return
				}
				health, err := catalog.GetHealth(ctx, cfg, service)
				ch <- result{pods: pods, health: health, err: err}
			}()

			r := <-ch
			if r.err != nil {
				return r.err
			}

			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			color.Cyan("Service: %s | Env: %s\n\n", service, cfg.Environment)
			fmt.Fprintln(w, "POD\tSTATUS\tRESTARTS\tAGE\tNODE")
			for _, p := range r.pods {
				statusColor := color.GreenString(p.Status)
				if p.Status != "Running" {
					statusColor = color.RedString(p.Status)
				}
				fmt.Fprintf(w, "%s\t%s\t%d\t%s\t%s\n", p.Name, statusColor, p.Restarts, p.Age, p.Node)
			}
			_ = w.Flush()

			fmt.Printf("\nOverall Health: %s\n", colorHealth(r.health.Status))
			fmt.Printf("p50 latency: %s  p99 latency: %s  Error rate: %.2f%%\n",
				r.health.P50Latency, r.health.P99Latency, r.health.ErrorRate)
			fmt.Printf("Grafana: %s\n", r.health.GrafanaURL)
			return nil
		},
	}
}

func colorHealth(status string) string {
	switch status {
	case "healthy":
		return color.GreenString(status)
	case "degraded":
		return color.YellowString(status)
	default:
		return color.RedString(status)
	}
}
```

### Measuring Developer Experience: SPACE and DORA

Measuring platform impact requires tracking both business outcomes (DORA) and developer wellbeing (SPACE). SPACE stands for Satisfaction, Performance, Activity, Communication/Collaboration, and Efficiency.

```go
// internal/metrics/space.go
package metrics

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// SPACEMetrics holds aggregated SPACE scores for a team over a reporting period.
type SPACEMetrics struct {
	Team        string    `json:"team"`
	Period      string    `json:"period"`
	CollectedAt time.Time `json:"collectedAt"`
	// Satisfaction - quarterly developer survey score, 0-10
	DeveloperSatisfaction float64 `json:"developerSatisfaction"`
	// Performance - system-derived signals
	PRReviewedWithin24h float64 `json:"prReviewedWithin24hPct"`
	BuildSuccessRate    float64 `json:"buildSuccessRatePct"`
	// Activity - per-engineer-per-week averages
	CommitsPerEngineerWeek float64 `json:"commitsPerEngineerWeek"`
	DeploysPerEngineerWeek float64 `json:"deploysPerEngineerWeek"`
	// Communication - documentation and meeting overhead
	DocCoveragePct      float64 `json:"docCoveragePct"`
	MeetingHoursPerWeek float64 `json:"meetingHoursPerWeek"`
	// Efficiency - speed of key developer flows
	MedianCIMinutes         float64 `json:"medianCIMinutes"`
	OnboardingDaysToFirstPR float64 `json:"onboardingDaysToFirstPR"`
	TimeToProductionMinutes float64 `json:"timeToProductionMinutes"`
}

// SPACECollector aggregates SPACE metrics from survey and GitHub APIs.
type SPACECollector struct {
	githubToken    string
	surveyEndpoint string
	httpClient     *http.Client
}

// NewSPACECollector creates a collector with the given credentials.
func NewSPACECollector(githubToken, surveyEndpoint string) *SPACECollector {
	return &SPACECollector{
		githubToken:    githubToken,
		surveyEndpoint: surveyEndpoint,
		httpClient:     &http.Client{Timeout: 10 * time.Second},
	}
}

// Collect gathers all SPACE dimensions for a team over a reporting period.
func (c *SPACECollector) Collect(ctx context.Context, team, period string) (*SPACEMetrics, error) {
	m := &SPACEMetrics{Team: team, Period: period, CollectedAt: time.Now()}
	if err := c.fetchSurveyData(ctx, team, period, m); err != nil {
		return nil, fmt.Errorf("survey data: %w", err)
	}
	if err := c.fetchGitHubData(ctx, team, period, m); err != nil {
		return nil, fmt.Errorf("github data: %w", err)
	}
	return m, nil
}

func (c *SPACECollector) fetchSurveyData(ctx context.Context, team, period string, m *SPACEMetrics) error {
	url := fmt.Sprintf("%s/api/v1/results?team=%s&period=%s", c.surveyEndpoint, team, period)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var result struct {
		Satisfaction       float64 `json:"satisfaction"`
		MeetingHoursWeekly float64 `json:"meetingHoursWeekly"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return err
	}
	m.DeveloperSatisfaction = result.Satisfaction
	m.MeetingHoursPerWeek = result.MeetingHoursWeekly
	return nil
}

func (c *SPACECollector) fetchGitHubData(ctx context.Context, team, period string, m *SPACEMetrics) error {
	// Production: use GitHub GraphQL API for real PR review times and commit counts.
	// Sample values provided for illustration.
	m.PRReviewedWithin24h = 78.5
	m.BuildSuccessRate = 94.2
	m.CommitsPerEngineerWeek = 12.3
	m.DeploysPerEngineerWeek = 3.1
	m.DocCoveragePct = 72.0
	m.MedianCIMinutes = 4.7
	m.OnboardingDaysToFirstPR = 2.5
	m.TimeToProductionMinutes = 18.0
	return nil
}
```

### Enforcing Golden Paths Without Blocking Autonomy

The golden path is enforced through incentives, not gates:

| Enforcement Layer | Mechanism | Blocks Deploy? |
|---|---|---|
| Linting | `platform lint` in CI catches missing catalog-info.yaml and bad Dockerfiles | No - warning only |
| Policy (OPA) | Admission webhook requires `golden-path` label on all new namespaces | No - allows override via annotation |
| Security scanning | Trivy blocks HIGH/CRITICAL CVEs in golden-path images | Yes - fix or get security sign-off |
| Cost guardrails | OPA Gatekeeper rejects Pods without resource requests | Yes - always enforced |
| On-call routing | PagerDuty auto-assigns incidents to non-golden-path teams. No platform on-call cover | Incentive only |

The key principle: **the golden path should be the easiest path**. If developers are bypassing it, the platform team has a product problem, not a discipline problem.

### Junior → FAANG: Reading the Platform CLI as a Go Design Study

The `platform` CLI in this section is a well-structured Go CLI application and is worth studying in detail even if you are not building a platform. The design patterns it demonstrates apply to any CLI tool.

The `NewRootCmd` function shows the Cobra pattern for composing a CLI from subcommands. Each subcommand is a separate function (`newCreateCmd`, `newDeployCmd`, `newStatusCmd`) that returns a `*cobra.Command`. These functions receive configuration via the `cfg *config.Config` parameter rather than accessing global state. This makes each command independently testable: you can call `newCreateCmd(testConfig)` in a test and verify its behavior without running the full CLI.

The `printNextSteps` function uses `text/template` to generate the post-scaffold help message. This is a minor but instructive detail: instead of string concatenation or `fmt.Sprintf`, the template is compiled once and can be extended without changing the surrounding code. It also demonstrates that templates in Go are not just for generating code. They are useful for any structured text output.

The `newDeployCmd` function demonstrates the pattern of deriving a default value from context (current git SHA) when the user does not provide an explicit value. This is excellent CLI UX: the most common case (deploy the current commit) requires no flags, but the power user case (deploy a specific tag) is supported via `--tag`. Designing CLI flags to have sensible defaults that cover 90% of use cases, with explicit overrides for the remaining 10%, is a product thinking skill that transfers to API design.

The `newStatusCmd` shows concurrent data fetching: pods and health data are fetched in a goroutine and collected via a channel. The result is a single render pass that shows all information together, with a 15-second timeout that prevents the command from hanging indefinitely if one data source is unavailable. This is a practical pattern for any CLI that aggregates data from multiple services.

### Senior @ FAANG: The CLI as a Platform Contract and Migration Tool

At the senior level, the `platform` CLI is not just a convenience tool. It is the primary mechanism through which the platform team controls the developer experience and drives adoption of platform capabilities.

The `platform create service` command is the entry point to the golden path. Every parameter it accepts (team, database type, gRPC option) represents a capability the platform team has invested in. Parameters the CLI does not expose (the underlying Kubernetes cluster name, the ArgoCD server URL, the GitHub organization) are details the developer should never need to know. The CLI's surface area is a deliberate product decision: hiding implementation details that might change prevents developers from taking dependencies on those details and makes future platform migrations transparent.

The version pinning in the deploy command (`imageTag[:8]` from current git SHA) is a common source of production incidents. If the SHA is taken from a dirty working tree (uncommitted local changes), the deployed image will not exactly match any committed code, making it impossible to reproduce the deployed artifact. A senior engineer reviewing this code would add a check that the working tree is clean before using the current SHA as a default image tag, or alternatively always require an explicit `--tag` for production deployments and use the git SHA default only for staging.

The `SPACECollector` and `SPACEMetrics` structures in the SPACE measurement section show the data model for a metrics aggregation service. The production challenge for this service is the `fetchGitHubData` method, which currently returns hard-coded sample values. Replacing these with real GitHub GraphQL API calls requires handling rate limiting (GitHub limits unauthenticated requests to 60 per hour and authenticated requests to 5,000 per hour), pagination (a team with 200 engineers has thousands of PRs per quarter), and data freshness (nightly aggregation vs. real-time computation). These are infrastructure design decisions with real cost implications, and a principal engineer designing this system must specify not just the API surface but the data pipeline architecture that makes the API viable at scale.
