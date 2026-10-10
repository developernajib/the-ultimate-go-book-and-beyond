## 99.7 Mid-Chapter Synthesis: CI/CD Fundamentals Review

### CI/CD Best Practices

1. **Run checks in parallel** - Lint, test, security concurrently
2. **Cache dependencies** - Speed up builds
3. **Use multi-stage Docker builds** - Smaller images
4. **Separate environments** - Staging before production
5. **Require manual approval** - For production deployments

### Pipeline Checklist

- [ ] Linting (golangci-lint)
- [ ] Unit tests with coverage
- [ ] Integration tests
- [ ] Security scanning
- [ ] Docker build and push
- [ ] Staging deployment
- [ ] Production deployment

---

### Junior → FAANG: CI/CD as a Team Sport

CI/CD is not a solo activity. The pipeline serves every engineer on the team, and its reliability affects everyone. Contributing to pipeline improvements (fixing flaky tests, improving caching, adding missing checks) is a form of team contribution that compounds in value as the team grows.

The mindset shift from "the pipeline is someone else's responsibility" to "I own a share of the pipeline's reliability" is what differentiates engineers who grow quickly in their careers from those who stay focused only on their feature work. At FAANG companies, being known as someone who improves shared infrastructure is a significant career differentiator.

### Senior @ FAANG: CI/CD Maturity as an Engineering Organization Indicator

At L6/L7, the state of the CI/CD system is a leading indicator of engineering organization health. A well-functioning pipeline with short lead times, low failure rates, and high adoption of progressive delivery indicates a mature engineering culture. A slow, flaky pipeline with frequent bypasses and manual deployment steps indicates accumulated technical debt and process gaps that will constrain growth.

The staff engineer's role is to assess the current state of the CI/CD system honestly, identify the most valuable improvements, make the investment case for those improvements, and drive their adoption. The target state is a pipeline where any engineer can deploy any service to production with confidence, in under 30 minutes from merge, with automatic rollback if the deployment degrades SLOs. Every gap between the current state and that target is an actionable item on the platform roadmap.
