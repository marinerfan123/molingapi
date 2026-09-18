[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$SourceRoot = (Join-Path $PSScriptRoot '..\..\AiOnline')
)

$ErrorActionPreference = 'Stop'

$resolvedSourceRoot = (Resolve-Path -LiteralPath $SourceRoot -ErrorAction Stop).Path
$required = @(
  'src/pages/ModelHubPage/ModelHubPage.tsx',
  'src/hooks/useModelHub.ts',
  'src/data/models.ts',
  'server/modules/modelhub/resolver.cjs',
  'server/modules/modelhub/bindings.cjs',
  'server/modules/modelhub/router.cjs',
  'server/modules/modelhub/jobs.cjs',
  'server/dispatcher.cjs'
)

foreach ($path in $required) {
  $candidate = Join-Path $resolvedSourceRoot $path
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "missing source: $path"
  }
}

Write-Output 'model relay source inventory: PASS'
