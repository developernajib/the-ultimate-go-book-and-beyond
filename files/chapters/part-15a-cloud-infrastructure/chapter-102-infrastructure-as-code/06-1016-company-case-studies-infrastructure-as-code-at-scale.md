## 102.6 Company Case Studies: Infrastructure as Code at Scale

### Google: Terraform for GCP

Google uses Terraform extensively for GCP infrastructure:

```hcl
# Google-style Terraform for GKE cluster
module "gke" {
  source  = "terraform-google-modules/kubernetes-engine/google"
  version = "~> 28.0"

  project_id        = var.project_id
  name              = "${var.project_name}-${var.environment}"
  region            = var.region
  network           = module.vpc.network_name
  subnetwork        = module.vpc.subnets["${var.region}/gke-subnet"].name

  ip_range_pods     = "gke-pods"
  ip_range_services = "gke-services"

  # Google best practices
  release_channel     = "REGULAR"
  enable_private_nodes = true
  master_ipv4_cidr_block = "172.16.0.0/28"

  # Workload Identity (recommended over service account keys)
  identity_namespace = "${var.project_id}.svc.id.goog"

  # Binary Authorization
  enable_binary_authorization = var.environment == "prod"

  node_pools = [
    {
      name               = "default-pool"
      machine_type       = var.environment == "prod" ? "e2-standard-4" : "e2-medium"
      min_count          = var.environment == "prod" ? 3 : 1
      max_count          = var.environment == "prod" ? 10 : 3
      disk_size_gb       = 100
      disk_type          = "pd-ssd"
      auto_repair        = true
      auto_upgrade       = true
      service_account    = google_service_account.gke_nodes.email

      # Shielded nodes
      enable_integrity_monitoring = true
      enable_secure_boot          = true
    },
  ]

  # Cluster autoscaling profile
  cluster_autoscaling = {
    enabled             = true
    autoscaling_profile = "OPTIMIZE_UTILIZATION"
    gpu_resources       = []
  }
}

# Workload Identity for Go service
resource "google_service_account" "go_service" {
  account_id   = "go-service-${var.environment}"
  display_name = "Go Service Workload Identity"
}

resource "google_project_iam_member" "go_service_roles" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/storage.objectViewer",
    "roles/pubsub.publisher",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.go_service.email}"
}

resource "google_service_account_iam_member" "workload_identity" {
  service_account_id = google_service_account.go_service.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.namespace}/go-service]"
}
```

### Uber: Pulumi for Multi-Environment

Uber uses Pulumi with Go for infrastructure:

```go
// Uber-style Pulumi infrastructure
package main

import (
    "fmt"

    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/eks"
    "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes"
    "github.com/pulumi/pulumi-kubernetes/sdk/v4/go/kubernetes/helm/v3"
    "github.com/pulumi/pulumi/sdk/v3/go/pulumi"
    "github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

type EnvConfig struct {
    NodeCount    int
    InstanceType string
    MultiAZ      bool
}

type VPCResult struct {
    VpcID pulumi.StringOutput
}

func NewVPC(ctx *pulumi.Context, name string, cfg EnvConfig) (*VPCResult, error) {
    return &VPCResult{VpcID: pulumi.Sprintf("%s-vpc-id", name)}, nil
}

func NewEKSCluster(ctx *pulumi.Context, name string, vpc *VPCResult, cfg EnvConfig) (*eks.Cluster, pulumi.StringOutput, error) {
    cluster, err := eks.NewCluster(ctx, name, &eks.ClusterArgs{
        RoleArn: pulumi.String("arn:aws:iam::123456789012:role/eks-cluster-role"),
        VpcConfig: &eks.ClusterVpcConfigArgs{
            SubnetIds: pulumi.StringArray{vpc.VpcID},
        },
    })
    if err != nil {
        return nil, pulumi.StringOutput{}, err
    }
    kubeconfig := pulumi.Sprintf("apiVersion: v1\nclusters:\n- cluster:\n    server: %s\n  name: %s\n", cluster.Endpoint, cluster.Name)
    return cluster, kubeconfig, nil
}

func main() {
    pulumi.Run(func(ctx *pulumi.Context) error {
        cfg := config.New(ctx, "")
        env := cfg.Require("environment")

        // Create infrastructure based on environment
        infra, err := NewInfrastructure(ctx, env)
        if err != nil {
            return err
        }

        // Export outputs
        ctx.Export("clusterEndpoint", infra.Cluster.Endpoint)
        ctx.Export("kubeconfig", infra.Kubeconfig)

        return nil
    })
}

type Infrastructure struct {
    VPC        *VPCResult
    Cluster    *eks.Cluster
    Kubeconfig pulumi.StringOutput
}

func NewInfrastructure(ctx *pulumi.Context, env string) (*Infrastructure, error) {
    // Environment-specific configurations
    configs := map[string]EnvConfig{
        "dev": {
            NodeCount:    2,
            InstanceType: "t3.medium",
            MultiAZ:      false,
        },
        "staging": {
            NodeCount:    3,
            InstanceType: "t3.large",
            MultiAZ:      true,
        },
        "prod": {
            NodeCount:    5,
            InstanceType: "m5.xlarge",
            MultiAZ:      true,
        },
    }

    envCfg := configs[env]

    // Create VPC with proper tagging
    vpc, err := NewVPC(ctx, fmt.Sprintf("uber-%s", env), envCfg)
    if err != nil {
        return nil, err
    }

    // Create EKS cluster
    cluster, kubeconfig, err := NewEKSCluster(ctx, fmt.Sprintf("uber-%s", env), vpc, envCfg)
    if err != nil {
        return nil, err
    }

    // Deploy platform components
    k8sProvider, err := kubernetes.NewProvider(ctx, "k8s", &kubernetes.ProviderArgs{
        Kubeconfig: kubeconfig,
    })
    if err != nil {
        return nil, err
    }

    // Deploy Uber-specific platform components
    if err := DeployPlatformComponents(ctx, k8sProvider, env); err != nil {
        return nil, err
    }

    return &Infrastructure{
        VPC:        vpc,
        Cluster:    cluster,
        Kubeconfig: kubeconfig,
    }, nil
}

func DeployPlatformComponents(ctx *pulumi.Context, provider *kubernetes.Provider, env string) error {
    // Deploy service mesh
    _, err := helm.NewChart(ctx, "istio", helm.ChartArgs{
        Chart:     pulumi.String("base"),
        Version:   pulumi.String("1.20.0"),
        Namespace: pulumi.String("istio-system"),
        FetchArgs: helm.FetchArgs{
            Repo: pulumi.String("https://istio-release.storage.googleapis.com/charts"),
        },
    }, pulumi.Provider(provider))
    if err != nil {
        return err
    }

    // Deploy observability stack
    _, err = helm.NewChart(ctx, "prometheus", helm.ChartArgs{
        Chart:     pulumi.String("kube-prometheus-stack"),
        Namespace: pulumi.String("monitoring"),
        FetchArgs: helm.FetchArgs{
            Repo: pulumi.String("https://prometheus-community.github.io/helm-charts"),
        },
        Values: pulumi.Map{
            "prometheus": pulumi.Map{
                "prometheusSpec": pulumi.Map{
                    "retention": pulumi.String("30d"),
                },
            },
        },
    }, pulumi.Provider(provider))

    return err
}
```

### Netflix: GitOps with Flux

Netflix uses GitOps extensively for their deployments:

```yaml
# Netflix-style Flux configuration
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: platform-config
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/netflix/platform-config
  ref:
    branch: main
  secretRef:
    name: github-deploy-key
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: infrastructure
  namespace: flux-system
spec:
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: platform-config
  path: ./infrastructure
  prune: true
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: platform-controller
      namespace: platform-system
  postBuild:
    substitute:
      ENVIRONMENT: production
      REGION: us-west-2
---
# Netflix chaos engineering integration
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: chaos-monkey
  namespace: flux-system
spec:
  dependsOn:
    - name: infrastructure
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: platform-config
  path: ./chaos-monkey
  prune: true
  patches:
    - patch: |
        - op: replace
          path: /spec/schedule
          value: "*/30 * * * *"  # Run every 30 minutes in prod
      target:
        kind: ChaosPod
        name: random-pod-killer
```

