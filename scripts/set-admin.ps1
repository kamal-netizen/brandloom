<#
  Creates your Brandloom login on the live site from credentials typed here.

    pwsh -File scripts/set-admin.ps1
    pwsh -File scripts/set-admin.ps1 -Local     # also create it in the local dev database

  The password is read without echo and goes straight from this window to the
  site's own sign-up API — nobody else (and no assistant) sees it. The live
  site only accepts addresses in ALLOWED_SIGNUP_EMAILS and makes them ADMIN,
  so there is no database step afterwards.
#>
param(
  [string]$SiteUrl = "https://brandloom.srv1867587.hstgr.cloud",
  [switch]$Local
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Read-Plain([string]$prompt) {
  $secure = Read-Host -Prompt $prompt -AsSecureString
  return [System.Net.NetworkCredential]::new("", $secure).Password
}

Write-Host "Brandloom admin setup" -ForegroundColor Cyan
Write-Host "Live site: $SiteUrl`n"

$email = (Read-Host -Prompt "Email").Trim()
if ($email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw "That does not look like an email address." }
$name = (Read-Host -Prompt "Name (Enter for '$($email.Split('@')[0])')").Trim()
if (-not $name) { $name = $email.Split('@')[0] }

$password = Read-Plain "Password (min 10 characters)"
if ($password.Length -lt 10) { throw "Password must be at least 10 characters." }
if ($password -ne (Read-Plain "Repeat password")) { throw "Passwords do not match." }

if ($Local) {
  Push-Location $root
  try {
    $env:ADMIN_EMAIL = $email; $env:ADMIN_NAME = $name; $env:ADMIN_PASSWORD = $password
    npx tsx scripts/make-admin.ts
    if ($LASTEXITCODE -ne 0) { throw "make-admin failed (is the dev database running? npm run db:dev)" }
    Write-Host "Local admin ready: http://localhost:3000/login" -ForegroundColor Green
  } finally {
    Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
    Pop-Location
  }
}

$body = @{ email = $email; password = $password; name = $name } | ConvertTo-Json
try {
  Invoke-RestMethod -Method Post -Uri "$SiteUrl/api/auth/sign-up/email" `
    -ContentType "application/json" -Headers @{ Origin = $SiteUrl } -Body $body | Out-Null
  Write-Host "Live admin account created for $email" -ForegroundColor Green
} catch {
  $detail = $_.ErrorDetails.Message
  if ($detail -match "USER_ALREADY_EXISTS|already exists") {
    Write-Host "$email already has a live account; its password was left unchanged." -ForegroundColor Yellow
  } elseif ($detail -match "closed for this address") {
    Write-Host "The live site refused $email: it is not in ALLOWED_SIGNUP_EMAILS." -ForegroundColor Red
    exit 1
  } else {
    Write-Host "Live sign-up failed: $($_.Exception.Message) $detail" -ForegroundColor Red
    exit 1
  }
}
$password = $null
Write-Host "`nSign in at $SiteUrl/login" -ForegroundColor Cyan
