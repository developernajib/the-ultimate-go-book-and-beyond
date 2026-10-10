## 102.10 Exercises with Complete Solutions

### Exercise 1: Complete Terraform Module for a Go Microservice

**Problem:** Create a reusable Terraform module that deploys a Go microservice with all necessary infrastructure.

**Solution:**

```hcl
# modules/go-microservice/main.tf

terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
  }
}

# Variables
variable "name" {
  description = "Name of the microservice"
  type        = string
}

variable "environment" {
  description = "Environment (dev, staging, prod)"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID to deploy into"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs"
  type        = list(string)
}

variable "eks_cluster_name" {
  description = "EKS cluster name"
  type        = string
}

variable "container_port" {
  description = "Port the Go service listens on"
  type        = number
  default     = 8080
}

variable "replicas" {
  description = "Number of replicas"
  type        = number
  default     = 3
}

variable "resources" {
  description = "Container resources"
  type = object({
    cpu_request    = string
    cpu_limit      = string
    memory_request = string
    memory_limit   = string
  })
  default = {
    cpu_request    = "100m"
    cpu_limit      = "500m"
    memory_request = "128Mi"
    memory_limit   = "512Mi"
  }
}

variable "enable_database" {
  description = "Create RDS database"
  type        = bool
  default     = true
}

variable "enable_redis" {
  description = "Create ElastiCache Redis"
  type        = bool
  default     = false
}

# Locals
locals {
  full_name = "${var.name}-${var.environment}"
  is_prod   = var.environment == "prod"

  common_tags = {
    Service     = var.name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ECR Repository
resource "aws_ecr_repository" "main" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = local.common_tags
}

resource "aws_ecr_lifecycle_policy" "main" {
  repository = aws_ecr_repository.main.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 30 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# Security Group for the service
resource "aws_security_group" "service" {
  name        = "${local.full_name}-service"
  description = "Security group for ${var.name} service"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = var.container_port
    to_port     = var.container_port
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.full_name}-service"
  })
}

# RDS Database (optional)
resource "aws_db_subnet_group" "main" {
  count = var.enable_database ? 1 : 0

  name       = local.full_name
  subnet_ids = var.private_subnet_ids

  tags = local.common_tags
}

resource "aws_security_group" "rds" {
  count = var.enable_database ? 1 : 0

  name        = "${local.full_name}-rds"
  description = "RDS security group for ${var.name}"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }

  tags = local.common_tags
}

resource "random_password" "db_password" {
  count   = var.enable_database ? 1 : 0
  length  = 32
  special = false
}

resource "aws_db_instance" "main" {
  count = var.enable_database ? 1 : 0

  identifier = local.full_name

  engine               = "postgres"
  engine_version       = "15.4"
  instance_class       = local.is_prod ? "db.r6g.large" : "db.t3.micro"
  allocated_storage    = local.is_prod ? 100 : 20
  max_allocated_storage = local.is_prod ? 1000 : 100
  storage_encrypted    = true

  db_name  = replace(var.name, "-", "_")
  username = "admin"
  password = random_password.db_password[0].result

  multi_az               = local.is_prod
  db_subnet_group_name   = aws_db_subnet_group.main[0].name
  vpc_security_group_ids = [aws_security_group.rds[0].id]

  backup_retention_period = local.is_prod ? 35 : 7
  skip_final_snapshot     = !local.is_prod
  deletion_protection     = local.is_prod

  performance_insights_enabled = local.is_prod

  tags = local.common_tags
}

# Store database credentials in Secrets Manager
resource "aws_secretsmanager_secret" "db_credentials" {
  count = var.enable_database ? 1 : 0

  name = "/${var.environment}/${var.name}/database"

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  count = var.enable_database ? 1 : 0

  secret_id = aws_secretsmanager_secret.db_credentials[0].id
  secret_string = jsonencode({
    host     = aws_db_instance.main[0].address
    port     = 5432
    username = aws_db_instance.main[0].username
    password = random_password.db_password[0].result
    dbname   = aws_db_instance.main[0].db_name
    url      = "postgres://${aws_db_instance.main[0].username}:${random_password.db_password[0].result}@${aws_db_instance.main[0].address}:5432/${aws_db_instance.main[0].db_name}?sslmode=require"
  })
}

# ElastiCache Redis (optional)
resource "aws_elasticache_subnet_group" "main" {
  count = var.enable_redis ? 1 : 0

  name       = local.full_name
  subnet_ids = var.private_subnet_ids
}

resource "aws_security_group" "redis" {
  count = var.enable_redis ? 1 : 0

  name        = "${local.full_name}-redis"
  description = "Redis security group for ${var.name}"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }

  tags = local.common_tags
}

resource "aws_elasticache_replication_group" "main" {
  count = var.enable_redis ? 1 : 0

  replication_group_id = local.full_name
  description          = "Redis for ${var.name}"

  engine               = "redis"
  engine_version       = "7.0"
  node_type            = local.is_prod ? "cache.r6g.large" : "cache.t3.micro"
  num_cache_clusters   = local.is_prod ? 2 : 1

  automatic_failover_enabled = local.is_prod
  multi_az_enabled           = local.is_prod

  subnet_group_name  = aws_elasticache_subnet_group.main[0].name
  security_group_ids = [aws_security_group.redis[0].id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  tags = local.common_tags
}

# Kubernetes Namespace
resource "kubernetes_namespace" "main" {
  metadata {
    name = var.name

    labels = {
      "app.kubernetes.io/name"       = var.name
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }
}

# Kubernetes Deployment
resource "kubernetes_deployment" "main" {
  metadata {
    name      = var.name
    namespace = kubernetes_namespace.main.metadata[0].name

    labels = {
      "app.kubernetes.io/name" = var.name
    }
  }

  spec {
    replicas = var.replicas

    selector {
      match_labels = {
        "app.kubernetes.io/name" = var.name
      }
    }

    template {
      metadata {
        labels = {
          "app.kubernetes.io/name" = var.name
        }
      }

      spec {
        container {
          name  = var.name
          image = "${aws_ecr_repository.main.repository_url}:latest"

          port {
            container_port = var.container_port
          }

          resources {
            requests = {
              cpu    = var.resources.cpu_request
              memory = var.resources.memory_request
            }
            limits = {
              cpu    = var.resources.cpu_limit
              memory = var.resources.memory_limit
            }
          }

          env {
            name  = "PORT"
            value = tostring(var.container_port)
          }

          env {
            name  = "ENVIRONMENT"
            value = var.environment
          }

          dynamic "env" {
            for_each = var.enable_database ? [1] : []
            content {
              name = "DATABASE_URL"
              value_from {
                secret_key_ref {
                  name = kubernetes_secret.db_credentials[0].metadata[0].name
                  key  = "url"
                }
              }
            }
          }

          dynamic "env" {
            for_each = var.enable_redis ? [1] : []
            content {
              name  = "REDIS_URL"
              value = "redis://${aws_elasticache_replication_group.main[0].primary_endpoint_address}:6379"
            }
          }

          liveness_probe {
            http_get {
              path = "/health"
              port = var.container_port
            }
            initial_delay_seconds = 10
            period_seconds        = 10
          }

          readiness_probe {
            http_get {
              path = "/ready"
              port = var.container_port
            }
            initial_delay_seconds = 5
            period_seconds        = 5
          }
        }
      }
    }
  }
}

# Kubernetes Secret for database credentials
resource "kubernetes_secret" "db_credentials" {
  count = var.enable_database ? 1 : 0

  metadata {
    name      = "${var.name}-db-credentials"
    namespace = kubernetes_namespace.main.metadata[0].name
  }

  data = {
    url = "postgres://${aws_db_instance.main[0].username}:${random_password.db_password[0].result}@${aws_db_instance.main[0].address}:5432/${aws_db_instance.main[0].db_name}?sslmode=require"
  }
}

# Kubernetes Service
resource "kubernetes_service" "main" {
  metadata {
    name      = var.name
    namespace = kubernetes_namespace.main.metadata[0].name
  }

  spec {
    selector = {
      "app.kubernetes.io/name" = var.name
    }

    port {
      port        = 80
      target_port = var.container_port
    }

    type = "ClusterIP"
  }
}

# Kubernetes HPA
resource "kubernetes_horizontal_pod_autoscaler_v2" "main" {
  metadata {
    name      = var.name
    namespace = kubernetes_namespace.main.metadata[0].name
  }

  spec {
    scale_target_ref {
      api_version = "apps/v1"
      kind        = "Deployment"
      name        = kubernetes_deployment.main.metadata[0].name
    }

    min_replicas = var.replicas
    max_replicas = var.replicas * 3

    metric {
      type = "Resource"
      resource {
        name = "cpu"
        target {
          type                = "Utilization"
          average_utilization = 70
        }
      }
    }

    metric {
      type = "Resource"
      resource {
        name = "memory"
        target {
          type                = "Utilization"
          average_utilization = 80
        }
      }
    }
  }
}

# Outputs
output "ecr_repository_url" {
  description = "ECR repository URL"
  value       = aws_ecr_repository.main.repository_url
}

output "service_endpoint" {
  description = "Kubernetes service endpoint"
  value       = "${kubernetes_service.main.metadata[0].name}.${kubernetes_namespace.main.metadata[0].name}.svc.cluster.local"
}

output "database_endpoint" {
  description = "RDS endpoint"
  value       = var.enable_database ? aws_db_instance.main[0].endpoint : null
  sensitive   = true
}

output "redis_endpoint" {
  description = "Redis endpoint"
  value       = var.enable_redis ? aws_elasticache_replication_group.main[0].primary_endpoint_address : null
}
```

