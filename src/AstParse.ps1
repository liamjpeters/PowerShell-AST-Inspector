[CmdletBinding()]
param (
    [AllowEmptyString()]
    [Parameter(Mandatory)]
    [string]
    $Content
)

$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'

try {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput(
        $Content,
        [ref]$tokens,
        [ref]$errors
    )

    if ($null -eq $ast) {
        throw 'Failed to parse PowerShell content - AST is null'
    }

    $parseErrors = @()
    if ($null -ne $errors -and $errors.Count -gt 0) {
        foreach ($err in $errors) {
            $parseErrors += @{
                message = $err.Message
                startLine = $err.Extent.StartLineNumber
                startColumn = $err.Extent.StartColumnNumber
                endLine = $err.Extent.EndLineNumber
                endColumn = $err.Extent.EndColumnNumber
            }
        }
    }

    class AstProperty {

        [string] $Name
        [string] $Value
        [string] $TypeName

        AstProperty ([string]$Name, [string]$Value, [string]$TypeName) {
            $this.Name = $Name
            $this.Value = [AstProperty]::TrimString($Value)
            $this.TypeName = $TypeName
        }

        static [string] TrimString([string]$String) {
            return [AstProperty]::TrimString($String, 200)
        }

        static [string] TrimString([string]$String, [int]$MaxChars) {
            if ([string]::IsNullOrEmpty($String)) {
                return ''
            }
            if ($String.Length -le $MaxChars) {
                return $String
            } else {
                return "$($String.Substring(0,$MaxChars))..."
            }
        }
    }

    function Get-AstProperties {
        [OutputType([AstProperty[]])]
        [CmdletBinding()]
        param (
            [Parameter(Mandatory, Position = 0)]
            [object]
            $Ast
        )
        end {
            foreach ($Prop in $Ast.PSObject.Properties) {
                if ($Prop.MemberType -ne 'Property' -or
                    $Prop.Name -eq 'Parent' -or
                    $Prop.Name -eq 'Extent' -or
                    $Prop.Name -eq 'ErrorPosition') {
                    continue
                }
                if ($null -eq $Prop.Value) {
                    [AstProperty]::new($Prop.Name, $null, $Prop.TypeNameOfValue)
                } else {
                    [AstProperty]::new($Prop.Name, $Prop.Value.ToString(), $Prop.TypeNameOfValue)
                }
            }
        }
    }

    # Get all AST nodes using FindAll - this gets everything!
    $allAstNodes = $ast.FindAll({ $true }, $true)
    $nodeId = 0
    $result = [System.Collections.ArrayList]::new()
    
    foreach ($node in $allAstNodes) {
        $nodeId++
        
        # Get parent hash code (null for root)
        $parentHashCode = if ($null -ne $node.Parent) { 
            $node.Parent.GetHashCode() 
        } else { 
            $null 
        }
        
        $nodeData = @{
            id                = "node_$($nodeId)"
            hashCode          = $node.GetHashCode()
            parentHashCode    = $parentHashCode
            type              = if ($node.GetType()) { $node.GetType().Name } else { 'Unknown' }
            text              = [AstProperty]::TrimString($node.ToString(), 100)
            textLength        = $node.Extent.EndOffset - $node.Extent.StartOffset
            extentString      = "Ln $($node.Extent.StartLineNumber), Col $($node.Extent.StartColumnNumber) -> Ln $($node.Extent.EndLineNumber), Col $($node.Extent.EndColumnNumber)"
            StartLineNumber   = $node.Extent.StartLineNumber
            StartColumnNumber = $node.Extent.StartColumnNumber
            EndLineNumber     = $node.Extent.EndLineNumber
            EndColumnNumber   = $node.Extent.EndColumnNumber
            properties        = Get-AstProperties -Ast $node
        }
        $result.Add($nodeData) | Out-Null
    }

    $finalOutput = @{
        nodes = $result
        errors = $parseErrors
    }
    Write-Output ($finalOutput | ConvertTo-Json -Depth 5 -Compress)
} catch {
    $errorObj = @{
        error   = $true
        message = $_.Exception.Message
        type    = 'ParseError'
    }
    Write-Output ($errorObj | ConvertTo-Json -Compress)
    exit 1
}