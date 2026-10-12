<#
.SYNOPSIS
    One-time setup so Yaho's release workflow can sign Windows builds as Bosma Interactive AB.

.DESCRIPTION
    The release workflow (.github/workflows/release.yml) signs with Azure Artifact Signing, the same certificate
    profile filestar/build-scripts uses, and logs in with GitHub OIDC, so there is no secret. This script sets up,
    and is safe to run again (it finds what exists, asks before each change, and checks the result):

      1. an Entra app registration + service principal for Yaho, separate from Filestar's,
      2. a federated credential that trusts nielsbosma/yaho's GitHub environment 'release' and nothing else,
      3. the role "Artifact Signing Certificate Profile Signer" on the SeoToolsRelease profile only,
      4. the GitHub environment 'release' (tags v* and main only), and
      5. the repository variables WINDOWS_SIGNING_*.

    Run it as a MEMBER of the Bosma Interactive tenant (niels@bosmainteractive.onmicrosoft.com), not the guest.
    It needs az (Azure CLI) and gh (signed in with admin rights on nielsbosma/yaho). -WhatIf changes nothing.

.EXAMPLE
    pwsh -File tools/setup-signing.ps1 -WhatIf
    pwsh -File tools/setup-signing.ps1

.NOTES
    Adapted from filestar/build-scripts shared/windows/Setup-Signing.ps1. Undo: delete the app registration
    'yaho-release-signing' in Entra, and the WINDOWS_SIGNING_* variables on the repo.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Yes,
    # Sign in with a code at https://microsoft.com/devicelogin instead of a browser window.
    [switch]$UseDeviceCode,
    # Reuse an existing az profile folder instead of a fresh sign-in (for testing the script).
    [string]$AzureConfigDir
)
$ErrorActionPreference = 'Stop'

# ---- What gets set up. Change here, nowhere else. ------------------------------------------------
$Repo          = 'nielsbosma/yaho'
$MemberAccount = 'niels@bosmainteractive.onmicrosoft.com'
$AppName       = 'yaho-release-signing'
$Environment   = 'release'   # the GitHub environment the release workflow signs in
$Tenant        = '2105329e-0664-401c-a3f0-0d9334e840ff'   # Bosma Interactive
$Subscription  = 'a09ad87c-18d6-4895-a328-9ee64af02e5a'   # Bosma Interactive (not the Filestar one being closed)
$ResourceGroup = 'rg-artifact-signing'
$Account       = 'bosmainteractive'
$CertProfile       = 'SeoToolsRelease'
$Endpoint      = 'https://neu.codesigning.azure.net/'
$Publisher     = 'Bosma Interactive AB'
$Role          = 'Artifact Signing Certificate Profile Signer'
$Issuer        = 'https://token.actions.githubusercontent.com'
$Audience      = 'api://AzureADTokenExchange'
$ProfileId     = "/subscriptions/$Subscription/resourceGroups/$ResourceGroup/providers/Microsoft.CodeSigning/codeSigningAccounts/$Account/certificateProfiles/$CertProfile"
# --------------------------------------------------------------------------------------------------

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "   ok    $text" -ForegroundColor Green }
function Todo($text) { Write-Host "   todo  $text" -ForegroundColor Yellow }

function Confirm-Change([string]$what) {
    if ($WhatIfPreference) { Write-Host "   what-if: would $what" -ForegroundColor DarkYellow; return $false }
    if ($Yes) { return $true }
    $answer = Read-Host "   $what ? [y/N]"
    if ($answer -notmatch '^(y|yes)$') { throw "Stopped: '$what' was not confirmed. Nothing after this step was changed." }
    return $true
}

