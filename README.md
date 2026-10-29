# dsh-print —— DeepSeek Harness 打印插件

给 DSH 加「打印」能力：打印 **PDF / 图片 / 文本** 与 **docx/xlsx/pptx** 等 Office 文件，
读取 **全能扫描王（CamScanner）本地库** 把扫描件按页直接送打印，并提供打印队列的查看与取消。

- 仓库：<https://github.com/ABccgh/dsh-print>（0.1.0，2026-10-29 发布）
- 包名：`@local/print`，插件行 id：`print`
- 工具：**7 个 `print_*`**（见下表）
- 平台：**仅 Windows**（Windows PowerShell 5.1 + GDI/WinRT）；非 Windows 只提示不支持
- 运行时零外部依赖：`lib/**/*.js` 只 import `node:*` 与包内模块；Office 转换需要另装
  LibreOffice Kit（MPL-2.0，**不在本仓库**，见安装第 2 步）

> **为什么不「接入扫描王来打印」？** 全能扫描王 PC 版（Electron/VS Code 派生）没有对外
> API/SDK/CLI 打印入口：打印是主进程内部 `PrintService`（`webContents.print()`），静默打印
> `silentPrintPdf` 只对内部渲染进程开放；资源管理器右键动词只有「转 Word / 转 PDF / PDF 转图片 /
> AI 助手」，**没有打印**。所以本插件自己做打印引擎，只把扫描王当**只读数据源**
> （`camscanner.db` + 页图）。

---

## 1. 安装

> **从副本安装，不要从 git 工作树安装。** 安装目标会成为 profile 的 `link:` 依赖，
> 工作树里的改动会直接影响线上插件；误删工作树也会让插件失效。

仓库是源码；实际运行的是 `%USERPROFILE%\dsh-bundles\print` 下的**安装副本**。

1. 从 GitHub 克隆（或直接使用本地仓库）：

   ```powershell
   git clone https://github.com/ABccgh/dsh-print.git
   ```

2. 复制到长期保留的安装目录：

   ```powershell
   robocopy "<仓库路径>" "$env:USERPROFILE\dsh-bundles\print" /MIR /XD .git test node_modules
   ```

   `/MIR` 会删除副本里源没有的文件，所以 `DO-NOT-DELETE.txt` 是**放在仓库里**的，同步不会删掉它。

3. 装 Office 转换后端（可选；docx/xlsx/pptx 需要）——LibreOffice Kit：

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
   插件还需要一个 Node 运行时跑 Kit 的 CLI，默认自动探测 DSH 运行时自带的 `node.exe`。

4. 装进 profile（推荐用插件管理器，它会自动写 profile 的依赖与 bundles）：

   ```text
   plugin_manager  action: install_bundle  target: %USERPROFILE%\dsh-bundles\print
   ```

   手工兜底（没有插件管理器时）：

   ```powershell
   dsh plugin --profile desktop add "link:$env:USERPROFILE/dsh-bundles/print"
   # 再把 "@local/print" 追加到 <DSH_HOME>\profiles\desktop\package.json 的 dsh.profile.bundles
   ```

5. **重启 DSH**（或把插件页里的 `print` 关开一次），新会话里应看到 7 个 `print_*` 工具。

- 首次安装返回 `application: applied` 即生效（HMR 会激活新 bundle）。
- **改 `lib/` 代码**：重新 robocopy → **重启 DSH**（Host 缓存已加载的 ESM）。
- **只改 `cordis.patch.yml` 的配置值**：插件页把 `print` 关开一次即可。
- 卸载：`plugin_manager action: remove_bundle`（bundle 名 `@local/print`），再删
  `%USERPROFILE%\dsh-bundles\print`；Office Kit 可整目录删 `%LOCALAPPDATA%\dsh-print\office-kit`。

---

## 2. 工具一览

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `print_status` | 打印机/默认打印机/队列、helper 状态、Office 后端、扫描王库、配置摘要；只读 | — |
| `print_file` | 打印文件；默认只出计划，`confirm=true` 执行 | `files[]`；`printer`；`copies`；`pages`；`paper`；`orientation`；`color`；`duplex`；`preview`；`confirm` |
| `print_test_page` | 打一张 A4 测试页（时间、打印机名、边框、对齐线） | `printer`；`copies`；`confirm` |
| `print_jobs` | 查看打印队列（任务号、状态、页数、队列位置） | `printer`；`limit` |
| `print_cancel` | 取消任务；默认先出计划 | `printer`；`jobId` / `all`；`confirm` |
| `print_camscanner_docs` | 列出扫描王本地库文档与每页质量（全高清/仅预览/缺页图）；只读 | `limit` |
| `print_camscanner_doc` | 打印扫描件（序号/ID/标题），支持页范围、份数、纸型、预览 | `doc`；`printer`；`copies`；`pages`；`paper`；`orientation`；`preview`；`confirm` |

