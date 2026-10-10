## 102F.5 Platform API in Go

Building a platform API that abstracts infrastructure operations for developers:

```go
package platform

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "time"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

// ProvisionEnvironmentRequest represents a request to create a new environment
type ProvisionEnvironmentRequest struct {
    Name      string            `json:"name" validate:"required,lowercase,alphanum"`
    Team      string            `json:"team" validate:"required"`
    Type      string            `json:"type" validate:"required,oneof=dev staging preview"`
    TTL       *time.Duration    `json:"ttl,omitempty"` // auto-delete after TTL (for preview envs)
    Resources ResourceQuotas    `json:"resources"`
}

type ResourceQuotas struct {
    CPU    string `json:"cpu" default:"4"`
    Memory string `json:"memory" default:"8Gi"`
    Pods   int    `json:"pods" default:"20"`
}

// ProvisionServiceRequest represents a new service onboarding request
type ProvisionServiceRequest struct {
    ServiceName string `json:"service_name" validate:"required"`
    Team        string `json:"team" validate:"required"`
    Language    string `json:"language" validate:"required,oneof=go python typescript java"`
    HasDatabase bool   `json:"has_database"`
    HasCache    bool   `json:"has_cache"`
}

// PlatformAPI handles platform engineering operations
type PlatformAPI struct {
    k8s    *kubernetes.Clientset
    client client.Client
    github GitHubClient
    argocd ArgoCDClient
    logger *slog.Logger
}

func NewPlatformAPI(k8s *kubernetes.Clientset, c client.Client, gh GitHubClient, argo ArgoCDClient, logger *slog.Logger) *PlatformAPI {
    return &PlatformAPI{k8s: k8s, client: c, github: gh, argocd: argo, logger: logger}
}

func (p *PlatformAPI) Router() http.Handler {
    r := chi.NewRouter()
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)
    r.Use(middleware.RequestID)

    r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
        json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
    })

    r.Route("/v1", func(r chi.Router) {
        r.Post("/environments", p.provisionEnvironment)
        r.Delete("/environments/{name}", p.deprovisionEnvironment)
        r.Get("/environments", p.listEnvironments)

        r.Post("/services/onboard", p.onboardService)
        r.Get("/services/{name}/status", p.getServiceStatus)
    })

    return r
}

// provisionEnvironment creates a fully configured Kubernetes namespace
// with RBAC, network policies, resource quotas, and LimitRange
func (p *PlatformAPI) provisionEnvironment(w http.ResponseWriter, r *http.Request) {
    var req ProvisionEnvironmentRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request body", http.StatusBadRequest)
        return
    }

    ctx := r.Context()
    reqID := middleware.GetReqID(ctx)

    p.logger.Info("provisioning environment",
        "name", req.Name,
        "team", req.Team,
        "type", req.Type,
        "request_id", reqID,
    )

    // Create namespace
    ns := buildNamespace(req)
    if _, err := p.k8s.CoreV1().Namespaces().Create(ctx, ns, metav1.CreateOptions{}); err != nil {
        p.logger.Error("failed to create namespace", "err", err, "name", req.Name)
        http.Error(w, fmt.Sprintf("failed to create namespace: %v", err), http.StatusInternalServerError)
        return
    }

    // Apply resource quota
    quota := buildResourceQuota(req)
    if _, err := p.k8s.CoreV1().ResourceQuotas(req.Name).Create(ctx, quota, metav1.CreateOptions{}); err != nil {
        p.logger.Error("failed to create resource quota", "err", err)
    }

    // Apply LimitRange defaults
    lr := buildLimitRange(req.Name)
    if _, err := p.k8s.CoreV1().LimitRanges(req.Name).Create(ctx, lr, metav1.CreateOptions{}); err != nil {
        p.logger.Error("failed to create limit range", "err", err)
    }

    // Apply default network policies
    if err := p.applyDefaultNetworkPolicies(ctx, req.Name); err != nil {
        p.logger.Error("failed to apply network policies", "err", err)
    }

    // Create team RBAC
    if err := p.createTeamRBAC(ctx, req.Name, req.Team); err != nil {
        p.logger.Error("failed to create RBAC", "err", err)
    }

    // If TTL set, schedule auto-deletion
    if req.TTL != nil {
        if err := p.scheduleCleanup(ctx, req.Name, *req.TTL); err != nil {
            p.logger.Error("failed to schedule cleanup", "err", err)
        }
    }

    p.logger.Info("environment provisioned", "name", req.Name, "team", req.Team)

    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(map[string]string{
        "name":   req.Name,
        "status": "provisioned",
    })
}

// onboardService creates a new service: GitHub repo, CI/CD, ArgoCD application
func (p *PlatformAPI) onboardService(w http.ResponseWriter, r *http.Request) {
    var req ProvisionServiceRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request body", http.StatusBadRequest)
        return
    }

    ctx := r.Context()

    p.logger.Info("onboarding service",
        "service", req.ServiceName,
        "team", req.Team,
        "language", req.Language,
    )

    // 1. Create GitHub repository from template
    repoURL, err := p.github.CreateRepoFromTemplate(ctx, GitHubRepoRequest{
        Name:     req.ServiceName,
        Team:     req.Team,
        Template: "go-microservice-template",
        Variables: map[string]string{
            "SERVICE_NAME": req.ServiceName,
            "TEAM":         req.Team,
        },
    })
    if err != nil {
        http.Error(w, fmt.Sprintf("failed to create repo: %v", err), http.StatusInternalServerError)
        return
    }

    // 2. Create Kubernetes manifest repo entries
    if err := p.github.CreateManifestFiles(ctx, req.ServiceName, req.Team); err != nil {
        p.logger.Error("failed to create manifests", "err", err)
    }

    // 3. Create ArgoCD application
    if err := p.argocd.CreateApplication(ctx, ArgoCDApplication{
        Name:      fmt.Sprintf("%s-dev", req.ServiceName),
        Namespace: fmt.Sprintf("%s-dev", req.Team),
        RepoPath:  fmt.Sprintf("apps/%s/overlays/dev", req.ServiceName),
    }); err != nil {
        p.logger.Error("failed to create ArgoCD app", "err", err)
    }

    // 4. If database needed, create Crossplane claim
    if req.HasDatabase {
        if err := p.provisionDatabase(ctx, req.ServiceName, req.Team); err != nil {
            p.logger.Error("failed to provision database", "err", err)
        }
    }

    p.logger.Info("service onboarded", "service", req.ServiceName, "repo", repoURL)

    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(map[string]any{
        "service":   req.ServiceName,
        "repo_url":  repoURL,
        "status":    "onboarded",
    })
}

// Placeholder interfaces - implementations call GitHub/ArgoCD APIs
type GitHubClient interface {
    CreateRepoFromTemplate(ctx context.Context, req GitHubRepoRequest) (string, error)
    CreateManifestFiles(ctx context.Context, serviceName, team string) error
}

type ArgoCDClient interface {
    CreateApplication(ctx context.Context, app ArgoCDApplication) error
}

type GitHubRepoRequest struct {
    Name      string
    Team      string
    Template  string
    Variables map[string]string
}

type ArgoCDApplication struct {
    Name      string
    Namespace string
    RepoPath  string
}

// Helper functions (simplified)
func buildNamespace(req ProvisionEnvironmentRequest) *corev1.Namespace {
    return &corev1.Namespace{
        ObjectMeta: metav1.ObjectMeta{
            Name: req.Name,
            Labels: map[string]string{
                "team":                            req.Team,
                "environment-type":                req.Type,
                "managed-by":                      "platform-api",
                "pod-security.kubernetes.io/enforce": "restricted",
            },
        },
    }
}

func (p *PlatformAPI) deprovisionEnvironment(w http.ResponseWriter, r *http.Request) {
    name := chi.URLParam(r, "name")
    if err := p.k8s.CoreV1().Namespaces().Delete(r.Context(), name, metav1.DeleteOptions{}); err != nil {
        p.logger.Error("failed to delete namespace", "err", err, "name", name)
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    w.WriteHeader(http.StatusNoContent)
}

func (p *PlatformAPI) listEnvironments(w http.ResponseWriter, r *http.Request) {
    list, err := p.k8s.CoreV1().Namespaces().List(r.Context(), metav1.ListOptions{
        LabelSelector: "managed-by=platform-api",
    })
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    var envs []string
    for _, ns := range list.Items {
        envs = append(envs, ns.Name)
    }
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(envs)
}

func (p *PlatformAPI) getServiceStatus(w http.ResponseWriter, r *http.Request) {
    name := chi.URLParam(r, "name")
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{
        "service": name,
        "status":  "healthy",
    })
}

func buildResourceQuota(req ProvisionEnvironmentRequest) *corev1.ResourceQuota {
    return &corev1.ResourceQuota{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "compute-quota",
            Namespace: req.Name,
        },
    }
}

func buildLimitRange(namespace string) *corev1.LimitRange {
    return &corev1.LimitRange{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "default-limits",
            Namespace: namespace,
        },
    }
}

func (p *PlatformAPI) applyDefaultNetworkPolicies(ctx context.Context, namespace string) error {
    return nil
}

func (p *PlatformAPI) createTeamRBAC(ctx context.Context, namespace, team string) error {
    return nil
}

func (p *PlatformAPI) scheduleCleanup(ctx context.Context, namespace string, ttl time.Duration) error {
    return nil
}

func (p *PlatformAPI) provisionDatabase(ctx context.Context, serviceName, team string) error {
    return nil
}
```

