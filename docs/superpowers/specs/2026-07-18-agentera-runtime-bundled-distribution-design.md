# AgentEra Runtime 内置分发设计

状态：2026-07-18 已逐节确认，可进入实施计划阶段前的书面审阅。

## 目标

让 AgentEra Studio 安装包直接携带可运行的 AgentEra Runtime/Hermes 核心，使首次启动不依赖 GitHub、Git、系统 Python 或在线安装脚本，同时允许用户确认后安全更新和自动回滚。

本设计只改变 Runtime 程序的构建、安装、选择和更新方式。它不得改写 Hermes 的 Profile、Memory、USER、Skills、会话、Curator 状态、工作区文件或自我学习行为。

## 已确认的产品决策

- 采用平台专属 Runtime Seed，而不是把完整 Git 仓库放入安装包。
- 首发平台为 macOS ARM64 和 Windows x64。
- macOS x64、Linux x64 和 Linux ARM64 在首发机制稳定后接入同一分发协议。
- 首次启动完全使用安装包内 Seed，不访问 GitHub。
- 自动检查 Runtime 更新，但只有用户确认后才下载；下载完成后由用户重启切换。
- 更新制品由公开的 `Ablankpaper/aera-runtime` 仓库发布，客户端不携带 GitHub Token。
- Chromium、语音模型、本地模型权重等大型可选资源不进入首版核心 Seed。
- Runtime 发布必须通过 Hermes 核心机制和自我学习兼容性门禁。

## 仓库与职责边界

### `Ablankpaper/aera-runtime`

Runtime 仓库是制品生产者和源码事实来源。

它负责：

- 从经过审阅的源码提交构建平台专属 Runtime Seed；
- 固定 Python、依赖锁文件和构建工具版本；
- 生成 Runtime 清单、文件哈希和签名；
- 执行 Hermes 兼容性门禁；
- 发布稳定或候选 Runtime Release；
- 保留 `upstream` 远端，用受控的手动同步流程吸收 NousResearch 上游更新。

Runtime 仓库不存储 AgentEra 用户、设备、Token、Profile 或云端业务数据。

### `Ablankpaper/aera`

桌面仓库是 Runtime Seed 消费者和本机生命周期管理者。

它负责：

- 在桌面构建时取得一个精确平台、架构和版本的 Seed；
- 在打包前验证清单、签名、哈希和兼容范围；
- 通过 Electron `extraResources` 将 Seed 放入安装包；
- 首次启动时本地安装 Seed；
- 自动检查更新、展示版本信息、接收用户确认、下载候选版本并在重启时切换；
- 维护 `current`、`candidate` 和 `previous` 状态；
- 在候选版本失败时自动回滚。

桌面 Renderer 不读取签名私钥、GitHub 凭据、Runtime 文件系统路径或用户 Profile 私有内容。下载、校验、安装和切换全部由 Electron 主进程完成。

### `Ablankpaper/aera-cloud`

云端认证服务不参与 Runtime 二进制分发。

它只提供现有产品账户、设备会话、个人空间和七天离线授权。未来云同步可以记录 `runtime_distribution_version`，但不能代理 GitHub Token、持有 Runtime 私钥或获得 Hermes 私有数据。

## 已考虑的实现方案

### 采用：平台专属、预构建并签名的 Runtime Seed

每个平台在原生 CI Runner 上构建完整可运行目录，压缩成确定性 Seed。桌面安装包携带对应 Seed，首次运行只做本地校验和原子安装。

该方案能真正实现断网首次启动，并把 Python、依赖、CLI 和 Runtime 版本固定在发布门禁内。它也允许 Runtime 与桌面应用独立升级和回滚。

### 未采用：直接从 Electron 应用资源目录运行

直接运行 `resources` 中的 Runtime 可以少一次复制，但会把 Runtime 生命周期与应用签名目录绑定。macOS 应用签名、Windows 安装升级、磁盘权限和独立回滚都会变得更脆弱，因此不采用。

### 未采用：安装包只放源码，首次启动在线创建环境

源码加在线 `uv sync`、Git clone 或安装脚本仍依赖 GitHub、PyPI、Node 和系统工具，无法解决中国大陆用户的首次安装超时问题，也无法保证依赖可复现，因此不采用。

## Runtime Seed 定义

Runtime Seed 是桌面首次安装 Runtime 的只读、平台专属发布制品，不是开发仓库快照。