### Exercise 2: Pulumi Program for Multi-Region Deployment

**Problem:** Create a Pulumi program in Go that deploys a Go service to multiple AWS regions.

**Solution:**

```go
// main.go
package main

import (
    "fmt"

    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/ec2"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/ecr"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/ecs"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/lb"
    "github.com/pulumi/pulumi-aws/sdk/v6/go/aws/iam"
    "github.com/pulumi/pulumi/sdk/v3/go/pulumi"
    "github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

type RegionalDeployment struct {
    Region       string
    VPCCIDR      string
    InstanceType string
}

func main() {
    pulumi.Run(func(ctx *pulumi.Context) error {
        cfg := config.New(ctx, "")
        serviceName := cfg.Require("serviceName")
        environment := cfg.Require("environment")

        // Define regions for multi-region deployment
        regions := []RegionalDeployment{
            {Region: "us-west-2", VPCCIDR: "10.0.0.0/16", InstanceType: "t3.medium"},
            {Region: "us-east-1", VPCCIDR: "10.1.0.0/16", InstanceType: "t3.medium"},
            {Region: "eu-west-1", VPCCIDR: "10.2.0.0/16", InstanceType: "t3.medium"},
        }

        // Create global ECR repository (in primary region)
        repo, err := ecr.NewRepository(ctx, serviceName, &ecr.RepositoryArgs{
            Name:               pulumi.String(serviceName),
            ImageTagMutability: pulumi.String("IMMUTABLE"),
            ImageScanningConfiguration: &ecr.RepositoryImageScanningConfigurationArgs{
                ScanOnPush: pulumi.Bool(true),
            },
        })
        if err != nil {
            return err
        }

        // Deploy to each region
        var endpoints []pulumi.StringOutput
        for _, region := range regions {
            endpoint, err := deployToRegion(ctx, serviceName, environment, region, repo)
            if err != nil {
                return fmt.Errorf("failed to deploy to %s: %w", region.Region, err)
            }
            endpoints = append(endpoints, endpoint)
        }

        // Exports
        ctx.Export("ecrRepositoryUrl", repo.RepositoryUrl)
        for i, endpoint := range endpoints {
            ctx.Export(fmt.Sprintf("endpoint_%s", regions[i].Region), endpoint)
        }

        return nil
    })
}

func deployToRegion(
    ctx *pulumi.Context,
    serviceName, environment string,
    region RegionalDeployment,
    repo *ecr.Repository,
) (pulumi.StringOutput, error) {
    // Create provider for this region
    provider, err := aws.NewProvider(ctx, fmt.Sprintf("aws-%s", region.Region), &aws.ProviderArgs{
        Region: pulumi.String(region.Region),
    })
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    // Create VPC
    vpc, err := ec2.NewVpc(ctx, fmt.Sprintf("%s-%s-vpc", serviceName, region.Region), &ec2.VpcArgs{
        CidrBlock:          pulumi.String(region.VPCCIDR),
        EnableDnsHostnames: pulumi.Bool(true),
        EnableDnsSupport:   pulumi.Bool(true),
        Tags: pulumi.StringMap{
            "Name":        pulumi.Sprintf("%s-%s-vpc", serviceName, region.Region),
            "Environment": pulumi.String(environment),
        },
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    // Create Internet Gateway
    igw, err := ec2.NewInternetGateway(ctx, fmt.Sprintf("%s-%s-igw", serviceName, region.Region), &ec2.InternetGatewayArgs{
        VpcId: vpc.ID(),
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    // Create subnets (2 AZs)
    azSuffixes := []string{"a", "b"}
    var publicSubnetIds pulumi.StringArray
    var privateSubnetIds pulumi.StringArray

    for i, az := range azSuffixes {
        // Public subnet
        publicSubnet, err := ec2.NewSubnet(ctx, fmt.Sprintf("%s-%s-public-%s", serviceName, region.Region, az), &ec2.SubnetArgs{
            VpcId:               vpc.ID(),
            CidrBlock:           pulumi.Sprintf("%s.%d.0/24", region.VPCCIDR[:len(region.VPCCIDR)-5], i+1),
            AvailabilityZone:    pulumi.Sprintf("%s%s", region.Region, az),
            MapPublicIpOnLaunch: pulumi.Bool(true),
        }, pulumi.Provider(provider))
        if err != nil {
            return pulumi.StringOutput{}, err
        }
        publicSubnetIds = append(publicSubnetIds, publicSubnet.ID())

        // Private subnet
        privateSubnet, err := ec2.NewSubnet(ctx, fmt.Sprintf("%s-%s-private-%s", serviceName, region.Region, az), &ec2.SubnetArgs{
            VpcId:            vpc.ID(),
            CidrBlock:        pulumi.Sprintf("%s.%d.0/24", region.VPCCIDR[:len(region.VPCCIDR)-5], i+101),
            AvailabilityZone: pulumi.Sprintf("%s%s", region.Region, az),
        }, pulumi.Provider(provider))
        if err != nil {
            return pulumi.StringOutput{}, err
        }
        privateSubnetIds = append(privateSubnetIds, privateSubnet.ID())
    }

    // Create route table for public subnets
    publicRT, err := ec2.NewRouteTable(ctx, fmt.Sprintf("%s-%s-public-rt", serviceName, region.Region), &ec2.RouteTableArgs{
        VpcId: vpc.ID(),
        Routes: ec2.RouteTableRouteArray{
            &ec2.RouteTableRouteArgs{
                CidrBlock: pulumi.String("0.0.0.0/0"),
                GatewayId: igw.ID(),
            },
        },
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    // Associate route table with public subnets
    for i, subnetId := range publicSubnetIds {
        _, err = ec2.NewRouteTableAssociation(ctx, fmt.Sprintf("%s-%s-public-rta-%d", serviceName, region.Region, i), &ec2.RouteTableAssociationArgs{
            SubnetId:     subnetId,
            RouteTableId: publicRT.ID(),
        }, pulumi.Provider(provider))
        if err != nil {
            return pulumi.StringOutput{}, err
        }
    }

    // Create security group for ALB
    albSG, err := ec2.NewSecurityGroup(ctx, fmt.Sprintf("%s-%s-alb-sg", serviceName, region.Region), &ec2.SecurityGroupArgs{
        VpcId: vpc.ID(),
        Ingress: ec2.SecurityGroupIngressArray{
            &ec2.SecurityGroupIngressArgs{
                Protocol:   pulumi.String("tcp"),
                FromPort:   pulumi.Int(80),
                ToPort:     pulumi.Int(80),
                CidrBlocks: pulumi.StringArray{pulumi.String("0.0.0.0/0")},
            },
            &ec2.SecurityGroupIngressArgs{
                Protocol:   pulumi.String("tcp"),
                FromPort:   pulumi.Int(443),
                ToPort:     pulumi.Int(443),
                CidrBlocks: pulumi.StringArray{pulumi.String("0.0.0.0/0")},
            },
        },
        Egress: ec2.SecurityGroupEgressArray{
            &ec2.SecurityGroupEgressArgs{
                Protocol:   pulumi.String("-1"),
                FromPort:   pulumi.Int(0),
                ToPort:     pulumi.Int(0),
                CidrBlocks: pulumi.StringArray{pulumi.String("0.0.0.0/0")},
            },
        },
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    // Create security group for ECS tasks
    taskSG, err := ec2.NewSecurityGroup(ctx, fmt.Sprintf("%s-%s-task-sg", serviceName, region.Region), &ec2.SecurityGroupArgs{
        VpcId: vpc.ID(),
        Ingress: ec2.SecurityGroupIngressArray{
            &ec2.SecurityGroupIngressArgs{
                Protocol:       pulumi.String("tcp"),
                FromPort:       pulumi.Int(8080),
                ToPort:         pulumi.Int(8080),
                SecurityGroups: pulumi.StringArray{albSG.ID()},
            },
        },
        Egress: ec2.SecurityGroupEgressArray{
            &ec2.SecurityGroupEgressArgs{
                Protocol:   pulumi.String("-1"),
                FromPort:   pulumi.Int(0),
                ToPort:     pulumi.Int(0),
                CidrBlocks: pulumi.StringArray{pulumi.String("0.0.0.0/0")},
            },
        },
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    // Create ALB
    alb, err := lb.NewLoadBalancer(ctx, fmt.Sprintf("%s-%s-alb", serviceName, region.Region), &lb.LoadBalancerArgs{
        Subnets:        publicSubnetIds,
        SecurityGroups: pulumi.StringArray{albSG.ID()},
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    // Create target group
    tg, err := lb.NewTargetGroup(ctx, fmt.Sprintf("%s-%s-tg", serviceName, region.Region), &lb.TargetGroupArgs{
        Port:       pulumi.Int(8080),
        Protocol:   pulumi.String("HTTP"),
        VpcId:      vpc.ID(),
        TargetType: pulumi.String("ip"),
        HealthCheck: &lb.TargetGroupHealthCheckArgs{
            Path:                pulumi.String("/health"),
            Protocol:            pulumi.String("HTTP"),
            HealthyThreshold:    pulumi.Int(2),
            UnhealthyThreshold:  pulumi.Int(3),
            Timeout:             pulumi.Int(5),
            Interval:            pulumi.Int(30),
        },
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    // Create listener
    _, err = lb.NewListener(ctx, fmt.Sprintf("%s-%s-listener", serviceName, region.Region), &lb.ListenerArgs{
        LoadBalancerArn: alb.Arn,
        Port:            pulumi.Int(80),
        Protocol:        pulumi.String("HTTP"),
        DefaultActions: lb.ListenerDefaultActionArray{
            &lb.ListenerDefaultActionArgs{
                Type:           pulumi.String("forward"),
                TargetGroupArn: tg.Arn,
            },
        },
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    // Create ECS cluster
    cluster, err := ecs.NewCluster(ctx, fmt.Sprintf("%s-%s-cluster", serviceName, region.Region), &ecs.ClusterArgs{
        Name: pulumi.Sprintf("%s-%s", serviceName, region.Region),
        Settings: ecs.ClusterSettingArray{
            &ecs.ClusterSettingArgs{
                Name:  pulumi.String("containerInsights"),
                Value: pulumi.String("enabled"),
            },
        },
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    // Create task execution role
    executionRole, err := iam.NewRole(ctx, fmt.Sprintf("%s-%s-execution-role", serviceName, region.Region), &iam.RoleArgs{
        AssumeRolePolicy: pulumi.String(`{
            "Version": "2012-10-17",
            "Statement": [{
                "Action": "sts:AssumeRole",
                "Principal": {"Service": "ecs-tasks.amazonaws.com"},
                "Effect": "Allow"
            }]
        }`),
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    _, err = iam.NewRolePolicyAttachment(ctx, fmt.Sprintf("%s-%s-execution-policy", serviceName, region.Region), &iam.RolePolicyAttachmentArgs{
        Role:      executionRole.Name,
        PolicyArn: pulumi.String("arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"),
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    // Create task definition
    taskDef, err := ecs.NewTaskDefinition(ctx, fmt.Sprintf("%s-%s-task", serviceName, region.Region), &ecs.TaskDefinitionArgs{
        Family:                  pulumi.String(serviceName),
        NetworkMode:             pulumi.String("awsvpc"),
        RequiresCompatibilities: pulumi.StringArray{pulumi.String("FARGATE")},
        Cpu:                     pulumi.String("256"),
        Memory:                  pulumi.String("512"),
        ExecutionRoleArn:        executionRole.Arn,
        ContainerDefinitions: repo.RepositoryUrl.ApplyT(func(url string) string {
            return fmt.Sprintf(`[{
                "name": "%s",
                "image": "%s:latest",
                "portMappings": [{
                    "containerPort": 8080,
                    "hostPort": 8080,
                    "protocol": "tcp"
                }],
                "environment": [
                    {"name": "PORT", "value": "8080"},
                    {"name": "REGION", "value": "%s"},
                    {"name": "ENVIRONMENT", "value": "%s"}
                ],
                "logConfiguration": {
                    "logDriver": "awslogs",
                    "options": {
                        "awslogs-group": "/ecs/%s",
                        "awslogs-region": "%s",
                        "awslogs-stream-prefix": "ecs"
                    }
                }
            }]`, serviceName, url, region.Region, environment, serviceName, region.Region)
        }).(pulumi.StringOutput),
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    // Create ECS service
    _, err = ecs.NewService(ctx, fmt.Sprintf("%s-%s-service", serviceName, region.Region), &ecs.ServiceArgs{
        Name:           pulumi.String(serviceName),
        Cluster:        cluster.Arn,
        TaskDefinition: taskDef.Arn,
        DesiredCount:   pulumi.Int(2),
        LaunchType:     pulumi.String("FARGATE"),
        NetworkConfiguration: &ecs.ServiceNetworkConfigurationArgs{
            Subnets:        privateSubnetIds,
            SecurityGroups: pulumi.StringArray{taskSG.ID()},
        },
        LoadBalancers: ecs.ServiceLoadBalancerArray{
            &ecs.ServiceLoadBalancerArgs{
                TargetGroupArn: tg.Arn,
                ContainerName:  pulumi.String(serviceName),
                ContainerPort:  pulumi.Int(8080),
            },
        },
    }, pulumi.Provider(provider))
    if err != nil {
        return pulumi.StringOutput{}, err
    }

    return alb.DnsName, nil
}
```

