## 28.11 Company Case Studies

### How GitHub CLI (gh) is Built

GitHub's official CLI (`gh`) is one of the strongest examples of a professional Go CLI application in production:

**Key Design Decisions:**

1. **Extension System**: gh supports custom extensions written in any language, discovered via naming convention (`gh-*`).

2. **Output Modes**: Every command supports `--json` with customizable field selection via `--jq`.

3. **Auth Flow**: OAuth browser flow with fallback to token-based auth for headless environments.

```go
// GitHub CLI pattern - output modes
type cmdOutput struct {
	JSON   bool
	JQ     string
	Fields []string
}

func (c *cmdOutput) AddFlags(cmd *cobra.Command) {
	cmd.Flags().BoolVar(&c.JSON, "json", false, "output JSON")
	cmd.Flags().StringVar(&c.JQ, "jq", "", "JQ expression to filter JSON")
	cmd.Flags().StringSliceVar(&c.Fields, "fields", nil, "specific fields to include")
}

func (c *cmdOutput) Print(data any) error {
	if c.JSON {
		if c.JQ != "" {
			return printWithJQ(data, c.JQ)
		}
		if len(c.Fields) > 0 {
			return printSelectedFields(data, c.Fields)
		}
		return printJSON(data)
	}
	return printTable(data)
}
```

**Lessons from gh:**
- Make CLI scriptable with JSON output and JQ support
- Provide both interactive and non-interactive modes
- Support extensions for community contributions

### How Kubernetes kubectl Works

kubectl is the most widely-used Go CLI, managing millions of clusters:

**Architecture:**

1. **Plugin System**: Uses `kubectl-*` binary naming for plugins in PATH.

2. **Resource Types**: Generic handlers for any Kubernetes resource type.

3. **Output Formats**: Supports table, JSON, YAML, custom columns, JSONPath, go-template.

```go
// kubectl pattern - generic resource handling
type ResourceOptions struct {
	Resource  string
	Name      string
	Namespace string
	All       bool
	Selector  string
	Output    string
}

func (o *ResourceOptions) Run(ctx context.Context) error {
	// Build dynamic client based on resource type
	client, err := o.buildClient()
	if err != nil {
		return err
	}

	// Get resources
	resources, err := client.Get(ctx, o.buildRequest())
	if err != nil {
		return err
	}

	// Format output
	return o.printResources(resources)
}
```

**Lessons from kubectl:**
- Design for extensibility with plugins
- Support multiple output formats
- Use kubeconfig for multi-cluster management

### How Terraform CLI Manages State

Terraform's CLI handles complex state management:

**Key Features:**

1. **Plan/Apply Model**: Preview changes before applying.

2. **State Locking**: Prevents concurrent modifications.

3. **Provider System**: Plugin architecture for different cloud providers.

```go
// Terraform pattern - plan/apply workflow
type ApplyCommand struct {
	AutoApprove bool
	PlanFile    string
	Parallelism int
}

func (c *ApplyCommand) Run(args []string) int {
	// Load or create plan
	plan, err := c.loadOrCreatePlan(args)
	if err != nil {
		c.printError(err)
		return 1
	}

	// Show plan summary
	c.printPlanSummary(plan)

	// Confirm unless auto-approved
	if !c.AutoApprove {
		if !c.confirm("Apply these changes?") {
			c.print("Apply canceled.")
			return 0
		}
	}

	// Apply with state locking
	return c.applyWithLock(plan)
}
```

**Lessons from Terraform:**
- Preview destructive operations before execution
- Implement state locking for concurrent safety
- Design for infrastructure as code workflows

### Junior to FAANG: reading these case studies

The case studies above are not trivia. Each decision maps to a problem you will face on your first CLI project. Reuse the patterns.

`gh` and output modes. The `--json` plus `--jq` plus `--fields` pattern is the gold standard for scriptable CLIs. When you add JSON output to your tool, copy this three-flag design. Users who have seen it once will expect it everywhere.

