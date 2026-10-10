## 102C.6 Testing with Terratest (Go)

Terratest is a Go library for testing Terraform configurations by creating real infrastructure, running tests against it, and tearing it down.

```go
// test/vpc_test.go
package test

import (
    "fmt"
    "testing"
    "time"

    "github.com/gruntwork-io/terratest/modules/aws"
    "github.com/gruntwork-io/terratest/modules/retry"
    "github.com/gruntwork-io/terratest/modules/terraform"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestVPCModule(t *testing.T) {
    t.Parallel()

    awsRegion := "us-east-1"
    uniqueID := terraform.UniqueId()

    terraformOptions := &terraform.Options{
        TerraformDir: "../modules/vpc",
        Vars: map[string]any{
            "project":            fmt.Sprintf("test-%s", uniqueID),
            "environment":        "test",
            "cidr_block":         "10.99.0.0/16",
            "availability_zones": []string{"us-east-1a", "us-east-1b"},
        },
        // Retry on known transient AWS errors
        RetryableTerraformErrors: map[string]string{
            "RequestError: send request failed": "Transient AWS error",
        },
        MaxRetries:         3,
        TimeBetweenRetries: 5 * time.Second,
    }

    // Destroy at test end, even on failure
    defer terraform.Destroy(t, terraformOptions)

    // Apply the module
    terraform.InitAndApply(t, terraformOptions)

    // Read outputs
    vpcID := terraform.Output(t, terraformOptions, "vpc_id")
    privateSubnetIDs := terraform.OutputList(t, terraformOptions, "private_subnet_ids")
    publicSubnetIDs := terraform.OutputList(t, terraformOptions, "public_subnet_ids")

    // Validate VPC exists
    vpc := aws.GetVpcById(t, vpcID, awsRegion)
    require.NotNil(t, vpc)
    assert.Equal(t, "10.99.0.0/16", aws.GetVpcCidrBlock(t, vpcID, awsRegion))

    // Validate subnet count
    assert.Equal(t, 2, len(privateSubnetIDs))
    assert.Equal(t, 2, len(publicSubnetIDs))

    // Validate private subnets have no route to IGW
    for _, subnetID := range privateSubnetIDs {
        routeTable := aws.GetRouteTable(t, subnetID, awsRegion)
        hasIGWRoute := false
        for _, route := range routeTable.Routes {
            if route.GatewayId != nil && *route.GatewayId != "" {
                hasIGWRoute = true
            }
        }
        assert.False(t, hasIGWRoute, "Private subnet %s should not have IGW route", subnetID)
    }
}

func TestECSServiceModule(t *testing.T) {
    t.Parallel()

    awsRegion := "us-east-1"
    uniqueID := terraform.UniqueId()

    // Deploy VPC first (or use existing test VPC)
    vpcOptions := &terraform.Options{
        TerraformDir: "../modules/vpc",
        Vars: map[string]any{
            "project":            fmt.Sprintf("test-%s", uniqueID),
            "environment":        "test",
            "cidr_block":         "10.98.0.0/16",
            "availability_zones": []string{"us-east-1a", "us-east-1b"},
        },
    }
    defer terraform.Destroy(t, vpcOptions)
    terraform.InitAndApply(t, vpcOptions)

    vpcID := terraform.Output(t, vpcOptions, "vpc_id")
    subnetIDs := terraform.OutputList(t, vpcOptions, "private_subnet_ids")

    // Deploy ECS cluster
    clusterOptions := &terraform.Options{
        TerraformDir: "../modules/ecs-cluster",
        Vars: map[string]any{
            "cluster_name": fmt.Sprintf("test-%s", uniqueID),
        },
    }
    defer terraform.Destroy(t, clusterOptions)
    terraform.InitAndApply(t, clusterOptions)
    clusterID := terraform.Output(t, clusterOptions, "cluster_id")

    // Deploy ECS service
    serviceOptions := &terraform.Options{
        TerraformDir: "../modules/ecs-service",
        Vars: map[string]any{
            "service_name":    fmt.Sprintf("test-api-%s", uniqueID),
            "cluster_id":      clusterID,
            "container_image": "public.ecr.aws/nginx/nginx:latest",
            "container_port":  80,
            "subnet_ids":      subnetIDs,
            "vpc_id":          vpcID,
            "min_capacity":    1,
            "max_capacity":    2,
        },
    }
    defer terraform.Destroy(t, serviceOptions)
    terraform.InitAndApply(t, serviceOptions)

    serviceARN := terraform.Output(t, serviceOptions, "service_arn")

    // Wait for service to stabilize
    maxRetries := 30
    timeBetweenRetries := 10 * time.Second
    retry.DoWithRetry(t, "Wait for ECS service to stabilize", maxRetries, timeBetweenRetries, func() (string, error) {
        service := aws.GetEcsService(t, awsRegion, clusterID, serviceARN)
        if service.RunningCount != service.DesiredCount {
            return "", fmt.Errorf("service not stable: running=%d desired=%d",
                service.RunningCount, service.DesiredCount)
        }
        return "stable", nil
    })

    // Validate health
    service := aws.GetEcsService(t, awsRegion, clusterID, serviceARN)
    assert.Equal(t, int64(1), service.RunningCount)
}
```

