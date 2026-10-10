## 98.21 Core Concepts Recap

### Key Takeaways

1. **Use proper health checks** - Liveness for process health, readiness for traffic routing
2. **Implement graceful shutdown** - Handle SIGTERM and drain connections
3. **Set resource requests and limits** - Essential for scheduling and stability
4. **Use ConfigMaps and Secrets** - Externalize configuration
5. **Enable autoscaling** - HPA for dynamic workloads
6. **Spread across zones** - Use topology constraints for HA
7. **Protect with PDBs** - Ensure minimum availability during disruptions
8. **Secure with RBAC** - Principle of least privilege
9. **Use NetworkPolicies** - Defense in depth
10. **Consider operators** - For complex application lifecycle

### Kubernetes Checklist

- [ ] Deployment with proper labels
- [ ] Liveness and readiness probes (different!)
- [ ] Resource requests and limits
- [ ] Graceful shutdown handling
- [ ] ConfigMap for configuration
- [ ] Secrets for sensitive data
- [ ] HPA for autoscaling
- [ ] PDB for availability
- [ ] Topology spread constraints
- [ ] Network policies
- [ ] RBAC with minimal permissions
- [ ] Ingress for external access

### Quick Reference Commands

These are the kubectl commands you will reach for most often when operating Go services in Kubernetes. They cover the full operational loop: deploying and rolling back workloads, inspecting failing pods without needing SSH access, querying resource pressure that triggers evictions or throttling, and verifying network policy enforcement by checking which endpoints are actually backing a service.

```bash
# Deployment
kubectl apply -f deployment.yaml
kubectl rollout status deployment/myapp
kubectl rollout undo deployment/myapp
kubectl scale deployment/myapp --replicas=5

# Debugging
kubectl describe pod <pod>
kubectl logs <pod> --previous
kubectl exec -it <pod> -- sh
kubectl port-forward <pod> 8080:8080

# Resources
kubectl top pods
kubectl top nodes
kubectl get events --sort-by='.lastTimestamp'

# Networking
kubectl get svc,ep
kubectl run test --rm -it --image=busybox -- nslookup <service>

# Security
kubectl auth can-i --list
kubectl get networkpolicies
```

---

**Next Chapter: CI/CD** - We'll cover building automated pipelines for testing, building, and deploying Go applications.

### Junior → FAANG: Kubernetes as a Career Multiplier

Kubernetes knowledge compounds. The concepts in this chapter (control loops, declarative state management, health-driven scheduling) appear throughout the cloud-native ecosystem. Understanding Kubernetes deeply makes it easier to understand Argo Workflows, KEDA, Crossplane, and the dozens of other projects that build on the same foundations.

The practical career advice: get hands-on with a real cluster. Set up a local kind cluster, deploy a real Go application end to end, break it, fix it, and repeat. Read the Kubernetes source code for the components you use most (the Deployment controller is surprisingly readable). Follow the Kubernetes release notes for each minor version to understand how the platform is evolving. This ongoing engagement with the technology is what separates engineers who understand Kubernetes from engineers who can recite Kubernetes concepts.

### Senior @ FAANG: Platform Engineering as an Organizational Multiplier

At L6/L7, Kubernetes is the substrate for organizational productivity. The platform team that runs it well multiplies the effectiveness of every engineering team that uses it. The platform team that runs it poorly creates friction that slows every team down.

The measurement of a well-run Kubernetes platform: new service time-to-production (below two weeks from "we decided to build this" to "it is handling production traffic"), deployment lead time (below one hour from code commit to production deployment), deployment failure rate (below 5% of deployments require immediate rollback), and platform availability (99.9% or better for the control plane and the services running on it). These metrics, tracked over quarters, tell the story of platform maturity more clearly than any architectural diagram.

The staff engineer who builds and maintains a platform that achieves these metrics is creating organizational leverage that compounds over time. Every team that is faster and more reliable because of the platform is a multiplier on the platform team's investment. This is the L6/L7 value proposition: impact that scales with the organization rather than linearly with individual effort.
