# dsh-print helper 协议

`print-helper.ps1` 由插件以**一次性进程**调用，每次动作都：

1. 插件把参数写成 UTF-8 JSON 临时文件（`%LOCALAPPDATA%\dsh-print\tmp\payload-*.json`）；
2. 插件构造一段 PowerShell 脚本：
   ```powershell
   $ErrorActionPreference = 'Stop'
   $ProgressPreference = 'SilentlyContinue'
   [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
   . '<helper 路径>'
   Invoke-DshPrintAction -Action '<动作>' -PayloadFile '<payload 路径>'
   ```
3. 脚本按 UTF-16LE 编码成 base64，用 `powershell.exe -NoLogo -NoProfile -NonInteractive -Sta
   -ExecutionPolicy Bypass -EncodedCommand <base64>` 执行；
4. stdout 只认**最后一行**以 `{` 开头的 JSON。

成功：

```json
{"ok":true,"data":{...}}
```

失败：

```json
{"ok":false,"error":{"code":"E_PRINTER_NOT_FOUND","message":"...","detail":"..."}}
```

插件把 `error.code` 原样透传成自己的错误码。helper 必须在 Windows PowerShell **5.1**（`powershell.exe`）
下运行——`Windows.Data.Pdf` 等 WinRT 类型只在 .NET Framework 的 WindowsRuntime 投影下可加载。
另外 `print-helper.ps1` 必须保持 **UTF-8 with BOM**，否则 5.1 会按 ANSI 解码中文导致解析错误。

## 动作

| 动作 | payload | 返回 `data` |
|---|---|---|
| `info` | `{}` | `psVersion`、`winrtOk`、`printers[]`、`defaultPrinter`、`printJobs`、`paperSizes[]` 等 |
| `inspect` | `{ pdfs:[], images:[] }` | `{ pdfs:[{path,pages,sizes[]}], images:[{path,width,height}] }` |
| `print-pdf` | `{ printer, pdf, pages, copies, paper, orientation, color, duplex, documentName, spoolFile? }` | `{ pages, copies, elapsedMs, spoolFile }` |
| `print-images` | `{ printer, images[], copies, pages, paper, orientation, color, duplex, documentName }` | 同上 |
| `print-text` | `{ printer, textFile?, text?, copies, paper, orientation, color, duplex, documentName }` | 同上 |
| `test-page` | `{ printer, copies, paper, documentName, spoolFile? }` | 同上 |
| `preview` | `{ pdf?, images?, pages?, outDir, maxPages }` | `{ files:[{page,path,width,height}] }` |
| `jobs` | `{ printer? }` | `{ printer, jobs:[{id,document,status,pages,totalPages,submittedAt,position}] }` |
| `cancel` | `{ printer, jobId?, all? }` | `{ removed, printer, jobId? }` |

## 约定

- `pages` 用 `1-3,5` 或 `all`；PDF 与图片按页，文本/测试页只能是 `all`。
- `paper` 是打印机 `PaperSizes` 里的名字（如 `A4`），找不到时退回打印机默认纸。
- `copies` 由 helper 按页循环实现，不依赖驱动对 `PrinterSettings.Copies` 的支持。
- `spoolFile` 只给测试用：设置后 `PrintDocument` 走 `PrintToFile`，不碰真实打印机。
- `orientation` 为 `portrait`/`landscape`；留空表示不改打印机默认方向。
- 预览图写到 `outDir`，命名 `page-XXX.png` / `image-XXX.png`。