---

### Junior → FAANG: Your First Terratest Suite

The hardest part of writing your first Terratest test is accepting that it is slow. A VPC test that creates real subnets, internet gateways, and route tables in AWS takes 3-5 minutes. An ECS service test takes 8-12 minutes. This is normal. The solution is not to avoid testing real infrastructure. It is to run tests with `t.Parallel()` and budget 30-60 minutes for a full CI test run.

Three habits to develop immediately: First, always use `defer terraform.Destroy(t, terraformOptions)` as the very first line after creating the options. This ensures cleanup runs even if the test panics or calls `t.Fatal`. Second, always use `terraform.UniqueId()` in resource names so parallel runs in CI do not conflict on the same AWS account. Third, check more than Terraform outputs. Use the AWS SDK directly to verify the actual resource has the properties you care about (encryption enabled, not publicly accessible, backup retention set).

For interviews, be ready to explain the tradeoff: Terratest tests are expensive in time and money, so you run them in CI against a dedicated test AWS account, not production. The test account has a budget alarm at $500/month and automated cleanup for any resources older than 24 hours (a Lambda-based resource janitor).

### Senior @ FAANG: Terratest Strategy at Platform Scale

At L6, you design the Terratest strategy for an organization where 30+ module repositories need coverage. The individual test patterns above are correct. The strategic questions are at a higher level.

**Test account governance.** A dedicated test account needs its own baseline infrastructure: a VPC with private subnets for tests that cannot use the default VPC, IAM roles with least-privilege access for test execution, resource tagging policies that mark every test resource with the PR number and expiry time, and a cleanup Lambda that runs hourly and destroys resources older than 4 hours. Without automatic cleanup, test accounts accumulate orphaned resources from interrupted CI runs, and the cost grows unbounded.

**Test granularity and the cost-speed tradeoff.** Not every module needs a full Terratest integration test. The testing pyramid for infrastructure has three tiers: static analysis (`terraform validate`, `tflint`, `tfsec`, Checkov) that runs in under 30 seconds with no AWS calls, narrow integration tests that test a single module in isolation (5-15 minutes), and end-to-end tests that test a composed stack (20-45 minutes). At staff level, you define which tier applies to which category of change: static analysis on every PR commit, narrow integration tests as a merge gate, end-to-end tests on a schedule (nightly) or on release candidates.

**Idempotency as a first-class test assertion.** The most valuable Terratest assertion at scale is the idempotency check: apply, then immediately plan again and assert exit code 0. This catches modules with non-deterministic resource generation (timestamp-based names, computed attributes that differ between plan and apply) before they reach production. Include this check in every module test suite as a standard step.

**Contract testing for module outputs.** When 20 root modules depend on the VPC module's outputs, changes to the output interface are breaking changes. Contract tests (as shown in section 102C.10) run on every VPC module PR and assert that all required outputs exist with the correct format. This is the IaC equivalent of API contract testing and prevents the silent breaking changes that cause cascading failures across dependent modules. At L6, you define the required contract tests for every module in your platform library as a gate for module publication to the internal registry.