---

### Junior → FAANG: IaC Exercises as Production Readiness Training

These exercises are designed to create production-like IaC scenarios. The most valuable exercise is the complete Terraform module for a Go microservice: it requires you to think about which infrastructure a Go service actually needs (ECS task definition with correct CPU/memory, security groups with least-privilege rules, IAM role with the service's required permissions), not just which resources exist.

The Pulumi exercise is particularly valuable for Go engineers because it demonstrates that infrastructure code can use the same patterns as application code: error handling, loops, functions, and type safety. The shift from "infrastructure is configuration" to "infrastructure is code" opens up testing and abstraction possibilities that HCL cannot provide.

### Senior @ FAANG: IaC Exercises as Module Design Templates

At staff level, these exercises produce the initial templates for the organization's module library. The "complete Terraform module for a Go microservice" exercise, extended with the organization's specific requirements (mandatory tags, specific security group rules, IAM boundary policies), becomes the standard module that every new Go service uses as its starting point.

The exercise of building a drift detection pipeline becomes the platform team's actual drift detection infrastructure. The Pulumi automation API exercise becomes the mechanism for the organization's self-service infrastructure portal. In a mature platform team, exercises like these are not learning activities but prototyping sessions that produce artifacts ready for productionization with additional testing, documentation, and operational hardening.