# az with a checked exit code; returns stdout. -Json parses it.
function Invoke-Az {
    param([Parameter(ValueFromRemainingArguments)][string[]]$AzArgs, [switch]$Json, [switch]$AllowFail)
    $out = & az @AzArgs --only-show-errors 2>&1
    if ($LASTEXITCODE -ne 0) {
        if ($AllowFail) { return $null }
        throw "az $($AzArgs -join ' ') failed:`n$($out -join "`n")"
    }
    $text = ($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    if ($Json) { if ($text.Trim()) { return $text | ConvertFrom-Json } else { return $null } }
    return $text.Trim()
}

function FederatedCredential([string]$name, [string]$subject) {
    $existing = @(Invoke-Az ad app federated-credential list --id $script:AppId --output json -Json) | Where-Object { $_ }
    $same = $existing | Where-Object { $_.subject -eq $subject }
    if ($same) { Ok "federated credential '$($same.name)' trusts $subject"; return }
    $clash = $existing | Where-Object { $_.name -eq $name }
    if ($clash) { throw "A federated credential named '$name' exists with subject '$($clash.subject)'. Remove it in Entra, then run again." }
    Todo "no federated credential for $subject"
    if (Confirm-Change "add federated credential '$name' for $subject") {
        $file = Join-Path $script:Work "fic-$name.json"
        @{ name = $name; issuer = $Issuer; subject = $subject; audiences = @($Audience)
           description = "GitHub Actions in $Repo (environment $Environment) may sign Yaho's Windows builds" } |
            ConvertTo-Json | Set-Content -Encoding utf8 $file -WhatIf:$false
        Invoke-Az ad app federated-credential create --id $script:AppId --parameters "@$file" --output none | Out-Null
        Ok "federated credential '$name' added"
    }
}

# ---- 0. Tools ------------------------------------------------------------------------------------
Step 'Tools'
foreach ($tool in 'az', 'gh') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is not installed. az: winget install -e --id Microsoft.AzureCLI   gh: winget install -e --id GitHub.cli"
    }
}
Ok 'az and gh found'
& gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) { throw 'gh is not signed in. Run: gh auth login' }
$perm = & gh api "repos/$Repo" --jq '.permissions.admin' 2>$null
if ($perm -ne 'true') { throw "Your gh account is not an admin of $Repo; it cannot set repository variables." }
Ok "gh can administer $Repo"

# ---- 1. Sign in (private az profile) ---------------------------------------------------------------
Step 'Azure sign-in (Bosma Interactive tenant)'
$script:Work = Join-Path ([IO.Path]::GetTempPath()) ("yaho-signing-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $script:Work -WhatIf:$false | Out-Null
$previousConfig = $env:AZURE_CONFIG_DIR
try {
    if ($AzureConfigDir) {
        $env:AZURE_CONFIG_DIR = (Resolve-Path $AzureConfigDir).Path
        Write-Host "   using the az profile in $env:AZURE_CONFIG_DIR"
    } else {
        $env:AZURE_CONFIG_DIR = Join-Path $script:Work 'az'
        # On Windows az signs in through the Web Account Manager, which silently picks an account Windows
        # already knows (often the guest). With the broker off, the browser shows an account picker.
        # This only changes the private profile above, not your own az config.
        & az config set core.enable_broker_on_windows=false --only-show-errors *> $null
    }
    $me = $null
    for ($attempt = 1; ; $attempt++) {
        if (-not $AzureConfigDir) {
            Write-Host "   Sign in as a MEMBER of the Bosma Interactive tenant: $MemberAccount"
            Write-Host '   (not the guest niels@bosmainteractive.se). In the account picker choose "Use another account" if it is not listed.'
            $login = @('login', '--tenant', $Tenant, '--only-show-errors', '--output', 'none')
            if ($UseDeviceCode) { $login += '--use-device-code' }
            & az @login
            if ($LASTEXITCODE -ne 0) { throw 'az login failed' }
        }
        Invoke-Az account set --subscription $Subscription | Out-Null
        # userType is not in Graph's default /me answer, so ask for it.
        $me = Invoke-Az rest --method get --url 'https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,userType,id' --query '{upn:userPrincipalName, type:userType, id:id}' --output json -Json
        Write-Host "   signed in as $($me.upn) ($($me.type))"
        if ($me.type -eq 'Member') { break }
        $why = "$($me.upn) is a $($me.type) in this tenant, and Entra does not let a guest create app registrations."
        if ($AzureConfigDir -or $attempt -ge 3) { throw "$why Sign in as $MemberAccount (try -UseDeviceCode)." }
        Write-Host "   $why" -ForegroundColor Yellow
        & az logout --only-show-errors *> $null
        & az account clear --only-show-errors *> $null
        $again = Read-Host "   Sign in again as $MemberAccount ? [Y/n]"
        if ($again -match '^(n|no)$') { throw 'Stopped at sign-in; nothing was changed.' }
    }
    Ok 'member of the Bosma Interactive tenant'

    # ---- 2. The certificate profile the role is scoped to -----------------------------------------
    Step "Certificate profile $Account/$CertProfile"
    $status = Invoke-Az resource show --ids $ProfileId --query properties.status --output tsv -AllowFail
    if ($status -ne 'Active') { throw "Certificate profile $ProfileId is '$status', expected Active." }
    Ok "$CertProfile is Active"

    # ---- 3. App registration + service principal ---------------------------------------------------
    Step "App registration '$AppName'"
    $apps = @(Invoke-Az ad app list --display-name $AppName --query '[].appId' --output json -Json) | Where-Object { $_ }
    if ($apps.Count -gt 1) { throw "There are $($apps.Count) app registrations named '$AppName'. Delete the extra ones in Entra, then run again." }
    $script:AppId = $apps | Select-Object -First 1
    if ($script:AppId) {
        Ok "exists, appId $script:AppId"
    } else {
        Todo 'does not exist'
        if (Confirm-Change "create app registration '$AppName' (single tenant, no secret)") {
            $script:AppId = Invoke-Az ad app create --display-name $AppName --sign-in-audience AzureADMyOrg --query appId --output tsv
            Ok "created, appId $script:AppId"
        }
    }

    $spId = $null
    if ($script:AppId) {
        $spId = Invoke-Az ad sp show --id $script:AppId --query id --output tsv -AllowFail
        if ($spId) { Ok "service principal $spId" }
        else {
            Todo 'no service principal'
            if (Confirm-Change 'create its service principal') {
                $spId = Invoke-Az ad sp create --id $script:AppId --query id --output tsv
                Ok "service principal $spId"
            }
        }
    }

    # ---- 4. Federated credentials --------------------------------------------------------------------
    Step 'Federated credentials (who may log in as the app)'
    if ($script:AppId) {
        # GitHub may send the immutable form (repo:<owner>@<id>/<repo>@<id>), which a renamed or re-created repo cannot
        # match; trust whatever this repository actually sends.
        $prefix = & gh api "repos/$Repo/actions/oidc/customization/sub" --jq '.sub_claim_prefix // empty' 2>$null
        if (-not $prefix) { $prefix = "repo:$Repo" }
        $name = if ($prefix -eq "repo:$Repo") { 'yaho-release' } else { 'yaho-release-immutable' }
        FederatedCredential $name "${prefix}:environment:${Environment}"
        $all = @(Invoke-Az ad app federated-credential list --id $script:AppId --output json -Json) | Where-Object { $_ }
        $foreign = $all | Where-Object { $_.issuer -ne $Issuer -or $_.subject -notlike "${prefix}:*" -and $_.subject -notlike "repo:${Repo}:*" }
        if ($foreign) { Write-Warning ("Credentials that trust something other than ${Repo}: " + (($foreign | ForEach-Object { "$($_.name) = $($_.subject)" }) -join '; ')) }
    } else { Todo 'skipped (no app yet)' }

    # ---- 5. Role on the certificate profile ----------------------------------------------------------
    Step "Role '$Role' on $CertProfile only"
    if ($spId) {
        # No JMESPath functions or filters here: az.cmd runs through cmd.exe, which breaks on '(' and '!'.
        $mine = @(Invoke-Az role assignment list --assignee $spId --all --output json -Json) | Where-Object { $_ }
        $has = @($mine | Where-Object { $_.scope -eq $ProfileId -and $_.roleDefinitionName -eq $Role })
        if ($has.Count -gt 0) { Ok 'assigned' }
        else {
            Todo 'not assigned'
            if (Confirm-Change "assign '$Role' to the service principal, scoped to the $CertProfile profile") {
                # A new service principal can take a minute to be visible to Azure RBAC.
                for ($i = 1; $i -le 12; $i++) {
                    $r = Invoke-Az role assignment create --assignee-object-id $spId --assignee-principal-type ServicePrincipal `
                        --role $Role --scope $ProfileId --output none -AllowFail
                    if ($null -ne $r) { break }
                    if ($i -eq 12) { throw 'The role assignment kept failing. Run the script again in a few minutes.' }
                    Write-Host "   not visible to RBAC yet, retrying ($i/12)"; Start-Sleep -Seconds 10
                }
                Ok 'assigned'
            }
        }
        $broad = @(Invoke-Az role assignment list --assignee $spId --all --output json -Json) | Where-Object { $_ -and $_.scope -ne $ProfileId }
        if ($broad) { Write-Warning ("The app also has roles elsewhere: " + (($broad | ForEach-Object { "$($_.roleDefinitionName) on $($_.scope)" }) -join '; ')) }
    } else { Todo 'skipped (no service principal yet)' }

    # ---- 6. The GitHub environment: only release tags may sign ----------------------------------------
    Step "GitHub environment '$Environment' on $Repo"
    $env_ = & gh api "repos/$Repo/environments/$Environment" 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($env_ -and $env_.name -eq $Environment) { Ok 'exists' }
    else {
        Todo 'does not exist'
        if (Confirm-Change "create environment '$Environment' (deployments from tags v* only)") {
            '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' | & gh api -X PUT "repos/$Repo/environments/$Environment" --input - | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'creating the environment failed' }
            & gh api -X POST "repos/$Repo/environments/$Environment/deployment-branch-policies" -f name='v*' -f type=tag | Out-Null
            & gh api -X POST "repos/$Repo/environments/$Environment/deployment-branch-policies" -f name='main' -f type=branch | Out-Null
            Ok "created; runs from tags v* and from main (dry runs) may use it"
        }
    }

    # ---- 7. Repository variables ----------------------------------------------------------------------
    Step "Repository variables on $Repo"
    $want = [ordered]@{
        WINDOWS_SIGNING_CLIENT_ID       = $script:AppId
        WINDOWS_SIGNING_TENANT_ID       = $Tenant
        WINDOWS_SIGNING_SUBSCRIPTION_ID = $Subscription
        WINDOWS_SIGNING_ENDPOINT        = $Endpoint
        WINDOWS_SIGNING_ACCOUNT         = $Account
        WINDOWS_SIGNING_PROFILE         = $CertProfile
        WINDOWS_SIGNING_PUBLISHER       = $Publisher
    }
    $have = @{}
    (& gh variable list --repo $Repo --json name,value | ConvertFrom-Json) | ForEach-Object { $have[$_.name] = $_.value }
    foreach ($name in $want.Keys) {
        $value = $want[$name]
        if (-not $value) { Todo "$name (no app yet)"; continue }
        if ($have[$name] -eq $value) { Ok "$name = $value"; continue }
        $from = if ($have.ContainsKey($name)) { "'$($have[$name])'" } else { 'unset' }
        if (Confirm-Change "set $name = $value (was $from)") {
            & gh variable set $name --repo $Repo --body $value
            if ($LASTEXITCODE -ne 0) { throw "gh variable set $name failed" }
            Ok "$name = $value"
        }
    }

    # ---- Done ------------------------------------------------------------------------------------------
    Step 'Next'
    if ($WhatIfPreference) { Write-Host '   -WhatIf: nothing was changed.'; return }
    Write-Host "   Release runs of $Repo can now sign as $Publisher."
    Write-Host '   Try it without publishing:'
    Write-Host "     gh workflow run release.yml --repo $Repo --ref main -f publish=false"
}
finally {
    $env:AZURE_CONFIG_DIR = $previousConfig
    if (-not $AzureConfigDir) { Remove-Item -Recurse -Force $script:Work -ErrorAction SilentlyContinue -WhatIf:$false }
    else { Remove-Item -Recurse -Force (Join-Path $script:Work 'fic-*.json') -ErrorAction SilentlyContinue -WhatIf:$false }
}
