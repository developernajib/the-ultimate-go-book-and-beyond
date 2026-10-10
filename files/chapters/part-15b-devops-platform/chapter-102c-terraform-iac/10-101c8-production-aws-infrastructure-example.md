## 102C.8 Production AWS Infrastructure Example

This example brings together all the HCL patterns from previous sections into a single production-grade configuration that provisions a complete application stack: a VPC with public and private subnets across three availability zones, an Application Load Balancer, an ECS Fargate service, an RDS PostgreSQL database, and an ElastiCache Redis cluster. Reading through this configuration is the fastest way to see how Terraform resources reference each other and how the module composition pattern keeps each concern in its own block.

```hcl
# Complete production setup: VPC + ALB + ECS + RDS + ElastiCache

# live/prod/main.tf
locals {
  project     = "shopapp"
  environment = "prod"
  aws_region  = "us-east-1"

  azs = ["us-east-1a", "us-east-1b", "us-east-1c"]

  db_instance_class    = "db.r7g.large"
  cache_node_type      = "cache.r7g.large"
  api_instance_cpu     = 1024
  api_instance_memory  = 2048
}

module "vpc" {
  source = "../../modules/vpc"

  project            = local.project
  environment        = local.environment
  cidr_block         = "10.0.0.0/16"
  availability_zones = local.azs
  enable_nat_gateway = true
  single_nat_gateway = false # one per AZ for HA
}

# Application Load Balancer
resource "aws_lb" "main" {
  name               = "${local.project}-${local.environment}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.vpc.public_subnet_ids

  enable_deletion_protection = true
  enable_http2               = true

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.bucket
    enabled = true
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = data.aws_acm_certificate.main.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# RDS PostgreSQL Multi-AZ
resource "aws_db_subnet_group" "main" {
  name       = "${local.project}-${local.environment}"
  subnet_ids = module.vpc.private_subnet_ids
}

resource "aws_db_instance" "main" {
  identifier        = "${local.project}-${local.environment}"
  engine            = "postgres"
  engine_version    = "16.2"
  instance_class    = local.db_instance_class
  allocated_storage = 100
  storage_type      = "gp3"
  iops              = 3000

  db_name  = "shopdb"
  username = "shopapp"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]

  multi_az               = true
  publicly_accessible    = false
  deletion_protection    = true
  skip_final_snapshot    = false
  final_snapshot_identifier = "${local.project}-${local.environment}-final"

  backup_retention_period   = 7
  backup_window             = "03:00-04:00"
  maintenance_window        = "sun:04:00-sun:05:00"
  auto_minor_version_upgrade = true

  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn

  parameter_group_name = aws_db_parameter_group.postgres16.name

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [password] # managed by rotation
  }
}

resource "aws_db_parameter_group" "postgres16" {
  name   = "${local.project}-${local.environment}-pg16"
  family = "postgres16"

  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements,pgaudit"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # log queries > 1 second
  }

  parameter {
    name  = "wal_level"
    value = "logical" # required for Debezium CDC
    apply_method = "pending-reboot"
  }
}

# ElastiCache Redis
resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.project}-${local.environment}"
  subnet_ids = module.vpc.private_subnet_ids
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.project}-${local.environment}"
  description          = "Redis cluster for ${local.project} ${local.environment}"

  node_type            = local.cache_node_type
  num_cache_clusters   = 3  # one per AZ
  parameter_group_name = "default.redis7"
  engine_version       = "7.1"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result

  automatic_failover_enabled = true
  multi_az_enabled           = true

  snapshot_retention_limit = 3
  snapshot_window          = "04:00-05:00"

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [auth_token]
  }
}

# ECS Cluster
resource "aws_ecs_cluster" "main" {
  name = "${local.project}-${local.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

module "api_service" {
  source = "../../modules/ecs-service"

  service_name       = "api"
  cluster_id         = aws_ecs_cluster.main.id
  container_image    = "${var.ecr_registry}/api:${var.image_tag}"
  container_port     = 8080
  desired_count      = 3
  cpu                = local.api_instance_cpu
  memory             = local.api_instance_memory
  subnet_ids         = module.vpc.private_subnet_ids
  security_group_ids = [aws_security_group.ecs_tasks.id]
  target_group_arn   = aws_lb_target_group.api.arn
  min_capacity       = 3
  max_capacity       = 30

  environment_variables = {
    APP_ENV    = local.environment
    LOG_LEVEL  = "info"
    DB_HOST    = aws_db_instance.main.address
    DB_PORT    = "5432"
    DB_NAME    = "shopdb"
    REDIS_HOST = aws_elasticache_replication_group.main.primary_endpoint_address
    REDIS_PORT = "6379"
  }

  secrets = {
    DB_PASSWORD    = aws_secretsmanager_secret.db_password.arn
    REDIS_PASSWORD = aws_secretsmanager_secret.redis_password.arn
    JWT_SECRET     = aws_secretsmanager_secret.jwt_secret.arn
  }

  tags = {
    Service = "api"
  }
}

# Outputs
output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "db_endpoint" {
  value     = aws_db_instance.main.endpoint
  sensitive = true
}

output "redis_endpoint" {
  value     = aws_elasticache_replication_group.main.primary_endpoint_address
  sensitive = true
}
```

