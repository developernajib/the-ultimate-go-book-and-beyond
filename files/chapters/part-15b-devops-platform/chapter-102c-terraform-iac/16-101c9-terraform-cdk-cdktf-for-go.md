## 102C.14 Terraform CDK (CDKTF) for Go

CDKTF (Cloud Development Kit for Terraform) lets you define infrastructure using real programming languages - including Go - instead of HCL. Internally, it synthesizes your Go code into standard Terraform JSON configuration files, which are then applied by the Terraform CLI. This means you get the full Terraform ecosystem (every provider, every module) with the expressiveness of Go: real loops, conditionals, type safety, structs, interfaces, and unit tests.

### Why CDKTF Exists

HCL is a configuration language, not a general-purpose programming language. Teams hit its limits when:

- Generating repetitive infrastructure (dozens of microservices each needing ALB rules, ECS services, IAM roles, CloudWatch alarms)
- Needing dynamic logic that `for_each` and `dynamic` blocks cannot cleanly express
- Wanting to share infrastructure patterns as typed Go packages instead of Terraform modules
- Running infrastructure tests using the Go standard `testing` package directly on the synthesized JSON before even running `terraform plan`

### CDKTF App Structure

```
infra/
├── main.go              # Entry point - cdktf.App
├── stacks/
│   ├── vpc_stack.go     # VPC infrastructure stack
│   ├── ecs_stack.go     # ECS cluster + services stack
│   └── rds_stack.go     # RDS stack
├── constructs/
│   ├── microservice.go  # Reusable construct: ECS service + ALB rule + IAM
│   └── database.go      # Reusable construct: RDS + parameter group + subnet group
├── go.mod
├── cdktf.json           # CDKTF config: output dir, providers, modules
└── cdktf.out/           # Synthesized Terraform JSON (gitignored or committed)
    └── stacks/
        ├── vpc/cdk.tf.json
        ├── ecs/cdk.tf.json
        └── rds/cdk.tf.json
```

### Installing CDKTF

CDKTF requires the `cdktf-cli` Node.js package alongside Go, since the CLI handles synthesis and deployment even though your infrastructure code is written in Go. After scaffolding the project with `cdktf init`, you declare the Terraform providers you need in `cdktf.json` and run `cdktf get` to auto-generate typed Go bindings for every resource and data source those providers expose.

```bash
# Install CDKTF CLI
npm install -g cdktf-cli

# Initialize a Go CDKTF project
cdktf init --template=go --local

# Add AWS provider to cdktf.json, then generate Go bindings
cdktf get
```

`cdktf.json` configuration:

```json
{
  "language": "go",
  "app": "go run main.go",
  "projectId": "my-infra-project",
  "sendCrashReports": false,
  "terraformProviders": ["aws@~> 5.0"],
  "terraformModules": [],
  "context": {
    "excludeStackIdFromLogicalIds": "true",
    "allowSepCharsInLogicalIds": "true"
  }
}
```

### Defining AWS Resources in Go

After running `cdktf get`, provider bindings are generated in `.gen/providers/aws/`. You define infrastructure using Go types:

```go
package stacks

import (
    "fmt"

    "github.com/aws/constructs-go/constructs/v10"
    "github.com/aws/jsii-runtime-go/runtime"
    "github.com/hashicorp/terraform-cdk-go/cdktf"

    // Auto-generated provider bindings (cdktf get)
    "cdk.tf/go/stack/.gen/providers/aws/internetgateway"
    "cdk.tf/go/stack/.gen/providers/aws/provider"
    "cdk.tf/go/stack/.gen/providers/aws/routetable"
    "cdk.tf/go/stack/.gen/providers/aws/routetableassociation"
    "cdk.tf/go/stack/.gen/providers/aws/subnet"
    "cdk.tf/go/stack/.gen/providers/aws/vpc"
)

// VpcStack defines the complete VPC infrastructure as a typed Go struct.
type VpcStack struct {
    cdktf.TerraformStack
    VpcID         *string
    PublicSubnets []*string
}

type VpcStackConfig struct {
    Region      string
    Environment string
    CidrBlock   string
    AZs         []string
}

func NewVpcStack(scope constructs.Construct, id string, cfg VpcStackConfig) *VpcStack {
    stack := &VpcStack{}
    stack.TerraformStack = cdktf.NewTerraformStack(scope, &id)

    // AWS provider with default tags applied to every resource
    provider.NewAwsProvider(stack, runtime.JsiiString("aws"), &provider.AwsProviderConfig{
        Region: runtime.JsiiString(cfg.Region),
        DefaultTags: &provider.AwsProviderDefaultTags{
            Tags: &map[string]*string{
                "Environment": runtime.JsiiString(cfg.Environment),
                "ManagedBy":   runtime.JsiiString("CDKTF"),
            },
        },
    })

    // VPC resource - same semantics as Terraform aws_vpc but type-safe Go
    mainVpc := vpc.NewVpc(stack, runtime.JsiiString("main"), &vpc.VpcConfig{
        CidrBlock:          runtime.JsiiString(cfg.CidrBlock),
        EnableDnsHostnames: runtime.JsiiBool(true),
        EnableDnsSupport:   runtime.JsiiBool(true),
        Tags: &map[string]*string{
            "Name": runtime.JsiiString(cfg.Environment + "-vpc"),
        },
    })
    stack.VpcID = mainVpc.Id()

    // Internet Gateway
    igw := internetgateway.NewInternetGateway(stack, runtime.JsiiString("igw"), &internetgateway.InternetGatewayConfig{
        VpcId: mainVpc.Id(),
    })

    // Public route table with IGW default route
    pubRt := routetable.NewRouteTable(stack, runtime.JsiiString("public_rt"), &routetable.RouteTableConfig{
        VpcId: mainVpc.Id(),
        Route: []routetable.RouteTableRoute{{
            CidrBlock: runtime.JsiiString("0.0.0.0/0"),
            GatewayId: igw.Id(),
        }},
    })

    // Subnets - real Go loop, not HCL count/for_each limitations
    stack.PublicSubnets = make([]*string, len(cfg.AZs))
    for i, az := range cfg.AZs {
        idx := i  // capture loop variable for closure correctness
        azVal := az

        sub := subnet.NewSubnet(stack,
            runtime.JsiiString(fmt.Sprintf("public_subnet_%d", idx)),
            &subnet.SubnetConfig{
                VpcId:               mainVpc.Id(),
                CidrBlock:           runtime.JsiiString(fmt.Sprintf("10.0.%d.0/24", idx)),
                AvailabilityZone:    runtime.JsiiString(azVal),
                MapPublicIpOnLaunch: runtime.JsiiBool(true),
                Tags: &map[string]*string{
                    "Name": runtime.JsiiString(fmt.Sprintf("%s-public-%s", cfg.Environment, azVal)),
                    "Type": runtime.JsiiString("public"),
                },
            })

        routetableassociation.NewRouteTableAssociation(stack,
            runtime.JsiiString(fmt.Sprintf("pub_rta_%d", idx)),
            &routetableassociation.RouteTableAssociationConfig{
                SubnetId:     sub.Id(),
                RouteTableId: pubRt.Id(),
            })

        stack.PublicSubnets[idx] = sub.Id()
    }

    return stack
}
```

### Reusable Constructs: The CDKTF Pattern

In CDKTF, a *construct* is a reusable infrastructure component - the Go equivalent of a Terraform module, but as a typed struct. This is the primary pattern for sharing infrastructure within your organization as versioned Go packages:

