## 102C.18 Automated Testing with Terratest

Terratest is the industry-standard Go library for testing infrastructure code. It creates real infrastructure, validates behavior, and tears it down, providing confidence that modules work before they reach production. Tests are slow (minutes) and cost money (real AWS resources), so run them in CI against a dedicated test account.

### Test Project Structure

Terratest tests live in a `test/` directory alongside the module they validate, following standard Go test file conventions. Each module under `modules/` has a corresponding test file under `test/`, and a `fixtures/` subdirectory contains the minimal Terraform configuration that exercises the module in isolation. Keeping fixtures small. Just enough to instantiate the module with representative inputs. Reduces infrastructure cost and test execution time.

```
modules/
└── kubernetes-cluster/
    ├── main.tf
    ├── variables.tf
    ├── outputs.tf
    └── versions.tf
test/
├── go.mod
├── go.sum
├── kubernetes_cluster_test.go
├── fixtures/
│   └── kubernetes-cluster/
│       ├── main.tf        # Minimal config calling the module with test values
│       └── outputs.tf
└── helpers/
    ├── aws.go             # AWS SDK helper functions
    └── k8s.go             # Kubernetes client helpers
```

### Full Terratest: EKS Cluster Module

An EKS cluster test is one of the most complex Terratest scenarios because it requires creating real AWS resources, waiting for the cluster to be ready, deploying a test workload, and verifying it runs correctly before tearing everything down. The test function below uses `defer terraform.Destroy` to ensure cleanup runs even if assertions fail mid-test, and uses `k8s.WaitUntilDeploymentAvailable` to block until the Kubernetes control plane accepts API requests.

```go
// test/kubernetes_cluster_test.go
package test

import (
    "context"
    "fmt"
    "testing"
    "time"

    awssdk "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/eks"
    "github.com/gruntwork-io/terratest/modules/k8s"
    "github.com/gruntwork-io/terratest/modules/random"
    "github.com/gruntwork-io/terratest/modules/retry"
    "github.com/gruntwork-io/terratest/modules/terraform"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// TestKubernetesCluster validates the EKS cluster module end-to-end.
// Runtime: ~20-30 minutes. Requires AWS credentials with EKS/VPC/IAM permissions.
func TestKubernetesCluster(t *testing.T) {
    t.Parallel()

    uniqueID    := random.UniqueId()
    clusterName := fmt.Sprintf("terratest-eks-%s", uniqueID)
    region      := "us-east-1"

    // Setup -- point at test fixture
    terraformOptions := terraform.WithDefaultRetryableErrors(t, &terraform.Options{
        TerraformDir: "../test/fixtures/kubernetes-cluster",
        Vars: map[string]any{
            "cluster_name":       clusterName,
            "cluster_version":    "1.29",
            "region":             region,
            "node_instance_type": "t3.medium",
            "node_desired_count": 2,
            "tags":               map[string]string{"Environment": "terratest", "TestID": uniqueID},
        },
        RetryableTerraformErrors: map[string]string{
            "RequestError: send request failed": "Transient network error",
            "ThrottlingException":               "AWS API rate limit",
        },
        MaxRetries:         3,
        TimeBetweenRetries: 10 * time.Second,
    })

    // Destroy -- defer runs even on panic or t.Fatal
    defer terraform.Destroy(t, terraformOptions)

    // Apply
    terraform.InitAndApply(t, terraformOptions)

    // Validate outputs
    t.Run("ValidateTerraformOutputs", func(t *testing.T) {
        endpoint := terraform.Output(t, terraformOptions, "cluster_endpoint")
        require.NotEmpty(t, endpoint)
        assert.Contains(t, endpoint, "eks.amazonaws.com")

        oidcURL := terraform.Output(t, terraformOptions, "oidc_provider_url")
        require.NotEmpty(t, oidcURL)
        assert.Contains(t, oidcURL, "oidc.eks")
    })

    // Validate AWS resources via SDK
    t.Run("ValidateAWSResources", func(t *testing.T) {
        ctx := context.Background()
        cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
        require.NoError(t, err)

        eksClient := eks.NewFromConfig(cfg)
        out, err := eksClient.DescribeCluster(ctx, &eks.DescribeClusterInput{
            Name: awssdk.String(clusterName),
        })
        require.NoError(t, err)
        assert.Equal(t, "ACTIVE", string(out.Cluster.Status))
        assert.Equal(t, "1.29", *out.Cluster.Version)

        // Security requirement: private API endpoint must be enabled
        require.NotNil(t, out.Cluster.ResourcesVpcConfig)
        assert.True(t, *out.Cluster.ResourcesVpcConfig.EndpointPrivateAccess,
            "private endpoint access must be enabled")

        // Security requirement: secrets must be encrypted
        assert.NotEmpty(t, out.Cluster.EncryptionConfig,
            "envelope encryption for Kubernetes secrets must be configured")
    })

    // Validate Kubernetes cluster behavior
    t.Run("ValidateKubernetesCluster", func(t *testing.T) {
        kubeconfigPath := terraform.Output(t, terraformOptions, "kubeconfig_path")
        k8sOptions     := k8s.NewKubectlOptions("", kubeconfigPath, "default")

        // Wait for nodes to become Ready (timeout: 10 minutes)
        retry.DoWithRetry(t, "wait for nodes ready", 20, 30*time.Second, func() (string, error) {
            nodes, err := k8s.GetNodesByFilterE(t, k8sOptions, metav1.ListOptions{})
            if err != nil {
                return "", err
            }
            for _, node := range nodes {
                if !k8s.IsNodeReady(node) {
                    return "", fmt.Errorf("node %s is not ready yet", node.Name)
                }
            }
            return fmt.Sprintf("all %d nodes ready", len(nodes)), nil
        })

        nodes, err := k8s.GetNodesByFilterE(t, k8sOptions, metav1.ListOptions{})
        require.NoError(t, err)
        assert.Equal(t, 2, len(nodes), "expected node count to match desired_count=2")
    })

    // Idempotency check -- second plan must produce zero changes
    t.Run("ValidateIdempotency", func(t *testing.T) {
        exitCode := terraform.PlanExitCode(t, terraformOptions)
        assert.Equal(t, 0, exitCode,
            "second plan exit code must be 0 (no changes); module is not idempotent")
    })
}
```