---

### Junior → FAANG: Reading Production Terraform Configurations

The example above is a realistic production configuration. Reading it is a skill in itself. When you encounter a large configuration for the first time, start with the `locals` block to understand the named constants, then trace the `module` calls to understand the dependency structure, then read the inline resources (RDS, ElastiCache, ECS cluster) in order from stateful (RDS, ElastiCache) to stateless (ECS).

Notice three patterns that appear in every production configuration but are often absent in tutorial code. First: `deletion_protection = true` and `lifecycle { prevent_destroy = true }` on RDS and ElastiCache. These two layers of protection prevent both API-level and Terraform-level deletion. Second: secrets are not in the configuration file. They are in Secrets Manager and referenced by ARN in the `secrets` block of the ECS module. The actual credential values never appear in HCL or in plan output. Third: `enable_deletion_protection = true` on the ALB prevents accidental destruction of the load balancer, which would cause an outage even if RDS and ECS survive.

For your first production infrastructure role, adopt these patterns immediately and propose them in code review when you see configurations that omit them.

### Senior @ FAANG: Production Configuration as a Security Baseline

At L6, the production configuration above represents a security baseline, not a complete production system. Every senior review of a configuration like this surfaces additional concerns:

**TLS policy selection.** The `ELBSecurityPolicy-TLS13-1-2-2021-06` policy is correct: it enforces TLS 1.2 minimum and prefers TLS 1.3. However, it should be reviewed quarterly against AWS's published policy deprecation schedule. Outdated TLS policies are a common PCI DSS finding. Encode the policy name as a validated variable rather than a string literal so policy updates can be applied across all environments by changing one value.

**WAF association.** A production ALB serving external traffic without a WAF association is incomplete. The configuration above lacks `aws_wafv2_web_acl_association`. This is a common gap in configurations that were written before WAF became cost-effective at the team level. At bar-raiser interviews, identifying this gap and proposing the AWS Managed Rules baseline (AWSManagedRulesCommonRuleSet, AWSManagedRulesSQLiRuleSet) demonstrates production security awareness.

**RDS parameter group for observability.** The `log_min_duration_statement = 1000` setting captures slow queries, and the `pgaudit` shared library enables statement-level audit logging for compliance. Both are present in this configuration, which is above average. The next level is shipping these logs to a centralized SIEM: a CloudWatch log subscription that forwards to OpenSearch or a third-party SIEM. At L6, you define this as a required element of the database module so all teams automatically get the right observability posture.

**Cost and scaling capacity planning.** The `min_capacity = 3`, `max_capacity = 30` bounds on the ECS service are not arbitrary. They encode a capacity decision: the minimum ensures HA across three AZs, the maximum prevents a traffic spike from generating a $50,000 AWS bill in one hour. At staff level, you define how these bounds are determined (load test data, historical peak traffic, budget constraints) and encode that decision rationale in the module documentation so future engineers do not change them without understanding the implications.
