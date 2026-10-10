## Summary

### CI/CD Best Practices

1. **Run checks in parallel** - Lint, test, security concurrently
2. **Cache dependencies** - Speed up builds significantly
3. **Use multi-stage Docker builds** - Smaller, more secure images
4. **Separate environments** - Staging before production
5. **Require manual approval** - For production deployments
6. **Sign artifacts** - Ensure integrity and authenticity
7. **Implement GitOps** - Declarative, auditable deployments
8. **Use canary releases** - Catch issues before full rollout
9. **Monitor after deploy** - Automatic rollback on issues
10. **Scan for vulnerabilities** - In code and dependencies

### Pipeline Checklist

- [ ] Linting (golangci-lint)
- [ ] Unit tests with coverage (>80%)
- [ ] Integration tests
- [ ] Security scanning (govulncheck, gosec)
- [ ] Secret scanning
- [ ] Docker build and push
- [ ] Image signing
- [ ] Staging deployment
- [ ] Smoke tests
- [ ] Canary deployment
- [ ] Production deployment
- [ ] Post-deploy monitoring
- [ ] Rollback capability

### Quick Reference Commands

These commands cover the most frequent operational tasks across local development, Kubernetes rollout management, ArgoCD GitOps workflows, and supply-chain security verification. Kubernetes' `rollout undo` and `rollout history` commands are your first line of defense when a bad deployment reaches the cluster, while `argocd app rollback` lets you revert to a prior Git-tracked state when using GitOps. `cosign verify` confirms that a container image was signed by your CI pipeline, closing the loop on artifact integrity checks introduced earlier in the chapter.

```bash
# Local development
make lint          # Run linting
make test          # Run tests
make security      # Run security scans
make build         # Build binary
make docker-build  # Build Docker image

# Kubernetes deployment
kubectl rollout status deployment/myapp
kubectl rollout undo deployment/myapp
kubectl rollout history deployment/myapp

# ArgoCD
argocd app sync myapp
argocd app rollback myapp
argocd app history myapp

# Image verification
cosign verify ghcr.io/myorg/myapp:v1.0.0
```

---

### Junior → FAANG: CI/CD Knowledge as the Foundation for Everything Else

CI/CD knowledge is multiplied by everything else in this book. Better Docker knowledge produces better build stages. Better Kubernetes knowledge produces better deployment configurations. Better testing knowledge produces better pipeline gates. The pipeline is the integration point where all other skills converge.

The practical career move: volunteer to improve your team's pipeline. Most teams have a pipeline that was set up quickly and never optimized. Adding caching, improving stage ordering, reducing flaky tests, or adding missing security checks are concrete improvements that are immediately visible to the entire team. This kind of contribution is noticed by engineering managers and is an accelerator for promotion decisions.

### Senior @ FAANG: CI/CD as the Delivery Nervous System

The CI/CD system is the delivery nervous system of an engineering organization. When it works well, changes flow quickly from idea to production with high confidence. When it does not, delivery is slow, painful, and risky, and the entire engineering organization suffers.

The L6/L7 responsibility for CI/CD is to treat it as organizational infrastructure deserving the same investment, operational standards, and reliability requirements as production services. This means: on-call rotation for the pipeline infrastructure, SLOs for pipeline availability and performance, regular architecture reviews, capacity planning for pipeline compute, and a roadmap of improvements tied to organizational delivery goals.

The staff engineer who builds this organizational capability around CI/CD is creating leverage that persists long after they move to their next project. Every team that ships faster, every incident that is prevented by automated gates, and every deployment that rolls back automatically is a compounding return on the platform investment. This is the definition of L6/L7 organizational impact.

---

*Next: [Chapter 100: Cloud Providers](../chapter-100-cloud-providers/00-introduction.md)*