支持的格式：`.pdf`；`.png/.jpg/.jpeg/.bmp/.tif/.tiff/.gif`；`.txt/.md/.markdown/.log`；
`.doc/.docx/.xls/.xlsx/.ppt/.pptx/.odt/.ods/.odp/.rtf`（需 Office 转换后端）。

### 典型用法

```text
print_status                                         # 先看打印机、墨量提示、扫描王库
print_file files=["D:\报告.pdf"] pages="1-2"          # 只出计划
print_file files=["D:\报告.pdf"] pages="1-2" confirm=true
print_camscanner_doc doc=1 preview=true              # 先渲染前两页 PNG 核对
print_camscanner_doc doc=1 confirm=true
print_jobs                                            # 看队列
print_cancel printer="HP DeskJet 2600 series" all=true confirm=true
```

---

## 3. 配置

配置文件：安装副本里的 `cordis.patch.yml`（仓库里的同名文件是模板）。

| 键 | 默认 | 说明 |
|---|---|---|
| `powershellPath` | 空=自动 | Windows PowerShell 5.1 绝对路径 |
| `helperPath` | 空=包内 | helper 脚本路径；一般不用改 |
| `timeoutMs` | 180000 | 单次打印/渲染超时 |
| `requestTimeoutMs` | 15000 | 状态/队列这类轻量 helper 调用超时 |
| `defaultPrinter` | 空=系统默认 | 默认目标打印机 |
| `confirmRequired` | true | 所有打印先出计划，`confirm=true` 才执行 |
| `dryRun` | false | 只出计划，永不打印 |
| `maxFiles` / `maxPages` | 20 / 300 | 单次调用的文件数与页数上限 |
| `allowPromptPrinters` | false | 放行 Microsoft Print to PDF 这类需要弹框的打印机 |
| `auditEnabled` / `auditFile` | true / 空=`%LOCALAPPDATA%\dsh-print\audit.jsonl` | 审计日志（JSONL） |
| `camscanner.enabled` | true | 是否允许读扫描王本地库 |
| `camscanner.dbPath` | 空=自动 | `camscanner.db` 路径 |
| `office.enabled` | true | 是否启用 Office 转换 |
| `office.sofficePath` | 空=自动 | 系统 LibreOffice 的 `soffice.exe` |
| `office.kitCliPath` | 空=自动 | LibreOffice Kit 的 `lib/cli.js` |
| `office.nodePath` | 空=自动 | 跑 Kit CLI 的 Node 运行时 |
| `office.timeoutMs` | 120000 | 单次转换超时 |

配置写错不会让插件装不上：`normalizeConfig` 会把非法值回退成默认值。

---

## 4. 安全模型

1. **先计划后执行**：所有打印工具在 `confirm=true` 之前只返回计划（文件、页数、份数、纸型、
   目标打印机），不向队列提交任何任务。
2. **dryRun**：配置开启后即使 `confirm=true` 也只出计划。
3. **虚拟打印机**：`Microsoft Print to PDF` / XPS 这类会弹「保存」对话框的打印机默认拒绝
   （`allowPromptPrinters=true` 才放行），避免卡在无人值守的对话框上。
4. **上限**：`maxFiles` / `maxPages` 防止误打整本文档。
5. **审计**：每次打印写 `%LOCALAPPDATA%\dsh-print\audit.jsonl`（时间、工具、文件、打印机、页数、结果、耗时）。
6. **只读扫描王**：以 `readOnly` 打开 SQLite，只 `SELECT`；不改库、不动页图、不启动 App。
7. **不驱动扫描王 UI**：不弹它的打印对话框、不注入它的进程，也不做云端扫描/打印。

---

## 5. 实现结构

