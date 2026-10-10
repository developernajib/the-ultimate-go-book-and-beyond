## Project Overview

This capstone project implements a **PostgreSQL Operator** that automates the deployment and lifecycle management of PostgreSQL databases on Kubernetes. The operator demonstrates all patterns required for production Kubernetes controllers used at companies like Google, Amazon, and Microsoft.

**Key Features:**
- **Custom Resource**: `PostgresCluster` CRD for declarative database management
- **Automated Provisioning**: Creates StatefulSet, Services, ConfigMaps, PVCs
- **High Availability**: Primary-replica topology with automatic failover
- **Backup Management**: Automated backups to S3-compatible storage
- **Status Reporting**: Comprehensive status with conditions and events
- **Validation Webhooks**: Prevent invalid configurations
- **Mutation Webhooks**: Set defaults and inject sidecar containers
- **Finalizers**: Proper cleanup on deletion
- **Leader Election**: Multi-replica operator deployment
- **Observability**: Metrics, logs, and tracing

**Technology Stack:**
- `controller-runtime` and `kubebuilder` for scaffolding
- `client-go` for Kubernetes API interaction
- `envtest` for integration testing
- Prometheus for metrics
- PostgreSQL as the managed application
