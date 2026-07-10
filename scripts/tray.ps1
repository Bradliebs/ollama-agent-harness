# Ollama Agent Harness - System Tray Client
#
# A tiny PowerShell tray app that polls the Harness HTTP API and exposes
# the controls you'd otherwise hit by curl-ing localhost:
#   - Green / amber / red icon based on kill-switch + scheduler state
#   - Open dashboard, engage/release kill switch, stop autonomy
#   - Start / stop the server (uses the existing .bat scripts)
#
# Runs unattended. Reuses the server's own endpoints; no shared state with
# the harness process. Safe to start, stop, or restart any time without
# affecting a running server.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- Config -----------------------------------------------------------------

$Script:HarnessRoot   = Split-Path -Parent $PSScriptRoot
$Script:HarnessPort   = if ($env:HARNESS_PORT) { $env:HARNESS_PORT } else { 4300 }
$Script:HarnessBase   = "http://127.0.0.1:$($Script:HarnessPort)"
$Script:PollInterval  = 5000   # ms; health poll cadence
$Script:HttpTimeout   = 3      # seconds; per-request

# --- State ------------------------------------------------------------------

$Script:LastHealth = $null
$Script:LastReachable = $false
$Script:LastIconKey = ''

# --- HTTP helpers -----------------------------------------------------------

function Invoke-HarnessGet([string]$path) {
    try {
        return Invoke-RestMethod -Uri "$($Script:HarnessBase)$path" `
            -Method Get -TimeoutSec $Script:HttpTimeout
    } catch {
        return $null
    }
}

function Invoke-HarnessPost([string]$path, $body) {
    try {
        $json = if ($null -eq $body) { '{}' } else { ($body | ConvertTo-Json -Compress) }
        return Invoke-RestMethod -Uri "$($Script:HarnessBase)$path" `
            -Method Post -Body $json -ContentType 'application/json' `
            -TimeoutSec $Script:HttpTimeout
    } catch {
        return $null
    }
}

# --- Icon generation --------------------------------------------------------
# Generated at runtime so we don't ship .ico files. 16x16 solid dot.

function New-DotIcon([System.Drawing.Color]$color) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush $color
    $g.FillEllipse($brush, 1, 1, 14, 14)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(80, 0, 0, 0)), 1
    $g.DrawEllipse($pen, 1, 1, 14, 14)
    $brush.Dispose(); $pen.Dispose(); $g.Dispose()
    $hIcon = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($hIcon)
    return @{ Icon = $icon; Bitmap = $bmp; Handle = $hIcon }
}

$Script:Icons = @{
    green  = New-DotIcon ([System.Drawing.Color]::FromArgb(40, 180, 80))
    amber  = New-DotIcon ([System.Drawing.Color]::FromArgb(230, 165, 30))
    red    = New-DotIcon ([System.Drawing.Color]::FromArgb(200, 60, 60))
    gray   = New-DotIcon ([System.Drawing.Color]::FromArgb(140, 140, 140))
}

# --- Health interpretation --------------------------------------------------

function Get-HealthBadge($health, [bool]$reachable) {
    if (-not $reachable) { return @{ Key = 'gray'; Tip = 'Harness: server not reachable' } }
    if ($null -eq $health) { return @{ Key = 'amber'; Tip = 'Harness: server reachable but no health data' } }

    $killActive = [bool]$health.kill_switch.active
    # Sandbox is optional on older servers; treat missing as inactive
    # so the tray stays compatible without a hard schema dependency.
    $sandboxActive = $false
    if ($health.PSObject.Properties.Match('sandbox').Count -gt 0 -and $health.sandbox) {
        $sandboxActive = [bool]$health.sandbox.active
    }
    $schedulers = @($health.schedulers)
    $runningCount = ($schedulers | Where-Object { $_.running }).Count
    $totalCount = $schedulers.Count

    if ($killActive) {
        $reason = if ($health.kill_switch.reason) { $health.kill_switch.reason } else { '(no reason)' }
        return @{ Key = 'red'; Tip = "Harness: KILL SWITCH ENGAGED`n$reason" }
    }
    if ($sandboxActive) {
        # Sandbox is intentional soft-lockdown, not failure. Amber
        # surfaces it visibly without alarming like the kill switch.
        $reason = if ($health.sandbox.reason) { $health.sandbox.reason } else { '(no reason)' }
        return @{ Key = 'amber'; Tip = "Harness: SANDBOX ACTIVE`n$reason" }
    }
    if ($totalCount -gt 0 -and $runningCount -lt $totalCount) {
        return @{ Key = 'amber'; Tip = "Harness: $runningCount/$totalCount schedulers running" }
    }
    return @{ Key = 'green'; Tip = "Harness: healthy ($runningCount schedulers)" }
}