### Junior → FAANG: Reading the Platform API as a Go Design Lesson

The `PlatformAPI` struct and its constructor are a clean example of dependency injection in Go. Rather than instantiating Kubernetes clients, GitHub clients, and ArgoCD clients inside the handler functions, they are passed in through `NewPlatformAPI`. This means each dependency can be replaced with a mock in tests without changing any handler code.

For a junior engineer, the `GitHubClient` and `ArgoCDClient` interfaces at the bottom of the file are the most instructive lines. These are not full SDK types. They are minimal interface definitions containing only the methods the platform API actually needs. This is the Interface Segregation Principle: consumers should not depend on methods they do not use. If the GitHub SDK has fifty methods, the platform API only declares an interface with the two it needs. Tests implement those two methods with simple stubs.

The `provisionEnvironment` handler shows a common pattern for partial failures. When namespace creation succeeds but RBAC creation fails, the handler logs the RBAC error but still returns 201 Created. This is a deliberate design choice: the namespace exists, which is the primary resource, and the caller can retry or the operator can fix RBAC manually. Alternatively, you could design this as a transactional operation that deletes the namespace if RBAC fails, but that adds complexity for a rare failure mode. Understanding the trade-off between atomic operations and partial success is an important first-job skill.

### Senior @ FAANG: Platform API Design for Long-Term Stability

