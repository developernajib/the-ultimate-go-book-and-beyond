## 102C.15 Advanced Terratest Patterns

Chapter 102C.6 covered basic Terratest. This section covers production patterns: parallel runs, test isolation, RDS module testing, stages for expensive resources, and contract testing.

### Test Isolation with Unique Resource Names

Every test run must create uniquely named resources to avoid conflicts when parallel CI pipelines run simultaneously across multiple open PRs on the same AWS account:

```go
package test

import (
    "fmt"
    "testing"
    "time"

    "github.com/gruntwork-io/terratest/modules/aws"
    "github.com/gruntwork-io/terratest/modules/random"
    "github.com/gruntwork-io/terratest/modules/terraform"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

// testUID returns a short suffix that is unique per test invocation.
// Combines a timestamp modulus with a random string to survive parallel CI runs.
func testUID() string {
    return fmt.Sprintf("%d-%s", time.Now().UnixMilli()%100000, random.UniqueId())
}

func TestS3BucketModule(t *testing.T) {
    t.Parallel() // This test runs concurrently with sibling tests

    uid := testUID()
    bucketName := fmt.Sprintf("test-bucket-%s", uid)

    opts := terraform.WithDefaultRetryableErrors(t, &terraform.Options{
        TerraformDir: "../modules/s3-bucket",
        Vars: map[string]any{
            "bucket_name":   bucketName,
            "environment":   "test",
            "force_destroy": true, // Required so destroy works even if bucket has objects
        },
        MaxRetries:         3,
        TimeBetweenRetries: 5 * time.Second,
        RetryableTerraformErrors: map[string]string{
            "BucketAlreadyOwnedByYou":  "S3 name conflict, retrying",
            "TooManyRequestsException": "AWS rate limit, retrying",
        },
    })

    // Deferred destroy runs on t.Fatal, panic, and normal exit
    defer terraform.Destroy(t, opts)
    terraform.InitAndApply(t, opts)

    region := terraform.Output(t, opts, "region")
    actualName := terraform.Output(t, opts, "bucket_name")
    assert.Equal(t, bucketName, actualName)

    // Versioning must be enabled
    versioning := aws.GetS3BucketVersioning(t, region, actualName)
    assert.Equal(t, "Enabled", versioning)

    // SSE with KMS must be configured
    sseConfig := aws.GetS3BucketServerSideEncryptionConfiguration(t, region, actualName)
    require.NotNil(t, sseConfig)
    require.NotEmpty(t, sseConfig.Rules)
    assert.Equal(t, "aws:kms",
        *sseConfig.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm)

    // Public access must be fully blocked
    publicBlock := aws.GetS3BucketPublicAccessBlock(t, region, actualName)
    assert.True(t, *publicBlock.BlockPublicAcls)
    assert.True(t, *publicBlock.BlockPublicPolicy)
    assert.True(t, *publicBlock.IgnorePublicAcls)
    assert.True(t, *publicBlock.RestrictPublicBuckets)
}
```

### RDS Module Testing

RDS provisioning is the most time-consuming resource in a typical module suite. An Aurora or PostgreSQL instance takes 5-10 minutes to reach the `available` state, so the test sets `MaxRetries: 20` with 30-second intervals to tolerate the provisioning window without flapping. Beyond Terraform outputs, the test uses the AWS SDK directly to read the actual `DBInstance` struct and assert security invariants. `StorageEncrypted`, `PubliclyAccessible: false`, and `BackupRetentionPeriod >= 1`. That Terraform outputs would not surface if a module author omitted them. Setting `skip_final_snapshot: true` and `deletion_protection: false` is mandatory so `terraform destroy` completes cleanly without manual intervention after the test finishes.