# --- Server process helpers -------------------------------------------------

function Test-ServerProcess() {
    $pidFile = Join-Path $Script:HarnessRoot '.harness\server.pid'
    if (-not (Test-Path $pidFile)) { return $null }
    try {
        $serverPid = [int](Get-Content $pidFile -ErrorAction Stop).Trim()
        $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
        if ($proc) { return $serverPid } else { return $null }
    } catch { return $null }
}

function Start-HarnessServer() {
    $bat = Join-Path $Script:HarnessRoot 'start-background.bat'
    if (Test-Path $bat) {
        Start-Process -FilePath $bat -WorkingDirectory $Script:HarnessRoot -WindowStyle Minimized | Out-Null
    } else {
        [System.Windows.Forms.MessageBox]::Show('start-background.bat not found at repo root', 'Harness Tray') | Out-Null
    }
}

function Stop-HarnessServer() {
    $bat = Join-Path $Script:HarnessRoot 'stop-server.bat'
    if (Test-Path $bat) {
        Start-Process -FilePath $bat -WorkingDirectory $Script:HarnessRoot -WindowStyle Hidden -Wait | Out-Null
    }
}

# --- Tray construction ------------------------------------------------------

$Script:Tray = New-Object System.Windows.Forms.NotifyIcon
$Script:Tray.Icon = $Script:Icons['gray'].Icon
$Script:Tray.Text = 'Harness: starting...'
$Script:Tray.Visible = $true

$Script:Menu = New-Object System.Windows.Forms.ContextMenuStrip

function Add-MenuItem([string]$text, [scriptblock]$action, [bool]$enabled = $true) {
    $item = New-Object System.Windows.Forms.ToolStripMenuItem $text
    $item.Enabled = $enabled
    if ($action) { $item.Add_Click({ & $action }.GetNewClosure()) }
    [void]$Script:Menu.Items.Add($item)
    return $item
}

function Add-MenuSeparator() {
    [void]$Script:Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
}