### 必须包含

- 受支持的 Python 解释器；
- 锁定后的核心 Python 依赖和 Runtime 包；
- `hermes` CLI 与 `hermes_cli.main` 入口；
- Dashboard 所需的 Runtime 服务端和已构建静态资源；
- Agent 执行所需的基础工具和基础 Skills；
- Runtime 自检入口；
- Runtime 版本与源码提交信息；
- 第三方许可证和制品清单。

“基础工具”由构建清单明确列举，只包含首次对话、配置、Profile、Memory、Skills、后台复盘和 Dashboard 所需能力。新增依赖不能通过隐式扫描进入 Seed。

### 明确排除

- `.git` 和 Git 历史；
- 测试、基准、网站源码、开发文档和 CI 缓存；
- `.venv` 之外的开发环境、Python 下载缓存和包管理缓存；
- Chromium、Playwright 浏览器包、语音模型、本地模型权重和其他大型可选资源；
- 用户 `.env`、API Key、OAuth Token、Cookie、Profile、Memory、会话、日志和本机路径；
- 桌面应用源码和重复的 Electron 依赖。

### 平台制品

首版至少产生：

```text
agentera-runtime-<version>-darwin-arm64.tar.zst
agentera-runtime-<version>-windows-x64.zip
agentera-runtime-<version>-darwin-arm64.manifest.json
agentera-runtime-<version>-windows-x64.manifest.json
agentera-runtime-<version>-darwin-arm64.manifest.sig
agentera-runtime-<version>-windows-x64.manifest.sig
```

压缩格式可以按平台不同，但解压后的逻辑目录和清单语义必须一致。

## 清单与签名协议

每个 Seed 都带一个规范化 JSON 清单和独立 Ed25519 签名。签名覆盖清单的原始规范字节，清单包含压缩包 SHA-256，因此签名同时绑定制品内容。

清单至少包含：

```json
{
  "schema_version": 1,
  "runtime_version": "0.18.2-agentera.1",
  "source_repository": "Ablankpaper/aera-runtime",
  "source_commit": "<full-sha>",
  "channel": "stable",
  "platform": "darwin",
  "arch": "arm64",
  "archive_name": "agentera-runtime-<version>-darwin-arm64.tar.zst",
  "archive_size": 0,
  "archive_sha256": "<hex>",
  "python_version": "3.11.x",
  "entrypoints": {
    "python": "python/bin/python3",
    "hermes": "runtime/hermes",
    "module": "hermes_cli.main"
  },
  "minimum_desktop_version": "0.7.3",
  "compatibility_gate_revision": 1,
  "created_at": "<UTC RFC3339>"
}
```

正式实现可以增加向后兼容字段，但不能静默改变字段语义。未知 `schema_version`、未知签名密钥、错误平台、错误架构、错误仓库、哈希不符或不兼容桌面版本都必须拒绝。

签名私钥只存在于受保护的 Runtime Release 环境。桌面仅内置按 `key_id` 管理的公钥集合，并允许在至少一个旧公钥仍受信任时进行平滑轮换。

## 构建和发布流程

Runtime 构建在目标操作系统和架构的 CI Runner 上完成，不能在一个平台上交叉复制另一个平台的 Python 环境。

稳定发布流程为：

1. 从 `Ablankpaper/aera-runtime` 的审阅提交或稳定标签开始。
2. 验证工作树、依赖锁和生成文件无漂移。
3. 创建干净的目标平台 Runtime 根目录。
4. 安装固定 Python 和锁定依赖。
5. 构建 Dashboard 静态资源和必要入口。
6. 删除测试、缓存、源码历史、临时文件和不可重定位路径。
7. 执行 Runtime 自检与 Hermes 兼容性门禁。
8. 生成确定性归档、SHA-256、清单和 Ed25519 签名。
9. 在干净临时目录解压并再次执行启动验证。
10. 发布 GitHub Release 制品。

Release 失败、平台制品缺失或任一兼容性门禁失败时，不得发布不完整的稳定版本。桌面构建也不得退回“在线安装最新 main”作为隐式补救。

## 桌面打包流程

桌面 Release CI 必须显式固定 Runtime 版本和完整源码提交，不能在构建时解析浮动的 `latest`。

桌面打包流程为：