### Stripe: Terraform with Policy as Code

Stripe combines Terraform with OPA for policy enforcement:

```hcl
# Stripe-style Terraform with compliance
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    opa = {
      source  = "open-policy-agent/opa"
      version = "~> 1.0"
    }
  }
}

# PCI-compliant RDS configuration
resource "aws_db_instance" "payments" {
  identifier = "payments-${var.environment}"

  # PCI DSS requirements
  engine               = "postgres"
  engine_version       = "15.4"
  instance_class       = var.environment == "prod" ? "db.r6g.xlarge" : "db.t3.medium"
  allocated_storage    = 100
  max_allocated_storage = 1000

  # Encryption at rest (PCI requirement)
  storage_encrypted = true
  kms_key_id        = aws_kms_key.rds.arn

  # Network isolation
  db_subnet_group_name   = aws_db_subnet_group.private.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  # Audit logging (PCI requirement)
  enabled_cloudwatch_logs_exports = [
    "postgresql",
    "upgrade",
  ]

  # Backup and recovery
  backup_retention_period = 35  # PCI requires 30+ days
  backup_window           = "03:00-04:00"
  maintenance_window      = "Mon:04:00-Mon:05:00"

  # Performance and monitoring
  performance_insights_enabled          = true
  performance_insights_retention_period = 731  # 2 years
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn

  # High availability for production
  multi_az               = var.environment == "prod"
  deletion_protection    = var.environment == "prod"
  skip_final_snapshot    = var.environment != "prod"
  final_snapshot_identifier = var.environment == "prod" ? "payments-final-${formatdate("YYYY-MM-DD", timestamp())}" : null

  tags = merge(var.common_tags, {
    PCI          = "true"
    DataClass    = "confidential"
    BackupPolicy = "daily"
  })
}

# OPA policy for compliance validation
data "opa_document" "pci_compliance" {
  query = "data.pci.compliance.deny"
  input = jsonencode({
    resource_type = "aws_db_instance"
    config = {
      storage_encrypted     = aws_db_instance.payments.storage_encrypted
      publicly_accessible   = aws_db_instance.payments.publicly_accessible
      backup_retention_period = aws_db_instance.payments.backup_retention_period
      multi_az              = aws_db_instance.payments.multi_az
    }
  })
}

# Fail if OPA policy denies
resource "null_resource" "pci_validation" {
  count = length(data.opa_document.pci_compliance.result) > 0 ? 1 : 0

  provisioner "local-exec" {
    command = "echo 'PCI compliance check failed: ${jsonencode(data.opa_document.pci_compliance.result)}' && exit 1"
  }
}
```

### Amazon: CDK for Infrastructure

Amazon teams use CDK with TypeScript/Python for infrastructure:

```go
// AWS CDK-style approach with Pulumi and Go
package main

import (
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/ecs"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/ecr"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/iam"
    "github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

// ServiceArgs provides configuration inputs for the construct
type ServiceArgs struct {
    Environment string
}

// AmazonServiceConstruct represents a reusable service pattern
type AmazonServiceConstruct struct {
    pulumi.ResourceState

    Repository *ecr.Repository
    Cluster    *ecs.Cluster
    Service    *ecs.Service
    TaskRole   *iam.Role
}

func NewAmazonServiceConstruct(ctx *pulumi.Context, name string, args *ServiceArgs) (*AmazonServiceConstruct, error) {
    _ = args
    construct := &AmazonServiceConstruct{}

    // Create ECR repository
    repo, err := ecr.NewRepository(ctx, name+"-repo", &ecr.RepositoryArgs{
        Name:               pulumi.String(name),
        ImageTagMutability: pulumi.String("IMMUTABLE"),
        ImageScanningConfiguration: &ecr.RepositoryImageScanningConfigurationArgs{
            ScanOnPush: pulumi.Bool(true),
        },
        EncryptionConfigurations: ecr.RepositoryEncryptionConfigurationArray{
            &ecr.RepositoryEncryptionConfigurationArgs{
                EncryptionType: pulumi.String("AES256"),
            },
        },
    })
    if err != nil {
        return nil, err
    }
    construct.Repository = repo

    // Create ECS cluster with Fargate
    cluster, err := ecs.NewCluster(ctx, name+"-cluster", &ecs.ClusterArgs{
        Name: pulumi.String(name),
        Settings: ecs.ClusterSettingArray{
            &ecs.ClusterSettingArgs{
                Name:  pulumi.String("containerInsights"),
                Value: pulumi.String("enabled"),
            },
        },
        Configuration: &ecs.ClusterConfigurationArgs{
            ExecuteCommandConfiguration: &ecs.ClusterConfigurationExecuteCommandConfigurationArgs{
                Logging: pulumi.String("OVERRIDE"),
                LogConfiguration: &ecs.ClusterConfigurationExecuteCommandConfigurationLogConfigurationArgs{
                    CloudWatchLogGroupName: pulumi.String("/ecs/" + name),
                },
            },
        },
    })
    if err != nil {
        return nil, err
    }
    construct.Cluster = cluster

    // Create task execution role
    taskRole, err := iam.NewRole(ctx, name+"-task-role", &iam.RoleArgs{
        AssumeRolePolicy: pulumi.String(`{
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": "ecs-tasks.amazonaws.com"},
                "Action": "sts:AssumeRole"
            }]
        }`),
    })
    if err != nil {
        return nil, err
    }
    construct.TaskRole = taskRole

    return construct, nil
}
```

**IaC Patterns by Company**:

| Company | Primary Tool | Key Pattern |
|---------|-------------|-------------|
| Google | Terraform | GCP modules, Workload Identity |
| Uber | Pulumi + Go | Environment-aware, component reuse |
| Netflix | Flux GitOps | Chaos integration, progressive delivery |
| Stripe | Terraform + OPA | Policy as code, PCI compliance |
| Amazon | CDK/Pulumi | Constructs, reusable patterns |

---

### Junior → FAANG: IaC Case Studies as Validation for Best Practices

The case studies in this section validate that the best practices in this chapter are genuinely used at production scale, not just theoretical ideals. Google using Terraform modules for GCP, Netflix implementing drift detection, and Amazon building construct libraries are all examples of patterns that every organization should adopt, at whatever scale is appropriate.

The specifically actionable lessons for junior engineers: the module pattern (Google's Terraform module library) means you should learn how to write and use Terraform modules, not just root configurations. The drift detection pattern (Netflix's automated plan checks) means you should add scheduled drift detection to any Terraform configuration you own. The construct library pattern (Amazon's CDK) means you should think about infrastructure in terms of reusable abstractions, not one-off configurations.

### Senior @ FAANG: IaC at Scale as Platform Team Responsibility

At staff level, these case studies describe platform team investments, not individual engineer contributions. Google's Terraform module library for GCP is owned and maintained by a platform team. Netflix's drift detection system is a platform service. Amazon's CDK construct library is published and maintained by a central team.

The organizational model that makes these investments possible: a platform team with a clear charter (make infrastructure provisioning safe, fast, and compliant for all engineering teams), a product roadmap for the module library and tooling, and direct relationships with the service teams who consume the platform. The staff engineer who builds this organizational model and drives its adoption is creating infrastructure leverage that compounds as the organization grows.

The ROI argument for platform IaC investment: every hour a service team engineer spends on incorrect infrastructure configuration, fixing state drift, or understanding tribal knowledge about cloud resource setup is an hour that could be spent on product work. Platform IaC that makes the correct infrastructure setup the default and the incorrect setup fail-fast returns those hours to product engineering. Quantifying this ROI (surveying teams on time spent on infrastructure issues, comparing before and after adopting platform modules) is the business case that justifies continued platform investment.
