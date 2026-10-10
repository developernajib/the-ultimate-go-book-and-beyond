## Part 12: Production Deployment Guide

Deploying an ML platform to production requires more than just running containers. You need reproducible infrastructure provisioning, metrics collection, alerting, and performance tuning. This part covers infrastructure as code with Terraform for creating cloud resources, Prometheus configuration for scraping platform metrics, and caching strategies that dramatically reduce database load during high-throughput inference workloads.

### 12.1 Infrastructure as Code (Terraform)

Terraform lets you define your cloud infrastructure -- databases, caches, Kubernetes clusters, and storage buckets -- in declarative configuration files. When you run `terraform apply`, it compares the desired state with the actual state and makes only the necessary changes. This is far safer than clicking through a cloud console because every change is version-controlled, peer-reviewed, and reproducible across environments.

```hcl
# infrastructure/main.tf

terraform {
  required_version = ">= 1.0"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# RDS PostgreSQL for metadata
resource "aws_db_instance" "mlplatform" {
  identifier        = "mlplatform-db"
  engine            = "postgres"
  engine_version    = "14"
  instance_class    = "db.r6g.2xlarge"
  allocated_storage = 500
  storage_type      = "gp3"
  
  db_name  = "mlplatform"
  username = var.db_username
  password = var.db_password
  
  vpc_security_group_ids = [aws_security_group.db.id]
  db_subnet_group_name   = aws_db_subnet_group.mlplatform.name
  
  backup_retention_period = 7
  multi_az               = true
  
  tags = {
    Name        = "mlplatform-db"
    Environment = var.environment
  }
}

# ElastiCache Redis for feature store
resource "aws_elasticache_cluster" "mlplatform" {
  cluster_id           = "mlplatform-redis"
  engine               = "redis"
  node_type            = "cache.r6g.xlarge"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  
  subnet_group_name    = aws_elasticache_subnet_group.mlplatform.name
  security_group_ids   = [aws_security_group.redis.id]
  
  tags = {
    Name        = "mlplatform-redis"
    Environment = var.environment
  }
}

# S3 for model artifacts
resource "aws_s3_bucket" "mlplatform" {
  bucket = "mlplatform-artifacts-${var.environment}"
  
  tags = {
    Name        = "mlplatform-artifacts"
    Environment = var.environment
  }
}

resource "aws_s3_bucket_versioning" "mlplatform" {
  bucket = aws_s3_bucket.mlplatform.id
  
  versioning_configuration {
    status = "Enabled"
  }
}

# EKS Cluster for running ML platform
resource "aws_eks_cluster" "mlplatform" {
  name     = "mlplatform-${var.environment}"
  role_arn = aws_iam_role.eks_cluster.arn
  version  = "1.28"
  
  vpc_config {
    subnet_ids = var.subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = true
  }
  
  depends_on = [
    aws_iam_role_policy_attachment.eks_cluster_policy,
  ]
}

# EKS Node Group
resource "aws_eks_node_group" "mlplatform" {
  cluster_name    = aws_eks_cluster.mlplatform.name
  node_group_name = "mlplatform-workers"
  node_role_arn   = aws_iam_role.eks_nodes.arn
  subnet_ids      = var.subnet_ids
  
  instance_types = ["m6i.2xlarge"]
  
  scaling_config {
    desired_size = 3
    max_size     = 10
    min_size     = 2
  }
  
  depends_on = [
    aws_iam_role_policy_attachment.eks_worker_node_policy,
    aws_iam_role_policy_attachment.eks_cni_policy,
    aws_iam_role_policy_attachment.eks_container_registry_policy,
  ]
}
```

### 12.2 Monitoring with Prometheus

Prometheus is the industry-standard tool for collecting and querying time-series metrics from cloud-native applications. The configuration below tells Prometheus where to find your ML platform's metrics endpoint and how frequently to scrape it. Once metrics are flowing, you can build Grafana dashboards to visualize inference latency, request rates, error counts, and model drift scores in real time, giving your team immediate visibility into platform health.

```yaml
# k8s/monitoring/prometheus.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s

    scrape_configs:
      - job_name: 'mlplatform'
        kubernetes_sd_configs:
          - role: pod
            namespaces:
              names:
                - ml-platform
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_label_app]
            action: keep
            regex: mlplatform
          - source_labels: [__meta_kubernetes_pod_name]
            target_label: pod_name
          - source_labels: [__meta_kubernetes_namespace]
            target_label: namespace

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: prometheus
  template:
    metadata:
      labels:
        app: prometheus
    spec:
      containers:
      - name: prometheus
        image: prom/prometheus:latest
        args:
          - '--config.file=/etc/prometheus/prometheus.yml'
          - '--storage.tsdb.path=/prometheus'
          - '--storage.tsdb.retention.time=30d'
        ports:
        - containerPort: 9090
        volumeMounts:
        - name: config
          mountPath: /etc/prometheus
        - name: storage
          mountPath: /prometheus
      volumes:
      - name: config
        configMap:
          name: prometheus-config
      - name: storage
        persistentVolumeClaim:
          claimName: prometheus-storage
```

### 12.3 Performance Optimization Tips

In a production ML platform, the model serving path handles the highest traffic and is the most latency-sensitive. Caching frequently requested feature vectors and prediction results in Redis can reduce database load by an order of magnitude. The implementation below shows a caching layer that wraps your existing services, checks Redis before hitting the database, and automatically invalidates stale entries. It also demonstrates batch prediction support, which amortizes the overhead of individual requests when you need to score many items at once.

```go
// internal/optimization/caching.go
package optimization

import (
	"context"
	"encoding/json"
	"time"

	"github.com/go-redis/redis/v8"
)

// CachingLayer provides caching for frequently accessed data
type CachingLayer struct {
	redis *redis.Client
	ttl   time.Duration
}

// NewCachingLayer creates a new caching layer
func NewCachingLayer(redisClient *redis.Client, ttl time.Duration) *CachingLayer {
	return &CachingLayer{
		redis: redisClient,
		ttl:   ttl,
	}
}

// Get retrieves a value from cache
func (c *CachingLayer) Get(ctx context.Context, key string, value any) (bool, error) {
	data, err := c.redis.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	if err := json.Unmarshal(data, value); err != nil {
		return false, err
	}

	return true, nil
}

// Set stores a value in cache
func (c *CachingLayer) Set(ctx context.Context, key string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}

	return c.redis.Set(ctx, key, data, c.ttl).Err()
}

// Delete removes a value from cache
func (c *CachingLayer) Delete(ctx context.Context, key string) error {
	return c.redis.Del(ctx, key).Err()
}
```

---
