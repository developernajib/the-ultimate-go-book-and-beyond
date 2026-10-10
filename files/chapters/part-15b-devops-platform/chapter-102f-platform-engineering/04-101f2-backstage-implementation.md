## 102F.2 Backstage Implementation

### Installation

Backstage is an open-source Internal Developer Portal built by Spotify, implemented as a Node.js application. You bootstrap it with the `create-app` scaffolder which generates a monorepo containing the frontend React application and backend API server. The `yarn dev` command starts both services concurrently in development mode. For production you build Docker images of the frontend and backend separately and deploy them to Kubernetes using the official Helm chart.

```bash
npx @backstage/create-app@latest --path backstage
cd backstage
yarn install
yarn dev
```

### catalog-info.yaml - Every Service Registers Here

Every service, library, and API in the Backstage catalog is registered via a `catalog-info.yaml` file in its repository root. This file declares the entity's kind (Component, API, Resource), its owner, lifecycle stage, and dependencies on other catalog entities. Backstage's software catalog ingestion process reads these files from repositories via Git integrations, making the catalog self-service: teams register their own services by committing a YAML file rather than submitting a ticket.

```yaml
# In each service's repository root
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: shopapp-api
  description: ShopApp main API service
  annotations:
    # Link to tech docs (auto-generated from docs/ directory)
    backstage.io/techdocs-ref: dir:.

    # Link to Kubernetes resources
    backstage.io/kubernetes-id: shopapp-api
    backstage.io/kubernetes-namespace: shopapp-production

    # Link to GitHub
    github.com/project-slug: myorg/shopapp-api

    # Link to observability
    grafana/dashboard-selector: "shopapp-api"
    pagerduty.com/service-id: P12345

    # SLO information
    slo.backstage.io/availability-target: "99.9"
    slo.backstage.io/latency-target-ms: "200"

  tags:
    - go
    - api
    - production-critical

  links:
    - url: https://shopapp.myorg.com
      title: Production URL
      icon: web
    - url: https://grafana.myorg.com/d/shopapp-api
      title: Grafana Dashboard
      icon: dashboard

spec:
  type: service
  lifecycle: production  # experimental, deprecated, production
  owner: team-backend    # who owns this? (maps to Team entity)
  system: shopapp        # which system does this belong to?
  dependsOn:
    - component:shopapp-database
    - component:redis-cache
  providesApis:
    - shopapp-api-v1
```

```yaml
# Team definition
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: team-backend
spec:
  type: team
  displayName: Backend Engineering
  email: backend@myorg.com
  members:
    - john.doe
    - jane.smith
  parent: engineering-org
---
# API definition
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: shopapp-api-v1
  description: ShopApp REST API v1
spec:
  type: openapi
  lifecycle: production
  owner: team-backend
  definition:
    $text: https://raw.githubusercontent.com/myorg/shopapp-api/main/api/openapi.yaml
```

### Scaffolding Template for Go Microservice

Backstage Software Templates are the mechanism for golden paths: a developer fills out a form in the UI, the template renders a new repository from a skeleton directory, and the scaffolded service is immediately production-ready with CI, linting, testing, Docker builds, and a `catalog-info.yaml` pre-configured. The template below wires together the repository creation, catalog registration, and team notification in a single declarative workflow, making new service creation a five-minute self-service operation rather than a two-week ops ticket.

