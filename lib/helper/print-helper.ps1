# dsh-print helper —— Windows PowerShell 5.1 打印/渲染引擎
#
# 由 DSH 插件以一次性进程调用：
#   powershell.exe -NoLogo -NoProfile -NonInteractive -Sta -ExecutionPolicy Bypass -EncodedCommand <base64>
# EncodedCommand 只做两件事：dot-source 本文件，然后调用
#   Invoke-DshPrintAction -Action <动作> -PayloadFile <UTF-8 JSON 路径>
# 结果固定输出一行 JSON：{"ok":true,"data":{...}} 或 {"ok":false,"error":{code,message,detail}}
#
# 为什么必须是 Windows PowerShell 5.1：Windows.Data.Pdf 这类 WinRT 类型只有在
# .NET Framework 的 WindowsRuntime 投影下才能可靠加载（pwsh 7 上加载不了）。
#
# 动作：info / inspect / print-pdf / print-images / print-text / test-page / preview / jobs / cancel

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing

$script:WinRTReady = $false
$script:AsTaskGeneric = $null
$script:AsTaskAction = $null
$script:DshPrintState = $null

# ---------------------------------------------------------------------------
# 基础输出与参数
# ---------------------------------------------------------------------------

function Write-DshResult {
    param($Object)
    [Console]::Out.WriteLine(($Object | ConvertTo-Json -Depth 12 -Compress))
}

function Get-Field {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    if ($null -eq $property.Value) { return $Default }
    return $property.Value
}

function Read-Payload {
    param([string]$PayloadFile)
    if ([string]::IsNullOrEmpty($PayloadFile)) { return [pscustomobject]@{} }
    if (-not (Test-Path -LiteralPath $PayloadFile)) {
        throw "[E_BAD_ARGS] payload 文件不存在：$PayloadFile"
    }
    $json = [System.IO.File]::ReadAllText($PayloadFile, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($json)) { return [pscustomobject]@{} }
    return ConvertFrom-Json $json
}

function Get-IntField {
    param($Object, [string]$Name, [int]$Default)
    $value = Get-Field $Object $Name $Default
    try { return [int]$value } catch { return $Default }
}

# ---------------------------------------------------------------------------
# WinRT / PDF
# ---------------------------------------------------------------------------

function Initialize-WinRT {
    if ($script:WinRTReady) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

    $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $script:AsTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
    if ($null -eq $script:AsTaskGeneric -or $null -eq $script:AsTaskAction) {
        throw '[E_WINRT] 找不到 WindowsRuntimeSystemExtensions.AsTask 方法'
    }
    $script:WinRTReady = $true
}

function Wait-Operation {
    param($Operation, [Type]$ResultType)
    $task = $script:AsTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait(-1) | Out-Null
    return $task.Result
}

function Wait-Action {
    param($Action)
    $task = $script:AsTaskAction.Invoke($null, @($Action))
    $task.Wait(-1) | Out-Null
}

function Open-PdfDocument {
    param([string]$Path)
    Initialize-WinRT
    if (-not (Test-Path -LiteralPath $Path)) { throw "[E_FILE_NOT_FOUND] PDF 不存在：$Path" }
    $full = (Resolve-Path -LiteralPath $Path).Path
    $file = Wait-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
    try {
        $document = Wait-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
    }
    catch {
        $message = $_.Exception.Message
        if ($message -match 'password|encrypt|加密|密码') {
            throw "[E_PDF_ENCRYPTED] PDF 已加密，无法渲染：$Path（$message）"
        }
        throw "[E_PDF_RENDER] 无法打开 PDF（可能已损坏或不受支持）：$Path（$message）"
    }
    return $document
}

function Get-PdfPageSize {
    param($Document, [int]$Index)
    $page = $Document.GetPage($Index)
    return @{ width = [math]::Round($page.Size.Width, 1); height = [math]::Round($page.Size.Height, 1) }
}