```go
package constructs

import (
    "fmt"

    "github.com/aws/constructs-go/constructs/v10"
    "github.com/aws/jsii-runtime-go/runtime"
    "cdk.tf/go/stack/.gen/providers/aws/cloudwatchmetricalarm"
    "cdk.tf/go/stack/.gen/providers/aws/ecsservice"
    "cdk.tf/go/stack/.gen/providers/aws/ecstaskdefinition"
    "cdk.tf/go/stack/.gen/providers/aws/iamrole"
    "cdk.tf/go/stack/.gen/providers/aws/lblistenerrule"
    "cdk.tf/go/stack/.gen/providers/aws/lbtargetgroup"
)

// MicroserviceConfig is strongly typed - no map[string]any like HCL variables.
type MicroserviceConfig struct {
    Name             string
    ClusterARN       *string
    VpcID            *string
    SubnetIDs        []*string
    ListenerARN      *string
    ContainerImage   string
    ContainerPort    int
    CPU              int    // millicores: 256, 512, 1024, 2048
    Memory           int    // MiB: 512, 1024, 2048
    DesiredCount     int
    Environment      string
    AlertSNSTopicARN *string // nil means no alarm provisioned
}

// MicroserviceConstruct provisions everything a microservice needs:
// ECS task definition, ECS service, IAM execution role, ALB target group,
// ALB listener rule, and optional CloudWatch CPU alarm.
type MicroserviceConstruct struct {
    constructs.Construct
    ServiceARN     *string
    TargetGroupARN *string
}

func NewMicroservice(scope constructs.Construct, id string, cfg MicroserviceConfig) *MicroserviceConstruct {
    c := &MicroserviceConstruct{}
    c.Construct = constructs.NewConstruct(scope, &id)

    // Dedicated IAM execution role per service (least privilege)
    role := iamrole.NewIamRole(c, runtime.JsiiString("exec_role"), &iamrole.IamRoleConfig{
        Name: runtime.JsiiString(fmt.Sprintf("%s-%s-exec", cfg.Environment, cfg.Name)),
        AssumeRolePolicy: runtime.JsiiString(`{
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": "ecs-tasks.amazonaws.com"},
                "Action": "sts:AssumeRole"
            }]
        }`),
        ManagedPolicyArns: &[]*string{
            runtime.JsiiString("arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"),
        },
    })

    containerDef := fmt.Sprintf(`[{
        "name": "%s",
        "image": "%s",
        "portMappings": [{"containerPort": %d, "protocol": "tcp"}],
        "logConfiguration": {
            "logDriver": "awslogs",
            "options": {
                "awslogs-group": "/ecs/%s/%s",
                "awslogs-region": "us-east-1",
                "awslogs-stream-prefix": "ecs"
            }
        }
    }]`, cfg.Name, cfg.ContainerImage, cfg.ContainerPort, cfg.Environment, cfg.Name)

    td := ecstaskdefinition.NewEcsTaskDefinition(c, runtime.JsiiString("task_def"), &ecstaskdefinition.EcsTaskDefinitionConfig{
        Family:                  runtime.JsiiString(fmt.Sprintf("%s-%s", cfg.Environment, cfg.Name)),
        NetworkMode:             runtime.JsiiString("awsvpc"),
        RequiresCompatibilities: &[]*string{runtime.JsiiString("FARGATE")},
        Cpu:                     runtime.JsiiString(fmt.Sprintf("%d", cfg.CPU)),
        Memory:                  runtime.JsiiString(fmt.Sprintf("%d", cfg.Memory)),
        ExecutionRoleArn:        role.Arn(),
        ContainerDefinitions:    runtime.JsiiString(containerDef),
    })

    // ALB Target Group with health check
    tg := lbtargetgroup.NewLbTargetGroup(c, runtime.JsiiString("tg"), &lbtargetgroup.LbTargetGroupConfig{
        Name:       runtime.JsiiString(fmt.Sprintf("%s-%s", cfg.Environment, cfg.Name)),
        Port:       runtime.JsiiNumber(float64(cfg.ContainerPort)),
        Protocol:   runtime.JsiiString("HTTP"),
        VpcId:      cfg.VpcID,
        TargetType: runtime.JsiiString("ip"),
        HealthCheck: &lbtargetgroup.LbTargetGroupHealthCheck{
            Path:               runtime.JsiiString("/health"),
            HealthyThreshold:   runtime.JsiiNumber(2),
            UnhealthyThreshold: runtime.JsiiNumber(3),
            Interval:           runtime.JsiiNumber(30),
        },
    })
    c.TargetGroupARN = tg.Arn()

    // Path-based ALB listener rule - routes /servicename/* to this service
    lblistenerrule.NewLbListenerRule(c, runtime.JsiiString("listener_rule"), &lblistenerrule.LbListenerRuleConfig{
        ListenerArn: cfg.ListenerARN,
        Priority:    runtime.JsiiNumber(100),
        Action: []lblistenerrule.LbListenerRuleAction{{
            Type:           runtime.JsiiString("forward"),
            TargetGroupArn: tg.Arn(),
        }},
        Condition: []lblistenerrule.LbListenerRuleCondition{{
            PathPattern: &lblistenerrule.LbListenerRuleConditionPathPattern{
                Values: &[]*string{runtime.JsiiString("/" + cfg.Name + "/*")},
            },
        }},
    })

    // Fargate ECS Service
    svc := ecsservice.NewEcsService(c, runtime.JsiiString("service"), &ecsservice.EcsServiceConfig{
        Name:           runtime.JsiiString(fmt.Sprintf("%s-%s", cfg.Environment, cfg.Name)),
        Cluster:        cfg.ClusterARN,
        TaskDefinition: td.Arn(),
        DesiredCount:   runtime.JsiiNumber(float64(cfg.DesiredCount)),
        LaunchType:     runtime.JsiiString("FARGATE"),
        NetworkConfiguration: &ecsservice.EcsServiceNetworkConfiguration{
            Subnets:        &cfg.SubnetIDs,
            AssignPublicIp: runtime.JsiiBool(false),
        },
        LoadBalancer: []ecsservice.EcsServiceLoadBalancer{{
            TargetGroupArn: tg.Arn(),
            ContainerName:  runtime.JsiiString(cfg.Name),
            ContainerPort:  runtime.JsiiNumber(float64(cfg.ContainerPort)),
        }},
    })
    c.ServiceARN = svc.Id()

    // Optional CloudWatch CPU alarm - nil pointer check is cleaner than a boolean flag
    if cfg.AlertSNSTopicARN != nil {
        cloudwatchmetricalarm.NewCloudwatchMetricAlarm(c, runtime.JsiiString("cpu_alarm"), &cloudwatchmetricalarm.CloudwatchMetricAlarmConfig{
            AlarmName:          runtime.JsiiString(fmt.Sprintf("%s-%s-cpu-high", cfg.Environment, cfg.Name)),
            ComparisonOperator: runtime.JsiiString("GreaterThanThreshold"),
            EvaluationPeriods:  runtime.JsiiNumber(2),
            MetricName:         runtime.JsiiString("CPUUtilization"),
            Namespace:          runtime.JsiiString("AWS/ECS"),
            Period:             runtime.JsiiNumber(300),
            Statistic:          runtime.JsiiString("Average"),
            Threshold:          runtime.JsiiNumber(80),
            AlarmActions:       &[]*string{cfg.AlertSNSTopicARN},
            Dimensions: &map[string]*string{
                "ClusterName": runtime.JsiiString(fmt.Sprintf("%s-cluster", cfg.Environment)),
                "ServiceName": runtime.JsiiString(fmt.Sprintf("%s-%s", cfg.Environment, cfg.Name)),
            },
        })
    }

    return c
}
```

