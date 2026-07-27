# ScopeCash AI — Terraform GCP module
#
# Provisions the real GCP infrastructure the application code in
# server/lib/{vertex-ai,storage,cloud-tasks,secret-manager}.js is already
# written against: Cloud Run (single service, SERVE_DASHBOARD=1 — see
# DEPLOY.md), Cloud SQL Postgres (private IP), Cloud Storage (evidence
# uploads), Cloud Tasks (async job queue), Secret Manager (secret
# *containers* only — see the note on secret_ids below), Artifact
# Registry, Vertex AI API access, and a least-privilege service account
# binding all of it together.
#
# This is a starting skeleton, same scope/intent as deploy/terraform/main.tf
# (the AWS module it sits alongside) — review for production hardening
# (customer-managed encryption keys, VPC Service Controls, Binary
# Authorization, org-policy constraints) before relying on it as-is.
#
# NOT deployed or billed for by the agent that authored this — no live GCP
# project was available in that session. Written directly against this
# repo's actual GCP integration code (env var names verified against
# server/lib/*.js), not generated from a generic template, but the actual
# `terraform apply` path is unverified. Run `terraform plan` and read it
# carefully before `apply`.

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.10" }
  }
}

variable "project_id"  { type = string }
variable "region"      { type = string  default = "us-central1" }
variable "environment" { type = string  default = "prod" }
variable "name"        { type = string  default = "scopecash-ai" }
variable "db_password" { type = string  sensitive = true }
variable "container_image" {
  type        = string
  description = "Full image ref (Artifact Registry path) to deploy to Cloud Run. Push one before first apply — Cloud Run needs an existing image to create the service against."
  default     = null
}
variable "cloud_sql_iam_auth" {
  type        = bool
  description = <<-EOT
    Provision Cloud SQL automatic IAM database authentication for the Cloud
    Run runtime service account (no static DB password) alongside the
    existing password-based `app` user. Additive and off by default so
    existing deployments are undisturbed by upgrading this module.
    Application-side wiring (lib/prisma.js#createPrismaClientWithIamAuth /
    lib/cloud-sql-connector.js) exists and is unit-tested but is NOT yet
    invoked from index.js's default boot path — see TODO.md. Setting this
    to true provisions the IAM identity + grants only; DATABASE_URL still
    uses the password-based user until that follow-up lands.
  EOT
  default     = false
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  labels = { platform = var.name, environment = var.environment, managed-by = "terraform" }
}

# --- Required APIs -------------------------------------------------------
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudtasks.googleapis.com",
    "aiplatform.googleapis.com",
    "storage.googleapis.com",
    "artifactregistry.googleapis.com",
    "vpcaccess.googleapis.com",
    "servicenetworking.googleapis.com",
    "compute.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

# --- Networking (private IP path to Cloud SQL) ----------------------------
resource "google_compute_network" "vpc" {
  name                    = "${var.name}-${var.environment}"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "subnet" {
  name          = "${var.name}-${var.environment}"
  ip_cidr_range = "10.60.0.0/24"
  region        = var.region
  network       = google_compute_network.vpc.id
}

resource "google_compute_global_address" "private_ip_range" {
  name          = "${var.name}-${var.environment}-sql-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_range.name]
}

resource "google_vpc_access_connector" "connector" {
  name          = "${var.name}-${substr(var.environment, 0, 6)}-vpc"
  region        = var.region
  network       = google_compute_network.vpc.name
  ip_cidr_range = "10.60.1.0/28"
  depends_on    = [google_project_service.apis]
}

# --- Cloud SQL (Postgres 16, private IP) ----------------------------------
resource "google_sql_database_instance" "postgres" {
  name                = "${var.name}-${var.environment}"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = var.environment == "prod"
  depends_on          = [google_service_networking_connection.private_vpc_connection]

  settings {
    tier              = var.environment == "prod" ? "db-custom-2-8192" : "db-f1-micro"
    availability_type = var.environment == "prod" ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true
    disk_size         = 20

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = var.environment == "prod"
      transaction_log_retention_days = 7
      backup_retention_settings { retained_backups = 14 }
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
    }

    database_flags { name = "cloudsql.iam_authentication" value = "on" } # required for var.cloud_sql_iam_auth's google_sql_user.app_iam below — see TODO.md
  }
}

