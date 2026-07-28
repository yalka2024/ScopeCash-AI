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
# Verification status — read before relying on this:
#   `terraform fmt`, `terraform init` and `terraform validate` all PASS
#   against the real hashicorp/google v6.10 provider schema (2026-07-27).
#   Until then this module had never been run through the Terraform CLI at
#   all, only hand-checked, and it did not parse: five `variable` blocks and
#   thirteen `env`/`database_flags` blocks put two arguments on a single line
#   (HCL allows one), and `depends_on` used concat() where a static list is
#   required. None of it could ever have been applied.
#
#   `terraform plan` and `apply` are still UNVERIFIED — both need real GCP
#   credentials and a live project, which no authoring session has had.
#   validate checks syntax, provider schema, and reference integrity; it does
#   NOT check quotas, IAM permissions, API enablement, or resource-name
#   collisions. Run `terraform plan` and read it carefully before `apply`.

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.10" }
  }
}

variable "project_id" { type = string }
# HCL allows at most ONE argument in a single-line block, so these four cannot
# be collapsed onto one line each — with a second argument the file does not
# parse at all ("Invalid single-argument block definition"), which is what
# `terraform fmt`/`validate` reported the first time they were run against
# this module.
variable "region" {
  type    = string
  default = "us-central1"
}
variable "environment" {
  type    = string
  default = "prod"
}
variable "name" {
  type    = string
  default = "scopecash-ai"
}
variable "db_password" {
  type      = string
  sensitive = true
}
variable "container_image" {
  type        = string
  description = "Full image ref (Artifact Registry path) to deploy to Cloud Run. Push one before first apply — Cloud Run needs an existing image to create the service against."
  default     = null
}
variable "public_base_url" {
  type        = string
  description = <<-EOT
    Externally reachable base URL of the deployed service, e.g.
    "https://api.example.com" or the Cloud Run URL after the first apply.

    This exists to enable Cloud Tasks. lib/evidence-jobs.js only uses the
    queue when JOBS_BACKEND=cloud-tasks AND CLOUD_TASKS_PUSH_URL is set;
    otherwise it silently falls back to in-process setImmediate, where a job
    in flight is lost on any instance restart — which on Cloud Run happens
    routinely at scale-to-zero. The module provisioned the queue and set
    CLOUD_TASKS_QUEUE but never set those two, so the queue was billed and
    idle while every job ran in-process.

    It cannot be derived automatically: the push URL is the service's own
    URL, and referencing google_cloud_run_v2_service.app.uri from inside that
    same resource is a dependency cycle. So this is a two-step: apply once
    with this null, read the `cloud_run_url` output, then set it and apply
    again (or set it to a custom domain up front).

    Left null, behaviour is exactly as before — in-process jobs — so this is
    additive and safe to ignore for a dev deployment.
  EOT
  default     = null
}

