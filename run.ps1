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
#   ./run.ps1 release:notes   # preview the AI-drafted notes only
#   ./run.ps1 release:notes --past   # notes for the LAST published release
#   ./run.ps1 release:notes --past 2 # notes for the release before that
#   ./run.ps1 release:notes --past --apply  # ...and push them to that release
#   ./run.ps1 dev --port 5000 # extra flags are forwarded to vite
#
# Release notes: `release`/`release:win` auto-draft user-facing notes from the
# commits since the last release using a local Ollama model (default
# llama3.2:latest, override via $env:WEEDIT_OLLAMA_MODEL). Pass -Notes "..." to
# supply your own and skip generation; if ollama is unavailable it silently
# falls back to release.py's default note.
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

# Did the caller already supply their own release notes? If so we don't generate.
function Test-HasNotesArg {
    param([string[]]$In)
    foreach ($a in $In) { if ($a -match '^(-Notes|--notes)$') { return $true } }
    return $false
}

# The Nth most recent published release tag (0 = latest). $null if out of range.
function Get-ReleaseTag {
    param([int]$Index = 0)
    $tags = @(& git tag --list 'build-*' --sort=-creatordate)
    if ($Index -ge 0 -and $Index -lt $tags.Count) { return $tags[$Index] }
    return $null
}