resource "google_sql_database" "app" {
  name     = replace(var.name, "-", "_")
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "app" {
  name     = "app"
  instance = google_sql_database_instance.postgres.name
  password = var.db_password
}

# Cloud SQL automatic IAM database authentication for the Cloud Run runtime
# service account — no static DB password for this identity at all, only a
# short-lived OAuth2 token + mTLS cert the connector mints and rotates. Per
# Cloud SQL's own convention, a service account's Postgres IAM username is
# its email WITHOUT the ".gserviceaccount.com" suffix (google_service_account
# .run_sa.email is "<id>@<project>.iam.gserviceaccount.com"; the effective
# Postgres role name in the database_flags = "on" instance above is
# "<id>@<project>.iam" — see lib/cloud-sql-connector.js).
resource "google_sql_user" "app_iam" {
  count    = var.cloud_sql_iam_auth ? 1 : 0
  name     = replace(google_service_account.run_sa.email, ".gserviceaccount.com", "")
  instance = google_sql_database_instance.postgres.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

# --- Cloud Storage (evidence uploads — STORAGE_DRIVER=gcs, STORAGE_BUCKET) --
resource "google_storage_bucket" "uploads" {
  name                        = "${var.name}-${var.environment}-uploads"
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  versioning { enabled = true }
  public_access_prevention = "enforced"

  lifecycle_rule {
    condition { age = 1 }
    action    { type = "AbortIncompleteMultipartUpload" }
  }
}

# --- Cloud Tasks (CLOUD_TASKS_QUEUE) --------------------------------------
resource "google_cloud_tasks_queue" "jobs" {
  name     = "scopecash-jobs"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 20
    max_dispatches_per_second = 10
  }
  retry_config {
    max_attempts = 8
    min_backoff  = "5s"
    max_backoff  = "600s"
    max_doublings = 5
  }
  depends_on = [google_project_service.apis]
}

# --- Artifact Registry (container images) ---------------------------------
resource "google_artifact_registry_repository" "containers" {
  repository_id = var.name
  location      = var.region
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

# --- Secret Manager — secret CONTAINERS ONLY ------------------------------
# Deliberately does not create secret_version resources: a secret value set
# via Terraform lives in tfstate in plaintext, defeating the point of using
# Secret Manager. Populate real values out-of-band and out of source
# control, e.g.:
#   echo -n "$(openssl rand -hex 48)" | gcloud secrets versions add \
#     scopecash-ai-prod-jwt-secret --data-file=-
locals {
  secret_ids = [
    "jwt-secret", "encryption-key", "encryption-search-key",
    "stripe-secret-key", "stripe-webhook-secret",
    "resend-api-key", "sendgrid-api-key", "sentry-dsn",
  ]
}
resource "google_secret_manager_secret" "app_secrets" {
  for_each  = toset(local.secret_ids)
  secret_id = "${var.name}-${var.environment}-${each.key}"
  replication { auto {} }
  depends_on = [google_project_service.apis]
}

# --- Service account (least privilege for the Cloud Run service) ----------
resource "google_service_account" "run_sa" {
  account_id   = "${var.name}-${substr(var.environment, 0, 8)}-run"
  display_name = "ScopeCash AI Cloud Run runtime (${var.environment})"
}

resource "google_project_iam_member" "run_sa_roles" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/cloudtasks.enqueuer",
    "roles/secretmanager.secretAccessor",
    "roles/aiplatform.user",
  ])
  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.run_sa.email}"
}

# roles/cloudsql.client (above) lets the runtime open a Cloud SQL connection
# at all; automatic IAM DB authentication additionally requires this role to
# actually log in as the IAM database user provisioned by google_sql_user.app_iam.
resource "google_project_iam_member" "run_sa_cloudsql_instance_user" {
  count   = var.cloud_sql_iam_auth ? 1 : 0
  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${google_service_account.run_sa.email}"
}

resource "google_storage_bucket_iam_member" "run_sa_uploads" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.run_sa.email}"
}

# The Cloud Tasks push target (routes/jobs.js) verifies an OIDC token minted
# by this same service account — CLOUD_TASKS_INVOKER_SA in the Cloud Run env.
resource "google_service_account_iam_member" "run_sa_self_token_creator" {
  service_account_id = google_service_account.run_sa.name
  role                = "roles/iam.serviceAccountTokenCreator"
  member              = "serviceAccount:${google_service_account.run_sa.email}"
}