The `PlatformAPI` shown here is a solid starting point, but a senior engineer would immediately identify several gaps that matter at production scale.

The first gap is idempotency. The `provisionEnvironment` endpoint returns 500 if the namespace already exists because `k8s.CoreV1().Namespaces().Create` returns an error for existing resources. At scale, callers retry on network failures and duplicate requests are common. The correct implementation checks for `kerrors.IsAlreadyExists` and returns 200 or 409 depending on the semantic: if the environment exists with the same configuration, return 200 (idempotent success). If it exists with a different configuration, return 409 (conflict). This is the difference between an API that is safe to retry and one that causes half-provisioned state on retry.

The second gap is observability. The handler logs request and response but does not emit structured metrics for SLO tracking. A production provisioning API should record a histogram for provisioning duration, increment a counter for each sub-step (namespace created, quota applied, RBAC configured), and emit a trace span for the entire request. Without these, the platform team cannot answer "what percentage of environment provisioning requests complete within 60 seconds?" which is a KPI for the SPACE efficiency dimension.

The third gap is authorization. The handler trusts the `req.Team` field from the request body. At FAANG scale, every platform API call must be authenticated and the caller's identity must be verified against an authorization policy: the caller can only provision environments for teams they belong to, the requested resource type must be within their quota, and administrative operations require elevated permissions. The `middleware.RequestID` middleware handles correlation but does not handle auth.

The fourth concern is the sequential provisioning flow. Creating the namespace, applying the quota, creating the LimitRange, applying network policies, and creating RBAC all happen sequentially in the request handler. For a response time SLO, this is problematic: if the RBAC step takes ten seconds due to a slow Kubernetes API server, the entire request takes ten seconds. The more scalable pattern is to accept the provisioning request, enqueue it as a work item, and return 202 Accepted with a polling URL. The provisioning steps execute asynchronously in a reconcile loop. This is exactly the Kubernetes controller pattern, and it is why mature platform teams often replace REST provisioning endpoints with controller-based reconciliation for long-running operations.