function Render-PdfPageBitmap {
    param($Document, [int]$Index, [int]$TargetWidth)
    $page = $Document.GetPage($Index)
    $randomAccessStream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $options.DestinationWidth = [uint32]$TargetWidth
    try {
        $action = $page.RenderToStreamAsync($randomAccessStream, $options)
        Wait-Action $action
        $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($randomAccessStream)
        $memory = New-Object System.IO.MemoryStream
        try {
            $netStream.CopyTo($memory)
            $memory.Position = 0
            $image = [System.Drawing.Image]::FromStream($memory)
            try {
                return New-Object System.Drawing.Bitmap($image)
            }
            finally {
                $image.Dispose()
            }
        }
        finally {
            $netStream.Dispose()
            $memory.Dispose()
        }
    }
    catch {
        throw "[E_PDF_RENDER] 渲染 PDF 第 $($Index + 1) 页失败：$($_.Exception.Message)"
    }
    finally {
        $page = $null
        $randomAccessStream.Dispose()
    }
}

# ---------------------------------------------------------------------------
# 打印机 / 队列
# ---------------------------------------------------------------------------

function Get-PrinterList {
    $items = @()
    try {
        $items = @(Get-Printer -ErrorAction Stop | ForEach-Object {
                [pscustomobject]@{
                    name          = [string]$_.Name
                    driverName    = [string]$_.DriverName
                    portName      = [string]$_.PortName
                    printerStatus = [string]$_.PrinterStatus
                    shared        = [bool]$_.Shared
                    published     = [bool]$_.Published
                    jobCount      = [int]$_.JobCount
                }
            })
    }
    catch {
        try {
            $items = @(Get-CimInstance -ClassName Win32_Printer -ErrorAction Stop | ForEach-Object {
                    [pscustomobject]@{
                        name          = [string]$_.Name
                        driverName    = [string]$_.DriverName
                        portName      = [string]$_.PortName
                        printerStatus = [string]$_.Status
                        shared        = [bool]$_.Shared
                        published     = [bool]$_.Published
                        jobCount      = 0
                    }
                })
        }
        catch {
            $items = @()
        }
    }
    return $items
}

function Get-DefaultPrinterName {
    try {
        $value = Get-CimInstance -ClassName Win32_Printer -Filter 'Default=TRUE' -ErrorAction Stop |
            Select-Object -First 1
        if ($null -ne $value) { return [string]$value.Name }
    }
    catch {
        # 忽略。
    }
    try {
        $settings = New-Object System.Drawing.Printing.PrinterSettings
        return [string]$settings.PrinterName
    }
    catch {
        return ''
    }
}

function Get-PaperNames {
    param([string]$Printer)
    if ([string]::IsNullOrEmpty($Printer)) { return @() }
    try {
        $settings = New-Object System.Drawing.Printing.PrinterSettings
        $settings.PrinterName = $Printer
        if (-not $settings.IsValid) { return @() }
        return @($settings.PaperSizes | ForEach-Object { [string]$_.PaperName } | Where-Object { $_ -ne '' })
    }
    catch {
        return @()
    }
}

function Resolve-PaperSize {
    param($Document, [string]$PaperName)
    if ([string]::IsNullOrEmpty($PaperName)) { return $null }
    try {
        $match = $Document.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -eq $PaperName } | Select-Object -First 1
        if ($null -ne $match) { return $match }
        return $Document.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -like "*$PaperName*" } | Select-Object -First 1
    }
    catch {
        return $null
    }
}

