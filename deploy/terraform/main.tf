# ScopeCash AI — Terraform AWS module
# Provisions: VPC, RDS Postgres 16, ElastiCache Redis 7, S3 (uploads), ECR repos.
# This is a starting skeleton — review for production hardening (KMS, IAM, backups, MFA delete).

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
}

variable "name"        { type = string default = "scopecash-ai" }
variable "region"      { type = string default = "us-east-1" }
variable "environment" { type = string default = "prod" }
variable "vpc_cidr"    { type = string default = "10.40.0.0/16" }
variable "db_password" { type = string sensitive = true }

provider "aws" {
  region = var.region
  default_tags { tags = { Platform = var.name, Environment = var.environment, ManagedBy = "terraform" } }
}

locals {
  azs = ["${var.region}a", "${var.region}b", "${var.region}c"]
}

# --- VPC ---------------------------------------------------------------
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.13"

  name = "${var.name}-${var.environment}"
  cidr = var.vpc_cidr
  azs  = local.azs

  private_subnets = ["10.40.1.0/24", "10.40.2.0/24", "10.40.3.0/24"]
  public_subnets  = ["10.40.101.0/24", "10.40.102.0/24", "10.40.103.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = true
  enable_dns_hostnames = true
}

# --- RDS Postgres ------------------------------------------------------
resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-${var.environment}"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "rds" {
  name   = "${var.name}-${var.environment}-rds"
  vpc_id = module.vpc.vpc_id
  ingress { from_port = 5432 to_port = 5432 protocol = "tcp" cidr_blocks = [var.vpc_cidr] }
  egress  { from_port = 0    to_port = 0    protocol = "-1"  cidr_blocks = ["0.0.0.0/0"] }
}

resource "aws_db_instance" "postgres" {
  identifier              = "${var.name}-${var.environment}"
  engine                  = "postgres"
  engine_version          = "16.4"
  instance_class          = "db.t4g.medium"
  allocated_storage       = 50
  max_allocated_storage   = 500
  storage_encrypted       = true
  db_name                 = replace(var.name, "-", "_")
  username                = "app"
  password                = var.db_password
  db_subnet_group_name    = aws_db_subnet_group.this.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  backup_retention_period = 14
  deletion_protection     = true
  performance_insights_enabled = true
  multi_az                = var.environment == "prod"
  skip_final_snapshot     = false
  final_snapshot_identifier = "${var.name}-${var.environment}-final"
}

# --- ElastiCache Redis -------------------------------------------------
resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-${var.environment}"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "redis" {
  name   = "${var.name}-${var.environment}-redis"
  vpc_id = module.vpc.vpc_id
  ingress { from_port = 6379 to_port = 6379 protocol = "tcp" cidr_blocks = [var.vpc_cidr] }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = "${var.name}-${var.environment}"
  description                = "ScopeCash AI cache + queue"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.t4g.small"
  num_cache_clusters         = var.environment == "prod" ? 2 : 1
  automatic_failover_enabled = var.environment == "prod"
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]
}

# --- S3 (uploads) ------------------------------------------------------
resource "aws_s3_bucket" "uploads" {
  bucket = "${var.name}-${var.environment}-uploads"
}

resource "aws_s3_bucket_versioning" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "AES256" } }
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- ECR ---------------------------------------------------------------
resource "aws_ecr_repository" "server" {
  name                 = "${var.name}/server"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_repository" "dashboard" {
  name                 = "${var.name}/dashboard"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

# --- Outputs -----------------------------------------------------------
output "database_url"      { value = "postgresql://${aws_db_instance.postgres.username}@${aws_db_instance.postgres.endpoint}/${aws_db_instance.postgres.db_name}" sensitive = true }
output "redis_url"         { value = "rediss://${aws_elasticache_replication_group.this.primary_endpoint_address}:6379" sensitive = true }
output "uploads_bucket"    { value = aws_s3_bucket.uploads.bucket }
output "ecr_server_url"    { value = aws_ecr_repository.server.repository_url }
output "ecr_dashboard_url" { value = aws_ecr_repository.dashboard.repository_url }