# Menu items rebuilt on each tick so labels reflect current state.
function Rebuild-Menu() {
    $Script:Menu.Items.Clear()

    $health = $Script:LastHealth
    $reachable = $Script:LastReachable
    $killActive = $reachable -and $health -and [bool]$health.kill_switch.active
    $sandboxActive = $false
    if ($reachable -and $health -and $health.PSObject.Properties.Match('sandbox').Count -gt 0 -and $health.sandbox) {
        $sandboxActive = [bool]$health.sandbox.active
    }

    Add-MenuItem 'Open Dashboard' {
        Start-Process $Script:HarnessBase | Out-Null
    } | Out-Null

    Add-MenuSeparator

    # Status block (disabled menu items, info only)
    if (-not $reachable) {
        Add-MenuItem '  Server: not reachable' $null $false | Out-Null
    } else {
        $schedulers = if ($health) { @($health.schedulers) } else { @() }
        $runningCount = ($schedulers | Where-Object { $_.running }).Count
        Add-MenuItem "  Server: running on port $($Script:HarnessPort)" $null $false | Out-Null
        Add-MenuItem "  Schedulers: $runningCount / $($schedulers.Count)" $null $false | Out-Null
        if ($health.heartbeat -and $health.heartbeat.last_run_at) {
            Add-MenuItem "  Last heartbeat: $($health.heartbeat.last_run_at)" $null $false | Out-Null
        }
        if ($killActive) {
            Add-MenuItem '  KILL SWITCH ACTIVE' $null $false | Out-Null
        }
        if ($sandboxActive) {
            Add-MenuItem '  SANDBOX ACTIVE' $null $false | Out-Null
        }
    }

    Add-MenuSeparator

    if ($reachable) {
        if ($killActive) {
            Add-MenuItem 'Release Kill Switch' {
                Invoke-HarnessPost '/api/permissions/kill-switch' @{ active = $false } | Out-Null
            } | Out-Null
        } else {
            Add-MenuItem 'Engage Kill Switch' {
                $result = [System.Windows.Forms.MessageBox]::Show(
                    'Engage the kill switch? All tool calls will be denied until released.',
                    'Harness Tray',
                    [System.Windows.Forms.MessageBoxButtons]::OKCancel,
                    [System.Windows.Forms.MessageBoxIcon]::Warning)
                if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
                    Invoke-HarnessPost '/api/permissions/kill-switch' @{
                        active = $true; reason = 'Engaged from tray.'
                    } | Out-Null
                }
            } | Out-Null
        }
        # Sandbox toggle — soft containment (path / shell / network
        # confined to workspace + safe binaries + public hosts). Lower
        # blast radius than kill switch; useful when you want the agent
        # to keep working but stay in a box.
        if ($sandboxActive) {
            Add-MenuItem 'Exit Sandbox' {
                Invoke-HarnessPost '/api/permissions/sandbox' @{ active = $false } | Out-Null
            } | Out-Null
        } else {
            Add-MenuItem 'Enter Sandbox' {
                $result = [System.Windows.Forms.MessageBox]::Show(
                    "Enter sandbox mode?`n`nTools will be restricted to the workspace, a curated shell allowlist, and public network hosts. The agent keeps working but with a narrower blast radius.",
                    'Harness Tray',
                    [System.Windows.Forms.MessageBoxButtons]::OKCancel,
                    [System.Windows.Forms.MessageBoxIcon]::Information)
                if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
                    Invoke-HarnessPost '/api/permissions/sandbox' @{
                        active = $true; reason = 'Engaged from tray.'
                    } | Out-Null
                }
            } | Out-Null
        }
        Add-MenuItem 'Stop Autonomy' {
            Invoke-HarnessPost '/api/autonomy/stop' $null | Out-Null
        } | Out-Null
    }

    Add-MenuSeparator

    $serverPid = Test-ServerProcess
    if ($null -eq $serverPid -and -not $reachable) {
        Add-MenuItem 'Start Server' { Start-HarnessServer } | Out-Null
    } else {
        Add-MenuItem 'Stop Server' {
            $result = [System.Windows.Forms.MessageBox]::Show(
                'Stop the Harness server?', 'Harness Tray',
                [System.Windows.Forms.MessageBoxButtons]::OKCancel,
                [System.Windows.Forms.MessageBoxIcon]::Question)
            if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
                Stop-HarnessServer
            }
        } | Out-Null
    }

    Add-MenuSeparator

    Add-MenuItem 'Quit Tray' {
        $Script:Tray.Visible = $false
        $Script:Tray.Dispose()
        [System.Windows.Forms.Application]::Exit()
    } | Out-Null
}

$Script:Tray.ContextMenuStrip = $Script:Menu

# Double-click opens the dashboard (most common action).
$Script:Tray.Add_MouseDoubleClick({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Start-Process $Script:HarnessBase | Out-Null
    }
})

# --- Polling timer ----------------------------------------------------------

$Script:Timer = New-Object System.Windows.Forms.Timer
$Script:Timer.Interval = $Script:PollInterval
$Script:Timer.Add_Tick({
    $health = Invoke-HarnessGet '/api/system/health'
    $Script:LastHealth = $health
    $Script:LastReachable = ($null -ne $health)

    $badge = Get-HealthBadge $health $Script:LastReachable
    if ($badge.Key -ne $Script:LastIconKey) {
        $Script:Tray.Icon = $Script:Icons[$badge.Key].Icon
        $Script:LastIconKey = $badge.Key
        # Surface state transitions to red as a balloon (kill switch engaged).
        if ($badge.Key -eq 'red') {
            $Script:Tray.BalloonTipTitle = 'Harness: kill switch engaged'
            $Script:Tray.BalloonTipText = $badge.Tip
            $Script:Tray.ShowBalloonTip(5000)
        }
    }
    # NotifyIcon.Text has a hard 127-char limit; truncate defensively.
    $tip = $badge.Tip
    if ($tip.Length -gt 127) { $tip = $tip.Substring(0, 124) + '...' }
    $Script:Tray.Text = $tip

    Rebuild-Menu
})

# Kick off an immediate poll so the icon isn't gray for 5s.
$Script:Timer.Start()
Rebuild-Menu

# --- Message loop -----------------------------------------------------------

[System.Windows.Forms.Application]::Run()