function Get-JobSnapshot {
    param([string]$Printer)
    $jobs = @()
    try {
        if ([string]::IsNullOrEmpty($Printer)) {
            $jobs = @(Get-PrintJob -ErrorAction SilentlyContinue)
        }
        else {
            $jobs = @(Get-PrintJob -PrinterName $Printer -ErrorAction SilentlyContinue)
        }
    }
    catch {
        $jobs = @()
    }
    if ($jobs.Count -eq 0) {
        try {
            $cimFilter = if ([string]::IsNullOrEmpty($Printer)) { $null } else { "PrinterName='$($Printer.Replace("'", "''"))'" }
            $cimJobs = if ($null -eq $cimFilter) { @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue) }
            else { @(Get-CimInstance Win32_PrintJob -Filter $cimFilter -ErrorAction SilentlyContinue) }
            return @($cimJobs | ForEach-Object {
                    [pscustomobject]@{
                        id          = [int]$_.JobId
                        document    = [string]$_.Document
                        status      = [string]$_.JobStatus
                        pages       = [int]$_.PagesPrinted
                        totalPages  = [int]$_.TotalPages
                        submittedAt = ''
                        position    = 0
                    }
                })
        }
        catch {
            return @()
        }
    }
    return @($jobs | ForEach-Object {
            [pscustomobject]@{
                id          = [int]$_.Id
                document    = [string]$_.DocumentName
                status      = [string]$_.JobStatus
                pages       = [int]$_.PagesPrinted
                totalPages  = [int]$_.TotalPages
                submittedAt = if ($null -ne $_.SubmittedTime) { $_.SubmittedTime.ToString('s') } else { '' }
                position    = [int]$_.Position
            }
        })
}

# ---------------------------------------------------------------------------
# 页面范围
# ---------------------------------------------------------------------------

function ConvertTo-PageIndexes {
    param([string]$Spec, [int]$TotalPages)
    if ($TotalPages -lt 1) { throw '[E_BAD_ARGS] 文档没有可打印的页' }
    if ([string]::IsNullOrEmpty($Spec) -or $Spec -eq 'all') {
        return @(0..($TotalPages - 1))
    }
    $indexes = New-Object System.Collections.Generic.List[int]
    foreach ($part in ($Spec -replace '，', ',').Split(',')) {
        $trimmed = $part.Trim()
        if ($trimmed -eq '') { continue }
        if ($trimmed -notmatch '^(\d+)(?:\s*-\s*(\d+))?$') {
            throw "[E_BAD_ARGS] 页面范围写法不对：$trimmed"
        }
        $start = [int]$Matches[1]
        $end = if ($Matches[2]) { [int]$Matches[2] } else { $start }
        if ($start -lt 1 -or $end -lt $start -or $end -gt $TotalPages) {
            throw "[E_BAD_ARGS] 页面范围 $trimmed 超出 1..$TotalPages"
        }
        for ($page = $start; $page -le $end; $page++) {
            if (-not $indexes.Contains($page - 1)) { $indexes.Add($page - 1) }
        }
    }
    $indexes.Sort()
    if ($indexes.Count -eq 0) { throw '[E_BAD_ARGS] 页面范围为空' }
    return $indexes.ToArray()
}

# ---------------------------------------------------------------------------
# 排版与打印
# ---------------------------------------------------------------------------

function Draw-FitImage {
    param($Graphics, $Image, $Bounds)
    $scale = [math]::Min($Bounds.Width / $Image.Width, $Bounds.Height / $Image.Height)
    $width = [int][math]::Round($Image.Width * $scale)
    $height = [int][math]::Round($Image.Height * $scale)
    if ($width -lt 1) { $width = 1 }
    if ($height -lt 1) { $height = 1 }
    $x = [int]($Bounds.X + ($Bounds.Width - $width) / 2)
    $y = [int]($Bounds.Y + ($Bounds.Height - $height) / 2)
    $rectangle = New-Object System.Drawing.Rectangle($x, $y, $width, $height)
    $Graphics.DrawImage($Image, $rectangle)
}