# --- Cloud Run service ------------------------------------------------------
# Single combined service (SERVE_DASHBOARD=1) matching DEPLOY.md's manual
# `gcloud run deploy` instructions — this resource is the IaC equivalent of
# that command, not an additional deployment path.
resource "google_cloud_run_v2_service" "app" {
  count    = var.container_image == null ? 0 : 1
  name     = "${var.name}-${var.environment}"
  location = var.region
  labels   = local.labels

  template {
    service_account = google_service_account.run_sa.email
    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.container_image
      ports { container_port = 8080 }

      env { name = "NODE_ENV"        value = "production" }
      env { name = "SERVE_DASHBOARD" value = "1" }
      env { name = "AI_PROVIDER"     value = "gemini" }
      env { name = "GCP_PROJECT_ID"  value = var.project_id }
      env { name = "GCP_LOCATION"    value = var.region }
      env { name = "STORAGE_DRIVER"  value = "gcs" }
      env { name = "STORAGE_BUCKET"  value = google_storage_bucket.uploads.name }
      env { name = "CLOUD_TASKS_QUEUE"      value = google_cloud_tasks_queue.jobs.name }
      env { name = "CLOUD_TASKS_INVOKER_SA" value = google_service_account.run_sa.email }
      env {
        name  = "DATABASE_URL"
        value = "postgresql://${google_sql_user.app.name}:${var.db_password}@localhost/${google_sql_database.app.name}?host=/cloudsql/${google_sql_database_instance.postgres.connection_name}"
      }
      # Provisions the IAM identity + grants only (google_sql_user.app_iam,
      # run_sa_cloudsql_instance_user above) — DATABASE_URL still uses the
      # password-based user regardless of this flag until
      # lib/prisma.js#createPrismaClientWithIamAuth is actually wired into
      # index.js's boot sequence (see that function's header comment and
      # TODO.md). These env vars are what that follow-up will read.
      dynamic "env" {
        for_each = var.cloud_sql_iam_auth ? [1] : []
        content {
          name  = "CLOUD_SQL_IAM_AUTH"
          value = "1"
        }
      }
      dynamic "env" {
        for_each = var.cloud_sql_iam_auth ? [1] : []
        content {
          name  = "CLOUD_SQL_CONNECTION_NAME"
          value = google_sql_database_instance.postgres.connection_name
        }
      }
      dynamic "env" {
        for_each = var.cloud_sql_iam_auth ? [1] : []
        content {
          name  = "CLOUD_SQL_IAM_USER"
          value = google_sql_user.app_iam[0].name
        }
      }
      # VERTEX_GEMINI_MODEL / VERTEX_GEMINI_PRO_MODEL are deliberately NOT
      # set here — lib/vertex-ai.js refuses to start with an unpinned or
      # "-latest" model id by design (see that file's header comment). Set
      # a real, dated model id explicitly per deployment, not via a default
      # baked into this module.
      dynamic "env" {
        for_each = local.secret_ids
        content {
          name = upper(replace(env.value, "-", "_"))
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app_secrets[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }

    scaling {
      min_instance_count = var.environment == "prod" ? 1 : 0
      max_instance_count = 10
    }
  }

  depends_on = concat(
    [google_project_iam_member.run_sa_roles, google_storage_bucket_iam_member.run_sa_uploads],
    var.cloud_sql_iam_auth ? [google_project_iam_member.run_sa_cloudsql_instance_user[0], google_sql_user.app_iam[0]] : [],
  )
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count    = var.container_image == null ? 0 : 1
  location = google_cloud_run_v2_service.app[0].location
  name     = google_cloud_run_v2_service.app[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Outputs ---------------------------------------------------------------
output "cloud_run_url" {
  value = var.container_image == null ? null : google_cloud_run_v2_service.app[0].uri
}
output "cloud_sql_connection_name" { value = google_sql_database_instance.postgres.connection_name }
output "uploads_bucket"            { value = google_storage_bucket.uploads.name }
output "artifact_registry_repo"    { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.containers.repository_id}" }
output "cloud_tasks_queue"         { value = google_cloud_tasks_queue.jobs.name }
output "run_service_account"       { value = google_service_account.run_sa.email }
output "cloud_sql_iam_user"        { value = var.cloud_sql_iam_auth ? google_sql_user.app_iam[0].name : null }