### Test Fixture

A test fixture is the minimal Terraform configuration that instantiates a module under test with representative inputs. Fixtures use random suffix generation to ensure test runs do not collide with each other or with existing resources, which is essential when running tests in parallel against a shared AWS account. Fixtures should not include any resources beyond what is needed to test the module. Extra resources add cost and create potential interference between tests.

```hcl
# test/fixtures/kubernetes-cluster/main.tf
provider "aws" { region = var.region }

# Minimal VPC for test isolation -- not reusing production VPC module
module "vpc" {
  source             = "terraform-aws-modules/vpc/aws"
  version            = "5.1.2"
  name               = "${var.cluster_name}-vpc"
  cidr               = "10.0.0.0/16"
  azs                = ["${var.region}a", "${var.region}b"]
  private_subnets    = ["10.0.1.0/24", "10.0.2.0/24"]
  public_subnets     = ["10.0.101.0/24", "10.0.102.0/24"]
  enable_nat_gateway = true
  single_nat_gateway = true  # Cost optimization for tests
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"           = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "owned"
  }
}

# The module under test
module "eks" {
  source             = "../../../modules/kubernetes-cluster"
  cluster_name       = var.cluster_name
  cluster_version    = var.cluster_version
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnets
  node_instance_type = var.node_instance_type
  node_desired_count = var.node_desired_count
  tags               = var.tags
}
```

### Parallel Test Suite and CLI Usage

Running Terratest tests in parallel using `t.Parallel()` is essential for keeping CI times manageable. A suite of 10 module tests that each take 10 minutes would take 100 minutes sequentially but only ~10 minutes in parallel. The key is to give each parallel test unique resource names (using `random.UniqueId()`) so they do not interfere with each other in the same AWS account. The suite file below shows how to wire all module tests into a single `go test` invocation with configurable timeout.