1. 根据目标平台和架构选择唯一 Seed。
2. 下载或读取 CI 传入的归档、清单和签名。
3. 验证仓库、版本、平台、架构、签名、哈希、大小和最低桌面版本。
4. 执行最小解压自检。
5. 将三项制品放入 `resources/agentera-runtime-seed/`。
6. 使用 `electron-builder` 打包、签名和公证桌面应用。
7. 从最终安装包中再次提取并验证 Seed，防止打包过程遗漏或损坏资源。

开发模式允许通过显式环境变量指向本地已构建 Seed，但不能把开发回退路径带进正式构建，也不能默认调用 NousResearch 在线安装脚本。

## 本机目录与所有权

Runtime 程序目录与 Hermes 用户数据目录必须物理分离。

桌面使用 `app.getPath("userData")` 下的 Runtime 根目录：

```text
<userData>/runtime/
  current.json
  previous.json
  candidate.json
  versions/
    <runtime-version>-<source-short-sha>/
  staging/
    <transaction-id>/
  downloads/
```

`current.json` 是跨平台指针，不依赖 Windows 不稳定的符号链接权限。指针文件通过临时文件、`fsync` 和原子重命名更新。

Hermes 的 `HERMES_HOME` 继续拥有：

- Profile 配置和凭据；
- `MEMORY.md` 与 `USER.md`；
- 会话和本地数据库；
- agent-created Skills 与 Curator 状态；
- Gateway、Cron、日志、缓存和工作区文件。

Runtime Manager 只能读取启动所需的 Profile 路径，不能把用户数据复制进版本目录。删除旧 Runtime 版本也不得遍历或删除 `HERMES_HOME`。

## 首次启动状态机

首次 Runtime 安装位于现有 AgentEra 产品登录之后，并服从认证设计中的 Profile 绑定顺序。

1. 启动页执行不读取用户内容的 Seed 和当前 Runtime 预检。
2. 桌面完成在线登录或验证七天离线凭证。
3. 如果 `current` Runtime 完整且受信任，直接进入 Profile 绑定检查。
4. 如果没有当前 Runtime，验证安装包内 Seed。
5. 检查磁盘空间和目标目录权限。
6. 解压到新的 `staging/<transaction-id>`。
7. 对解压后的关键文件和入口再次校验。
8. 执行 `--version` 和最小无用户数据自检。
9. 原子移动到 `versions/<version>-<sha>` 并写入 `current.json`。
10. 创建或认领物理 Profile，随后进入 Setup 或主界面。

整个首次安装不请求网络。Seed 损坏时显示“安装包中的 Runtime 无效”，引导用户重新安装桌面应用，而不是退回 GitHub 下载。

## 既有 Hermes 安装兼容

当前用户可能已经在 `HERMES_HOME/hermes-agent` 拥有 Git Checkout 和虚拟环境。新机制不能删除、覆盖或原地改写它。

迁移规则为：

- 现有 Profile 和全部用户数据保持原位；
- AgentEra Studio 默认安装并使用自己的受签名 Runtime 版本；
- “使用现有安装”兼容入口在迁移期保留，但标记为外部 Runtime，不获得 AgentEra 自动更新或签名信任声明；
- 旧代码目录可以保留为用户手动回退，不计入 AgentEra `previous`；
- 用户主动清理旧安装前，产品只展示预计释放空间，不自动删除；
- 更新 Runtime 时不调用可能对 `HERMES_HOME` 执行 clone、reset、stash、pull 或目录替换的旧安装脚本。

## Runtime 更新策略

Runtime 与桌面应用使用独立版本和独立更新状态。桌面更新不能隐式改变 Runtime，Runtime 更新也不能替换 Electron 应用。

已确认的稳定更新流程为：

1. 主界面可用后后台检查稳定 Runtime 清单；检查失败不影响本地使用。
2. 发现兼容的新版本时展示版本、来源、大小、必要说明和“下载并在重启后更新”按钮。
3. 只有用户确认后才开始下载。
4. 下载支持断点续传、限时、重试和取消。
5. 完成后验证签名、哈希、平台、架构和兼容范围。
6. 解压到 `staging`，完成无用户数据自检后写入 `candidate.json`。
7. 当前任务、Gateway、SSH 或 Dashboard 活跃时不得切换。
8. UI 提示用户重启，只有用户执行重启才进入候选切换。
9. 重启时把旧 `current` 记录为 `previous`，临时选择 `candidate` 并执行健康检查。
10. 健康检查成功后提交 `current`；失败时恢复 `previous` 并记录脱敏诊断。

