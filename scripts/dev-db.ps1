<#
  Local development database: a private Postgres cluster for Brandloom only.

    npm run db:dev            # creates on first run, then starts it
    npm run db:dev -- -Stop

  Data lives in %LOCALAPPDATA%\brandloom\pgdata (outside the repo), port 5441,
  trust auth on localhost — it never holds anything but test data.
  Needs Postgres binaries on PATH (scoop install postgresql).
#>
param([switch]$Stop, [int]$Port = 5441)

$ErrorActionPreference = "Stop"
$data = Join-Path $env:LOCALAPPDATA "brandloom\pgdata"
$log = Join-Path $env:LOCALAPPDATA "brandloom\pg.log"

if ($Stop) { pg_ctl -D $data stop -m fast; exit $LASTEXITCODE }

if (-not (Test-Path (Join-Path $data "PG_VERSION"))) {
  New-Item -ItemType Directory -Force (Split-Path $data) | Out-Null
  initdb -D $data -U postgres -A trust -E UTF8 | Out-Null
  Write-Host "Created cluster at $data"
}

& pg_ctl -D $data status *> $null
if ($LASTEXITCODE -ne 0) {
  # Through cmd with output to nul: the postmaster inherits pg_ctl's handles,
  # and a PowerShell pipeline would otherwise wait on it forever.
  cmd /c "pg_ctl -D `"$data`" -l `"$log`" -o `"-p $Port`" -w start >nul 2>&1"
}
Write-Host "Postgres running on localhost:$Port"

$exists = psql -h localhost -p $Port -U postgres -tAc "select 1 from pg_database where datname='brandloom_dev'"
if ($exists -ne "1") {
  createdb -h localhost -p $Port -U postgres brandloom_dev
  createdb -h localhost -p $Port -U postgres brandloom_test
  Write-Host "Created databases brandloom_dev and brandloom_test"
}
