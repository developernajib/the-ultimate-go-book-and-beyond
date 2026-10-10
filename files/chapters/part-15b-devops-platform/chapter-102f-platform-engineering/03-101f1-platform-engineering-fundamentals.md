## 102F.1 Platform Engineering Fundamentals

### Platform Engineering vs DevOps vs SRE

DevOps, SRE, and platform engineering are related disciplines that are frequently confused. DevOps is a cultural movement that breaks down the wall between development and operations through shared responsibility and CI/CD automation. SRE applies software engineering to reliability problems: defining SLOs, managing error budgets, and automating toil. Platform engineering focuses on building and maintaining an Internal Developer Platform. A self-service layer of paved roads and golden paths that lets application teams deploy, monitor, and scale services without requiring per-team operations support.

```
DevOps: cultural movement - dev and ops collaboration, shared responsibility,
        automation of deployment pipelines. "You build it, you run it."
        → Focus: breaking silos, CI/CD, monitoring

SRE (Site Reliability Engineering): applying software engineering to operations.
        Reliability targets (SLOs), error budgets, toil reduction, post-mortems.
        → Focus: reliability, scalability, operational excellence

Platform Engineering: building internal products for developers.
        Reduces cognitive load by providing golden paths, self-service tooling,
        and abstractions over infrastructure complexity.
        → Focus: developer productivity, self-service, standardization

Key distinction: SRE manages production reliability. Platform engineering
manages the developer experience of BUILDING and DEPLOYING software.
```

### Cognitive Load Framework

Team Topologies (Skelton & Pais) categorizes cognitive load:
- **Intrinsic**: understanding the domain problem being solved (can't reduce)
- **Extraneous**: setup, configuration, learning infrastructure details (reduce this)
- **Germane**: internalizing patterns that make you better (enable this)

Platform engineering goal: minimize extraneous cognitive load so developers focus on intrinsic + germane.

```
Without platform:
  Developer task: "Add a new API endpoint"
  Cognitive load: understand the business logic (intrinsic)
               + configure Kubernetes YAML (extraneous)
               + set up observability (extraneous)
               + create CI/CD pipeline (extraneous)
               + provision database (extraneous)
               + configure RBAC (extraneous)

With platform (golden path):
  Developer task: "Add a new API endpoint"
  Cognitive load: understand the business logic (intrinsic)
               + run `platform create service my-api` (1 command, extraneous minimized)
```

### Paved Roads vs Golden Paths

Paved roads and golden paths are the primary value delivery mechanism of a platform engineering team. A paved road is a supported, recommended path with guardrails. Teams can deviate, but they carry the operational burden themselves. A golden path is an opinionated subset of the paved road optimized for the common case: a one-command service bootstrapper that produces a repository with CI, tests, observability, and deployment configuration already wired up. Golden paths reduce cognitive load for new teams and enforce standards at creation time rather than through audits and policies after the fact.

```
Paved road: the SUPPORTED, RECOMMENDED path. Teams can go off-road, but
            the platform only provides tooling for the paved road.
            Off-road = manual work + no platform support.

Golden path: a specific, complete, opinionated paved road for the most
            common scenario. E.g., "Go microservice with PostgreSQL and Redis"
            includes: repository template, CI/CD, Kubernetes manifests,
            observability, database provisioning, secrets management.

Key principle: golden paths should be easier than doing it yourself.
               If developers bypass the platform, the platform has failed.
```

### Junior → FAANG: The Vocabulary That Gets You Through the Interview

Platform engineering interviews at FAANG companies test vocabulary as much as technical depth. Three terms from this section appear in nearly every system design or behavioral question on this topic: cognitive load, paved road, and golden path.

Cognitive load is the most testable concept. John Sweller's three-part model (intrinsic, extraneous, germane) is directly applicable to engineering organizations. Know the definitions, and more importantly know how to give a concrete example. The "add a new API endpoint" scenario from the section is a perfect interview answer: intrinsic load is the business logic you must understand, extraneous load is the Kubernetes YAML and CI configuration you must configure, and the platform eliminates the extraneous load so you can focus on the intrinsic problem.

The DevOps versus SRE versus platform engineering distinction is almost always asked at FAANG interviews for platform roles. The cleanest answer: DevOps is a cultural and organizational practice about breaking down silos between development and operations. SRE is a job function that applies software engineering to reliability problems. Platform engineering is a product function that builds internal tooling to increase developer productivity. All three can coexist in the same organization and serve complementary purposes.

For the golden path question, the key interview signal is knowing why teams voluntarily adopt golden paths. It is not because they are mandated. It is because the golden path is more convenient than the alternative. A golden path that requires ten additional steps to use compared to doing it manually will be abandoned. The platform team's job is to make the golden path the path of least resistance.

### Senior @ FAANG: Cognitive Load as a Design Constraint at Org Scale

The Team Topologies model introduced in this section is the most influential organizational design framework in platform engineering, and it is referenced explicitly in staff-level interview loops at Google, Meta, and Netflix. The senior-level depth required is not just knowing the four team types but understanding the cognitive load boundaries that motivate the model.

The key insight for bar-raiser interviews is that Team Topologies prescribes that platform teams should reduce the cognitive load of stream-aligned teams by providing X-as-a-Service. The moment a platform team begins requiring stream-aligned teams to understand the internals of the platform in order to use it, the platform has failed its design constraint. A well-run platform team measures the cognitive load it imposes on consumers, not just the features it provides.

At the L7 and principal level, the paved road versus golden path distinction becomes an organizational governance question. Who decides what is on the paved road? In large organizations, the paved road is often governed by a Technical Advisory Board or Architecture Review Board that includes representatives from major product domains. The platform team implements the paved road but does not unilaterally define it. This separation of concerns between defining standards and implementing tooling is a maturity signal that distinguishes elite platform organizations from those that use the platform as a vehicle for technical preferences.

The "if developers bypass the platform, the platform has failed" principle is deceptively simple but has deep implications for how the platform team measures success. Adoption rate is a leading indicator of whether the platform is delivering value. A platform team that tracks deployment frequency (a DORA metric) but not golden path adoption rate is missing the most direct signal of whether their product is working. At senior levels, you are expected to define the measurement strategy for the platform, not just build the features.
