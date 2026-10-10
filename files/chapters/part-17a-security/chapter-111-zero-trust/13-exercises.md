## Exercises

1. **SPIFFE Implementation**: Set up SPIRE server and agent in Docker, configure two Go services to authenticate using SPIFFE IDs.

2. **mTLS Certificate Rotation**: Implement automatic certificate rotation with zero downtime. Services should refresh certificates before expiration.

3. **Service Mesh Integration**: Deploy Istio or Linkerd and configure mTLS between services. Compare performance and operational complexity.

4. **OPA Policy Development**: Write Rego policies for a multi-tenant SaaS application with role-based and attribute-based access control.

5. **Kubernetes Network Policies**: Define network policies that only allow communication between specific services based on labels.

6. **Zero-Trust Monitoring**: Build a dashboard showing authentication failures, unusual access patterns, and certificate expiration warnings.

7. **AWS IRSA Setup**: Configure an EKS cluster with IRSA, deploy a Go service that accesses S3 and DynamoDB without static credentials.

### Junior → FAANG: Starting With Exercise 1 (SPIFFE Implementation)

Exercise 1 (SPIFFE/SPIRE setup with two Go services) is the most valuable for building zero-trust credential understanding. The setup requires running Docker containers, configuring SPIRE, and writing Go code that uses the SPIFFE SDK. Completing it means you have hands-on SPIRE experience that most junior engineers lack.

**Gap to close:** If Docker is available on your machine, complete Exercise 1 before your next interview. The SPIFFE Workload API Go client (`github.com/spiffe/go-spiffe`) is well-documented. The exercise takes 2-4 hours. After completing it, you can describe the SPIFFE/SPIRE architecture from implementation experience, not just documentation reading.

**Portfolio value:** A working two-service SPIFFE demo with clear setup instructions is a strong portfolio item. Publish it as a GitHub repository with a `docker-compose.yaml` that sets up the full environment in one command. Engineers who find your repository when researching SPIFFE will see a working example that demonstrates your practical knowledge.

### Senior @ FAANG: Using Exercises to Evaluate Staff-Level Candidates

The exercises in this section are calibrated to reveal staff-level architectural thinking when escalated appropriately.

**Exercise 1 escalation for L7 candidates:** After a candidate completes the basic SPIFFE exercise, ask: "Your organization has 10 Kubernetes clusters across 3 regions and 2 cloud providers. How would you design the SPIFFE trust domain hierarchy and the SPIRE federation to provide consistent workload identity across all clusters?" This question tests: trust domain design, federation topology, availability across regions and cloud providers, and the operational model for managing trust bundles at scale. The answer reveals whether the candidate thinks in platform terms (L7) or in service terms (L5).

**Exercise 7 (AWS IRSA) for L6 interviews:** IRSA setup is a common FAANG infrastructure interview topic. Ask the candidate to describe not just the setup but the IAM policy design for a service with multiple S3 buckets with different sensitivity levels. Can they design IAM conditions that scope access to specific prefixes and specific operations per bucket? This tests IAM policy depth that is expected at L6.

---
