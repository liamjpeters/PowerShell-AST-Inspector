# Script to fetch the PowerShell runtime nuget package, extract the XML doc file
# and parse it. For every type that subclasses AST, gather some rudamentrary
# documentation. Export a json file that can be used by the extension to show
# help info for each AST node type and it's properties. This is a best endevours
# attempt to provide some documentation around what AST nodes represent and what
# their properties mean.


# Get the list of all versions of the nuget package
$packageName = 'system.management.automation'
$indexUrl = "https://api.nuget.org/v3-flatcontainer/$packageName/index.json"
$versions = (Invoke-RestMethod $indexUrl).versions

# Filter to the last entry with an un pre-fixed/post-fixed version number.
$latestStableVersion = $versions | Where-Object {
    $_ -match '^\d+\.\d+\.\d+$'
} | Select-Object -Last 1

# Download the nupkg file
$nupkgUrl = "https://www.nuget.org/api/v2/package/$packageName/$latestStableVersion"
$destination = "$PSScriptRoot\$packageName.$latestStableVersion.nupkg"
Invoke-WebRequest -Uri $nupkgUrl -OutFile $destination -ProgressAction SilentlyContinue


# Expand the nupkg file (it's just a zip container)
$expandedArchive = Expand-Archive $destination -PassThru

# Find the xml file we need to parse
$xmlFile = $expandedArchive | Where-Object {
    $_ -like "*\System.Management.Automation.xml"
} | Select-Object -First 1

# Parse the XML file.
[xml]$xmlDoc = Get-Content $xmlFile

# Cleanup
Remove-Item $expandedArchive[0].Parent.FullName -Recurse -Force -Confirm:$false
Remove-Item $destination -Force -Confirm:$false


# List all AST node types and their properties
Add-Type -AssemblyName System.Management.Automation

# Find all types that subclass AST and are public
$astTypes = [System.Management.Automation.Language.Ast].Assembly.GetTypes() |
    Where-Object { 
        $_.IsSubclassOf([System.Management.Automation.Language.Ast]) -and
        $_.IsPublic
    }

function Get-SimplifiedTypeName {
    param(
        [Parameter(Mandatory)]
        [string]$typeNameString
    )

    function ParseTypeName {
        param([string]$typeName)

        # Remove assembly info (anything after a comma outside brackets)
        $typeName = $typeName.Trim()
        $bracketDepth = 0
        $result = ""
        for ($i = 0; $i -lt $typeName.Length; $i++) {
            $c = $typeName[$i]
            if ($c -eq '[') { $bracketDepth++ }
            elseif ($c -eq ']') { $bracketDepth-- }
            elseif ($c -eq ',' -and $bracketDepth -eq 0) { break }
            $result += $c
        }
        $typeName = $result

        # Handle generics: look for `N[...]
        if ($typeName -match '^(?<base>.+?)`[0-9]+\[(?<args>.+)\]$') {
            $baseType = $matches['base']
            $genericArgs = $matches['args']

            # Remove namespaces from base type
            $simpleBase = $baseType.Split('.')[-1]

            # Split generic arguments, handling nested brackets
            $arguments = @()
            $current = ""
            $depth = 0
            for ($i = 0; $i -lt $genericArgs.Length; $i++) {
                $ch = $genericArgs[$i]
                if ($ch -eq '[') {
                    if ($depth -gt 0) { $current += $ch }
                    $depth++
                } elseif ($ch -eq ']') {
                    $depth--
                    if ($depth -gt 0) { $current += $ch }
                } elseif ($ch -eq ',' -and $depth -eq 0) {
                    $arguments += $current.Trim()
                    $current = ""
                } else {
                    $current += $ch
                }
            }
            if ($current.Trim()) { $arguments += $current.Trim() }

            # Recursively simplify each argument
            $simplifiedArgs = $arguments | ForEach-Object { ParseTypeName $_ }
            return "$simpleBase[$($simplifiedArgs -join ', ')]"
        } else {
            # Not a generic: remove namespace
            return $typeName.Split('.')[-1]
        }
    }

    ParseTypeName $typeNameString
}