# Draft user-facing release notes from the commits since the last release,
# using a local Ollama model. Returns $null on ANY failure (no ollama, no model,
# no new commits, no user-facing changes) so notes generation never blocks a
# release -- release.py just falls back to its default note in that case.
# Pass -Since <ref> to summarize commits since a specific tag/commit, and
# -Until <ref> to set the endpoint (default HEAD; used by --past to regenerate
# notes for a past release). Override the model with $env:WEEDIT_OLLAMA_MODEL.
function New-ReleaseNotes {
    param([string]$Since, [string]$Until = 'HEAD')
    $model = if ($env:WEEDIT_OLLAMA_MODEL) { $env:WEEDIT_OLLAMA_MODEL } else { 'llama3.2:latest' }
    try {
        if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
            Write-Host "==> ollama not found; falling back to default release notes" -ForegroundColor Yellow
            return $null
        }
        # Determine the commit range base. With -Since, diff against that ref.
        # Otherwise, when summarizing up to HEAD, auto-detect the previous
        # release tag (build-*); if HEAD itself is already tagged (a re-release/
        # resume), look from its parent so we don't diff against HEAD's own tag
        # and get an empty range. First release (no such tag yet) -> last 30.
        if ($Since) {
            $base = $Since
        } elseif ($Until -eq 'HEAD') {
            $describeRef = 'HEAD'
            if (@(& git tag --points-at HEAD --list 'build-*').Count -gt 0) { $describeRef = 'HEAD^' }
            $prev = (& git describe --tags --abbrev=0 --match 'build-*' $describeRef 2>$null)
            $base = if ($LASTEXITCODE -eq 0 -and $prev) { $prev.Trim() } else { $null }
        } else {
            $base = $null
        }
        if ($base) {
            $log = (& git log --no-merges --pretty=format:'- %s' "$base..$Until")
        } else {
            $log = (& git log --no-merges -n 30 --pretty=format:'- %s' $Until)
        }
        $baseLabel = if ($base) { $base } else { 'the last release' }
        if (-not $log) {
            Write-Host "==> no new commits since $baseLabel; using default note" -ForegroundColor Yellow
            return $null
        }
        $commits = ($log -join "`n")
        $rangeLabel = if ($base) { "$base..$Until" } else { "$Until~30..$Until" }
        Write-Host "==> Summarizing $(@($log).Count) commit(s) ($rangeLabel)" -ForegroundColor DarkGray
        $prompt = @"
You are writing concise, user-facing release notes for WeEdit, a desktop video editor for Twitch VODs.
Summarize the following git commit subjects into short markdown release notes.
Group them under '### Added', '### Fixed', and '### Changed' (omit any group that would be empty).
Write for end users, not developers. Keep developer-tooling/build-script commits brief but DO include them under Changed rather than dropping them entirely.
Do not mention commit hashes or file paths. Output ONLY the markdown notes, with no preamble, sign-off, or explanation.

Commits:
$commits
"@
        Write-Host "==> Drafting release notes with ollama ($model)..." -ForegroundColor Cyan
        # ollama draws a progress spinner on stderr; we leave it (redirecting a
        # native command's stderr under ErrorActionPreference=Stop in Windows
        # PowerShell 5.1 turns it into a terminating error). $notes captures only
        # stdout, so the spinner is cosmetic and the generated text stays clean.
        $notes = ($prompt | & ollama run $model)
        # ollama streams tokens to stdout and occasionally interleaves ANSI
        # cursor codes (e.g. backspace corrections like ESC[5D ESC[K). Strip all
        # CSI escape sequences so they don't end up in the published notes.
        $clean = ((($notes -join "`n") -replace "\x1B\[[0-?]*[ -/]*[@-~]", '').Trim())
        if ($LASTEXITCODE -ne 0 -or -not $clean) {
            Write-Host "==> ollama returned no notes; using default" -ForegroundColor Yellow
            return $null
        }
        # Guard against header-only output: if the model filtered every commit
        # out, there's nothing but '### Added' lines left. Treat that as no notes.
        $body = @($clean -split "`n" | Where-Object { $_.Trim() -and $_ -notmatch '^\s*#{1,6}\s' })
        if ($body.Count -eq 0) {
            Write-Host "==> no user-facing changes in that range; using default note" -ForegroundColor Yellow
            return $null
        }
        return $clean
    }
    catch {
        Write-Host "==> release-notes generation failed: $($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
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
            $relArgs = ConvertTo-ReleaseArgs $Rest
            if (-not (Test-HasNotesArg $Rest)) {
                $notes = New-ReleaseNotes
                if ($notes) { $relArgs += @('--notes', $notes) }
            }
            Invoke-Step (Get-PythonExe) (@('scripts/release.py','release-all') + $relArgs)
        } }
    'release:win'     = @{ Desc = 'Windows-only release (skip the Linux build)';   Run = {
            $relArgs = ConvertTo-ReleaseArgs $Rest
            if (-not (Test-HasNotesArg $Rest)) {
                $notes = New-ReleaseNotes
                if ($notes) { $relArgs += @('--notes', $notes) }
            }
            Invoke-Step (Get-PythonExe) (@('scripts/release.py','release') + $relArgs)
        } }
    'release:notes'   = @{ Desc = 'Preview AI notes. Args: <base-ref> | --past [N] [--apply]'; Run = {
            # Parse args: --past [N] regenerates notes for the Nth-from-latest
            # published release (default 1 = the last one). --apply pushes the
            # generated notes onto that GitHub release via `gh release edit`.
            # A bare ref is used as the diff base for notes up to HEAD.
            $past = $false; $apply = $false; $n = 1; $since = $null
            for ($i = 0; $i -lt @($Rest).Count; $i++) {
                if ($Rest[$i] -match '^--?past$') {
                    $past = $true
                    if (($i + 1) -lt @($Rest).Count -and $Rest[$i + 1] -match '^\d+$') { $n = [int]$Rest[$i + 1]; $i++ }
                } elseif ($Rest[$i] -match '^--?apply$') { $apply = $true }
                elseif (-not $since) { $since = $Rest[$i] }
            }
            if ($apply -and -not $past) {
                throw "--apply only works with --past (it updates an existing release). For HEAD, run a real release with `./run.ps1 release`."
            }
            $until = $null
            if ($past) {
                $until = Get-ReleaseTag -Index ($n - 1)   # the release to describe
                $base = Get-ReleaseTag -Index $n          # the release before it
                if (-not $until) { Write-Host "No release tag found $n back." -ForegroundColor Yellow; return }
                Write-Host "==> Notes for past release $until" -ForegroundColor Cyan
                $notes = New-ReleaseNotes -Since $base -Until $until
            } else {
                $notes = New-ReleaseNotes -Since $since
            }
            if (-not $notes) { Write-Host 'No notes generated.' -ForegroundColor Yellow; return }
            Write-Host "`n$notes`n"
            if ($apply) {
                if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
                    throw "gh (GitHub CLI) not found on PATH; can't apply notes. Install: https://cli.github.com/"
                }
                Write-Host "==> Updating release $until notes on GitHub..." -ForegroundColor Cyan
                Invoke-Step gh @('release', 'edit', $until, '--notes', $notes)
                Write-Host "==> Updated $until." -ForegroundColor Green
            }
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
