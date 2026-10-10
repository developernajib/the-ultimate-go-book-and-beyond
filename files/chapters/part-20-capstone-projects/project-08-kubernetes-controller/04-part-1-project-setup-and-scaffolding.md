## Part 1: Project Setup and Scaffolding

Every Kubernetes operator project starts with installing the right toolchain and scaffolding out the initial project structure. Kubebuilder is the standard tool for generating operator boilerplate, and it creates a well-organized directory layout that separates your API types, controller logic, and deployment configuration. In this part, you will install the required CLI tools, initialize a new operator project, and understand the purpose of each generated file and directory.

### Prerequisites
Install the kubebuilder CLI, controller-gen for code generation, and kustomize for Kubernetes manifest management:

```bash
# Install kubebuilder
curl -L -o kubebuilder https://go.kubebuilder.io/dl/latest/$(go env GOOS)/$(go env GOARCH)
chmod +x kubebuilder && sudo mv kubebuilder /usr/local/bin/

# Install controller-gen
go install sigs.k8s.io/controller-tools/cmd/controller-gen@latest

# Install kustomize
curl -s "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" | bash
sudo mv kustomize /usr/local/bin/

# Verify Kubernetes cluster access
kubectl cluster-info
```

### Initialize the Project

Kubebuilder scaffolds the project structure, generating the API types, controller skeleton, and Makefile targets for code generation and deployment:

```bash
# Create project directory
mkdir postgres-operator
cd postgres-operator

# Initialize Go module
go mod init github.com/example/postgres-operator

# Initialize kubebuilder project
kubebuilder init --domain example.com --repo github.com/example/postgres-operator

# Create API and controller
kubebuilder create api --group database --version v1alpha1 --kind PostgresCluster
# Say yes to "Create Resource" and "Create Controller"
```

### Project Structure

The project structure establishes the layered package organization, handlers, services, repositories, domain, that enforces separation of concerns and prevents business logic from leaking into HTTP handler code. This architecture makes it straightforward to add new tenant-aware features without touching cross-cutting infrastructure.

```
postgres-operator/
├── api/
│   └── v1alpha1/
│       ├── postgrescluster_types.go      # CRD definition
│       ├── postgrescluster_webhook.go    # Webhook logic
│       └── zz_generated.deepcopy.go      # Generated code
├── config/
│   ├── crd/                              # CRD manifests
│   ├── manager/                          # Operator deployment
│   ├── rbac/                             # RBAC rules
│   ├── webhook/                          # Webhook configuration
│   └── samples/                          # Example CRs
├── internal/
│   └── controller/
│       └── postgrescluster_controller.go # Reconciliation logic
├── cmd/
│   └── main.go                           # Entrypoint
├── Dockerfile
├── Makefile
└── go.mod
```

### Dependencies

The `go.mod` file lists the controller-runtime framework and Kubernetes API libraries that the operator depends on:

```
// go.mod
module github.com/example/postgres-operator

go 1.27

require (
    k8s.io/api v0.33.0
    k8s.io/apimachinery v0.33.0
    k8s.io/client-go v0.33.0
    sigs.k8s.io/controller-runtime v0.21.0
    github.com/go-logr/logr v1.4.2
    github.com/prometheus/client_golang v1.22.0
)
```