### Main Entry Point

The `main.go` file is where all stacks are instantiated and wired together, with outputs from foundational stacks passed directly as typed Go pointers to the stacks that depend on them. This replaces the HCL pattern of `terraform_remote_state` data sources and string interpolation with ordinary Go function arguments that the compiler validates at build time. Calling `app.Synth()` at the end triggers CDKTF to walk the construct tree and emit one `cdk.tf.json` file per stack into the `cdktf.out` directory.

```go
package main

import (
    "github.com/hashicorp/terraform-cdk-go/cdktf"
    "cdk.tf/go/stack/stacks"
)

func main() {
    app := cdktf.NewApp(nil)

    // Foundation VPC stack - outputs feed into all dependent stacks
    vpcStack := stacks.NewVpcStack(app, "vpc", stacks.VpcStackConfig{
        Region:      "us-east-1",
        Environment: "production",
        CidrBlock:   "10.0.0.0/16",
        AZs:         []string{"us-east-1a", "us-east-1b", "us-east-1c"},
    })

    // ECS stack consumes VPC outputs as typed *string values
    // - no HCL data source lookups, no string interpolation
    stacks.NewEcsStack(app, "ecs", stacks.EcsStackConfig{
        Region:      "us-east-1",
        Environment: "production",
        VpcID:       vpcStack.VpcID,
        SubnetIDs:   vpcStack.PublicSubnets,
    })

    app.Synth()
}
```

Running `cdktf synth` generates `cdktf.out/stacks/vpc/cdk.tf.json` - standard Terraform JSON that `cdktf deploy` or `terraform apply` can execute directly.

### Synthesizing and Deploying

The CDKTF workflow separates synthesis. Translating Go code into Terraform JSON. From actual infrastructure changes, mirroring the `terraform plan` / `terraform apply` distinction. Running `cdktf synth` is a pure local operation that you can inspect, diff, and check into version control before any cloud API calls are made. Deployment commands like `cdktf deploy` accept stack names to target specific layers, respecting cross-stack dependencies so the VPC is always provisioned before the ECS cluster that references it.

```bash
# Generate Terraform JSON (no AWS API calls)
cdktf synth

# Plan - equivalent to terraform plan on the synthesized JSON
cdktf diff

# Deploy specific stacks (dependency order respected)
cdktf deploy vpc ecs

# Deploy all stacks
cdktf deploy --all

# Destroy a specific stack
cdktf destroy vpc
```

### CDKTF vs Pulumi vs CDK vs Plain HCL - Decision Framework

| Dimension | Plain HCL | CDKTF | Pulumi | AWS CDK |
|---|---|---|---|---|
| **Language** | HCL DSL | Go, TS, Python, Java | Go, TS, Python, .NET | TS, Python, Java |
| **Provider ecosystem** | 10,000+ TF providers | All TF providers | 100+ (native + TF bridge) | AWS only |
| **State backend** | TF / TF Cloud | TF / TF Cloud | Pulumi Cloud / S3 | CloudFormation |
| **Testing** | Terratest | Standard `go test` | Standard `go test` | CDK assertions |
| **Real loops/types** | Limited | Full Go | Full Go | Full TS/Python |
| **Existing TF modules** | Native | Native | Via TF bridge | No |
| **Multi-cloud** | Yes | Yes | Yes | No |
| **Runtime engine** | TF CLI | TF CLI | Pulumi engine | CloudFormation |
| **FAANG adoption** | Dominant | Growing | Moderate | High (AWS-only) |