function Draw-TestPage {
    param($Graphics, $Bounds, $Printer, $PageNumber, $TotalPages)
    $titleFont = New-Object System.Drawing.Font('Microsoft YaHei', 24, [System.Drawing.FontStyle]::Bold)
    $bodyFont = New-Object System.Drawing.Font('Microsoft YaHei', 11)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 120, 120), 1)
    try {
        $Graphics.DrawString('dsh-print 测试页', $titleFont, [System.Drawing.Brushes]::Black, $Bounds.Left, $Bounds.Top)
        $lines = @(
            "打印机：$Printer"
            "时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
            "第 $PageNumber / $TotalPages 页"
            "如果用纸正常，这张页说明打印链路（WinRT/GDI → 打印队列）可用。"
        )
        $y = $Bounds.Top + 90
        foreach ($line in $lines) {
            $Graphics.DrawString($line, $bodyFont, [System.Drawing.Brushes]::Black, $Bounds.Left, $y)
            $y += 40
        }
        $Graphics.DrawLine($pen, $Bounds.Left, $Bounds.Top, $Bounds.Right, $Bounds.Top)
        $Graphics.DrawLine($pen, $Bounds.Left, $Bounds.Bottom, $Bounds.Right, $Bounds.Bottom)
        $Graphics.DrawLine($pen, $Bounds.Left, $Bounds.Top, $Bounds.Left, $Bounds.Bottom)
        $Graphics.DrawLine($pen, $Bounds.Right, $Bounds.Top, $Bounds.Right, $Bounds.Bottom)
        $centerX = [int](($Bounds.Left + $Bounds.Right) / 2)
        $centerY = [int](($Bounds.Top + $Bounds.Bottom) / 2)
        $Graphics.DrawLine($pen, $centerX - 60, $centerY, $centerX + 60, $centerY)
        $Graphics.DrawLine($pen, $centerX, $centerY - 60, $centerX, $centerY + 60)
    }
    finally {
        $titleFont.Dispose()
        $bodyFont.Dispose()
        $pen.Dispose()
    }
}

function Draw-TextPage {
    param($Graphics, $Bounds, $State)
    $font = $State.Font
    $lineHeight = [math]::Max(14, [math]::Round($font.GetHeight($Graphics)))
    $y = $Bounds.Top
    while ($State.TextCursor -lt $State.Lines.Count) {
        if ($y + $lineHeight -gt $Bounds.Bottom) { break }
        $line = [string]$State.Lines[$State.TextCursor]
        if ($line.Length -gt 0) {
            $Graphics.DrawString($line, $font, [System.Drawing.Brushes]::Black, $Bounds.Left, $y)
        }
        $y += $lineHeight
        $State.TextCursor += 1
    }
    $State.PrintedPages += 1
    if ($State.TextCursor -ge $State.Lines.Count) {
        $State.CopiesDone += 1
        if ($State.CopiesDone -lt $State.Copies) {
            $State.TextCursor = 0
            $State.HasMore = $true
        }
        else {
            $State.HasMore = $false
        }
    }
    else {
        $State.HasMore = $true
    }
}

function Invoke-DshPrintPage {
    param($Sender, $Event)
    $state = $script:DshPrintState
    try {
        if ($null -eq $state) { $Event.HasMorePages = $false; return }
        $graphics = $Event.Graphics
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $bounds = $Event.MarginBounds

        switch ($state.Kind) {
            'pdf' {
                $targetWidth = [int][math]::Max(600, [math]::Min(2400, $bounds.Width * 2.4))
                $bitmap = Render-PdfPageBitmap -Document $state.Document -Index $state.Sequence[$state.Position] -TargetWidth $targetWidth
                try {
                    Draw-FitImage -Graphics $graphics -Image $bitmap -Bounds $bounds
                }
                finally {
                    $bitmap.Dispose()
                }
                $state.PrintedPages += 1
                $state.Position += 1
                $Event.HasMorePages = ($state.Position -lt $state.Sequence.Count)
            }
            'images' {
                $path = [string]$state.Images[$state.Sequence[$state.Position]]
                if (-not (Test-Path -LiteralPath $path)) { throw "[E_IMAGE_BROKEN] 图片不存在：$path" }
                $image = [System.Drawing.Image]::FromFile($path)
                try {
                    Draw-FitImage -Graphics $graphics -Image $image -Bounds $bounds
                }
                finally {
                    $image.Dispose()
                }
                $state.PrintedPages += 1
                $state.Position += 1
                $Event.HasMorePages = ($state.Position -lt $state.Sequence.Count)
            }
            'text' {
                Draw-TextPage -Graphics $graphics -Bounds $bounds -State $state
                $Event.HasMorePages = [bool]$state.HasMore
            }
            'test' {
                Draw-TestPage -Graphics $graphics -Bounds $bounds -Printer $state.Printer -PageNumber ($state.Position + 1) -TotalPages $state.Copies
                $state.PrintedPages += 1
                $state.Position += 1
                $Event.HasMorePages = ($state.Position -lt $state.Copies)
            }
            default {
                $Event.HasMorePages = $false
            }
        }
    }
    catch {
        # 事件处理器里抛异常会被 GDI 吞掉，这里转成打印取消 + 记录，由外层 Print() 抛出。
        $script:DshPrintError = $_.Exception
        $Event.Cancel = $true
        $Event.HasMorePages = $false
    }
}