variable "cloud_sql_iam_auth" {
  type        = bool
  description = <<-EOT
    Provision Cloud SQL automatic IAM database authentication for the Cloud
    Run runtime service account (no static DB password) alongside the
    existing password-based `app` user. Additive and off by default so
    existing deployments are undisturbed by upgrading this module.
    Application-side wiring is now live: index.js awaits
    lib/prisma.js#initCloudSqlIamAuth() before accepting traffic, which
    swaps in the IAM-authenticated client. Setting this variable provisions
    the IAM identity and grants; the application also needs
    CLOUD_SQL_IAM_AUTH=1 plus CLOUD_SQL_INSTANCE / CLOUD_SQL_IAM_USER /
    CLOUD_SQL_DATABASE (see server/.env.example) to actually use it —
    otherwise it keeps using the password-based `app` user.
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
    "monitoring.googleapis.com",
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

    # required for var.cloud_sql_iam_auth's google_sql_user.app_iam below
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
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
    action { type = "AbortIncompleteMultipartUpload" }
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
    max_attempts  = 8
    min_backoff   = "5s"
    max_backoff   = "600s"
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
  # Pinned to var.region, NOT `replication { auto {} }` — every other
  # resource in this module (Cloud SQL, GCS, Cloud Tasks, Cloud Run,
  # Vertex AI via GCP_LOCATION) already respects the chosen region, but
  # Secret Manager's `auto {}` mode hands region selection to Google's own
  # multi-region replication policy, entirely decoupled from `var.region`.
  # A deployment picking a specific region for data-residency reasons (see
  # ropa-template.md's "region configurable per deployment" claim) would
  # have every credential silently replicated outside it regardless.
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
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
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.run_sa.email}"
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

      env {

        name = "NODE_ENV"

        value = "production"

      }
      env {
        name  = "SERVE_DASHBOARD"
        value = "1"
      }
      env {
        # @node-rs/bcrypt's async hash/compare runs on libuv's threadpool
        name  = "AI_PROVIDER"
        value = "gemini"
      }
      # (default size 4) -- found via load testing (see TODO.md "Perf/
      # load/soak testing") that this becomes the throughput ceiling under
      # sustained concurrent login traffic. Documenting this in
      # server/.env.example alone isn't enough for a real deployment to
      # benefit from it -- has to actually be set where the container
      # boots.
      env {
        name  = "UV_THREADPOOL_SIZE"
        value = "16"
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        # Drives the public trust portal's data_residency claim
        name  = "GCP_LOCATION"
        value = var.region
      }
      # (lib/trust-pack.js) so it reflects whatever region this deployment
      # was actually applied with, instead of a hardcoded, possibly-false
      # value. Passes var.region through as-is (e.g. "us-central1") rather
      # than bucketing it into a coarse "US"/"EU" label — an earlier
      # version of this tried `startswith(var.region, "europe-") ? "EU" :
      # "US"`, which silently mapped every Asia/Australia/South America
      # region to "US" too, producing exactly the kind of false public
      # compliance claim this change exists to prevent. A real GCP region
      # code is unambiguous and still meaningful to a vendor-risk reviewer.
      env {
        name  = "DATA_RESIDENCY_REGION"
        value = var.region
      }
      env {
        name  = "STORAGE_DRIVER"
        value = "gcs"
      }
      env {
        name  = "STORAGE_BUCKET"
        value = google_storage_bucket.uploads.name
      }
      env {
        name  = "CLOUD_TASKS_QUEUE"
        value = google_cloud_tasks_queue.jobs.name
      }
      env {
        name  = "CLOUD_TASKS_INVOKER_SA"
        value = google_service_account.run_sa.email
      }
      env {
        # Provisions the IAM identity + grants only (google_sql_user.app_iam,
        name  = "DATABASE_URL"
        value = "postgresql://${google_sql_user.app.name}:${var.db_password}@localhost/${google_sql_database.app.name}?host=/cloudsql/${google_sql_database_instance.postgres.connection_name}"
      }
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
      # Cloud Tasks is only actually used when BOTH of these are present —
      # see var.public_base_url for why the queue was otherwise provisioned
      # but never reached. Gated on the variable so leaving it null preserves
      # the previous in-process behaviour rather than half-enabling the queue.
      dynamic "env" {
        for_each = var.public_base_url == null ? [] : [1]
        content {
          name  = "JOBS_BACKEND"
          value = "cloud-tasks"
        }
      }
      dynamic "env" {
        for_each = var.public_base_url == null ? [] : [1]
        content {
          name = "CLOUD_TASKS_PUSH_URL"
          # routes/jobs.js's push receiver; verified against the route mount
          # in index.js, not guessed.
          value = "${var.public_base_url}/api/jobs/process-task"
        }
      }
      # Required by lib/prisma.js#initCloudSqlIamAuth, which fails closed.
      # Without it the app would set CLOUD_SQL_IAM_AUTH=1 and then have no
      # database name to connect to, crash-looping the service on boot the
      # first time this feature was enabled. Must match google_sql_database.app.
      dynamic "env" {
        for_each = var.cloud_sql_iam_auth ? [1] : []
        content {
          name  = "CLOUD_SQL_DATABASE"
          value = google_sql_database.app.name
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

  # depends_on takes a STATIC list of references — Terraform builds the
  # dependency graph before evaluating expressions, so concat()/conditionals
  # here are a parse error ("A static list expression is required"). The two
  # IAM-auth resources are count-gated; referencing them WITHOUT an index
  # means "all instances of this resource", which is correctly zero when
  # var.cloud_sql_iam_auth is false. Same behaviour as the concat, and valid.
  depends_on = [
    google_project_iam_member.run_sa_roles,
    google_storage_bucket_iam_member.run_sa_uploads,
    google_project_iam_member.run_sa_cloudsql_instance_user,
    google_sql_user.app_iam,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count    = var.container_image == null ? 0 : 1
  location = google_cloud_run_v2_service.app[0].location
  name     = google_cloud_run_v2_service.app[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Cloud Monitoring: log-based metrics, alerts, SLO -----------------------
# Previously the module provisioned infrastructure with no observability on it
# at all: no alert policies, no log-based metrics, no notification channel and
# no SLO, so nothing would have told anyone the service was failing.
#
# The two log-based metrics below extract from the fields the app really emits
# (server/lib/gcp-logging.js): `severity` on every line, and `jsonPayload.type`
# for the specific events worth counting. They are only meaningful because that
# module sets severity — without it every line is DEFAULT and these match zero.

variable "alert_email" {
  type        = string
  description = "Address to send monitoring alerts to. No notification channel or alert policy is created when this is null, so the module stays usable without one."
  default     = null
}

resource "google_monitoring_notification_channel" "email" {
  count        = var.alert_email == null ? 0 : 1
  display_name = "${var.name}-${var.environment} alerts"
  type         = "email"
  labels       = { email_address = var.alert_email }
}

# 5xx responses, counted from the access log's own severity.
resource "google_logging_metric" "server_errors" {
  name   = "${var.name}-${var.environment}-server-errors"
  filter = <<-EOT
    resource.type="cloud_run_revision"
    jsonPayload.type="http"
    jsonPayload.status>=500
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# Requests rejected for exceeding a plan quota. Not an outage — a product
# signal (customers hitting limits) that is easy to miss without a metric.
resource "google_logging_metric" "quota_rejections" {
  name = "${var.name}-${var.environment}-quota-rejections"
  # Matches the ACCESS log (type="http"), not the error log. The 402s this is
  # meant to count never produce a type="error" line: lib/validate.js returns
  # HttpError responses before its logging call, and the api-call/ai-token
  # quota 402s are returned directly from middleware/tenant.js and
  # lib/ai-budget.js without logging at all. Filtering on type="error" — as
  # this did when first written — would have read zero forever while looking
  # like working instrumentation.
  filter = <<-EOT
    resource.type="cloud_run_revision"
    jsonPayload.type="http"
    jsonPayload.status=402
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "server_errors" {
  count        = var.alert_email == null ? 0 : 1
  display_name = "${var.name}-${var.environment}: elevated 5xx rate"
  combiner     = "OR"
  conditions {
    display_name = "5xx responses > 5 in 5 minutes"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.server_errors.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.email[0].id]
  documentation {
    content = "Cloud Run is returning 5xx. Check the Logs Explorer for jsonPayload.type=\"error\" with severity=ERROR; each entry carries a requestId and a Cloud Trace link."
  }
}

resource "google_monitoring_alert_policy" "request_latency" {
  count        = var.alert_email == null ? 0 : 1
  display_name = "${var.name}-${var.environment}: p95 request latency"
  combiner     = "OR"
  conditions {
    display_name = "p95 latency > 2s for 5 minutes"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_latencies\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2000
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_PERCENTILE_95"
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.email[0].id]
}

resource "google_monitoring_alert_policy" "cloud_sql_disk" {
  count        = var.alert_email == null ? 0 : 1
  display_name = "${var.name}-${var.environment}: Cloud SQL disk utilization"
  combiner     = "OR"
  conditions {
    display_name = "Disk > 85% for 15 minutes"
    condition_threshold {
      filter          = "resource.type=\"cloudsql_database\" AND metric.type=\"cloudsql.googleapis.com/database/disk/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      duration        = "900s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.email[0].id]
  documentation {
    content = "disk_autoresize is on, so this is a cost/throttling warning rather than an imminent outage — but investigate growth before it compounds."
  }
}

# Availability SLO (99.9% of requests non-5xx over 28 days). Cloud Run's own
# request metrics back this, so it needs no application change. Gated on the
# service existing, which itself depends on var.container_image.
resource "google_monitoring_slo" "availability" {
  count               = var.container_image == null ? 0 : 1
  service             = google_monitoring_custom_service.app[0].service_id
  slo_id              = "${var.name}-${var.environment}-availability"
  display_name        = "99.9% of requests succeed (28d rolling)"
  goal                = 0.999
  rolling_period_days = 28

  request_based_sli {
    good_total_ratio {
      total_service_filter = "resource.type=\"cloud_run_revision\" metric.type=\"run.googleapis.com/request_count\""
      good_service_filter  = "resource.type=\"cloud_run_revision\" metric.type=\"run.googleapis.com/request_count\" metric.label.\"response_code_class\"!=\"5xx\""
    }
  }
}

resource "google_monitoring_custom_service" "app" {
  count        = var.container_image == null ? 0 : 1
  service_id   = "${var.name}-${var.environment}"
  display_name = "${var.name} (${var.environment})"
}

# --- Outputs ---------------------------------------------------------------
output "cloud_run_url" {
  value = var.container_image == null ? null : google_cloud_run_v2_service.app[0].uri
}
output "cloud_sql_connection_name" { value = google_sql_database_instance.postgres.connection_name }
output "uploads_bucket" { value = google_storage_bucket.uploads.name }
output "artifact_registry_repo" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.containers.repository_id}" }
output "cloud_tasks_queue" { value = google_cloud_tasks_queue.jobs.name }
output "run_service_account" { value = google_service_account.run_sa.email }
output "cloud_sql_iam_user" { value = var.cloud_sql_iam_auth ? google_sql_user.app_iam[0].name : null }
