## 109.10 Company Case Studies: Secrets Management at Scale

### Google: Secret Manager

Google Cloud Secret Manager with Workload Identity:

```go
// Reading "latest" means rotated values are picked up on the next fetch
func GetSecretLatest(ctx context.Context, projectID, name string) (string, error) {
    client, err := secretmanager.NewClient(ctx)
    if err != nil {
        return "", err
    }
    defer client.Close()

    result, err := client.AccessSecretVersion(ctx, &secretmanagerpb.AccessSecretVersionRequest{
        Name: fmt.Sprintf("projects/%s/secrets/%s/versions/latest", projectID, name),
    })
    if err != nil {
        return "", err
    }
    return string(result.Payload.Data), nil
}
```

### Uber: Custom Vault Integration

Uber's high-throughput secrets access pattern for 4,000+ microservices.

### Netflix: Secrets in Titus

Netflix integrates secrets management with their Titus container platform.

### Stripe: Zero-Trust Secrets

Stripe's approach with short-lived credentials and mandatory rotation.

### Amazon: Secrets Manager with Lambda Rotation

Amazon's automatic rotation pattern using Lambda functions.

**Secrets Management by Company**:

| Company | Primary Tool | Key Pattern |
|---------|-------------|-------------|
| Google | Secret Manager | Workload Identity |
| Uber | Vault | High-throughput caching |
| Netflix | Vault + Titus | Container injection |
| Stripe | Vault | Short-lived credentials |
| Amazon | Secrets Manager | Lambda rotation |

### Junior → FAANG: Learning the Right Lessons From Case Studies

The companies in this case study table made their secrets management choices in response to specific scale, regulatory, and threat model requirements. Copying their choices without understanding their context produces cargo-cult security.

**Gap to close:** For each company in the table, understand why they made their choice. Stripe uses Vault with short-lived credentials because financial services regulators require audit trails and because a static credential compromise at Stripe's scale would be catastrophic. Amazon uses Secrets Manager for Lambda rotation because it is native to their platform and reduces operational overhead. These context-specific reasons are more useful than the implementation details.

**Interview framing:** When asked "what secrets management approach would you use?", describe how your choice depends on context: cloud provider (AWS native tools for AWS-centric shops, Vault for multi-cloud or on-premises), compliance requirements (PCI DSS may require specific audit capabilities), team size and operational maturity, and scale. Demonstrating context-aware selection is a stronger answer than naming a specific tool.

### Senior @ FAANG: Designing Secrets Management for Your Organization

The case studies represent mature implementations. Getting from where most organizations start (environment variables, manual rotation) to where these companies are (automated rotation, short-lived credentials, comprehensive audit) requires a multi-year program.

**Phase 1 foundations:** Adopt a secrets manager (Vault or cloud-native). Migrate all hardcoded secrets to the secrets manager. Enable audit logging. Set up pre-commit hooks and CI scanning. This phase eliminates the most severe risks and can be completed in 1-2 quarters.

**Phase 2 maturity:** Enable automatic rotation for all secrets with supported rotation mechanisms. Implement workload identity to eliminate bootstrap secrets. Add secrets access anomaly detection to the SIEM. Establish a secrets inventory. This phase requires 2-4 quarters depending on the number of services.

**Phase 3 target state:** Dynamic secrets for database credentials (no static passwords). Short-lived certificates for service-to-service authentication (mTLS via SPIFFE/SPIRE). Secrets manager audit logs as a real-time detection mechanism. 100% of services using approved secrets management patterns. This phase requires ongoing operational investment and is the target state that the case study companies represent.

**Program ownership:** Each phase requires a sponsor (staff engineer or security engineering lead) who drives adoption, resolves blockers, and measures progress. Without ownership, the program stalls at Phase 1. Staff engineers who have driven a secrets management program to Phase 3 have a compelling story for FAANG security interviews.

---
