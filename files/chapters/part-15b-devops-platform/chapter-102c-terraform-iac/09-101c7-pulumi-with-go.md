## 102C.7 Pulumi with Go

Pulumi expresses infrastructure using real programming languages including Go, enabling full power of the language for infrastructure logic.

```go
// pulumi/main.go
package main

import (
    "fmt"

    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/ec2"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/ecs"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/rds"
    "github.com/pulumi/pulumi/sdk/v3/go/pulumi"
    "github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

type InfraStack struct {
    VPC            *ec2.Vpc
    PrivateSubnets []*ec2.Subnet
    PublicSubnets  []*ec2.Subnet
    ECSCluster     *ecs.Cluster
    Database       *rds.Instance
}

func main() {
    pulumi.Run(func(ctx *pulumi.Context) error {
        cfg := config.New(ctx, "")
        environment := cfg.Require("environment")
        project := ctx.Project()

        // VPC
        vpc, err := ec2.NewVpc(ctx, "main", &ec2.VpcArgs{
            CidrBlock:          pulumi.String("10.0.0.0/16"),
            EnableDnsHostnames: pulumi.Bool(true),
            EnableDnsSupport:   pulumi.Bool(true),
            Tags: pulumi.StringMap{
                "Name":        pulumi.Sprintf("%s-%s-vpc", project, environment),
                "Environment": pulumi.String(environment),
                "ManagedBy":   pulumi.String("pulumi"),
            },
        })
        if err != nil {
            return err
        }

        azs := []string{"us-east-1a", "us-east-1b"}
        privateSubnets := make([]*ec2.Subnet, len(azs))

        for i, az := range azs {
            subnet, err := ec2.NewSubnet(ctx, fmt.Sprintf("private-%d", i), &ec2.SubnetArgs{
                VpcId:            vpc.ID(),
                CidrBlock:        pulumi.Sprintf("10.0.%d.0/24", i),
                AvailabilityZone: pulumi.String(az),
                Tags: pulumi.StringMap{
                    "Name": pulumi.Sprintf("%s-%s-private-%s", project, environment, az),
                },
            })
            if err != nil {
                return err
            }
            privateSubnets[i] = subnet
        }

        // ECS Cluster
        cluster, err := ecs.NewCluster(ctx, "main", &ecs.ClusterArgs{
            Name: pulumi.Sprintf("%s-%s", project, environment),
            Settings: ecs.ClusterSettingArray{
                &ecs.ClusterSettingArgs{
                    Name:  pulumi.String("containerInsights"),
                    Value: pulumi.String("enabled"),
                },
            },
        })
        if err != nil {
            return err
        }

        // Export useful outputs
        ctx.Export("vpcId", vpc.ID())
        ctx.Export("clusterArn", cluster.Arn)

        _ = privateSubnets
        return nil
    })
}
```

**When to use Pulumi vs Terraform**:
- Pulumi: when infrastructure logic requires real programming (loops with conditions, external API calls, complex computed values)
- Terraform: when team prefers declarative HCL, uses the massive existing module ecosystem, or requires state management transparency

---

### Junior → FAANG: Pulumi vs Terraform as a Career Decision

For junior Go engineers, the practical question is which tool to invest in. The honest answer is Terraform first. Terraform has a larger job market, more existing codebases to learn from, and a more mature community. Pulumi is the correct choice when your team is already predominantly Go engineers and wants infrastructure code that participates in the same review, testing, and dependency management workflows as application code.

The Pulumi example above shows a real advantage: the `for` loop over availability zones is plain Go, not a `count.index` workaround or a `for_each` over a set. When generating a dozen similar resources with slightly different configurations, Go's expressiveness is genuinely superior to HCL's limited iteration constructs.

For interviews: know both tools exist and understand the tradeoffs. Being able to say "I would choose Pulumi when the infrastructure logic requires real programming constructs, and Terraform when the team needs the module ecosystem or declarative transparency" demonstrates the judgment that distinguishes thoughtful candidates.

### Senior @ FAANG: When Pulumi Is the Architecturally Correct Choice

At staff level, the Pulumi vs. Terraform decision is an ADR with organizational implications. It is not just about syntax preference.

**The testing integration argument.** Pulumi infrastructure tests are regular Go tests using `pulumi.testing` or the actual Pulumi automation API. There is no Terratest wrapper, no `terraform.InitAndApply()`, just a function that invokes your infrastructure code programmatically and returns outputs. This means infrastructure tests participate in the same CI framework as application tests, are written by the same engineers, and use the same assertion libraries. For organizations where the IaC/Application boundary is deliberately blurred (platform engineering teams that build and test infrastructure as part of the application delivery pipeline), this integration is a meaningful advantage.

**The state backend tradeoff.** Pulumi's state can be stored in Pulumi Cloud (managed, with secrets encryption and audit logging) or in S3 using the self-managed backend. The S3 backend is operationally equivalent to Terraform's S3 backend but without DynamoDB locking by default. For organizations that are already invested in Terraform Cloud or Atlantis workflows, the migration cost to Pulumi state management is non-trivial. At L6, you factor this into the ADR.

**Dependency management as a Go module concern.** Pulumi infrastructure code is a Go module. Provider bindings are versioned Go packages. This means `go mod tidy`, `go mod vendor`, and Dependabot work exactly as they do for application dependencies. The upgrade story is `go get github.com/pulumi/pulumi-aws/sdk/v6@v6.x.y` followed by `go build` and your compiler tells you about breaking changes. Compare this to Terraform provider upgrades, which require reading changelogs and running `terraform init -upgrade`. At organizations where Go expertise is deep and the upgrade discipline is strong, Pulumi's dependency management integrates more naturally into existing workflows.

**Multi-language teams and the ecosystem problem.** Pulumi's provider ecosystem, while large, does not match Terraform's 10,000+ community providers. If your organization uses niche internal systems that have Terraform providers but no Pulumi native provider, the Pulumi Terraform bridge works but adds a conversion layer. At bar-raiser interviews, acknowledging this constraint and explaining when you would use the bridge versus writing a native Pulumi provider demonstrates architectural pragmatism.
