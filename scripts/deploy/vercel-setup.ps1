# Uploads the production environment variables of this project to Vercel and deploys it. RUN BY YOU, in this project's folder:
#   powershell -ExecutionPolicy Bypass -File scripts\deploy\vercel-setup.ps1
# It reads the values from .env.local (they are never printed, never written to a file, never committed), marks the secrets as
# "sensitive" in Vercel, creates a NEW CRON_SECRET for production, and sets APP_URL to the project's address.
# Needs: `npx vercel whoami` working (already logged in) and the project linked (`.vercel` folder: done by `npx vercel link`).
param([string]$AppUrl = "https://sales-crm-mgh.vercel.app", [switch]$NoDeploy)
$ErrorActionPreference = "Stop"
$envFile = Join-Path (Get-Location) ".env.local"
if (-not (Test-Path $envFile)) { throw ".env.local not found: run this from the project folder" }
function Get-Val([string]$name) {
  $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -First 1
  if (-not $line) { throw "$name is missing in .env.local" }
  return (($line -split "=", 2)[1]).Trim().Trim('"')
}
function Put([string]$name, [string]$value, [bool]$secret) {
  $args = @("vercel", "env", "add", $name, "production", "--force")
  if ($secret) { $args += "--sensitive" }
  $value | & npx @args *> $null
  if ($LASTEXITCODE -ne 0) { throw "could not set $name" }
  Write-Host "set $name$(if ($secret) { ' (sensitive)' })"
}
$bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$cron = -join ($bytes | ForEach-Object { $_.ToString("x2") })

Put "NEXT_PUBLIC_SUPABASE_URL"      (Get-Val "NEXT_PUBLIC_SUPABASE_URL")      $false
Put "NEXT_PUBLIC_SUPABASE_ANON_KEY" (Get-Val "NEXT_PUBLIC_SUPABASE_ANON_KEY") $false
Put "SUPABASE_SERVICE_ROLE_KEY"     (Get-Val "SUPABASE_SERVICE_ROLE_KEY")     $true
Put "KAPSO_WEBHOOK_SECRET"          (Get-Val "KAPSO_WEBHOOK_SECRET")          $true
Put "KAPSO_API_KEY"                 (Get-Val "KAPSO_API_KEY")                 $true
Put "KAPSO_PROTOCOL"                "v2"                                      $false
Put "KAPSO_SEND_ALLOWLIST"          "*"                                       $false
Put "CRON_SECRET"                   $cron                                     $true
Put "APP_URL"                       $AppUrl                                   $false
if (-not $NoDeploy) { & npx vercel deploy --prod --yes }