function Invoke-PrintPipeline {
    param($State, $Payload, [string]$DocumentName)
    $printer = [string](Get-Field $Payload 'printer' '')
    if ([string]::IsNullOrEmpty($printer)) { throw '[E_PRINTER_NOT_FOUND] 没有指定打印机' }
    $spoolFile = [string](Get-Field $Payload 'spoolFile' '')
    $paper = [string](Get-Field $Payload 'paper' '')
    $orientation = [string](Get-Field $Payload 'orientation' '')
    $color = [bool](Get-Field $Payload 'color' $true)
    $duplex = [string](Get-Field $Payload 'duplex' 'simplex')

    $document = New-Object System.Drawing.Printing.PrintDocument
    $document.PrinterSettings.PrinterName = $printer
    if (-not $document.PrinterSettings.IsValid) {
        throw "[E_PRINTER_NOT_FOUND] 打印机不可用：$printer"
    }
    if ($paper -ne '') {
        $paperSize = Resolve-PaperSize -Document $document -PaperName $paper
        if ($null -ne $paperSize) { $document.DefaultPageSettings.PaperSize = $paperSize }
    }
    if ($orientation -eq 'landscape') { $document.DefaultPageSettings.Landscape = $true }
    elseif ($orientation -eq 'portrait') { $document.DefaultPageSettings.Landscape = $false }
    $document.DefaultPageSettings.Color = $color
    switch ($duplex) {
        'short' { try { $document.PrinterSettings.Duplex = [System.Drawing.Printing.Duplex]::Vertical } catch { } }
        'long' { try { $document.PrinterSettings.Duplex = [System.Drawing.Printing.Duplex]::Horizontal } catch { } }
        default { try { $document.PrinterSettings.Duplex = [System.Drawing.Printing.Duplex]::Simplex } catch { } }
    }
    if ($spoolFile -ne '') {
        $spoolDir = Split-Path -Parent $spoolFile
        if ($spoolDir -and -not (Test-Path -LiteralPath $spoolDir)) {
            New-Item -ItemType Directory -Force -Path $spoolDir | Out-Null
        }
        $document.PrinterSettings.PrintToFile = $true
        $document.PrinterSettings.PrintFileName = $spoolFile
    }
    $document.DocumentName = $DocumentName

    $script:DshPrintState = $State
    $script:DshPrintError = $null
    $startedAt = Get-Date
    $document.add_PrintPage({ param($sender, $event) Invoke-DshPrintPage $sender $event })
    try {
        $document.Print()
    }
    catch {
        if ($null -ne $script:DshPrintError) {
            throw "[E_SPOOL] 打印页渲染失败：$($script:DshPrintError.Message)"
        }
        throw "[E_SPOOL] 提交打印任务失败：$($_.Exception.Message)"
    }
    finally {
        $document.Dispose()
        $script:DshPrintState = $null
    }
    $elapsed = [int]((Get-Date) - $startedAt).TotalMilliseconds
    return @{
        documentName = $DocumentName
        printer      = $printer
        pages        = [int]$State.PrintedPages
        copies       = [int]$State.Copies
        spoolFile    = $spoolFile
        elapsedMs    = $elapsed
    }
}

# ---------------------------------------------------------------------------
# 动作实现
# ---------------------------------------------------------------------------

