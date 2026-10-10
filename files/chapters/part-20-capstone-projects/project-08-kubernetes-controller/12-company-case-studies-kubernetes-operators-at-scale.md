## Company Case Studies: Kubernetes Operators at Scale

The operator pattern has been adopted by nearly every major cloud and infrastructure company to automate complex application lifecycle management. The following case studies show how industry leaders like Red Hat, VMware, Spotify, and Datadog use Kubernetes operators at massive scale. Each example demonstrates a different aspect of operator design, from lifecycle management and supply chain automation to developer portals and monitoring agents. Studying these real-world patterns will help you understand the design decisions that matter when building operators that must run reliably across thousands of clusters.

### Red Hat: OpenShift Operator Framework

The Operator Framework powers enterprise Kubernetes:

```go
// Operator Framework-style controller with OLM integration
package openshift

import (
    "context"
    "time"

    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/reconcile"
)

// OperatorController manages operator lifecycle
type OperatorController struct {
    client.Client
    olmClient      *OLMClient
    catalogSource  *CatalogSource
    subscriptions  map[string]*Subscription
}

// ClusterServiceVersion represents an operator version
type ClusterServiceVersion struct {
    Name         string              `json:"name"`
    Version      string              `json:"version"`
    DisplayName  string              `json:"displayName"`
    Description  string              `json:"description"`
    Maturity     string              `json:"maturity"` // alpha, beta, stable
    Provider     Provider            `json:"provider"`
    InstallModes []InstallMode       `json:"installModes"`
    CustomResourceDefinitions CRDList `json:"customResourceDefinitions"`
    InstallStrategy InstallStrategy `json:"install"`
}

// Subscription represents an operator subscription
type Subscription struct {
    Name           string `json:"name"`
    Namespace      string `json:"namespace"`
    Channel        string `json:"channel"`
    Source         string `json:"source"`
    SourceNamespace string `json:"sourceNamespace"`
    InstallPlanApproval string `json:"installPlanApproval"` // Automatic, Manual
    StartingCSV    string `json:"startingCSV,omitempty"`
}

// ReconcileOperator handles operator lifecycle
func (c *OperatorController) ReconcileOperator(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
    subscription := &Subscription{}
    if err := c.Get(ctx, req.NamespacedName, subscription); err != nil {
        return reconcile.Result{}, client.IgnoreNotFound(err)
    }

    // Get catalog source
    catalog, err := c.olmClient.GetCatalog(ctx, subscription.Source, subscription.SourceNamespace)
    if err != nil {
        return reconcile.Result{}, err
    }

    // Find latest CSV in channel
    csv, err := catalog.GetLatestCSV(subscription.Channel)
    if err != nil {
        return reconcile.Result{}, err
    }

    // Check if upgrade is available
    currentCSV, _ := c.getCurrentInstalledCSV(ctx, subscription)
    if currentCSV != nil && currentCSV.Version == csv.Version {
        // No upgrade needed
        return reconcile.Result{RequeueAfter: 15 * time.Minute}, nil
    }

    // Create install plan
    installPlan := c.createInstallPlan(subscription, csv)

    if subscription.InstallPlanApproval == "Automatic" {
        // Auto-approve and install
        if err := c.executeInstallPlan(ctx, installPlan); err != nil {
            return reconcile.Result{}, err
        }
    } else {
        // Wait for manual approval
        if err := c.Create(ctx, installPlan); err != nil {
            return reconcile.Result{}, err
        }
    }

    return reconcile.Result{RequeueAfter: time.Minute}, nil
}
```

### VMware Tanzu: Application Platform Operator

Tanzu operators for platform automation:

```go
// Tanzu-style application platform operator
package tanzu

import (
    "context"

    "sigs.k8s.io/controller-runtime/pkg/client"
)

// AppPlatformController manages application workloads
type AppPlatformController struct {
    client.Client
    supplyChainManager *SupplyChainManager
    sourceResolver     *SourceResolver
    buildService       *BuildService
}

// Workload represents a TAP workload
type Workload struct {
    Name      string           `json:"name"`
    Namespace string           `json:"namespace"`
    Labels    map[string]string `json:"labels"`
    Source    WorkloadSource   `json:"source"`
    Build     *BuildSpec       `json:"build,omitempty"`
    Params    []Param          `json:"params,omitempty"`
    Resources *ResourceSpec    `json:"resources,omitempty"`
}

// WorkloadSource defines where source code comes from
type WorkloadSource struct {
    Git   *GitSource   `json:"git,omitempty"`
    Image string       `json:"image,omitempty"`
}

// SupplyChain defines the build/deploy pipeline
type SupplyChain struct {
    Name       string                `json:"name"`
    Selector   SupplyChainSelector   `json:"selector"`
    Resources  []SupplyChainResource `json:"resources"`
}

// ReconcileWorkload processes a workload through supply chain
func (c *AppPlatformController) ReconcileWorkload(ctx context.Context, workload *Workload) error {
    // Select matching supply chain
    supplyChain, err := c.supplyChainManager.SelectSupplyChain(ctx, workload)
    if err != nil {
        return err
    }

    // Resolve source
    sourceOutput, err := c.sourceResolver.Resolve(ctx, workload.Source)
    if err != nil {
        return err
    }

    // Run through supply chain stages
    outputs := map[string]any{
        "source": sourceOutput,
    }

    for _, resource := range supplyChain.Resources {
        output, err := c.executeSupplyChainResource(ctx, resource, workload, outputs)
        if err != nil {
            return err
        }
        outputs[resource.Name] = output
    }

    // Update workload status
    workload.Status.SupplyChainRef = supplyChain.Name
    workload.Status.Conditions = c.buildConditions(outputs)

    return c.Status().Update(ctx, workload)
}
```

### Spotify: Backstage Kubernetes Plugin

Backstage integration for developer portals:

```go
// Backstage-style Kubernetes integration
package backstage

import (
    "context"

    "k8s.io/client-go/kubernetes"
)

// KubernetesPlugin provides cluster visibility
type KubernetesPlugin struct {
    clusters map[string]*ClusterConnection
    cache    *ResourceCache
}

// ClusterConnection represents a K8s cluster
type ClusterConnection struct {
    Name       string
    URL        string
    AuthType   string // serviceAccount, oidc, google
    Client     kubernetes.Interface
}

// ServiceResources aggregates K8s resources for a service
type ServiceResources struct {
    ServiceName string               `json:"serviceName"`
    Cluster     string               `json:"cluster"`
    Namespace   string               `json:"namespace"`
    Deployments []DeploymentInfo     `json:"deployments"`
    Pods        []PodInfo            `json:"pods"`
    Services    []ServiceInfo        `json:"services"`
    Ingresses   []IngressInfo        `json:"ingresses"`
    Events      []EventInfo          `json:"events"`
    Metrics     *ResourceMetrics     `json:"metrics,omitempty"`
}

// GetServiceResources fetches all K8s resources for a Backstage entity
func (p *KubernetesPlugin) GetServiceResources(ctx context.Context, entityRef string) (*ServiceResources, error) {
    // Parse entity reference (e.g., "component:default/my-service")
    entity, err := p.parseEntityRef(entityRef)
    if err != nil {
        return nil, err
    }

    // Get kubernetes annotations from entity
    annotations := entity.Metadata.Annotations
    clusterName := annotations["backstage.io/kubernetes-cluster"]
    namespace := annotations["backstage.io/kubernetes-namespace"]
    labelSelector := annotations["backstage.io/kubernetes-label-selector"]

    cluster := p.clusters[clusterName]
    if cluster == nil {
        return nil, ErrClusterNotFound
    }

    resources := &ServiceResources{
        ServiceName: entity.Metadata.Name,
        Cluster:     clusterName,
        Namespace:   namespace,
    }

    // Fetch deployments
    deployments, _ := cluster.Client.AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{
        LabelSelector: labelSelector,
    })
    for _, d := range deployments.Items {
        resources.Deployments = append(resources.Deployments, p.mapDeployment(&d))
    }

    // Fetch pods
    pods, _ := cluster.Client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
        LabelSelector: labelSelector,
    })
    for _, pod := range pods.Items {
        resources.Pods = append(resources.Pods, p.mapPod(&pod))
    }

    // Fetch recent events
    events, _ := cluster.Client.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
        FieldSelector: fmt.Sprintf("involvedObject.name=%s", entity.Metadata.Name),
    })
    for _, e := range events.Items {
        resources.Events = append(resources.Events, p.mapEvent(&e))
    }

    return resources, nil
}
```

