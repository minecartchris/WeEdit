#!/usr/bin/env pwsh
# WeEdit task runner — one entry point for every way to run the code.
#
# Wraps the npm scripts in package.json (plus a couple of Rust/setup helpers)
# behind short, memorable commands so you don't have to remember which npm
# script maps to "the desktop app" vs "the web build".
#
# Usage
#   ./run.ps1 <command> [extra args passed through to the tool]
#   ./run.ps1 help            # list every command
#   ./run.ps1 list            # same as help
#
# Examples
#   ./run.ps1 dev             # Vite dev server (browser build)
#   ./run.ps1 app             # Tauri desktop app in dev mode
#   ./run.ps1 build           # type-check + production web build
#   ./run.ps1 build:app       # full desktop installer build
#   ./run.ps1 check           # type-check frontend (tsc) + backend (cargo)
#   ./run.ps1 release         # publish Windows + Linux (.deb/.AppImage via WSL)
#   ./run.ps1 release -DryRun # build both without publishing
#   ./run.ps1 release -Push   # push HEAD to origin, then publish
#   ./run.ps1 dev --port 5000 # extra flags are forwarded to vite
#
# Note: extra args are forwarded verbatim. Don't use a bare `--` separator —
# PowerShell parses it as an (empty) parameter name and errors out.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = 'help',

    # Everything after the command is forwarded verbatim to the underlying tool.
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Always operate from the repo root, regardless of the caller's cwd.
$RepoRoot = $PSScriptRoot
Set-Location $RepoRoot

# Normalize to an array even when no extra args were supplied.
if ($null -eq $Rest) { $Rest = @() }

function Invoke-Step {
    # NOTE: don't name the array param $Args — it collides with PowerShell's
    # automatic $Args variable and silently won't bind.
    param([string]$Exe, [string[]]$CmdArgs)
    $shown = (@($Exe) + $CmdArgs) -join ' '
    Write-Host "==> $shown" -ForegroundColor Cyan
    & $Exe @CmdArgs
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $shown" }
}

# Load the Tauri updater signing key into the environment for release builds.
# Without it, `tauri build` produces the installers fine but then fails at the
# signing step ("A public key has been found, but no private key").
function Initialize-SigningKey {
    $keyPath = Join-Path $HOME '.tauri/weedit.key'
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
        if (Test-Path $keyPath) {
            $env:TAURI_SIGNING_PRIVATE_KEY = [System.IO.File]::ReadAllText((Resolve-Path $keyPath).Path)
            Write-Host "==> Using signing key: $keyPath" -ForegroundColor Cyan
        } else {
            throw "No signing key found. Set `$env:TAURI_SIGNING_PRIVATE_KEY, or place the key at $keyPath."
        }
    }
    # Tauri needs the password var to EXIST even if the key has no password,
    # otherwise it fails with a misleading 'incorrect password' error.
    if (-not (Test-Path Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
    }
}

# Find a Python launcher for scripts/release.py (the Windows+Linux orchestrator).
function Get-PythonExe {
    foreach ($p in 'python', 'py', 'python3') {
        if (Get-Command $p -ErrorAction SilentlyContinue) { return $p }
    }
    throw "Python not found on PATH. Install Python to run scripts/release.py."
}

# Translate the PowerShell-style switches this runner accepts (-DryRun, -Push,
# -Notes) into the flags scripts/release.py expects (--dry-run, --push, --notes).
# Anything else is passed through untouched.
function ConvertTo-ReleaseArgs {
    param([string[]]$In)
    $out = @()
    foreach ($a in $In) {
        switch -Regex ($a) {
            '^-DryRun$' { $out += '--dry-run' }
            '^-Push$'   { $out += '--push' }
            '^-Notes$'  { $out += '--notes' }
            default     { $out += $a }
        }
    }
    return $out
}