```yaml
# templates/go-microservice/template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-microservice
  title: Go Microservice
  description: Create a new Go microservice with full platform integration
  tags:
    - go
    - microservice
    - recommended
spec:
  owner: platform-team
  type: service

  parameters:
    - title: Service Information
      required: [name, description, owner]
      properties:
        name:
          title: Service Name
          type: string
          description: Lowercase, hyphenated (e.g., payment-service)
          pattern: '^[a-z][a-z0-9-]*$'
        description:
          title: Description
          type: string
        owner:
          title: Team Owner
          type: string
          ui:field: OwnerPicker
          ui:options:
            catalogFilter:
              kind: Group

    - title: Database Configuration
      properties:
        database:
          title: PostgreSQL Database
          type: boolean
          default: false
        databaseName:
          title: Database Name
          type: string
          description: Required if Database is enabled

    - title: Infrastructure
      properties:
        environment:
          title: Initial Environment
          type: string
          enum: [dev, staging]
          default: dev
        namespace:
          title: Kubernetes Namespace
          type: string

  steps:
    - id: fetch-template
      name: Fetch Template
      action: fetch:template
      input:
        url: ./skeleton
        values:
          name: ${{ parameters.name }}
          description: ${{ parameters.description }}
          owner: ${{ parameters.owner }}
          database: ${{ parameters.database }}

    - id: publish
      name: Publish to GitHub
      action: publish:github
      input:
        allowedHosts: [github.com]
        description: ${{ parameters.description }}
        repoUrl: github.com?owner=myorg&repo=${{ parameters.name }}
        defaultBranch: main
        repoVisibility: internal
        topics: [go, microservice]

    - id: create-argocd-app
      name: Create ArgoCD Application
      action: argocd:create-resources
      input:
        appName: ${{ parameters.name }}-${{ parameters.environment }}
        argoInstance: argocd.myorg.com
        projectName: default
        namespace: ${{ parameters.namespace }}
        repoUrl: https://github.com/myorg/k8s-manifests
        path: apps/${{ parameters.name }}/overlays/${{ parameters.environment }}

    - id: register-catalog
      name: Register in Backstage Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps.publish.output.repoContentsUrl }}
        catalogInfoPath: /catalog-info.yaml

  output:
    links:
      - title: Repository
        url: ${{ steps.publish.output.remoteUrl }}
      - title: Open in Backstage
        icon: catalog
        entityRef: ${{ steps.register-catalog.output.entityRef }}
```

### Junior → FAANG: What to Know About Backstage Before Your First Interview

Most junior engineers have used Backstage as a consumer but have not implemented it. For interviews, knowing the three core capabilities (catalog, scaffolder, TechDocs) and being able to explain the role of `catalog-info.yaml` is sufficient for entry-level platform roles.

The mental model to internalize: `catalog-info.yaml` is a service's declaration of its own identity. When a team commits this file to their repository, Backstage discovers it automatically via GitHub integration and registers the service in the catalog. This is a pull model: Backstage pulls metadata from repositories rather than requiring a separate registration step. Teams own their own catalog entries.

The scaffolding template YAML shows the declarative power of the scaffolder. A developer fills out a form in the UI, and the template engine renders a repository, creates an ArgoCD application, and registers the catalog entry all in one workflow. This is the self-service onboarding flow that replaces a two-week ops ticket. For an interview, be prepared to describe each step of a scaffolding workflow and what happens if one step fails (the scaffolder has a rollback mechanism via compensating steps).

Common first-job questions about Backstage: "How do you keep the catalog accurate?" The answer is automated PR checks that validate `catalog-info.yaml` on every pull request, plus periodic Backstage ingestion that flags stale or invalid entries.

### Senior @ FAANG: Backstage as a Platform Product, Not Just a Tool

At the senior level, the interesting questions about Backstage are not about YAML syntax but about operating Backstage at scale and maintaining the health of the catalog.

Catalog accuracy is the hardest operational problem. At organizations with thousands of services, catalog entries go stale: teams change ownership, services are deprecated, APIs are removed. A senior platform engineer designs automated remediation: nightly jobs that check for services registered in the catalog but no longer deployed in any cluster, and that open pull requests to mark them deprecated. The catalog must be treated as a live database with data quality requirements, not a static wiki.

Plugin governance is a staff-level concern that does not appear in the implementation details but becomes critical at FAANG scale. When any team can write a Backstage plugin, the plugin ecosystem fragments quickly: plugins with incompatible Backstage API versions, plugins that make unauthenticated calls to internal services, plugins that expose sensitive data in browser-accessible responses. A governance process for plugins includes a security review, a compatibility matrix against the deployed Backstage version, and a deprecation policy when Backstage upstream breaks the plugin API.

The scaffolding template shown here creates an ArgoCD application as part of the onboarding workflow. At scale, this creates a coupling concern: the scaffolding template must be updated every time the ArgoCD API surface or naming convention changes. A more resilient design decouples the scaffolding template from the provisioning implementation by having the template call a stable Platform API endpoint (POST /services/onboard) rather than directly calling ArgoCD. The Platform API becomes the stable abstraction. The underlying tools can change without requiring template updates. This is the dependency inversion principle applied to the scaffolding layer.

The `OwnerPicker` and `EntityPicker` UI fields in the template are a subtle but important design detail. By constraining owner to a `Group` entity and system to a `System` entity in the catalog, the template enforces referential integrity: you cannot create a service owned by a group that does not exist in the catalog. This prevents orphaned services with unknown owners, which is the primary cause of catalog decay in large organizations.