function Get-Summary {
    param (
        [AllowNull()]
        [Parameter(Mandatory, Position=0)]
        [System.Xml.XmlElement]
        $Element
    )
    if ($null -eq $Element) {
        return ""
    }
    $Text = if ($null -eq $Element.summary) {
        ""
    } elseif ($Element.summary -is [System.String]) {
        $Element.Summary
    } else {
        $sb = [System.Text.StringBuilder]::new()
        foreach ($node in $Element.summary.childnodes) {
            if ($node.NodeType -eq 'Text') {
                $sb.Append($node.InnerText) | Out-Null
                continue
            }
            if ($node.NodeType -eq 'Element' -and $node.Name -eq 'see') {
                $sb.Append(($node.Attributes[0].value -replace '^(T:|P:|F:)', '')) | Out-Null
                continue
            }
            if ($node.NodeType -eq 'Element' -and $node.Name -eq 'list') {
                $innerListItems = @()
                foreach ($listItem in $node.childnodes) {
                    $innerListItems += $listItem.childnodes[0].Attributes[0].value -replace '^(T:|P:|F:)', ''
                }
                $sb.Append(($innerListItems -join ', ')) | Out-Null
                continue
            }
            $sb.Append($node.OuterXml) | Out-Null
        }
        $sb.ToString()
    }
    # Remove tags and convert consecutive spaces to just one.
    $Text.Trim() -replace '\s{2,}', ' '
}

function Get-TypeSummary {
    [CmdletBinding()]
    param (
        [Parameter(Mandatory, Position=0)]
        [System.Xml.XmlDocument]
        $XmlDoc,
        [Parameter(Mandatory, Position=1)]
        $Type
    )
    Get-Summary $xmlDoc.SelectSingleNode("//member[@name='T:$($Type.FullName)']")
}

function Get-TypePropertySummary {
    [OutputType([System.String])]
    [CmdletBinding()]
    param (
        [Parameter(Mandatory, Position=0)]
        [System.Xml.XmlDocument]
        $XmlDoc,
        [Parameter(Mandatory, Position=1)]
        $Type,
        [Parameter(Mandatory, Position=2)]
        $PropertyName
    )

    # Keep a list of the types we've checked for the property docs
    $TypeToCheck = $Type
    $TypesChecked = @()
    
    while(
        $null -ne $TypeToCheck -and
        $TypesChecked -notcontains $TypeToCheck.FullName
    ) {
        # Track that we've tried this typename
        $TypesChecked += $TypeToCheck.FullName

        # Search the XMLDoc for the property on this type
        $TypeNode = $xmlDoc.SelectSingleNode("//member[@name='P:$($TypeToCheck.FullName).$($PropertyName)']")
        if ($null -ne $TypeNode) {
            # We found a node in the XML doc for this property
            return Get-Summary $TypeNode
        }

        if ($null -eq $TypeToCheck.BaseType) {
            return ''
        }

        $TypeToCheck = $TypeToCheck.BaseType
    }
}

$astTypes | ForEach-Object {
    $typeSummary = Get-TypeSummary $xmlDoc $_

    $properties = foreach($property in $_.GetProperties()) {
        $propSummary = Get-TypePropertySummary $xmlDoc $_ $property.Name

        $EnumValues = if ($property.PropertyType.IsEnum) {
            $property.PropertyType | 
                Select-Object -ExpandProperty DeclaredFields |
                Select-Object -expand Name |
                Where-Object {
                    $_ -ne 'value__'
                }
        } else {
            ''
        }

        [PSCustomObject]@{
            Name = $property.Name
            TypeName = Get-SimplifiedTypeName $Property.PropertyType.FullName
            EnumValues = $EnumValues
            Summary = $propSummary
        }
    }
    [pscustomobject] @{
        Name = $_.Name
        Summary = $typeSummary
        Properties = $properties
    }
} | ConvertTo-Json -Depth 5 -Compress | Out-File "$PSScriptRoot\src\AstDoc.json" -Force