自动检查不能变成自动下载，也不能在用户工作期间替换运行中的 Python、CLI 或 Gateway。

## GitHub 与未来国内镜像

第一版更新源使用公开的 `Ablankpaper/aera-runtime` GitHub Release，允许普通客户端匿名下载，且客户端不包含任何 GitHub Token。

GitHub 在中国大陆可能仍然超时，因此 GitHub 只承担第一版更新源，不承担首次启动可用性。下载失败时继续使用当前 Runtime，并允许用户重试。

未来可以把完全相同的归档、清单和签名同步到国内 OSS/CDN。镜像只改变传输地址，不改变制品身份和信任根；客户端仍验证 `source_repository`、签名和 SHA-256，不能因为镜像域名受信任而跳过内容验证。

## Hermes 自我学习保护规则

Runtime 生命周期管理必须服从“不得破坏 Hermes 核心机制和自我学习机制”的发布阻断规则。

以下内容在安装、更新、回滚和旧版本清理前后必须保持不变：

- 活跃 Profile 的物理 `HERMES_HOME`；
- `MEMORY.md`、`USER.md` 和本地会话；
- agent-created Skills、provenance、pin 和 archive；
- Curator 状态和后台复盘行为；
- Profile 凭据、Gateway、Cron 和工作区文件；
- 已开始会话的 Prompt、Tool Schema、Skill Index 和 RuntimeBinding。

Runtime 更新只在新的进程和新的会话边界生效。正在执行的会话不会在中途更换 Python 环境或 Runtime 代码。

如果上游 Hermes 更新改变核心行为，AgentEra 兼容性测试失败必须阻止 Seed 发布；品牌、账户、安装成功或普通单元测试通过不能覆盖该失败。

## 错误处理与恢复

### 安装包 Seed 缺失或损坏

桌面阻止本地 Runtime 启动，展示重新下载安装包的修复路径，并继续允许用户查看不依赖 Runtime 的账户状态。它不静默下载 `main` 或执行上游安装脚本。

### 磁盘空间不足或权限失败

桌面在解压前检查“归档大小 + 解压预算 + 回滚版本预算”。失败时保留现有 Runtime 和所有用户数据，清理本次 `staging`，并显示可操作错误。

### 更新下载中断

下载元数据和部分文件保存在 `downloads`，下次由用户重试时继续。超过保留期的部分文件可以清理，但不能删除 `current` 或 `previous`。

### 候选版本启动失败

桌面在同一次启动中恢复 `previous`，标记候选失败，避免无限重试，并允许用户导出不含 Token、路径和 Profile 内容的诊断摘要。

### 当前版本损坏

桌面先尝试 `previous`，再尝试重新安装包内 Seed。两者都失败时进入修复界面，不读取或修改 Profile。

### GitHub 或控制面不可用

更新检查和云功能暂停，当前 Runtime、本地 Profile 和 Hermes 自我学习保持可用。模型仍通过其独立 API Endpoint 工作；AgentEra 控制面故障不伪装成模型故障。

## UI 与可见状态

设置页中的 Runtime 卡片与桌面应用更新卡片保持分离。

Runtime 卡片至少显示：

- 当前 Runtime 版本和源码短 SHA；
- 内置 Seed 版本；
- 更新检查时间；
- `current`、`downloading`、`candidate ready`、`rollback` 或 `repair required` 状态；
- 下载大小、进度、取消与重试；
- 用户确认下载和重启更新按钮；
- 上一次失败的脱敏原因。

首次安装界面不再显示“从 GitHub 下载 Hermes Agent”，而显示“正在准备 AgentEra Runtime”。只有后续可选资源或 Runtime 更新才出现网络下载进度。

## 测试策略

实施遵循测试驱动开发，先建立制品和数据隔离断言，再修改安装路径。

### Runtime 生产者测试

- 清单 Schema、规范化字节、签名和密钥轮换；
- 错误平台、错误架构、错误仓库、未知 Schema 和错误最低桌面版本；
- 确定性构建与归档 SHA-256；
- 禁止 `.git`、缓存、测试数据、密钥和用户文件进入 Seed；
- 干净解压后的 CLI、Dashboard 和基础工具自检；
- macOS ARM64 与 Windows x64 原生 CI 构建；
- 完整 Hermes 兼容性门禁。

