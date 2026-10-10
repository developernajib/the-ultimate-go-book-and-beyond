## Exercises

1. **Pulumi Go Program for a Full Kubernetes Stack**: Write a Pulumi program in Go that provisions a Kubernetes `Namespace`, a `Deployment` (3 replicas, resource limits set), a `Service` of type `ClusterIP`, and an `Ingress` with TLS using cert-manager annotations - all in a single stack. Run `pulumi up` against a local kind cluster and confirm all resources are healthy. Use `pulumi destroy` to clean up and verify no orphaned resources remain.

2. **Converting Terraform to Pulumi**: Take an existing Terraform configuration that creates an S3 bucket (or GCS bucket) with versioning, server-side encryption, and a lifecycle policy, and rewrite it as a Pulumi Go program using the Pulumi AWS (or GCP) provider. The two configurations must produce identical cloud resources. Document any semantic differences discovered during the conversion and how you resolved them.

3. **Implementing a Drift Detection CI Pipeline**: Build a GitHub Actions (or GitLab CI) pipeline that runs `pulumi preview` (or `terraform plan`) on a schedule (e.g., every 6 hours) against a live environment and fails the pipeline if any drift is detected. Post a summary of the diff as a comment or Slack notification. Test by manually changing a resource tag in the console and confirming the pipeline catches it within the next scheduled run.

4. **Cross-Stack References**: Create two Pulumi Go stacks - a `networking` stack that provisions a VPC and subnets, and an `application` stack that reads the VPC ID and subnet IDs as stack references and deploys an EKS (or GKE) cluster into them. Confirm that updating the networking stack automatically reflects in a `pulumi preview` of the application stack without modifying the application stack code.

5. **Custom Pulumi Resource Provider**: Implement a minimal custom Pulumi resource provider in Go using the Pulumi Provider SDK that manages a fake "DNS record" backed by a local JSON file. The provider must support `Create`, `Read`, `Update`, and `Delete` operations with proper diff detection. Write a Pulumi Go program that uses this provider to create two records, update one, and delete the other, asserting correct state after each operation.

6. **GitOps-Based IaC Deployment Pipeline**: Configure Argo CD (or Flux) to watch a Git repository containing Pulumi or Terraform configurations. On a `git push` to the `main` branch, the pipeline should run `pulumi up --non-interactive` (or `terraform apply -auto-approve`) inside a Kubernetes Job and update the target cluster. Demonstrate the full flow: commit a resource change, observe the GitOps controller trigger the Job, and confirm the resource change is applied - then roll back via a `git revert` and confirm the rollback propagates.

### Junior → FAANG: IaC Exercises as Real-World Skill Builders

These exercises require real cloud resources or a local Kubernetes cluster. Use a kind cluster and the Pulumi Kubernetes provider for exercises 1-3 (no cloud cost), and the AWS or GCP free tier for exercises 4-6 (minimal cost). The hands-on experience of dealing with provider errors, permission issues, and state management is irreplaceable.

The most technically challenging exercise is exercise 5 (custom Pulumi resource provider): it requires understanding the Pulumi provider protocol, Go plugin architecture, and the full CRUD lifecycle of a managed resource. Completing this exercise provides deep insight into how all Pulumi providers work internally.

### Senior @ FAANG: IaC Exercises as Platform Module Prototypes

At staff level, exercise 1 (Pulumi Go program for a full Kubernetes stack) is a prototype for the platform's standard Go service infrastructure module. Hardening this prototype into a production module requires: adding all mandatory labels and annotations (cost center, team, service name), adding all security defaults (network policies, pod security standards), parameterizing per-environment values (replica count, resource limits, ingress hostname), and adding comprehensive unit tests using the Pulumi testing framework.

Exercise 6 (GitOps-based IaC deployment pipeline) is the prototype for the platform's infrastructure deployment system. The production version requires: authentication and authorization (who can trigger deployments), audit logging, approval workflows, rollback automation, and integration with the incident management system (blocking deployments during active incidents). Converting this prototype to a production system is a multi-week platform engineering project.
