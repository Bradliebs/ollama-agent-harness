<#
.SYNOPSIS
    Fast-forward the mainline branches to the tip of the source branch and push them.

.DESCRIPTION
    Keeps main and master in lockstep with the working branch (dev by default) so a
    plain `git pull` on any of them on another machine gets the latest changes.

    Safety:
      - Uses `git merge --ff-only`, so it ABORTS rather than creating a merge commit
        if a target branch has diverged. Nothing is forced.
      - Refuses to run with a dirty working tree (uncommitted changes).
      - Only touches the source and target branches; feature branches are never modified.

.PARAMETER Source
    Branch whose tip the targets are advanced to. Defaults to the current branch.

.PARAMETER Targets
    Branches to fast-forward and push. Defaults to main, master.

.PARAMETER Remote
    Remote to push to. Defaults to origin.

.EXAMPLE
    ./scripts/sync-branches.ps1
    Fast-forwards main and master to the current branch and pushes all three.

.EXAMPLE
    ./scripts/sync-branches.ps1 -Source dev -Targets main,master
#>
[CmdletBinding()]
param(
    [string]$Source,
    [string[]]$Targets = @('main', 'master'),
    [string]$Remote = 'origin'
)

$ErrorActionPreference = 'Stop'

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments)] [string[]]$Args)
    $output = & git @Args 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Args -join ' ') failed:`n$output"
    }
    return $output
}

# Resolve source branch (default: current branch).
if (-not $Source) {
    $Source = (& git rev-parse --abbrev-ref HEAD).Trim()
}
if ($Source -eq 'HEAD') {
    throw "Detached HEAD. Check out a branch or pass -Source explicitly."
}

# Refuse on uncommitted TRACKED changes so a checkout/fast-forward can't carry them
# across or clobber work. Untracked scratch files are ignored: a fast-forward never
# touches them, and this repo routinely holds untracked logs/outputs.
$dirty = & git status --porcelain --untracked-files=no
if ($dirty) {
    throw "You have uncommitted changes to tracked files. Commit or stash them before syncing."
}

Write-Host "Fetching $Remote..." -ForegroundColor Cyan
Invoke-Git fetch $Remote --quiet | Out-Null

$startBranch = (& git rev-parse --abbrev-ref HEAD).Trim()

# Make sure the source branch itself is pushed before advancing anything to it.
Write-Host "Pushing source branch '$Source' to $Remote..." -ForegroundColor Cyan
& git checkout $Source | Out-Null
Invoke-Git push $Remote $Source | Out-Null

foreach ($target in $Targets) {
    Write-Host "Syncing '$target' -> '$Source'..." -ForegroundColor Cyan
    & git checkout $target | Out-Null
    try {
        Invoke-Git merge --ff-only $Source | Out-Null
    }
    catch {
        & git checkout $startBranch | Out-Null
        throw "Cannot fast-forward '$target' onto '$Source' (branches diverged). " +
              "Resolve manually with a merge or rebase. No branches were pushed past this point."
    }
    Invoke-Git push $Remote $target | Out-Null
    Write-Host "  '$target' is now at $Source and pushed." -ForegroundColor Green
}

# Return to the branch the user started on.
& git checkout $startBranch | Out-Null

Write-Host "Done. $Source, $($Targets -join ', ') are in sync and pushed to $Remote." -ForegroundColor Green
