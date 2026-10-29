# dsh-print —— DSH 打印插件

给 DeepSeek Harness 加「打印」能力：

- 打印 **PDF / 图片 / 文本**，以及 **docx/xlsx/pptx** 等 Office 文件（先转 PDF）；
- 读取 **全能扫描王（CamScanner）本地库**，把扫描件按页直接送打印；
- 查看/取消 Windows 打印队列、打测试页；
- 全程「先出计划、确认后才打印」，每次调用写审计日志。

> **为什么不“接入扫描王来打印”？** 全能扫描王 PC 版（Electron/VS Code 派生）没有对外
> API/SDK/CLI 打印入口：它的打印是主进程内部 `PrintService`（`webContents.print()`），静默打印
> `silentPrintPdf` 只对内部渲染进程开放；资源管理器右键动词只有「转 Word / 转 PDF / PDF 转图片 / AI 助手」，
> **没有打印**。所以本插件自己做打印引擎，只把扫描王当**只读数据源**（`camscanner.db` + 页图）。

## 工具

| 工具 | 说明 |
|---|---|
| `print_status` | 打印机/默认打印机/队列、helper 状态、Office 转换后端、CamScanner 库、配置摘要。只读。 |
| `print_file` | 打印文件。默认只出计划；`confirm=true` 执行；`preview=true` 先渲染前两页 PNG。 |
| `print_test_page` | 打一张 A4 测试页（时间、打印机名、边框、对齐线）。 |
| `print_jobs` | 查看打印队列（任务号、状态、页数、队列位置）。 |
| `print_cancel` | 取消任务（`jobId` 或 `all=true`），默认先计划。 |
| `print_camscanner_docs` | 列出扫描王本地库文档与每页质量（全高清 / 仅预览 / 缺页图）。只读。 |
| `print_camscanner_doc` | 打印扫描件（序号/ID/标题），支持页范围、份数、纸型、预览。 |

支持的格式：`.pdf`；`.png/.jpg/.jpeg/.bmp/.tif/.tiff/.gif`；`.txt/.md/.markdown/.log`；
`.doc/.docx/.xls/.xlsx/.ppt/.pptx/.odt/.ods/.odp/.rtf`（需 Office 转换后端）。

## 安装

前提：Windows 10/11、Windows PowerShell 5.1（系统自带）、DSH desktop profile。

1. **复制到安装副本**（排除开发产物）：

   ```powershell
   robocopy "D:\DSH workspace\dsh-print" "$env:USERPROFILE\dsh-bundles\print" /MIR /XD .git test node_modules
   ```

2. **装 Office 转换后端（可选，但 docx/xlsx/pptx 需要）**——LibreOffice Kit：

   ```powershell
   $root = "$env:LOCALAPPDATA\dsh-print\office-kit"
   New-Item -ItemType Directory -Force $root | Out-Null
   @'
   { "name": "dsh-print-office-kit", "private": true, "type": "module",
     "dependencies": {
       "@deepseek-ai/libreoffice-kit": "0.2.3",
       "@deepseek-ai/libreoffice-kit-win32-x64": "0.2.3"
     } }
   '@ | Set-Content "$root\package.json" -Encoding utf8
   # 用 DSH 自带的 node + pnpm（路径见 load_workspace_dependencies）
   node <pnpm.mjs> install --ignore-scripts --registry https://registry.npmmirror.com
   ```

   Windows x64 装 `win32-x64`；其它平台换成对应 engine 包（`win32-arm64` / `darwin-*` / `wasm`）。
   也可以装系统版 LibreOffice，插件会自动探测 `C:\Program Files\LibreOffice\program\soffice.exe`。
   插件还需要一个 Node 运行时跑 Kit 的 CLI，默认用 DSH 运行时自带的 `node.exe` 自动探测。

3. **装进 profile**：

   ```powershell
   dsh plugin --profile desktop add link:C:/Users/11210/dsh-bundles/print
   ```

   然后把 `@local/print` 追加到 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的
   `dsh.profile.bundles` 数组里（插件包本身不带 loader 行，必须显式列进 bundles）。

4. **重启 DSH**（或把插件页里的 print 关开一次），新会话里应看到 7 个 `print_*` 工具。

## 配置

配置在安装副本的 `cordis.patch.yml`（仓库里的那份只是模板）：