function Get-InfoPayload {
    $winrtOk = $false
    $winrtError = ''
    try {
        Initialize-WinRT
        $winrtOk = $true
    }
    catch {
        $winrtError = $_.Exception.Message
    }
    $printers = @(Get-PrinterList)
    $defaultPrinter = Get-DefaultPrinterName
    $jobCount = 0
    try { $jobCount = @(Get-PrintJob -ErrorAction SilentlyContinue).Count } catch { }
    return @{
        psVersion       = $PSVersionTable.PSVersion.ToString()
        osVersion       = [Environment]::OSVersion.VersionString
        userInteractive = [Environment]::UserInteractive
        elevated        = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        winrtOk         = $winrtOk
        winrtError      = $winrtError
        drawingOk       = $true
        printers        = $printers
        defaultPrinter  = $defaultPrinter
        printJobs       = [int]$jobCount
        paperSizes      = @(Get-PaperNames $defaultPrinter)
    }
}

function Get-InspectPayload {
    param($Payload)
    $result = @{ pdfs = @(); images = @() }
    foreach ($pdf in @(Get-Field $Payload 'pdfs' @())) {
        $path = [string]$pdf
        if ([string]::IsNullOrEmpty($path) -or -not (Test-Path -LiteralPath $path)) {
            throw "[E_FILE_NOT_FOUND] PDF 不存在：$path"
        }
        $document = Open-PdfDocument -Path $path
        $sizes = @()
        for ($index = 0; $index -lt [int]$document.PageCount; $index++) {
            $sizes += Get-PdfPageSize -Document $document -Index $index
        }
        $result.pdfs += @{ path = $path; pages = [int]$document.PageCount; sizes = $sizes }
    }
    foreach ($image in @(Get-Field $Payload 'images' @())) {
        $path = [string]$image
        if ([string]::IsNullOrEmpty($path) -or -not (Test-Path -LiteralPath $path)) {
            throw "[E_FILE_NOT_FOUND] 图片不存在：$path"
        }
        try {
            $bitmap = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $path).Path)
            try {
                $result.images += @{ path = $path; width = [int]$bitmap.Width; height = [int]$bitmap.Height }
            }
            finally {
                $bitmap.Dispose()
            }
        }
        catch {
            throw "[E_IMAGE_BROKEN] 图片无法解码：$path（$($_.Exception.Message)）"
        }
    }
    return $result
}

function Invoke-PrintPdfAction {
    param($Payload)
    $pdfPath = [string](Get-Field $Payload 'pdf' '')
    if ($pdfPath -eq '') { throw '[E_BAD_ARGS] 缺少 pdf 参数' }
    $document = Open-PdfDocument -Path $pdfPath
    $copies = [math]::Max(1, (Get-IntField $Payload 'copies' 1))
    $selection = ConvertTo-PageIndexes -Spec ([string](Get-Field $Payload 'pages' 'all')) -TotalPages ([int]$document.PageCount)
    $sequence = New-Object System.Collections.Generic.List[int]
    for ($copy = 0; $copy -lt $copies; $copy++) {
        foreach ($index in $selection) { $sequence.Add([int]$index) }
    }
    $name = [string](Get-Field $Payload 'documentName' ([System.IO.Path]::GetFileName($pdfPath)))
    $state = @{
        Kind         = 'pdf'
        Document     = $document
        Images       = @()
        Sequence     = $sequence.ToArray()
        Position     = 0
        PrintedPages = 0
        Copies       = $copies
        Lines        = @()
        TextCursor   = 0
        CopiesDone   = 0
        HasMore      = $false
        Printer      = [string](Get-Field $Payload 'printer' '')
    }
    return Invoke-PrintPipeline -State $state -Payload $Payload -DocumentName $name
}