### 桌面单元与集成测试

- Seed 发现、验证、磁盘预算和原子安装；
- `current`、`candidate`、`previous` 状态恢复；
- 断点续传、取消、重试、签名错误和哈希错误；
- 用户未确认时零下载；
- 活跃任务存在时拒绝切换；
- 重启切换成功与失败回滚；
- Seed 损坏时不调用在线安装脚本；
- Runtime 清理永不进入 `HERMES_HOME`。

### 数据保护回归

使用包含真实结构的 Profile Fixture，在首次安装、更新、失败回滚和旧版本清理前后比较以下哈希：

- Memory 与 USER；
- 会话数据库和文件；
- agent-created Skills 与 provenance；
- Curator 状态与 archives；
- Gateway、Cron 和工作区状态。

任何私有数据变化都阻止合并和发布。

### 端到端与实体平台验证

- macOS ARM64 断网首次安装、登录、Profile 绑定、对话和重启；
- Windows x64 安装、升级、卸载、DPAPI、长路径和杀毒软件干预；
- 真实下载中断与恢复；
- 候选版本故意损坏后的自动回滚；
- 已有 Hermes 安装原地保留；
- 桌面安装包签名、公证和最终 Seed 提取验证。

托管 Windows CI 通过不能代替至少一次真实 Windows 安装、更新和卸载冒烟。

## 实施分解

Runtime 内置作为独立项目完成，不与云同步或工作区 Schema 放进同一个实现分支。

建议阶段为：

1. Runtime 分发协议、清单、签名和兼容门禁；
2. macOS ARM64 Seed 生产与桌面本地安装；
3. Windows x64 Seed 生产与桌面本地安装；
4. 更新检查、用户确认下载、候选切换和回滚；
5. 旧安装兼容、清理策略和跨平台发布门禁；
6. 完成后单独设计 Agent Definition、配置和不可变版本云同步；
7. 云同步稳定后单独设计工作区成员、角色、只读共享资产和审计。

每个阶段都必须保持桌面仓库与 Runtime 仓库可以独立测试和回退。

## 明确非目标

- 首版内置 Chromium、语音模型或本地大模型权重；
- 自动下载或静默安装 Runtime 更新；
- 在运行中的会话中热替换 Runtime；
- 用云端 Memory 或 AgentEra 学习引擎替代 Hermes 本地学习；
- 把 `MEMORY.md`、会话、文件或未提升 Skills 放进云同步；
- 自动删除用户旧 Hermes 安装；
- 在客户端嵌入 GitHub Token；
- 在本项目中完成云同步、工作区或企业功能。

## 完成标准

### 开发完成

macOS ARM64 和 Windows x64 的 Seed 构建、安装、更新、回滚、自动化测试及真实平台冒烟全部通过，且断网首次启动不执行 GitHub 下载。

### 可合并

桌面与 Runtime 代码审查、类型检查、完整测试、签名验证、Secret 扫描、安装包检查和 Hermes 兼容性门禁全部通过。

### 可公开发布

在“可合并”基础上，正式签名密钥仪式、macOS 公证、Windows 签名、真实安装升级卸载、制品留存、回滚演练和发布运行手册全部完成。

“安装包能构建”不得被描述成“已可公开商用发布”。

## 验收条件

- 新设备断网时可以从 AgentEra Studio 安装包准备并启动 Runtime。
- 首次启动不访问 GitHub、NousResearch、PyPI 或在线安装脚本。
- Runtime Seed 来自 `Ablankpaper/aera-runtime` 的精确提交并通过签名和哈希验证。
- macOS ARM64 和 Windows x64 使用各自原生构建的 Seed。
- 自动检查不会自动下载；只有用户确认后才下载候选版本。
- Runtime 只在用户重启并且没有活跃任务时切换。
- 候选失败自动恢复上一个有效版本。
- GitHub 不可访问时当前 Runtime 和本地 Agent 继续可用。
- 更新前后 Hermes Memory、USER、会话、Skills、Curator 和 Profile 数据保持不变。
- Runtime 发布失败时不会回退到未经验证的上游 `main`。
- 客户端和安装包不含 GitHub Token、签名私钥、API Key 或测试用户数据。
- Runtime 内置项目完成后，云同步和工作区分别进入独立设计与实施周期。
