# 打包 VS Code 扩展为 .vsix（不依赖 @vscode/vsce，不需要联网）
#
# 用法（Windows PowerShell 5.1 或 PowerShell 7 均可）:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<扩展目录>\build\pack-vsix.ps1"
#
# 要点：
#  1) extension.vsixmanifest 由 package.json 自动生成，版本号不会再对不上
#  2) 不能用 ZipFile.CreateFromDirectory —— .NET Framework 下它生成的条目名用反斜杠，
#     VS Code 解包会失败。这里逐条 CreateEntry，强制正斜杠。
#  3) 本脚本含中文，必须以 UTF-8 with BOM 保存，否则 PowerShell 5.1 会按 ANSI 读而报解析错误。

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$root  = Split-Path -Parent $PSScriptRoot          # 项目根（build 的上一层）
$stage = Join-Path $PSScriptRoot 'vsix'            # build\vsix
$ext   = Join-Path $stage 'extension'

Write-Output "项目根: $root"

# ---------- 读取 package.json ----------
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$id        = $pkg.name
$version   = $pkg.version
$publisher = $pkg.publisher
$engine    = $pkg.engines.vscode
if (-not $id -or -not $version -or -not $publisher -or -not $engine) {
  throw "package.json 缺少 name / version / publisher / engines.vscode"
}
$out = Join-Path $root ("{0}-{1}.vsix" -f $id, $version)
Write-Output "将打包: $id v$version  (publisher=$publisher, engine=$engine)"

# ---------- 生成 extension.vsixmanifest ----------
function XmlEsc([string]$s) {
  if ($null -eq $s) { return '' }
  return $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;')
}

$manifestPath = Join-Path $stage 'extension.vsixmanifest'
# 确保 vsix 暂存目录存在
if (-not (Test-Path $stage)) { New-Item -ItemType Directory -Force -Path $stage | Out-Null }
$manifestXml = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$(XmlEsc $id)" Version="$(XmlEsc $version)" Publisher="$(XmlEsc $publisher)" />
    <DisplayName>$(XmlEsc $pkg.displayName)</DisplayName>
    <Description xml:space="preserve">$(XmlEsc $pkg.description)</Description>
    <Tags>dsh,mcp,agent,vscode</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(XmlEsc $engine)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"@
# 不带 BOM 写 UTF-8：XML 解析器最省事
[System.IO.File]::WriteAllText($manifestPath, $manifestXml, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "已生成 extension.vsixmanifest"
$null = [xml](Get-Content $manifestPath -Raw -Encoding UTF8)
Write-Output "manifest XML 良构 ✓"

# ---------- 暂存 extension/ ----------
if (Test-Path $ext) { Remove-Item $ext -Recurse -Force }
New-Item -ItemType Directory -Force -Path $ext | Out-Null

$exclude = @('.git', 'node_modules', 'test', 'docs', 'build', '.github', '.vscode', '*.vsix', '*.log', '.gitignore', '.vscodeignore', 'CONTRIBUTING.md')
# 注意：暂存目录 build/vsix 由脚本自己重建，不应提交
Get-ChildItem $root -Force | Where-Object { $exclude -notcontains $_.Name -and $_.Name -notlike '*.vsix' } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $ext -Recurse -Force
}
$staged = @(Get-ChildItem $ext -Recurse -File)
Write-Output "已暂存 $($staged.Count) 个文件到 extension/"

# ---------- 必需件 ----------
$contentTypes = Join-Path $stage '[Content_Types].xml'
foreach ($p in @($manifestPath, $contentTypes, (Join-Path $ext 'package.json'))) {
  if (-not (Test-Path -LiteralPath $p)) { throw "缺少必需文件: $p" }
}

# ---------- 逐条写入 zip ----------
if (Test-Path $out) { Remove-Item $out -Force }
$items = @()
$items += [System.IO.FileInfo](Get-Item -LiteralPath $manifestPath)
$items += [System.IO.FileInfo](Get-Item -LiteralPath $contentTypes)
$items += $staged

$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in $items) {
    $rel = $f.FullName.Substring($stage.Length + 1).Replace('\', '/')
    $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open()
    try {
      $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
      $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
  }
} finally { $zip.Dispose() }

# ---------- 校验 ----------
$zip = [System.IO.Compression.ZipFile]::OpenRead($out)
try {
  Write-Output "`n=== .vsix 内容 ==="
  $zip.Entries | ForEach-Object { "{0,8}  {1}" -f $_.Length, $_.FullName }
  $names = @($zip.Entries | ForEach-Object { $_.FullName })
  foreach ($need in @('extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json')) {
    if ($names -notcontains $need) { throw "zip 根缺少 $need" }
  }
  if (@($zip.Entries | Where-Object { $_.FullName.Contains('\') }).Count -gt 0) {
    throw "有条目使用反斜杠"
  }
  Write-Output "`n条目全为正斜杠、三件套在根 ✓"
} finally { $zip.Dispose() }

Write-Output "`n输出: $out"
Write-Output "大小: $([math]::Round((Get-Item $out).Length / 1KB, 1)) KB"