function Invoke-PrintImagesAction {
    param($Payload)
    $images = @(@(Get-Field $Payload 'images' @()) | ForEach-Object { [string]$_ })
    if ($images.Count -eq 0) { throw '[E_BAD_ARGS] 缺少 images 参数' }
    foreach ($path in $images) {
        if (-not (Test-Path -LiteralPath $path)) { throw "[E_FILE_NOT_FOUND] 图片不存在：$path" }
    }
    $copies = [math]::Max(1, (Get-IntField $Payload 'copies' 1))
    $selection = ConvertTo-PageIndexes -Spec ([string](Get-Field $Payload 'pages' 'all')) -TotalPages $images.Count
    $sequence = New-Object System.Collections.Generic.List[int]
    for ($copy = 0; $copy -lt $copies; $copy++) {
        foreach ($index in $selection) { $sequence.Add([int]$index) }
    }
    $name = [string](Get-Field $Payload 'documentName' 'dsh-print images')
    $state = @{
        Kind         = 'images'
        Document     = $null
        Images       = $images
        Sequence     = $sequence.ToArray()
        Position     = 0
        PrintedPages = 0
        Copies       = $copies
        Lines        = @()
        TextCursor   = 0
        CopiesDone   = 0
        HasMore      = $false
        Printer      = [string](Get-Field $Payload 'printer' '')
    }
    return Invoke-PrintPipeline -State $state -Payload $Payload -DocumentName $name
}

function Invoke-PrintTextAction {
    param($Payload)
    $text = ''
    $textPath = [string](Get-Field $Payload 'textFile' '')
    $inline = [string](Get-Field $Payload 'text' '')
    if ($textPath -ne '') {
        if (-not (Test-Path -LiteralPath $textPath)) { throw "[E_FILE_NOT_FOUND] 文本文件不存在：$textPath" }
        $text = [System.IO.File]::ReadAllText($textPath, [System.Text.Encoding]::UTF8)
    }
    elseif ($inline -ne '') {
        $text = $inline
    }
    else {
        throw '[E_BAD_ARGS] 缺少 textFile 或 text'
    }
    $lines = @($text -split "\r?\n")
    if ($lines.Count -eq 0) { $lines = @('') }
    $copies = [math]::Max(1, (Get-IntField $Payload 'copies' 1))
    $name = [string](Get-Field $Payload 'documentName' 'dsh-print text')
    $state = @{
        Kind         = 'text'
        Document     = $null
        Images       = @()
        Sequence     = @()
        Position     = 0
        PrintedPages = 0
        Copies       = $copies
        Lines        = $lines
        TextCursor   = 0
        CopiesDone   = 0
        HasMore      = $true
        Font         = New-Object System.Drawing.Font('Microsoft YaHei', 11)
        Printer      = [string](Get-Field $Payload 'printer' '')
    }
    try {
        return Invoke-PrintPipeline -State $state -Payload $Payload -DocumentName $name
    }
    finally {
        if ($null -ne $state.Font) { $state.Font.Dispose() }
    }
}

function Invoke-TestPageAction {
    param($Payload)
    $copies = [math]::Max(1, (Get-IntField $Payload 'copies' 1))
    $state = @{
        Kind         = 'test'
        Document     = $null
        Images       = @()
        Sequence     = @()
        Position     = 0
        PrintedPages = 0
        Copies       = $copies
        Lines        = @()
        TextCursor   = 0
        CopiesDone   = 0
        HasMore      = $false
        Printer      = [string](Get-Field $Payload 'printer' '')
    }
    $name = [string](Get-Field $Payload 'documentName' 'dsh-print 测试页')
    return Invoke-PrintPipeline -State $state -Payload $Payload -DocumentName $name
}

