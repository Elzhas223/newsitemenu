param(
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$DataDir = Join-Path $Root 'data'
$OrdersFile = Join-Path $DataDir 'orders.json'
$LogFile = Join-Path $DataDir 'server.log'

$Mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'
  '.js' = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png' = 'image/png'
  '.jpg' = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.svg' = 'image/svg+xml; charset=utf-8'
  '.webp' = 'image/webp'
  '.ico' = 'image/x-icon'
}

function Write-ServerLog {
  param([string]$Message)
  if (!(Test-Path -LiteralPath $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir | Out-Null
  }
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Initialize-Store {
  if (!(Test-Path -LiteralPath $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir | Out-Null
  }
  if (!(Test-Path -LiteralPath $OrdersFile)) {
    Set-Content -LiteralPath $OrdersFile -Value '[]' -Encoding UTF8
  }
}

function Import-DotEnv {
  $envPath = Join-Path $Root '.env'
  if (!(Test-Path -LiteralPath $envPath)) { return }

  Get-Content -LiteralPath $envPath -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (!$line -or $line.StartsWith('#') -or !$line.Contains('=')) { return }

    $separator = $line.IndexOf('=')
    $key = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim().Trim('"').Trim("'")
    if ($key -and [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($key, 'Process'))) {
      [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
  }
}

function ConvertTo-JsonText {
  param($Value)
  return ($Value | ConvertTo-Json -Depth 12 -Compress)
}

function Send-TextResponse {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [int]$StatusCode,
    [string]$Body,
    [string]$ContentType = 'text/plain; charset=utf-8'
  )
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
  $Response.StatusCode = $StatusCode
  $Response.ContentType = $ContentType
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.OutputStream.Close()
}

function Send-JsonResponse {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [int]$StatusCode,
    $Payload
  )
  Send-TextResponse -Response $Response -StatusCode $StatusCode -Body (ConvertTo-JsonText $Payload) -ContentType 'application/json; charset=utf-8'
}

function Read-RequestJson {
  param([System.Net.HttpListenerRequest]$Request)
  $reader = [System.IO.StreamReader]::new($Request.InputStream, [System.Text.Encoding]::UTF8, $true)
  try {
    $raw = $reader.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
    return ($raw | ConvertFrom-Json)
  } finally {
    $reader.Dispose()
  }
}

function Read-Orders {
  Initialize-Store
  try {
    $raw = Get-Content -LiteralPath $OrdersFile -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    $orders = $raw | ConvertFrom-Json
    if ($null -eq $orders) { return @() }
    if ($orders -is [array]) { return @($orders) }
    return @($orders)
  } catch {
    return @()
  }
}

function Write-Orders {
  param([array]$Orders)
  Initialize-Store
  Set-Content -LiteralPath $OrdersFile -Value (ConvertTo-Json -InputObject @($Orders) -Depth 12) -Encoding UTF8
}

function Clean-Text {
  param(
    $Value,
    [int]$MaxLength = 180
  )
  if ($null -eq $Value) {
    $text = ''
  } else {
    $text = [string]$Value
  }
  $text = ($text -replace '\s+', ' ').Trim()
  if ($text.Length -gt $MaxLength) { return $text.Substring(0, $MaxLength) }
  return $text
}

function Format-Money {
  param([int]$Value)
  return ('{0:N0} tg' -f $Value).Replace(',', ' ')
}

function New-Order {
  param($Payload)
  $table = Clean-Text $Payload.table 40
  if (!$table) { throw 'Table number is required' }

  $items = @()
  foreach ($item in @($Payload.items)) {
    $name = Clean-Text $item.name 120
    $category = Clean-Text $item.category 80
    $price = [Math]::Max(0, [int]$item.price)
    $qty = [Math]::Max(1, [Math]::Min(99, [int]$item.qty))
    if ($name -and $price -gt 0) {
      $items += [pscustomobject]@{
        id = Clean-Text $item.id 100
        name = $name
        category = $category
        price = $price
        qty = $qty
      }
    }
  }

  if ($items.Count -eq 0) { throw 'Order items are required' }

  $total = 0
  foreach ($item in $items) {
    $total += $item.price * $item.qty
  }

  return [pscustomobject]@{
    id = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString('x')).ToUpper()
    table = $table
    items = $items
    total = $total
    status = 'new'
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
  }
}

function Format-OrderMessage {
  param($Order)
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('BRILLIANT MENU')
  $lines.Add("New order #$($Order.id)")
  $lines.Add('')
  $lines.Add("Table: $($Order.table)")
  $lines.Add("Time: $((Get-Date $Order.createdAt).ToString('dd.MM.yyyy HH:mm'))")
  $lines.Add('')
  $lines.Add('Items:')

  $index = 1
  foreach ($item in @($Order.items)) {
    $lineTotal = [int]$item.price * [int]$item.qty
    $lines.Add("$index. $($item.name)")
    $lines.Add("   $($item.category) | $($item.qty) x $(Format-Money $item.price) = $(Format-Money $lineTotal)")
    $index += 1
  }

  $lines.Add('')
  $lines.Add("Total: $(Format-Money $Order.total)")
  return ($lines -join "`n")
}

function Send-TelegramMessage {
  param([string]$Text)

  $token = [Environment]::GetEnvironmentVariable('TELEGRAM_BOT_TOKEN', 'Process')
  $chatId = [Environment]::GetEnvironmentVariable('TELEGRAM_CHAT_ID', 'Process')
  if (!$token -or !$chatId) {
    return [pscustomobject]@{
      sent = $false
      error = 'Telegram is not configured. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env.'
    }
  }

  try {
    $body = @{
      chat_id = $chatId
      text = $Text
    } | ConvertTo-Json -Depth 4

    Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/sendMessage" -Method Post -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 15 | Out-Null
    return [pscustomobject]@{ sent = $true }
  } catch {
    return [pscustomobject]@{
      sent = $false
      error = $_.Exception.Message
    }
  }
}

function Handle-Api {
  param([System.Net.HttpListenerContext]$Context)

  $request = $Context.Request
  $response = $Context.Response
  $pathName = $request.Url.AbsolutePath

  if ($request.HttpMethod -eq 'GET' -and $pathName -eq '/api/orders') {
    Send-JsonResponse -Response $response -StatusCode 200 -Payload @{ orders = @(Read-Orders) }
    return $true
  }

  if ($request.HttpMethod -eq 'POST' -and $pathName -eq '/api/orders') {
    try {
      $payload = Read-RequestJson $request
      $order = New-Order $payload
      $orders = @(Read-Orders)
      $orders = @($order) + $orders
      Write-Orders $orders
      $telegram = Send-TelegramMessage (Format-OrderMessage $order)
      Send-JsonResponse -Response $response -StatusCode 201 -Payload @{ order = $order; telegram = $telegram }
    } catch {
      Send-JsonResponse -Response $response -StatusCode 400 -Payload @{ error = $_.Exception.Message }
    }
    return $true
  }

  return $false
}

function Serve-StaticFile {
  param([System.Net.HttpListenerContext]$Context)

  $requestPath = [Uri]::UnescapeDataString($Context.Request.Url.AbsolutePath)
  if ($requestPath -eq '/') { $requestPath = '/index.html' }
  $relative = $requestPath.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
  $filePath = [IO.Path]::GetFullPath((Join-Path $Root $relative))
  $rootPath = [IO.Path]::GetFullPath($Root)
  $pathParts = @($relative.Split([IO.Path]::DirectorySeparatorChar, [System.StringSplitOptions]::RemoveEmptyEntries))
  $hasBlockedPart = @($pathParts | Where-Object { $_.StartsWith('.') -or $_ -eq 'data' }).Count -gt 0

  if (!$filePath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -or $hasBlockedPart) {
    Send-TextResponse -Response $Context.Response -StatusCode 403 -Body 'Forbidden'
    return
  }

  if (!(Test-Path -LiteralPath $filePath -PathType Leaf)) {
    Send-TextResponse -Response $Context.Response -StatusCode 404 -Body 'Not found'
    return
  }

  $extension = [IO.Path]::GetExtension($filePath).ToLowerInvariant()
  $contentType = $Mime[$extension]
  if (!$contentType) { $contentType = 'application/octet-stream' }

  $bytes = [IO.File]::ReadAllBytes($filePath)
  $Context.Response.StatusCode = 200
  $Context.Response.ContentType = $contentType
  $Context.Response.Headers['Cache-Control'] = 'no-cache'
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Context.Response.OutputStream.Close()
}

Initialize-Store
Import-DotEnv

$listener = [System.Net.HttpListener]::new()
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
  Write-ServerLog "Started $prefix"
  Write-Host "Brilliant Menu server: $prefix"
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    try {
      if ($context.Request.Url.AbsolutePath.StartsWith('/api/')) {
        $handled = Handle-Api $context
        if ($handled) { continue }
      }
      Serve-StaticFile $context
    } catch {
      Write-ServerLog "Request error: $($_.Exception.Message)"
      if ($context.Response.OutputStream.CanWrite) {
        Send-JsonResponse -Response $context.Response -StatusCode 500 -Payload @{ error = 'Server error' }
      }
    }
  }
} catch {
  Write-ServerLog "Fatal error: $($_.Exception.Message)"
  throw
} finally {
  if ($listener.IsListening) { $listener.Stop() }
  $listener.Close()
}