# command name -> description + the action to run. Action receives $Rest.
$Tasks = [ordered]@{
    'install'       = @{ Desc = 'Install npm dependencies';                       Run = { Invoke-Step npm (@('install') + $Rest) } }
    'dev'           = @{ Desc = 'Desktop app + web dev server together (browser at :5173)'; Run = { Invoke-Step npm (@('run','tauri:dev','--') + $Rest) } }
    'app'           = @{ Desc = 'Alias of `dev` - Tauri desktop app, hot reload';          Run = { Invoke-Step npm (@('run','tauri:dev','--') + $Rest) } }
    'web'           = @{ Desc = 'Web only: Vite dev server, no desktop window';            Run = { Invoke-Step npm (@('run','dev','--') + $Rest) } }
    'tauri'         = @{ Desc = 'Raw `tauri` CLI passthrough';                    Run = { Invoke-Step npm (@('run','tauri','--') + $Rest) } }
    'build'         = @{ Desc = 'Type-check + production web build';              Run = { Invoke-Step npm (@('run','build') + $Rest) } }
    'build:web'     = @{ Desc = 'Production build using vite.web.config.ts';      Run = { Invoke-Step npm (@('run','build:web') + $Rest) } }
    'build:app'     = @{ Desc = 'Full desktop installer build';                   Run = { Invoke-Step npm (@('run','tauri:build') + $Rest) } }
    'build:release' = @{ Desc = 'Signed desktop release build';                   Run = { Initialize-SigningKey; Invoke-Step npm (@('run','tauri:build:release') + $Rest) } }
    'preview'       = @{ Desc = 'Preview the production web build locally';       Run = { Invoke-Step npm (@('run','preview','--') + $Rest) } }
    'preview:web'   = @{ Desc = 'Preview the vite.web.config.ts build';           Run = { Invoke-Step npm (@('run','preview:web','--') + $Rest) } }
    'check'         = @{ Desc = 'Type-check frontend (tsc) + backend (cargo)';    Run = {
            Invoke-Step npx (@('tsc','-b'))
            Invoke-Step cargo (@('check','--manifest-path','src-tauri/Cargo.toml') + $Rest)
        } }
    'fetch-binaries'  = @{ Desc = 'Download bundled ffmpeg binaries';             Run = { Invoke-Step npm (@('run','fetch-binaries') + $Rest) } }
    'clean-installers'= @{ Desc = 'Remove stale installer artifacts';            Run = { Invoke-Step npm (@('run','clean-installers') + $Rest) } }
    'release'         = @{ Desc = 'Build, sign & publish a release: Windows + Linux (.deb/.AppImage via WSL)'; Run = {
            Invoke-Step (Get-PythonExe) (@('scripts/release.py','release-all') + (ConvertTo-ReleaseArgs $Rest))
        } }
    'release:win'     = @{ Desc = 'Windows-only release (skip the Linux build)';   Run = {
            Invoke-Step (Get-PythonExe) (@('scripts/release.py','release') + (ConvertTo-ReleaseArgs $Rest))
        } }
}

function Show-Help {
    Write-Host ''
    Write-Host 'WeEdit task runner' -ForegroundColor Green
    Write-Host '  Usage: ./run.ps1 <command> [extra args forwarded to the tool]'
    Write-Host ''
    Write-Host 'Commands:' -ForegroundColor Green
    $width = ($Tasks.Keys | Measure-Object -Property Length -Maximum).Maximum
    foreach ($name in $Tasks.Keys) {
        $pad = $name.PadRight($width)
        Write-Host ("  {0}  {1}" -f $pad, $Tasks[$name].Desc)
    }
    Write-Host ''
}

switch ($Command.ToLowerInvariant()) {
    { $_ -in @('help', '-h', '--help', '/?', 'list') } { Show-Help; break }
    default {
        if ($Tasks.Contains($Command)) {
            & $Tasks[$Command].Run
        }
        else {
            Write-Host "Unknown command: '$Command'" -ForegroundColor Red
            Show-Help
            exit 1
        }
    }
}