function Invoke-PreviewAction {
    param($Payload)
    $outDir = [string](Get-Field $Payload 'outDir' '')
    if ($outDir -eq '') { throw '[E_BAD_ARGS] 缺少 outDir' }
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $maxPages = [math]::Max(1, (Get-IntField $Payload 'maxPages' 2))
    $files = @()
    $pdfPath = [string](Get-Field $Payload 'pdf' '')
    if ($pdfPath -ne '') {
        $document = Open-PdfDocument -Path $pdfPath
        $total = [int]$document.PageCount
        $selection = ConvertTo-PageIndexes -Spec ([string](Get-Field $Payload 'pages' 'all')) -TotalPages $total
        $count = 0
        foreach ($index in $selection) {
            if ($count -ge $maxPages) { break }
            $bitmap = Render-PdfPageBitmap -Document $document -Index $index -TargetWidth 1200
            try {
                $file = Join-Path $outDir ("page-{0:D3}.png" -f ($index + 1))
                $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
                $files += @{ page = $index + 1; path = $file; width = $bitmap.Width; height = $bitmap.Height }
            }
            finally {
                $bitmap.Dispose()
            }
            $count += 1
        }
    }
    foreach ($image in @(Get-Field $Payload 'images' @())) {
        if ($files.Count -ge $maxPages) { break }
        $path = [string]$image
        if (-not (Test-Path -LiteralPath $path)) { throw "[E_FILE_NOT_FOUND] 图片不存在：$path" }
        try {
            $bitmap = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $path).Path)
            try {
                $file = Join-Path $outDir ("image-{0:D3}.png" -f ($files.Count + 1))
                $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
                $files += @{ page = $files.Count + 1; path = $file; width = $bitmap.Width; height = $bitmap.Height }
            }
            finally {
                $bitmap.Dispose()
            }
        }
        catch {
            throw "[E_IMAGE_BROKEN] 图片无法解码：$path（$($_.Exception.Message)）"
        }
    }
    return @{ files = $files }
}

function Get-JobsActionPayload {
    param($Payload)
    $printer = [string](Get-Field $Payload 'printer' '')
    return @{ printer = $printer; jobs = @(Get-JobSnapshot -Printer $printer) }
}

function Invoke-CancelAction {
    param($Payload)
    $printer = [string](Get-Field $Payload 'printer' '')
    if ($printer -eq '') { throw '[E_BAD_ARGS] 取消任务需要 printer' }
    $all = [bool](Get-Field $Payload 'all' $false)
    $jobId = Get-IntField $Payload 'jobId' -1
    if ($all) {
        $jobs = @(Get-PrintJob -PrinterName $printer -ErrorAction SilentlyContinue)
        $removed = 0
        foreach ($job in $jobs) {
            try {
                Remove-PrintJob -InputObject $job -ErrorAction Stop
                $removed += 1
            }
            catch {
                throw "[E_SPOOL] 取消任务 $($job.Id) 失败：$($_.Exception.Message)"
            }
        }
        return @{ removed = $removed; printer = $printer }
    }
    if ($jobId -lt 0) { throw '[E_BAD_ARGS] 需要 jobId 或 all=true' }
    try {
        Remove-PrintJob -PrinterName $printer -ID $jobId -ErrorAction Stop
    }
    catch {
        throw "[E_SPOOL] 取消任务 $jobId 失败：$($_.Exception.Message)"
    }
    return @{ removed = 1; printer = $printer; jobId = $jobId }
}

# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

function Invoke-DshPrintAction {
    param(
        [Parameter(Mandatory = $true)][string]$Action,
        [string]$PayloadFile = ''
    )
    try {
        $payload = Read-Payload -PayloadFile $PayloadFile
        $data = switch ($Action) {
            'info' { Get-InfoPayload }
            'inspect' { Get-InspectPayload -Payload $payload }
            'print-pdf' { Invoke-PrintPdfAction -Payload $payload }
            'print-images' { Invoke-PrintImagesAction -Payload $payload }
            'print-text' { Invoke-PrintTextAction -Payload $payload }
            'test-page' { Invoke-TestPageAction -Payload $payload }
            'preview' { Invoke-PreviewAction -Payload $payload }
            'jobs' { Get-JobsActionPayload -Payload $payload }
            'cancel' { Invoke-CancelAction -Payload $payload }
            default { throw "[E_BAD_ARGS] 未知动作：$Action" }
        }
        Write-DshResult ([ordered]@{ ok = $true; data = $data })
    }
    catch {
        $message = $_.Exception.Message
        $code = 'E_HELPER'
        if ($message -match '^\[(E_[A-Z_]+)\]\s*([\s\S]*)$') {
            $code = $Matches[1]
            $message = $Matches[2]
        }
        Write-DshResult ([ordered]@{
                ok    = $false
                error = [ordered]@{
                    code    = $code
                    message = $message
                    detail  = [string]$_.ScriptStackTrace
                }
            })
    }
}
