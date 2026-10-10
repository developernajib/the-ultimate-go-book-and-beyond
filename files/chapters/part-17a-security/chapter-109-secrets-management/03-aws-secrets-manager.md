## 109.3 AWS Secrets Manager

AWS Secrets Manager provides native AWS integration with automatic rotation support.

### AWS Secrets Manager Client

The AWS Secrets Manager client uses the AWS SDK v2 with the default credential chain, so it automatically uses IAM roles when running on EC2 or ECS without any hardcoded credentials in the Go binary. The retrieved secret string is JSON-decoded into a typed struct, making field access compile-time safe and avoiding error-prone string map lookups. Enabling automatic rotation in Secrets Manager means the Go service retrieves the current active version on each call. If rotation occurs between calls, the next retrieval transparently returns the new credential without requiring a service restart.

```go
// pkg/secrets/aws.go
package secrets

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

// AWSSecretsManager wraps AWS Secrets Manager client
type AWSSecretsManager struct {
    client *secretsmanager.Client
}

// NewAWSSecretsManager creates a new AWS Secrets Manager client
func NewAWSSecretsManager(ctx context.Context) (*AWSSecretsManager, error) {
    cfg, err := config.LoadDefaultConfig(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to load AWS config: %w", err)
    }

    return &AWSSecretsManager{
        client: secretsmanager.NewFromConfig(cfg),
    }, nil
}

// GetSecret retrieves a secret from AWS Secrets Manager
func (a *AWSSecretsManager) GetSecret(ctx context.Context, secretName string) (string, error) {
    input := &secretsmanager.GetSecretValueInput{
        SecretId: aws.String(secretName),
    }

    result, err := a.client.GetSecretValue(ctx, input)
    if err != nil {
        return "", fmt.Errorf("failed to get secret %s: %w", secretName, err)
    }

    if result.SecretString == nil {
        return "", fmt.Errorf("secret %s has no string value", secretName)
    }

    return *result.SecretString, nil
}

// GetSecretJSON retrieves and unmarshals a JSON secret
func (a *AWSSecretsManager) GetSecretJSON(ctx context.Context, secretName string, v any) error {
    secretString, err := a.GetSecret(ctx, secretName)
    if err != nil {
        return err
    }

    if err := json.Unmarshal([]byte(secretString), v); err != nil {
        return fmt.Errorf("failed to unmarshal secret %s: %w", secretName, err)
    }

    return nil
}

// CreateSecret creates a new secret
func (a *AWSSecretsManager) CreateSecret(ctx context.Context, name, description, value string) error {
    input := &secretsmanager.CreateSecretInput{
        Name:         aws.String(name),
        Description:  aws.String(description),
        SecretString: aws.String(value),
    }

    _, err := a.client.CreateSecret(ctx, input)
    if err != nil {
        return fmt.Errorf("failed to create secret %s: %w", name, err)
    }

    return nil
}

// UpdateSecret updates an existing secret
func (a *AWSSecretsManager) UpdateSecret(ctx context.Context, name, value string) error {
    input := &secretsmanager.UpdateSecretInput{
        SecretId:     aws.String(name),
        SecretString: aws.String(value),
    }

    _, err := a.client.UpdateSecret(ctx, input)
    if err != nil {
        return fmt.Errorf("failed to update secret %s: %w", name, err)
    }

    return nil
}

// RotateSecret triggers secret rotation
func (a *AWSSecretsManager) RotateSecret(ctx context.Context, secretName, lambdaARN string) error {
    input := &secretsmanager.RotateSecretInput{
        SecretId:           aws.String(secretName),
        RotationLambdaARN:  aws.String(lambdaARN),
        RotateImmediately:  aws.Bool(true),
    }

    _, err := a.client.RotateSecret(ctx, input)
    if err != nil {
        return fmt.Errorf("failed to rotate secret %s: %w", secretName, err)
    }

    return nil
}
```

### Database Configuration with AWS Secrets Manager