`kubectl` and plugins. If your tool might grow beyond 30 subcommands, plan for a plugin system from day one. Even if you do not build it immediately, leave the path clear. Refactoring a monolithic CLI into plugins after it has shipped is a multi-quarter project.

`terraform` and the plan/apply model. For any destructive tool, plan/apply is the safe interaction pattern. Show what will change. Require confirmation (or `--auto-approve`). Log the applied plan for audit. This is what distinguishes professional tools from sharp edges.

Interview entry point. "Which CLI would you pattern your tool after and why?" The answer depends on use case. Scriptable data retrieval, `gh`. Cluster management, `kubectl`. State mutation with side effects, `terraform`. Interactive wizards, `stripe-cli`. Knowing which to copy and why is an L5 signal.

### Senior at FAANG: case studies as organizational playbooks

Staff concerns. The case studies above are artifacts of staff-level decisions made over years. Understanding why they chose what they chose is the staff skill.

`gh` extension system. GitHub chose out-of-process extensions because in-process Go plugins are fragile on macOS and Windows. The tradeoff. Slower invocation (fork overhead) but language-agnostic extensions. Plugin authors write in Python, Ruby, anything. Staff lesson. When designing extensibility, pick the boundary that maximizes contributor reach over runtime efficiency. The extension ecosystem is what made `gh` adoption stick.

`kubectl` generic resource handling. The dynamic client model lets one CLI handle any CRD. This is why `kubectl get crontabs` works for a CRD you defined last week. Staff lesson. Design your CLI around type systems, not individual commands. If your tool has 20 nearly-identical `create`/`get`/`delete` triads, extract a generic handler.

`terraform` state locking. Distributed locking via DynamoDB, S3 with conditional writes, or Consul. The locking protocol is part of the CLI's public contract because teams build automation on top. Staff lesson. When multiple users can invoke your CLI against shared state, locking is not a feature, it is a requirement. Plan for it in v1 because retrofitting is painful.

Staff archetypes across case studies. `gh` is led by a small core team with large community extension authors. `kubectl` is led by Kubernetes SIG-CLI with hundreds of contributors across companies. `terraform` is led by HashiCorp's core team with provider authors being third parties. Each governance model implies different contribution workflows, different deprecation policies, different release cadences. When you join a CLI platform team, study the governance model before the code.

Hidden case study. The AWS CLI v1 to v2 migration took 4 years. v2 introduced a binary installer instead of pip, breaking Python integration workflows. It required a new `aws configure sso` flow. v1 remains supported as of 2026 in maintenance mode. Staff lesson. Major version migrations of widely-used CLIs take years, not quarters. Plan lifecycle accordingly. Write the migration guide before you ship v2.

`stripe-cli` as a design study. Webhook forwarding (`stripe listen --forward-to localhost:3000`) is a killer feature. Staff lesson. Look for friction in the developer workflow around your tool and build the friction-eliminating feature into the CLI. The tool becomes indispensable when it solves a problem no competitor solves.

`gcloud` command discovery. The component system (`gcloud components install`) lazy-loads subcommand bundles. Core binary is 30 MB, full install is 300 MB, users only pay for what they use. Staff lesson. For mega-CLIs, lazy component loading is how you scale binary size without hurting startup time.

Case study archetype. The CLI platform engineer role at each of these companies is a staff or principal position reporting to a director of developer productivity. They own grammar, output contracts, plugin ABI, release engineering, and contributor experience. It is one of the most effective IC roles in developer tools orgs.

Org-wide ADR template for adopting a CLI pattern. Context. Evaluated tools (gh, kubectl, terraform, stripe). Decision. "We adopt the gh pattern of JSON plus jq for scriptable output." Consequences. "Every new command must support `--json`, `--jq`, `--fields`. Retrofit existing commands over 2 quarters." Alternatives considered. "kubectl's custom columns are powerful but harder to learn. terraform's HCL is overkill for our simpler data." Rollback plan. "If telemetry shows <5 percent usage of --jq after 6 months, we revisit." Use this template for every cross-cutting CLI decision.

---