```go
// test/suite_test.go -- run all module tests concurrently
package test

import "testing"

func TestAll(t *testing.T) {
    t.Run("VPC", func(t *testing.T) { t.Parallel(); TestVPCModule(t) })
    t.Run("RDS", func(t *testing.T) { t.Parallel(); TestRDSModule(t) })
    t.Run("EKS", func(t *testing.T) { t.Parallel(); TestKubernetesCluster(t) })
    t.Run("ALB", func(t *testing.T) { t.Parallel(); TestALBModule(t) })
}
```

```bash
# Run all tests -- -count=1 disables Go result caching - -timeout for long-running infra tests
go test -v -timeout 60m -count=1 ./test/...

# Run a single named test
go test -v -timeout 30m -run TestKubernetesCluster ./test/...
```

---

### Junior → FAANG: Writing Your First Production Terratest Suite

The EKS test in this section is the most complex Terratest you will encounter in practice. Working through it teaches three core skills that transfer to every module test you write afterward.

First: the multi-layer validation approach. The test validates at three levels: Terraform outputs (did the module produce the expected values?), AWS SDK (does the actual resource have the required security properties?), and Kubernetes API (does the cluster actually accept connections?). Each layer catches a different class of bug. A module that produces correct outputs but configures encryption incorrectly would pass the first layer and fail the second. A module that configures resources correctly but has a networking problem preventing API access would pass the first two and fail the third. Implement all three layers for every module that has a runtime behavior component.

Second: the idempotency sub-test. `terraform.PlanExitCode(t, terraformOptions)` returning 0 after a successful apply is the most valuable assertion in the suite. It costs nothing (no new infrastructure) and catches a wide class of module bugs including timestamp-based naming, computed attributes that differ between plan and apply, and provider resources that generate a diff on every read. Add this assertion to every test you write.

Third: the defer placement. `defer terraform.Destroy(t, terraformOptions)` must be registered before `terraform.InitAndApply`. If `InitAndApply` panics before the defer is registered, you have orphaned infrastructure. The pattern is always: declare options, register defer, then apply.

### Senior @ FAANG: Terratest as a Platform Engineering Discipline

At L6, the individual test functions above are well-understood patterns. The strategic concerns are at the platform level: how do you make the entire module ecosystem consistently testable, reliably clean, and cost-bounded?

**The fixture isolation principle.** The test fixture in this section uses the public `terraform-aws-modules/vpc/aws` module rather than the organization's own VPC module. This is deliberate: using the org VPC module in a fixture creates a hidden dependency between the EKS module test and the VPC module, meaning an EKS module test can fail because of a VPC module bug. Production-grade fixtures use minimal, self-contained infrastructure (or well-understood public modules) to ensure that test failures are caused by the module under test, not its dependencies.

**Test result caching and CI optimization.** `-count=1` disables Go's test result caching, which is correct for Terratest because infrastructure tests have external state that changes between runs. However, there is a legitimate caching strategy at the module level: if a PR modifies only the ECS module, there is no reason to run the VPC module tests. Implementing module-level change detection in CI (using `git diff` to identify changed modules and running only the corresponding tests) reduces the test bill significantly at scale. At L6, you design this optimization into the CI pipeline rather than running all tests on every PR.

**The Kubernetes test as a reliability signal.** The `ValidateKubernetesCluster` sub-test in the EKS test is not just a functional check. It is a readiness probe for the entire infrastructure stack. When this test fails, the failure message tells you where in the stack the problem is: node provisioning (nodes not Ready within the timeout), control plane connectivity (Kubernetes API unreachable), or security group configuration (kubectl times out). Designing Terratest to produce structured, diagnostic failure messages rather than generic assertion errors makes post-incident investigation significantly faster. At bar-raiser level, you discuss this diagnostic design philosophy: test failures should be self-describing so the engineer reading CI output can identify the root cause without needing to reproduce the failure locally.