```yaml
- insert:
    - id: print
      name: '@local/print'
      config:
        powershellPath: ''      # 空=自动找 Windows PowerShell 5.1
        helperPath: ''          # 空=安装副本里的 lib/helper/print-helper.ps1
        timeoutMs: 180000
        requestTimeoutMs: 15000
        defaultPrinter: ''      # 空=系统默认
        confirmRequired: true   # 所有打印先计划
        dryRun: false           # true=只出计划，永不打印
        maxFiles: 20
        maxPages: 300
        allowPromptPrinters: false  # Microsoft Print to PDF 等需要弹框的默认拒绝
        auditEnabled: true
        auditFile: ''           # 空=%LOCALAPPDATA%\dsh-print\audit.jsonl
        camscanner:
          enabled: true
          dbPath: ''            # 空=%APPDATA%\CamScanner\Camscanner\camscanner.db
        office:
          enabled: true
          sofficePath: ''       # 空=自动探测 Kit → 系统 LibreOffice
          kitCliPath: ''        # 空=自动探测 %LOCALAPPDATA%\dsh-print\office-kit
          nodePath: ''          # 空=自动探测 DSH 运行时的 node.exe
          timeoutMs: 120000
```

改配置后把插件关开一次或重启 DSH；改 `lib/` 代码必须重启。

## 安全模型

- **先计划后执行**：所有打印工具在 `confirm=true` 之前只返回计划（文件、页数、份数、纸型、
  目标打印机），不向队列提交任何任务。
- **dryRun**：配置开启后即使 `confirm=true` 也只出计划。
- **虚拟打印机**：`Microsoft Print to PDF` / XPS 这类会弹「保存」对话框的打印机默认拒绝
  （`allowPromptPrinters=true` 才放行），避免卡在无人值守的对话框上。
- **上限**：`maxFiles` / `maxPages` 防止误打整本文档。
- **审计**：每次打印写 `%LOCALAPPDATA%\dsh-print\audit.jsonl`（时间、工具、文件、打印机、页数、结果、耗时）。
- **只读扫描王**：以 `readOnly` 打开 SQLite，只 `SELECT`；不改库、不动页图、不启动 App。

## 实现结构

```
lib/index.js            Cordis 入口（7 个工具，ctx.effect 注册）
lib/config.js           配置归一 + 路径解析（PowerShell / helper / 审计 / 扫描王库）
lib/helper-session.js   一次性 PowerShell 5.1 调用（EncodedCommand + JSON）
lib/office.js           Office → PDF（LibreOffice Kit / 系统 soffice）
lib/camscanner.js       扫描王本地库只读解析（页图优先级 + basename 兜底）
lib/tools/*.js          工具实现
lib/helper/print-helper.ps1   WinRT(PDF→位图) + System.Drawing(PrintDocument) 引擎
lib/helper/PROTOCOL.md  helper 协议
```

打印链路：`print_file` → helper；PDF 用 `Windows.Data.Pdf` 逐页渲染成位图，
图片/文本/测试页用 GDI+ 排版，统一交给 `System.Drawing.Printing.PrintDocument` 进打印队列。
Office 文件先转 PDF 再走同一条链路。helper 是一次性进程，退出即释放。

## 已知限制

- 扫描王升级可能改 `camscanner.db` 表结构：读取层会优雅报 `E_CAMSCANNER_DB`，不影响 PDF/图片打印。
- 扫描件只有 1000px 预览图时（约 120 DPI）打印会偏糊；在 App 里打开该文档一次可生成全高清页图。
  缺页图的页会明确报 `E_CAMSCANNER_PAGE`，不会静默跳过。
- 双面/份数是否生效取决于打印机驱动；份数由插件按页循环保证，不依赖驱动。
- 文本打印按 50 行/页估算页数，实际分页以打印时排版为准。
- 不驱动扫描王 UI（不弹它的打印对话框、不注入进程），也不做云端扫描/打印。

## 排错

| 现象 | 处理 |
|---|---|
| `E_HELPER` / helper 输出无法解析 | 确认 `powershell.exe` 是 5.1；`print-helper.ps1` 必须 UTF-8 **with BOM**（改了文件要重新加 BOM） |
| `E_TIMEOUT` | 大文件渲染慢，调大 `timeoutMs`；或先用 `preview=true` 看前两页 |
| `E_PRINTER_NOT_FOUND` | `print_status` 看可用打印机；注意打印机名要完全一致 |
| `E_PRINTER_PROMPT` | 目标是 PDF/XPS 虚拟打印机；换实体打印机，或临时开 `allowPromptPrinters` |
| `E_OFFICE_MISSING` | 按「安装」第 2 步装 LibreOffice Kit，或装系统 LibreOffice |
| `E_CAMSCANNER_DB` | 先打开一次扫描王并登录；或配置 `camscanner.dbPath` 指向 `camscanner.db` |
| 打印任务一直不出纸 | `print_jobs` 看状态；必要时 `print_cancel` 清队列，再检查打印机电源/纸张/驱动 |

## 开发

```powershell
node --test "test/*.test.js"          # 单元测试（假 helper，不碰打印机）
$env:DSH_PRINT_LIVE=1; node --test test/live.test.js   # 真机 helper 冒烟（只写 spool 文件）
```

License: MIT
