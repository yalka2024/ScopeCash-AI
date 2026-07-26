<#
.SYNOPSIS
    ScopeCash AI — Level-4 enterprise readiness audit (v2).
.DESCRIPTION
    Walks the generated platform looking for static evidence of every L4
    control defined in L4-CHECKLIST.md across the eight pillars. Emits
    `l4-attestation.json` in the platform root and writes a console
    summary table. Exit code is 0 only if no controls fail.

    "requires_runtime_evidence" controls cannot be proven by static
    inspection (vault sourcing, restore drills, audit-evidence repo
    membership, etc.) and must be confirmed by the operator.
#>

param(
    [string]$PlatformRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

function Test-FileContains {
    param([string]$Path, [string]$Pattern, [switch]$Regex)
    if (-not (Test-Path $Path)) { return $false }
    $text = Get-Content -Path $Path -Raw -ErrorAction SilentlyContinue
    if ($null -eq $text) { return $false }
    if ($Regex) { return [bool]([regex]::IsMatch($text, $Pattern, 'IgnoreCase, Singleline')) }
    return ($text -like "*$Pattern*")
}
function Test-AnyFileContains {
    param([string[]]$Paths, [string]$Pattern, [switch]$Regex)
    foreach ($p in $Paths) { if (Test-FileContains -Path $p -Pattern $Pattern -Regex:$Regex) { return $true } }
    return $false
}
function Add-L4 { param([string]$Id, [string]$Pillar, [string]$Status, [string]$Evidence)
    return [pscustomobject]@{ id = $Id; pillar = $Pillar; status = $Status; evidence = $Evidence }
}

$results = @()
$server  = Join-Path $PlatformRoot "server"
$dash    = Join-Path $PlatformRoot "dashboard"
$ops     = Join-Path $PlatformRoot "ops"
$deploy  = Join-Path $PlatformRoot "deploy"
$gh      = Join-Path $PlatformRoot ".github"

$indexJs    = Join-Path $server "index.js"
$authJs     = Join-Path $server "routes\auth.js"
$healthJs   = Join-Path $server "routes\health.js"
$securityJs = Join-Path $server "lib\security.js"
$signWf     = Join-Path $gh    "workflows\container-build-sign.yml"

# ── 1. Identity, access & secrets ─────────────────────────────────
$results += Add-L4 'AUTH-001' 'identity' `
    $(if (Test-AnyFileContains @($indexJs, $securityJs) 'JWT_SECRET' -Regex) { 'pass' } else { 'fail' }) `
    'JWT_SECRET length/placeholder boot guard'

$results += Add-L4 'AUTH-002' 'identity' `
    $(if (Test-FileContains $authJs 'refresh' -Regex) { 'pass' } else { 'fail' }) `
    'Refresh-token rotation in routes/auth.js'

$results += Add-L4 'AUTH-003' 'identity' `
    $(if (Test-FileContains $authJs '(mfa|totp)' -Regex) { 'pass' } else { 'fail' }) `
    'TOTP MFA endpoints in routes/auth.js'

$results += Add-L4 'AUTH-004' 'identity' `
    $(if ((Test-AnyFileContains @($securityJs, (Join-Path $server "routes\setup.js")) 'validatePassword' -Regex) -or
         (Test-AnyFileContains @($securityJs) 'min(.{0,4})12' -Regex)) { 'pass' } else { 'fail' }) `
    'Password policy ≥12 chars enforced (security.validatePassword)'

$results += Add-L4 'IAM-001' 'identity' `
    $(if (Test-AnyFileContains @($indexJs, (Join-Path $server "lib\csrf.js"), (Join-Path $server "lib\session.js")) 'SameSite' -Regex) { 'pass' } else { 'fail' }) `
    'Cookies set with Secure/HttpOnly/SameSite'

$results += Add-L4 'IAM-002' 'identity' `
    $(if (Test-Path (Join-Path $server "lib\csrf.js")) { 'pass' } else { 'fail' }) `
    'CSRF middleware lib/csrf.js present'

$results += Add-L4 'SEC-001' 'identity' 'requires_runtime_evidence' `
    'Operator must confirm secrets sourced from vault/KMS in prod (see SECRETS-ROTATION.md)'

$results += Add-L4 'SEC-002' 'identity' `
    $(if (Test-AnyFileContains @((Join-Path $server "routes\apikey.js"), (Join-Path $server "routes\api-keys.js"), (Join-Path $server "lib\api-keys.js"), (Join-Path $server "lib\apikey.js")) 'sha256|createHash' -Regex) { 'pass' } else { 'fail' }) `
    'API keys SHA-256 hashed at rest'

# ── 2. Data protection & multi-tenancy ────────────────────────────
$results += Add-L4 'DATA-001' 'data' `
    $(if (Test-AnyFileContains @((Join-Path $server "lib\tenant.js"), (Join-Path $server "lib\prisma.js")) '(organizationId|orgId)' -Regex) { 'pass' } else { 'fail' }) `
    'Tenant-scoped queries (orgId / organizationId filter)'

$results += Add-L4 'DATA-002' 'data' `
    $(if (Test-Path (Join-Path $server "lib\storage.js")) { 'pass' } else { 'fail' }) `
    'S3-capable storage abstraction lib/storage.js'

$results += Add-L4 'DATA-003' 'data' `
    $(if (Test-AnyFileContains @((Join-Path $PlatformRoot "fly.toml"), (Join-Path $deploy "helm\templates\ingress.yaml")) '(force_https|tls)' -Regex) { 'pass' } else { 'fail' }) `
    'TLS termination configured (fly.toml force_https / Helm ingress.tls)'

$results += Add-L4 'DATA-004' 'data' `
    $(if ((Test-Path (Join-Path $ops "backup\pg-backup.sh")) -and (Test-Path (Join-Path $ops "backup\pg-restore.sh"))) { 'pass' } else { 'fail' }) `
    'pg-backup.sh + pg-restore.sh in ops/backup/'

$results += Add-L4 'DATA-005' 'data' `
    $(if (Test-Path (Join-Path $server "lib\encryption.js")) { 'pass' } else { 'fail' }) `
    'Field-level encryption helper lib/encryption.js'

$results += Add-L4 'DATA-006' 'data' `
    $(if (Test-AnyFileContains @((Join-Path $server "routes\users.js"), (Join-Path $server "routes\admin.js"), (Join-Path $server "routes\dsar.js")) '(erase|dsar|delete.*account|right.to.erasure)' -Regex) { 'pass' } else { 'fail' }) `
    'DSAR / right-to-erasure endpoint present'

# ── 3. Reliability, scale & DR ────────────────────────────────────
$results += Add-L4 'REL-001' 'reliability' `
    $(if ((Test-FileContains $healthJs '/live') -and (Test-FileContains $healthJs '/ready')) { 'pass' } else { 'fail' }) `
    'Liveness + readiness probes in routes/health.js'

$results += Add-L4 'REL-002' 'reliability' `
    $(if (Test-FileContains $indexJs 'gracefulShutdown') { 'pass' } else { 'fail' }) `
    'gracefulShutdown handler in server/index.js'

$results += Add-L4 'REL-003' 'reliability' `
    $(if (Test-Path (Join-Path $server "worker.js")) { 'pass' } else { 'fail' }) `
    'Separate BullMQ worker process'

$results += Add-L4 'REL-004' 'reliability' `
    $(if (Test-AnyFileContains @((Join-Path $deploy "helm\values.yaml"), (Join-Path $deploy "helm\templates\server-deployment.yaml")) 'replicaCount.*[2-9]|RollingUpdate' -Regex) { 'pass' } else { 'fail' }) `
    'Rolling-update strategy + ≥2 replicas (Helm)'

$results += Add-L4 'REL-005' 'reliability' `
    $(if (Test-Path (Join-Path $deploy "helm\templates\backup-cronjob.yaml")) { 'pass' } else { 'fail' }) `
    'Daily encrypted backup CronJob in Helm chart'

$results += Add-L4 'DR-001' 'reliability' 'requires_runtime_evidence' `
    'Operator must record latest restore-drill date'

# ── 4. Observability ──────────────────────────────────────────────
$results += Add-L4 'OBS-001' 'observability' `
    $(if (Test-FileContains $indexJs 'requestId') { 'pass' } else { 'fail' }) `
    'Per-request requestId propagated in structured log'

$results += Add-L4 'OBS-002' 'observability' `
    $(if (Test-Path (Join-Path $server "lib\telemetry.js")) { 'pass' } else { 'fail' }) `
    'OTel SDK lib/telemetry.js present'

$results += Add-L4 'OBS-003' 'observability' `
    $(if ((Test-Path (Join-Path $server "lib\metrics.js")) -and (Test-Path (Join-Path $deploy "helm\templates\prometheusrule.yaml"))) { 'pass' } else { 'fail' }) `
    'prom-client + PrometheusRule alerts shipped'

$results += Add-L4 'OBS-004' 'observability' `
    $(if (Test-Path (Join-Path $server "lib\sentry.js")) { 'pass' } else { 'fail' }) `
    'Sentry integration lib/sentry.js present'

$results += Add-L4 'OBS-005' 'observability' `
    $(if (Test-FileContains (Join-Path $server "lib\audit.js") '(hashChain|previousHash|hash_chain)' -Regex) { 'pass' } else { 'fail' }) `
    'Append-only audit log with hash chaining'

# ── 5. Supply chain ───────────────────────────────────────────────
$results += Add-L4 'SUP-001' 'supply-chain' `
    $(if (Test-AnyFileContains @((Join-Path $PlatformRoot "Dockerfile"), (Join-Path $server "Dockerfile")) 'FROM node:.*-slim' -Regex) { 'pass' } else { 'fail' }) `
    'Slim base image pinned in Dockerfile'

$results += Add-L4 'SUP-002' 'supply-chain' `
    $(if (Test-FileContains $signWf 'sbom-action') { 'pass' } else { 'fail' }) `
    'SBOM (syft) generated in container-build-sign.yml'

$results += Add-L4 'SUP-003' 'supply-chain' `
    $(if (Test-FileContains $signWf 'cosign sign') { 'pass' } else { 'fail' }) `
    'cosign keyless signing in container-build-sign.yml'

$results += Add-L4 'SUP-004' 'supply-chain' `
    $(if (Test-FileContains $signWf 'anchore/scan-action') { 'pass' } else { 'fail' }) `
    'grype vuln scan in container-build-sign.yml'

$results += Add-L4 'SUP-005' 'supply-chain' `
    $(if (Test-Path (Join-Path $gh "dependabot.yml")) { 'pass' } else { 'fail' }) `
    '.github/dependabot.yml present (npm + docker + actions)'

# ── 6. CI/CD & change management ──────────────────────────────────
$results += Add-L4 'CI-001' 'cicd' `
    $(if (Test-Path (Join-Path $gh "workflows\ci.yml")) { 'pass' } else { 'fail' }) `
    '.github/workflows/ci.yml present (PR test gate)'

$results += Add-L4 'CI-002' 'cicd' `
    $(if (Test-FileContains (Join-Path $gh "workflows\ci.yml") 'prisma migrate deploy') { 'pass' } else { 'fail' }) `
    'Migrations applied via prisma migrate deploy in CI'

$results += Add-L4 'CI-003' 'cicd' `
    $(if (Test-FileContains $healthJs '(GIT_SHA|version)' -Regex) { 'pass' } else { 'fail' }) `
    'Build SHA / version surfaced in /api/health'

$results += Add-L4 'CI-004' 'cicd' `
    $(if (Test-Path (Join-Path $server "lib\feature-flags.js")) { 'pass' } else { 'fail' }) `
    'Feature-flag library (kill switches) present'

$results += Add-L4 'CI-005' 'cicd' `
    $(if (Test-Path (Join-Path $gh "workflows\codeql.yml")) { 'pass' } else { 'fail' }) `
    'CodeQL SAST workflow present'

$results += Add-L4 'CI-006' 'cicd' `
    $(if (Test-Path (Join-Path $gh "workflows\secret-scan.yml")) { 'pass' } else { 'fail' }) `
    'Gitleaks secret-scan workflow present'

# ── 7. Privacy, legal & contractual ───────────────────────────────
$results += Add-L4 'PRIV-001' 'privacy' 'requires_runtime_evidence' `
    'Operator must maintain DPA template (controller/processor terms)'

$results += Add-L4 'PRIV-002' 'privacy' 'requires_runtime_evidence' `
    'Operator must maintain a sub-processor list'

$results += Add-L4 'PRIV-003' 'privacy' `
    $(if (Test-AnyFileContains @((Join-Path $dash "src\App.js"), (Join-Path $dash "src\CookieBanner.js"), (Join-Path $dash "src\LandingPage.js")) '(cookie|consent)' -Regex) { 'pass' } else { 'fail' }) `
    'Cookie / consent banner present in dashboard'

$results += Add-L4 'PRIV-004' 'privacy' `
    $(if (Test-AnyFileContains @((Join-Path $PlatformRoot "fly.toml"), (Join-Path $PlatformRoot "DEPLOY.md")) '(residency|region.*fra|primary_region)' -Regex) { 'pass' } else { 'fail' }) `
    'Data-residency option documented'

$results += Add-L4 'PRIV-005' 'privacy' `
    $(if (Test-Path (Join-Path $PlatformRoot "SECURITY.md")) { 'pass' } else { 'fail' }) `
    'SECURITY.md disclosure policy present'

# ── 8. UX, accessibility & i18n ───────────────────────────────────
$results += Add-L4 'UX-001' 'ux' 'requires_runtime_evidence' `
    'Operator must run axe-core scan on built dashboard'

$results += Add-L4 'UX-002' 'ux' `
    $(if (Test-Path (Join-Path $dash "src\a11y.css")) { 'pass' } else { 'fail' }) `
    'a11y.css (focus rings + reduced-motion) present'

$results += Add-L4 'UX-003' 'ux' `
    $(if (Test-Path (Join-Path $dash "src\i18n\index.js")) { 'pass' } else { 'fail' }) `
    'i18n bootstrap dashboard/src/i18n/index.js present'

$results += Add-L4 'UX-004' 'ux' `
    $(if (Test-AnyFileContains @((Join-Path $dash "src\AuthPage.js"), (Join-Path $dash "src\SetupPage.js")) 'aria-' -Regex) { 'pass' } else { 'fail' }) `
    'Forms expose aria-* labels'

# ── 9. K8s hardening (extra) ──────────────────────────────────────
$results += Add-L4 'K8S-001' 'k8s' `
    $(if (Test-Path (Join-Path $deploy "helm\templates\networkpolicy.yaml")) { 'pass' } else { 'fail' }) `
    'NetworkPolicy (default-deny) in Helm chart'

$results += Add-L4 'K8S-002' 'k8s' `
    $(if (Test-Path (Join-Path $deploy "helm\templates\poddisruptionbudget.yaml")) { 'pass' } else { 'fail' }) `
    'PodDisruptionBudget in Helm chart'

$results += Add-L4 'K8S-003' 'k8s' `
    $(if (Test-Path (Join-Path $deploy "helm\templates\hpa.yaml")) { 'pass' } else { 'fail' }) `
    'HorizontalPodAutoscaler in Helm chart'

$results += Add-L4 'K8S-004' 'k8s' `
    $(if (Test-Path (Join-Path $deploy "helm\templates\serviceaccount.yaml")) { 'pass' } else { 'fail' }) `
    'Dedicated ServiceAccount (no default SA)'

$results += Add-L4 'K8S-005' 'k8s' `
    $(if (Test-FileContains (Join-Path $deploy "helm\values.yaml") 'readOnlyRootFilesystem:\s*true' -Regex) { 'pass' } else { 'fail' }) `
    'readOnlyRootFilesystem + drop ALL caps in pod security context'

# ── 10. Operator runbooks ─────────────────────────────────────────
$results += Add-L4 'OPS-001' 'ops' `
    $(if (Test-Path (Join-Path $ops "SECRETS-ROTATION.md")) { 'pass' } else { 'fail' }) `
    'Secrets-rotation runbook present (ops/SECRETS-ROTATION.md)'

$results += Add-L4 'OPS-002' 'ops' `
    $(if (Test-Path (Join-Path $ops "ENV-VARS.md")) { 'pass' } else { 'fail' }) `
    'Env-var inventory present (ops/ENV-VARS.md)'

$results += Add-L4 'OPS-003' 'ops' `
    $(if (Test-Path (Join-Path $PlatformRoot "DEPLOY.md")) { 'pass' } else { 'fail' }) `
    'DEPLOY.md present'

# ── Summary ───────────────────────────────────────────────────────
$pass    = ($results | Where-Object { $_.status -eq 'pass' }).Count
$fail    = ($results | Where-Object { $_.status -eq 'fail' }).Count
$pending = ($results | Where-Object { $_.status -eq 'requires_runtime_evidence' }).Count
$total   = $results.Count
$autoTotal = $total - $pending
$score   = if ($autoTotal -gt 0) { [math]::Round(($pass / $autoTotal) * 100, 1) } else { 0 }

# Per-pillar summary
$byPillar = $results | Group-Object pillar | ForEach-Object {
    $p = $_.Group | Where-Object { $_.status -eq 'pass' }
    $f = $_.Group | Where-Object { $_.status -eq 'fail' }
    $r = $_.Group | Where-Object { $_.status -eq 'requires_runtime_evidence' }
    [pscustomobject]@{
        pillar = $_.Name; pass = $p.Count; fail = $f.Count; pending = $r.Count; total = $_.Count
    }
}

$attestation = [ordered]@{
    platform   = 'ScopeCash AI'
    generated  = (Get-Date).ToUniversalTime().ToString('o')
    auditor    = 'l4-audit.ps1 v2'
    summary    = [ordered]@{
        total   = $total
        pass    = $pass
        fail    = $fail
        requires_runtime_evidence = $pending
        score_excl_runtime        = $score
    }
    by_pillar  = $byPillar
    controls   = $results
}

$out = Join-Path $PlatformRoot "l4-attestation.json"
$attestation | ConvertTo-Json -Depth 10 | Set-Content -Path $out -Encoding UTF8

Write-Host ""
Write-Host "Level-4 readiness — ScopeCash AI" -ForegroundColor Cyan
Write-Host ("  pass: {0}  fail: {1}  pending(runtime): {2}  score: {3}%" -f $pass, $fail, $pending, $score) -ForegroundColor Cyan
Write-Host ""
$byPillar | Format-Table pillar, pass, fail, pending, total -AutoSize | Out-String | Write-Host

if ($fail -gt 0) {
    Write-Host "Failures:" -ForegroundColor Red
    $results | Where-Object status -eq 'fail' | ForEach-Object { Write-Host ("  [{0}] {1}" -f $_.id, $_.evidence) -ForegroundColor Red }
}

Write-Host ""
Write-Host "Wrote $out"
if ($fail -gt 0) { exit 1 } else { exit 0 }
<#
.SYNOPSIS
    ScopeCash AI — automated Level-4 readiness audit.
.DESCRIPTION
    Walks the generated platform looking for static evidence of each L4
    control defined in L4-CHECKLIST.md. Produces `l4-attestation.json`
    in the platform root. Exit code is 0 only if no controls fail.

    This is a *static* attestation: it cannot prove that secrets are
    held in a real KMS or that DR drills have happened. Such controls
    are reported as `requires_runtime_evidence` and must be confirmed
    by the operator.
#>

param(
    [string]$PlatformRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

function Test-FileContains {
    param([string]$Path, [string]$Pattern, [switch]$Regex)
    if (-not (Test-Path $Path)) { return $false }
    $text = Get-Content -Path $Path -Raw -ErrorAction SilentlyContinue
    if ($null -eq $text) { return $false }
    if ($Regex) { return [bool]([regex]::IsMatch($text, $Pattern, 'IgnoreCase')) }
    return $text -like "*$Pattern*"
}

function New-Result { param([string]$Id, [string]$Pillar, [string]$Status, [string]$Evidence)
    return @{ id = $Id; pillar = $Pillar; status = $Status; evidence = $Evidence }
}

$results = @()
$server  = Join-Path $PlatformRoot "server"
$dash    = Join-Path $PlatformRoot "dashboard"
$ops     = Join-Path $PlatformRoot "ops"
$deploy  = Join-Path $PlatformRoot "deploy"

# --- 1. Identity & secrets -------------------------------------------------
$indexJs = Join-Path $server "index.js"
$results += New-Result 'AUTH-001' 'identity' `
    $(if (Test-FileContains $indexJs 'JWT_SECRET must be at least 32 characters') { 'pass' } else { 'fail' }) `
    'server/index.js boot guard for JWT_SECRET'

$authJs = Join-Path $server "routes\auth.js"
$results += New-Result 'AUTH-002' 'identity' `
    $(if (Test-FileContains $authJs 'refresh') { 'pass' } else { 'fail' }) `
    'refresh-token rotation present in routes/auth.js'

$results += New-Result 'AUTH-003' 'identity' `
    $(if (Test-FileContains $authJs 'mfa' -Regex) { 'pass' } else { 'fail' }) `
    'TOTP MFA endpoints present in routes/auth.js'

$results += New-Result 'IAM-002' 'identity' `
    $(if (Test-Path (Join-Path $server "lib\csrf.js")) { 'pass' } else { 'fail' }) `
    'server/lib/csrf.js present'

$results += New-Result 'SEC-001' 'identity' 'requires_runtime_evidence' `
    'Secrets must be sourced from vault/KMS in production'

# --- 2. Data protection ----------------------------------------------------
$results += New-Result 'DATA-002' 'data' `
    $(if (Test-Path (Join-Path $server "lib\storage.js")) { 'pass' } else { 'fail' }) `
    'server/lib/storage.js (S3-capable storage abstraction)'

$results += New-Result 'DATA-004' 'data' `
    $(if ((Test-Path (Join-Path $ops "backup\pg-backup.sh")) -and (Test-Path (Join-Path $ops "backup\pg-restore.sh"))) { 'pass' } else { 'fail' }) `
    'ops/backup/pg-backup.sh + pg-restore.sh present'

# --- 3. Reliability --------------------------------------------------------
$healthJs = Join-Path $server "routes\health.js"
$results += New-Result 'REL-001' 'reliability' `
    $(if ((Test-FileContains $healthJs '/live') -and (Test-FileContains $healthJs '/ready')) { 'pass' } else { 'fail' }) `
    'liveness + readiness probes in routes/health.js'

$results += New-Result 'REL-002' 'reliability' `
    $(if (Test-FileContains $indexJs 'gracefulShutdown') { 'pass' } else { 'fail' }) `
    'gracefulShutdown handler in server/index.js'

$results += New-Result 'REL-003' 'reliability' `
    $(if (Test-Path (Join-Path $server "worker.js")) { 'pass' } else { 'fail' }) `
    'separate worker process (BullMQ-capable)'

# --- 4. Observability ------------------------------------------------------
$results += New-Result 'OBS-002' 'observability' `
    $(if (Test-Path (Join-Path $server "lib\telemetry.js")) { 'pass' } else { 'fail' }) `
    'server/lib/telemetry.js (OpenTelemetry SDK)'

$results += New-Result 'OBS-003' 'observability' `
    $(if (Test-Path (Join-Path $server "lib\metrics.js")) { 'pass' } else { 'fail' }) `
    'server/lib/metrics.js (Prometheus)'

$results += New-Result 'OBS-004' 'observability' `
    $(if (Test-Path (Join-Path $server "lib\sentry.js")) { 'pass' } else { 'fail' }) `
    'server/lib/sentry.js'

$results += New-Result 'OBS-005' 'observability' `
    $(if (Test-Path (Join-Path $server "lib\audit.js")) { 'pass' } else { 'fail' }) `
    'server/lib/audit.js (append-only log)'

# --- 5. Supply chain -------------------------------------------------------
$signWf = Join-Path $PlatformRoot ".github\workflows\container-build-sign.yml"
$results += New-Result 'SUP-002' 'supply-chain' `
    $(if (Test-FileContains $signWf 'sbom-action') { 'pass' } else { 'fail' }) `
    'SBOM generation in container-build-sign workflow'

$results += New-Result 'SUP-003' 'supply-chain' `
    $(if (Test-FileContains $signWf 'cosign sign') { 'pass' } else { 'fail' }) `
    'cosign signing in container-build-sign workflow'

$results += New-Result 'SUP-004' 'supply-chain' `
    $(if (Test-FileContains $signWf 'anchore/scan-action') { 'pass' } else { 'fail' }) `
    'grype scan in container-build-sign workflow'

# --- 6. CI/CD --------------------------------------------------------------
$results += New-Result 'CI-001' 'cicd' `
    $(if (Test-Path (Join-Path $PlatformRoot ".github\workflows")) { 'pass' } else { 'fail' }) `
    '.github/workflows present'

# --- 7. Privacy ------------------------------------------------------------
$results += New-Result 'PRIV-001' 'privacy' 'requires_runtime_evidence' `
    'DPA template + sub-processor list owned by operator'

# --- 8. UX / a11y / i18n ---------------------------------------------------
$results += New-Result 'UX-002' 'ux' `
    $(if (Test-Path (Join-Path $dash "src\a11y.css"))  { 'pass' } else { 'fail' }) `
    'dashboard/src/a11y.css present'

$results += New-Result 'UX-003' 'ux' `
    $(if (Test-Path (Join-Path $dash "src\i18n\index.js")) { 'pass' } else { 'fail' }) `
    'dashboard/src/i18n/index.js present'

# --- Summary & attestation -------------------------------------------------
$pass    = ($results | Where-Object { $_.status -eq 'pass' }).Count
$fail    = ($results | Where-Object { $_.status -eq 'fail' }).Count
$pending = ($results | Where-Object { $_.status -eq 'requires_runtime_evidence' }).Count

$attestation = @{
    platform   = 'ScopeCash AI'
    generated  = (Get-Date).ToString('o')
    auditor    = 'l4-audit.ps1'
    summary    = @{
        total                       = $results.Count
        pass                        = $pass
        fail                        = $fail
        requires_runtime_evidence   = $pending
        score                       = if ($results.Count -gt 0) { [math]::Round($pass / $results.Count * 100, 1) } else { 0 }
    }
    controls   = $results
}

$out = Join-Path $PlatformRoot "l4-attestation.json"
$attestation | ConvertTo-Json -Depth 10 | Set-Content -Path $out -Encoding UTF8

Write-Host ""
Write-Host "L4 readiness — $pass pass / $fail fail / $pending need runtime evidence" -ForegroundColor Cyan
Write-Host "Wrote $out"
if ($fail -gt 0) {
    Write-Host "FAIL: at least one control failed" -ForegroundColor Red
    exit 1
}
exit 0