Combining `database/sql` with AWS Secrets Manager keeps credentials out of configuration files entirely. `ConnectWithAWSSecrets` below fetches the current connection details from Secrets Manager at startup and builds the DSN from the decoded `DBConfig`. To survive rotation without a restart, wrap this in a periodic re-fetch or reconnect-on-auth-failure layer, the pattern shown in the rotation section later in this chapter.

```go
// pkg/secrets/database.go
package secrets

import (
    "context"
    "database/sql"
    "fmt"

    _ "github.com/lib/pq"
)

// DBConfig represents database configuration stored in Secrets Manager
type DBConfig struct {
    Host     string `json:"host"`
    Port     int    `json:"port"`
    Username string `json:"username"`
    Password string `json:"password"`
    Database string `json:"database"`
    SSLMode  string `json:"sslmode"`
}

// ConnectWithAWSSecrets connects to a database using credentials from AWS Secrets Manager
func ConnectWithAWSSecrets(ctx context.Context, secretName string) (*sql.DB, error) {
    sm, err := NewAWSSecretsManager(ctx)
    if err != nil {
        return nil, err
    }

    var dbConfig DBConfig
    if err := sm.GetSecretJSON(ctx, secretName, &dbConfig); err != nil {
        return nil, err
    }

    dsn := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
        dbConfig.Host, dbConfig.Port, dbConfig.Username, dbConfig.Password, dbConfig.Database, dbConfig.SSLMode)

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, fmt.Errorf("failed to open database: %w", err)
    }

    if err := db.PingContext(ctx); err != nil {
        db.Close()
        return nil, fmt.Errorf("failed to ping database: %w", err)
    }

    return db, nil
}
```

### Junior → FAANG: AWS Secrets Manager Integration Fundamentals

AWS Secrets Manager is the default secrets management solution for services running on AWS. Understanding its integration patterns is required for any AWS-centric backend role.

**Gap to close:** Know the difference between AWS Secrets Manager and AWS Parameter Store. Secrets Manager is designed for secret values with rotation support, higher cost per API call, and automatic rotation for supported services (RDS, Redshift). Parameter Store is cheaper, supports hierarchical naming, and is suitable for configuration values that are not strictly secrets. Know which to use for which use case.

**IAM as the authentication mechanism:** In AWS, services authenticate to Secrets Manager using their IAM role. An EC2 instance or Lambda function has an IAM role with a policy that permits `secretsmanager:GetSecretValue` for specific secret ARNs. There is no separate credential: the workload identity IS the authentication. This is the correct model: no bootstrap secret is needed to get the secret.

**Interview framing:** When asked "how does a Go Lambda function securely access a database password?", describe: the Lambda has an IAM role with permission to get a specific secret ARN in Secrets Manager, the Go code uses the AWS SDK (which automatically uses the Lambda execution role credentials), and caches the secret value in memory for the function lifetime. Do not mention environment variables as the storage location for the database password.

### Senior @ FAANG: AWS Secrets Manager at Organization Scale

At senior level, AWS Secrets Manager is part of a larger secrets management architecture that spans multiple accounts, multiple regions, and multiple secret types.

**Multi-account secrets strategy:** In an AWS Organization with multiple accounts (development, staging, production, per-team sandboxes), decide whether secrets are stored per-account or in a centralized account with cross-account access. Per-account storage is simpler and provides natural isolation. Centralized storage is easier to audit and rotate. The decision depends on your organizational security model and compliance requirements. Document it in an ADR.

**Rotation at scale:** AWS Secrets Manager supports automatic rotation for RDS databases using Lambda rotation functions. For other secret types, you must implement custom rotation logic. Design rotation to be zero-downtime: the rotation process creates a new secret version, ensures the service can use both the old and new versions during the transition period, and then marks the old version as deprecated. Services that detect an authentication failure on the old credential and retry with a freshly fetched value support zero-downtime rotation.

**Cost and quota management:** At high secret access volume, Secrets Manager costs add up. Cache secrets in memory with a TTL that matches your rotation period: if secrets rotate every 24 hours, cache them for 23 hours and refresh 1 hour before expected rotation. Track Secrets Manager API call rates and costs in your AWS Cost Explorer. Design your caching layer to stay within the per-secret API rate limits to avoid throttling.
