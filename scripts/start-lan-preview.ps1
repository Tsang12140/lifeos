# Run from the repository root (or any directory):
# powershell -ExecutionPolicy Bypass -File .\scripts\start-lan-preview.ps1

[CmdletBinding()]
param(
    # Convenience only; the value is never printed. Prefer an inherited
    # LIFEOS_LAN_PASSWORD when one is already present in the environment.
    [Parameter()]
    [AllowEmptyString()]
    [string]$Password
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDirectory "..")).Path
$acceptServe = Join-Path $projectRoot ".review\accept-serve.mjs"

if (-not (Test-Path -LiteralPath $acceptServe -PathType Leaf)) {
    throw "Cannot find the preview launcher: $acceptServe"
}

$nodePath = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        throw "Node.js was not found at '$nodePath' and no 'node' command is available."
    }
    $nodePath = $nodeCommand.Source
}

$previousLan = [Environment]::GetEnvironmentVariable("LIFEOS_LAN", "Process")
$previousPassword = [Environment]::GetEnvironmentVariable("LIFEOS_LAN_PASSWORD", "Process")
$temporaryPassword = $false
$plainPassword = $null
$securePassword = $null
$passwordBstr = [IntPtr]::Zero
$exitCode = 1

try {
    [Environment]::SetEnvironmentVariable("LIFEOS_LAN", "1", "Process")

    $inheritedPassword = [Environment]::GetEnvironmentVariable("LIFEOS_LAN_PASSWORD", "Process")
    $hasPasswordParameter = $PSBoundParameters.ContainsKey("Password")
    if ($hasPasswordParameter -and [string]::IsNullOrWhiteSpace($Password)) {
        throw "-Password must not be empty or whitespace."
    }
    if (($null -ne $inheritedPassword) -and [string]::IsNullOrWhiteSpace($inheritedPassword)) {
        throw "LIFEOS_LAN_PASSWORD must not be empty or whitespace."
    }

    if ($null -ne $inheritedPassword) {
        # accept-serve.mjs trims and validates this inherited value.
        $temporaryPassword = $false
    } elseif ($hasPasswordParameter) {
        [Environment]::SetEnvironmentVariable("LIFEOS_LAN_PASSWORD", $Password, "Process")
        $temporaryPassword = $true
    } else {
        $securePassword = Read-Host -Prompt "Enter a temporary LAN preview password" -AsSecureString
        $passwordBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
        $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordBstr)
        if ([string]::IsNullOrWhiteSpace($plainPassword)) {
            throw "The LAN preview password must not be empty or whitespace."
        }
        [Environment]::SetEnvironmentVariable("LIFEOS_LAN_PASSWORD", $plainPassword, "Process")
        $temporaryPassword = $true
    }

    Write-Host "LifeOS LAN preview: http://127.0.0.1:5199/"
    Write-Host "For another device, run 'ipconfig' to find this PC's LAN IP, then open http://<LAN-IP>:5199/ and enter the same LAN password."
    Write-Host "Press Ctrl+C to stop the preview."

    # Run in the foreground so Ctrl+C reaches accept-serve.mjs, which shuts
    # down its API and Vite children as one tree.
    & $nodePath $acceptServe
    $exitCode = $LASTEXITCODE
} finally {
    if ($passwordBstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordBstr)
    }
    if ($null -ne $securePassword) {
        $securePassword.Dispose()
    }
    $plainPassword = $null

    if ($temporaryPassword) {
        [Environment]::SetEnvironmentVariable("LIFEOS_LAN_PASSWORD", $previousPassword, "Process")
    }
    [Environment]::SetEnvironmentVariable("LIFEOS_LAN", $previousLan, "Process")
}

exit $exitCode