```
DO-NOT-DELETE.txt       安装目录保护标记（随仓库同步，防 /MIR 删除）
lib/
├─ index.js             插件入口：normalize → 建 helper/audit → 注册 7 个工具 → effect 清理
├─ config.js            配置归一 + 路径解析（PowerShell / helper / 审计 / 扫描王库）
├─ errors.js            错误码 → 中文提示
├─ helper-session.js    一次性 PowerShell 5.1 调用（EncodedCommand + JSON over stdout）
├─ office.js            Office → PDF（LibreOffice Kit / 系统 soffice）
├─ camscanner.js        扫描王本地库只读解析（页图优先级 + basename 兜底）
├─ tool-kit.js          本地 defineTool（零 DSH 依赖）
├─ tools/               status / print / jobs / camscanner
└─ helper/
   ├─ print-helper.ps1  WinRT(PDF→位图) + System.Drawing(PrintDocument) 打印引擎
   └─ PROTOCOL.md       Node ↔ helper 线路协议
```

打印链路：`print_file` → helper；PDF 用 `Windows.Data.Pdf` 逐页渲染成位图，图片/文本/测试页用
GDI+ 排版，统一交给 `System.Drawing.Printing.PrintDocument` 进打印队列。Office 文件先转 PDF
再走同一条链路。helper 是一次性进程，退出即释放。

---

## 6. 已知限制

- 打印质量取决于打印机与墨水；黑色耗尽、彩色缺失或喷头堵塞时会出现发灰、缺页、任务卡在
  `Error, Printing, Retained`，这在插件侧无法绕过。
- 扫描王升级可能改 `camscanner.db` 表结构：读取层会优雅报 `E_CAMSCANNER_DB`，不影响 PDF/图片打印。
- 扫描件只有 1000px 预览图时（约 120 DPI）打印会偏糊；在 App 里打开该文档一次可生成全高清页图。
  缺页图的页会明确报 `E_CAMSCANNER_PAGE`，不会静默跳过。
- 双面/份数是否生效取决于打印机驱动；份数由插件按页循环保证，不依赖驱动。
- 文本打印按 50 行/页估算页数，实际分页以打印时排版为准。
- 只支持 Windows；Office 打印需要另装 LibreOffice Kit（或系统 LibreOffice）。

---

## 7. 排错

| 现象 | 处理 |
|---|---|
| `E_HELPER` / helper 输出无法解析 | 确认 `powershell.exe` 是 5.1；`print-helper.ps1` 必须 UTF-8 **with BOM**（改了文件要重新加 BOM） |
| `E_TIMEOUT` | 大文件渲染慢，调大 `timeoutMs`；或先用 `preview=true` 看前两页 |
| `E_PRINTER_NOT_FOUND` | `print_status` 看可用打印机；打印机名要完全一致 |
| `E_PRINTER_PROMPT` | 目标是 PDF/XPS 虚拟打印机；换实体打印机，或临时开 `allowPromptPrinters` |
| `E_OFFICE_MISSING` | 按安装第 3 步装 LibreOffice Kit，或装系统 LibreOffice |
| `E_CAMSCANNER_DB` | 先打开一次扫描王并登录；或配置 `camscanner.dbPath` 指向 `camscanner.db` |
| 打印任务一直不出纸 | `print_jobs` 看状态；必要时 `print_cancel` 清队列，再检查打印机电源/纸张/墨水/驱动 |

---

## 8. 测试与验证

```powershell
# 单元测试（假 helper，不碰打印机）：82 个用例
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" --test "test/*.test.js"

# 真机 helper 冒烟（只写 spool 文件，不消耗纸）
$env:DSH_PRINT_LIVE = '1'
& "...\node.exe" --test test/live.test.js
Remove-Item Env:\DSH_PRINT_LIVE
```

### 本机验证记录（2026-10-29，Windows 11 + HP DeskJet 2600 series）

- 单元测试：**82 例，80 通过 + 2 跳过**（live 需 `DSH_PRINT_LIVE=1`）；live **2/2 通过**。
- 真实出纸：**6 页**（A4 测试页 2、白皮书 PDF 3、docx 转 PDF 1），打印队列全部清零。
- 扫描王：账号 4 个文档；身份证 2 页全高清图 spool **7.3 MB**；`preview=true` 输出 2589×1619 等 PNG。
- 工具注册：重启 DSH 后 7 个 `print_*` 工具全部进入工具表并逐一实调通过。
- 未完成：收尾时打印机黑色墨盒余量 0%、彩色墨盒缺失，身份证复印件最终未出纸（作业 0 页被取消）；
  整页打印质量只验证到上述 6 页为止。

---

## 9. 许可

MIT，Copyright (c) 2026 ABccgh。见 [LICENSE](LICENSE)。

仓库不包含 LibreOffice 二进制；按安装第 3 步下载的 LibreOffice Kit 遵循 MPL-2.0。
