Aera Beta.33 外部诊断采集器 V4

用途
----
这是独立于 Aera UI 的终端采集器。它只观察一次真实会话，不修改 Aera、配置、Profile、数据库、缓存或账号，不自动点击、重试、修复、上传或推送更新。默认 external 模式；internal 模式也保持相同脱敏边界，只适用于明确授权的自有故障机。

采集范围
--------
一次运行会把 Main/Preload/Renderer/IPC 的稳定脱敏事件、真实 PID/进程树/可执行文件指纹、Runtime 当前日志路径、macOS unified log 精确时间窗口、macOS 签名/Quarantine/DNS/路由、Windows Application/签名/Quarantine/DNS/路由事件、Electron/native ABI、SQLite DB/WAL/SHM 只读状态、journal、五个受管文件 before/after、备份和 route candidates/重复 endpoint、owner transition 关联、Cloud origin 可观测性、updater 阶段和网络端点放进同一个带 schemaVersion=4 的 ZIP。无法读取的部分不会静默消失，而会出现在 manifest.missingEvidence 和对应 section 状态中。
`native-inventory.json` 同时记录 Electron 运行时 ABI、每个可读 `.node` 的实际内容 SHA-256，以及 `node_register_module_vN` marker（`collected`/`not_found`/`ambiguous`/`unavailable`）；因此 137/145 不匹配可以直接从采集结果核对。
Windows 会从 Aera.exe 同级的 `resources/app.asar.unpacked`（也兼容传入安装目录）扫描原生模块；目录不存在或不可读时，`native_abi` 会明确出现在 `manifest.missingEvidence`，不会被当成“没有原生模块”。

安全边界
--------
API Key、Token、Cookie、Authorization、密码、私钥、完整 .env、完整配置正文、SQLite 原始页、聊天内容、HTTP 请求/响应体和 URL 查询参数不会进入可发送 ZIP。Profile、owner、route、endpoint、PID 命令行和文件路径只保留域分离哈希、存在性、长度、计数或安全枚举。最终 secret scan 失败时不会生成 ZIP，只保留本机 quarantine 供复核。

启动（macOS）
-------------
1. 完全退出 Aera/Aera 2；不要删除数据库或清空配置。
2. 在终端进入解压目录，执行：

   bash run-macos.sh --app "/Applications/Aera.app" --target "/path/to/target.json"

   `--target` 是候选包生成的精确版本/架构/可执行文件/包 SHA 描述；没有候选描述时可以省略，manifest 会标记 `bindingStatus=runtime-unbound`，不能把它当作候选包验收证据。
3. 采集器使用 Aera.app 内置 Electron Node（`ELECTRON_RUN_AS_NODE=1`），不要求安装全局 Node，也不需要双击被 quarantine 的 `.command`。
4. 只做一次目标操作（例如打开模型中心并点击一次“添加并使用”），看到结果后回到终端按一次回车。采集器不会替你操作，也不会自动重试。
5. ZIP 和同名 `.zip.quarantine` 会写入桌面的 `Aera-Diagnostics`。发送前只发送 ZIP，并先查看 quarantine 中的 `redaction.json`。

启动（Windows）
---------------
PowerShell：

   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run-windows.ps1 -App "C:\Program Files\Aera\Aera.exe" -Target .\target.json

命令提示符：

   run-windows.bat -App "C:\Program Files\Aera\Aera.exe" -Target .\target.json

Windows 包装器会调用 Aera 自带的 Electron 运行时，不依赖全局 `node.exe`；它会把 App/Target/Output/Profile 路径解析成绝对路径、固定传入 `--platform windows`，并在 PowerShell 退出后恢复 `ELECTRON_RUN_AS_NODE` 环境变量。Windows 的 Runtime open-handle 证据目前会显式标为 `windows_open_files_unavailable`，不能把进程树或旧日志当作 PID 绑定日志。
Windows 采集器优先读取可执行文件的 ProductVersion；若系统无法提供版本且未使用 `--target`，会显式记录 `version=unknown` 并保持 `runtime-unbound`，不会伪造候选版本。提供了候选 target 时，版本缺失会因身份不匹配而 fail-closed。

会话有效性
----------
manifest 的 `reproductionConfirmed=true` 只有在采集器自己启动的主 PID 仍存活、可执行文件身份未改变、没有不属于该进程树的新 Aera 主进程，并且用户在终端按回车时才成立。主 PID 退出、被替换、出现不受信任的重开或超时都会明确记录 finishReason；重开一个新的 Aera 不会延续旧会话。

输出合同
--------
ZIP 根目录包含 manifest.json、timeline.json、app-identity.json、process.json、network.json、open-files.json、security.json、dns-routes.json、environment.json、native-inventory.json、runtime-evidence.json、events.json、journal.json、transaction-evidence.json、profile-evidence.json、route-catalog-evidence.json、updater.json、config-snapshot.json、logs.txt、macos-unified-log.txt、platform-diagnostics.json 和 redaction.json。manifest 的闭合 section registry 会单独登记 signature、quarantine、open_files、environment、dns_routes、cloud_origin、backups、managed_files、model_comparison 及六类稳定事件；`internal_stage_visibility` 固定为 `external_only`；采集器不能直接看到 Renderer→Preload→Main IPC 或 Coordinator 内部 stage，分析时不得把外部文件相关性误写成内部调用证明。
section 的 `collected` 只表示查询成功，不表示结果一定健康；例如 Windows `signature=collected` 时仍需查看 security.json 的 `statusValue` 是否为 `Valid`。

故障排查
--------
- `target identity mismatch`：目标描述和已安装包不是同一个候选；不要绕过门禁，重新生成匹配描述。
- `current_runtime_log_unavailable`：采集器会保留该缺失状态和候选路径哈希；不要把旧日志当作本次 Runtime 证据。
- `unified_log_query_failed`：manifest 会保留实际本地时间参数、退出码和截断状态；不要把空日志解释为“系统没有事件”。
- 没有 ZIP：先查看 `.capture-*` 或 `redaction.json` 的本机提示；通常是最终脱敏扫描命中。不要手工编辑或发送未扫描目录。

本工具只提供诊断证据，不代表 Aera 产品缺陷已经修复。必须结合精确候选包和故障机新采集结果作最终判断。