**Use CDKTF when**: Go team, wants typed infrastructure packages, needs TF provider ecosystem, wants `go test` for infra validation without Terratest overhead.

**Use plain HCL when**: Existing Terraform codebase, mixed team, using TF Registry community modules, using Sentinel/OPA policy-as-code with HCL-native tooling.

**Use Pulumi when**: Want infra fully integrated into application code, native Pulumi providers, richer multi-language tooling without binding generation step.

**Use AWS CDK when**: AWS-only workload, TypeScript culture, CloudFormation audit trail required, using CDK Constructs Hub.

---

### Junior → FAANG: Getting a Foothold with CDKTF

For Go engineers new to infrastructure, CDKTF offers an on-ramp that feels familiar: structs, interfaces, for loops, and `go test`. The mental model shift from HCL is smaller than it appears because the underlying concepts are identical. A CDKTF stack is a module. A CDKTF construct is a reusable resource group. A `cdktf synth` is a plan input. A `cdktf deploy` is an apply.

The practical skill to develop first is reading synthesized JSON. After running `cdktf synth`, open `cdktf.out/stacks/vpc/cdk.tf.json` and trace how your Go structs map to Terraform resource blocks. Understanding this translation makes debugging much faster: when a CDKTF deployment fails, you can read the synthesized JSON like HCL, find the problematic resource, and understand the exact configuration Terraform received.

The Node.js dependency (the `cdktf-cli` tool) surprises Go engineers who expected a pure-Go experience. Accept it as a build-time dependency, not a runtime dependency. Your infrastructure code is Go. The CLI wrapper that invokes synthesis and deployment happens to be implemented in TypeScript. This is similar to how many Go build tools have non-Go components.

For interviews, CDKTF knowledge is a differentiator at companies that are evaluating the tool or have adopted it. Being able to say "I have written CDKTF constructs that synthesize to valid Terraform JSON and verified them with `go test`" puts you ahead of candidates who have only used HCL.

### Senior @ FAANG: CDKTF as an Organizational Platform Decision

At L6, adopting CDKTF is an architectural decision with organization-wide implications, not an individual preference. The evaluation requires answering four questions before making a recommendation.

**The migration path question.** Most organizations adopting CDKTF have an existing HCL codebase with hundreds of modules and years of accumulated state. The migration strategy is not "rewrite everything". It is "use CDKTF for new platform modules that hit HCL's complexity ceiling while maintaining existing HCL modules." Define the complexity threshold explicitly: any module requiring more than two levels of nested dynamic blocks, any module generating more than 20 similar resources with per-resource configuration, any module that needs to call an external API during synthesis. Document this threshold in an ADR so teams have a clear criterion for choosing the tool.

**The generated bindings maintenance question.** CDKTF provider bindings are generated code that must be regenerated when provider versions change. At scale, this means tracking provider versions across all CDKTF projects, automating binding regeneration in CI when a new provider version is released, and running `go build` and `cdktf synth` in the same CI pipeline to catch binding incompatibilities before they reach deployment. The governance model for HCL provider pinning (lock file, deliberate upgrade PRs) applies equally to CDKTF but requires an additional automation layer for binding regeneration.

**The construct library as an internal product.** The `MicroserviceConstruct` in this section is the seed of an internal infrastructure library. At L6, you design this library with the same product thinking as a public API: semantic versioning via `go.mod` tags, a stability tier system, release notes on breaking changes, and a Go module proxy for internal distribution. The difference from a HCL module library is that construct libraries can use Go interfaces to enforce contract compliance at compile time, which is a stronger guarantee than the runtime validation HCL modules provide.

**The policy-as-code integration question.** OPA/Conftest policies that check synthesized Terraform JSON work with CDKTF without modification, because the output format is identical to what `terraform show -json` produces. This means your existing policy layer applies to CDKTF stacks without any migration. Run `cdktf synth` followed by `conftest test --policy policy/ cdktf.out/stacks/vpc/cdk.tf.json` in CI to enforce the same compliance rules across both HCL and CDKTF codebases. At bar-raiser level, articulating this policy portability demonstrates that you have thought through the governance implications of adopting a new tool rather than just evaluating its syntax appeal.