```go
func TestRDSModule(t *testing.T) {
    t.Parallel()

    uid := testUID()

    opts := terraform.WithDefaultRetryableErrors(t, &terraform.Options{
        TerraformDir: "../modules/rds",
        Vars: map[string]any{
            "identifier":          fmt.Sprintf("test-rds-%s", uid),
            "instance_class":      "db.t3.micro", // Smallest class for cost efficiency in tests
            "allocated_storage":   20,
            "engine_version":      "15.4",
            "database_name":       "testdb",
            "username":            "testadmin",
            "environment":         "test",
            "skip_final_snapshot": true,  // Mandatory for test teardown
            "deletion_protection": false, // Must be false to allow destroy
        },
        // RDS provisioning takes 5-10 minutes
        MaxRetries:         20,
        TimeBetweenRetries: 30 * time.Second,
    })

    defer terraform.Destroy(t, opts)
    terraform.InitAndApply(t, opts)

    endpoint   := terraform.Output(t, opts, "endpoint")
    port       := terraform.OutputInt(t, opts, "port")
    dbName     := terraform.Output(t, opts, "database_name")
    region     := terraform.Output(t, opts, "region")
    instanceID := terraform.Output(t, opts, "instance_id")

    assert.NotEmpty(t, endpoint)
    assert.Equal(t, 5432, port)
    assert.Equal(t, "testdb", dbName)

    // AWS SDK validation - verifies actual resource properties, not just Terraform outputs
    dbInst := aws.GetRdsInstanceById(t, instanceID, region)
    assert.Equal(t, "available", *dbInst.DBInstanceStatus)
    assert.True(t, *dbInst.StorageEncrypted, "storage encryption must be enabled")
    assert.False(t, *dbInst.PubliclyAccessible, "RDS must not be publicly accessible")
    assert.GreaterOrEqual(t, int(*dbInst.BackupRetentionPeriod), 1, "backup retention must be >= 1 day")
    assert.Equal(t, "db.t3.micro", *dbInst.DBInstanceClass)
}
```

### Test Stages for Expensive Resources

For slow resources (RDS creation: 8 minutes, EKS: 15 minutes), use `test_structure` to cache apply state. This lets you iterate on assertion code without paying creation cost every run:

```go
import "github.com/gruntwork-io/terratest/modules/test-structure"

func TestRDSModuleWithStages(t *testing.T) {
    t.Parallel()

    workDir := t.TempDir() // Unique per test run, isolated staging area

    defer test_structure.RunTestStage(t, "teardown", func() {
        opts := test_structure.LoadTerraformOptions(t, workDir)
        terraform.Destroy(t, opts)
    })

    test_structure.RunTestStage(t, "deploy", func() {
        uid := testUID()
        opts := terraform.WithDefaultRetryableErrors(t, &terraform.Options{
            TerraformDir: "../modules/rds",
            Vars: map[string]any{
                "identifier":          fmt.Sprintf("test-%s", uid),
                "skip_final_snapshot": true,
                "deletion_protection": false,
            },
        })
        test_structure.SaveTerraformOptions(t, workDir, opts)
        terraform.InitAndApply(t, opts)
    })

    test_structure.RunTestStage(t, "validate", func() {
        opts := test_structure.LoadTerraformOptions(t, workDir)
        endpoint := terraform.Output(t, opts, "endpoint")
        assert.NotEmpty(t, endpoint)
        // Add all assertions here
    })
    // Re-run assertions only: SKIP_deploy=true go test ./...
}
```

### Contract Testing for Module Output Interfaces

Contract tests verify that a module's output interface stays stable across versions - critical when 10+ root modules consume the same shared module:

```go
// contract_test.go - guards the output API of the vpc module
func TestVPCModuleContract(t *testing.T) {
    t.Parallel()

    opts := &terraform.Options{
        TerraformDir: "../modules/vpc",
        Vars: map[string]any{
            "name":       fmt.Sprintf("contract-%s", testUID()),
            "cidr_block": "10.99.0.0/16",
            "azs":        []string{"us-east-1a", "us-east-1b"},
        },
    }
    defer terraform.Destroy(t, opts)
    terraform.InitAndApply(t, opts)

    // Contract: these outputs MUST exist and be non-empty.
    // Removing or renaming them constitutes a breaking change (major version bump).
    for _, output := range []string{
        "vpc_id", "private_subnet_ids", "public_subnet_ids",
        "nat_gateway_ids", "vpc_cidr_block",
    } {
        val := terraform.Output(t, opts, output)
        assert.NotEmpty(t, val, "required output %q must not be empty", output)
    }

    // Contract: vpc_id must match the AWS VPC ID format
    vpcID := terraform.Output(t, opts, "vpc_id")
    assert.Regexp(t, `^vpc-[a-f0-9]+$`, vpcID, "vpc_id must be a valid VPC ID")

    // Contract: HA requires at least 2 private subnets
    subnets := terraform.OutputList(t, opts, "private_subnet_ids")
    assert.GreaterOrEqual(t, len(subnets), 2, "minimum 2 private subnets required for HA")
}
```

---

### Junior → FAANG: Making Advanced Patterns Practical

The four patterns in this section (unique naming, RDS testing, staged tests, contract tests) represent the gap between Terratest code that works in a tutorial and Terratest code that survives six months in production CI.

Start with unique naming. Every test resource name must include `testUID()` or `random.UniqueId()`. If you write even one test without this and run it twice in parallel (which CI does on every PR), you will see a name conflict failure that is confusing to debug. Make unique naming the first habit, before anything else.

The staged test pattern is the key to iterating quickly on assertions. When an RDS test takes 10 minutes to create the database, you do not want to pay that cost every time you fix a typo in an assertion. Use `SKIP_deploy=true go test -run TestRDSModuleWithStages ./test/...` to skip the creation stage and re-run only the validation stage against already-provisioned infrastructure. This reduces the iteration cycle from 10 minutes to 10 seconds.

For interviews, being able to describe the staged test pattern and explain why it exists (test execution time cost) demonstrates practical Terratest experience that goes beyond reading the documentation.

### Senior @ FAANG: Terratest at Platform Scale

The patterns above solve individual module testing problems. At L6, the strategic questions are about the test platform as a whole: how do you make 30 module repositories consistently testable, cost-efficient, and reliable in CI?

**Test account architecture as a reliability concern.** A shared test account without resource tagging policies becomes an orphaned-resource accumulator. Every interrupted CI run leaves partially created resources. Without automated cleanup, the account gradually fills with stale VPCs, RDS snapshots, and ECS clusters that no test references but continue to generate costs. The solution is a resource tagging policy (enforced by AWS Config) that requires every resource in the test account to have a `TestID` and `ExpiresAt` tag. A cleanup Lambda runs every 30 minutes and destroys any resource whose `ExpiresAt` has passed. Terratest tests set `ExpiresAt` to `time.Now().Add(4 * time.Hour)` in the resource tags, giving them a cleanup window even if the deferred destroy does not run.

**Contract tests as a registry gate.** The contract test pattern in this section is the most underused pattern in practice. When you have 20 modules consuming the VPC module's outputs, a breaking output change affects 20 teams simultaneously. The contract test runs on every VPC module PR and asserts the stable output surface. But at L6, you go further: the contract test is a required step in the module registry publication pipeline. A module version cannot be published to the internal registry unless all contract tests pass against the new version. This converts the contract test from an optional quality gate to a required release gate.

**Parallel test budget management.** `t.Parallel()` in Terratest is essential for speed but creates an implicit resource budget problem. If 20 tests run in parallel and each creates 10 AWS resources, you instantaneously have 200 resources being created. AWS imposes service quotas (for example, VPCs per region defaults to 5 in most regions). Hitting a quota causes spurious test failures that look like infrastructure problems but are actually quota problems. At staff level, you design the test parallelism budget: how many tests run simultaneously per test account, which resources need quota increases in the test account, and whether regional distribution (running different tests in different regions) is needed to avoid quota contention.