### Datadog: Kubernetes Monitoring Operator

Datadog's agent operator for observability:

```go
// Datadog-style monitoring operator
package datadog

import (
    "context"

    "sigs.k8s.io/controller-runtime/pkg/client"
)

// DatadogAgentController manages Datadog agent deployment
type DatadogAgentController struct {
    client.Client
    apiKey    string
    appKey    string
}

// DatadogAgent represents the Datadog agent CRD
type DatadogAgent struct {
    Name             string              `json:"name"`
    Namespace        string              `json:"namespace"`
    Credentials      *DatadogCredentials `json:"credentials"`
    Agent            *AgentConfig        `json:"agent"`
    ClusterAgent     *ClusterAgentConfig `json:"clusterAgent,omitempty"`
    ClusterChecks    *ClusterChecksConfig `json:"clusterChecksRunner,omitempty"`
    Features         *FeatureConfig      `json:"features"`
}

// AgentConfig configures the node agent
type AgentConfig struct {
    Image          string            `json:"image"`
    Env            []EnvVar          `json:"env,omitempty"`
    Resources      ResourceSpec      `json:"resources"`
    SecurityContext *SecurityContext `json:"securityContext,omitempty"`
    Config         *AgentConfiguration `json:"config"`
}

// ReconcileDatadogAgent ensures agent deployment matches spec
func (c *DatadogAgentController) ReconcileDatadogAgent(ctx context.Context, agent *DatadogAgent) error {
    // Create/update DaemonSet for node agent
    daemonSet := c.buildAgentDaemonSet(agent)
    if err := c.createOrUpdate(ctx, daemonSet); err != nil {
        return err
    }

    // Create Cluster Agent deployment if enabled
    if agent.ClusterAgent != nil && agent.ClusterAgent.Enabled {
        clusterAgentDeployment := c.buildClusterAgentDeployment(agent)
        if err := c.createOrUpdate(ctx, clusterAgentDeployment); err != nil {
            return err
        }

        // Create RBAC for cluster agent
        if err := c.ensureClusterAgentRBAC(ctx, agent); err != nil {
            return err
        }
    }

    // Configure auto-discovery annotations
    if agent.Features.AutoDiscovery != nil {
        c.configureAutoDiscovery(ctx, agent)
    }

    // Set up log collection if enabled
    if agent.Features.LogCollection != nil && agent.Features.LogCollection.Enabled {
        c.configureLogCollection(ctx, agent)
    }

    // Configure APM if enabled
    if agent.Features.APM != nil && agent.Features.APM.Enabled {
        c.configureAPM(ctx, agent)
    }

    return nil
}
```

### Key Takeaways from Industry Leaders

| Company | Key Innovation | Scale |
|---------|---------------|-------|
| Red Hat OLM | Operator lifecycle, catalog management | Enterprise standard |
| VMware Tanzu | Supply chain automation, gitops | Multi-cluster |
| Spotify Backstage | Developer portal integration | Developer experience |
| Datadog | Agent auto-discovery, observability | Millions of agents |

---
