# 多智能体记忆分层与全局用户画像治理 — 设计方案 v2.1

> 状态：功能闭环与定向真实 UI 验收已完成、最终全量门禁进行中 → 当前分支已实现 P0 显式身份/私有 USER 修复、P1 外置画像与会话快照、P3 自然语言候选和回复后确认；Runtime 生产代码保持不变
> 范围：aera 桌面端 + aera-runtime 协作边界
> 红线：不得替换、拦截、延迟或静默改变 Hermes 原生 Memory、USER profile、background review、skill learning、Curator、session stability、Profile isolation 行为

---

## 1. 核心结论

v1.x 的目标正确，但边界错了：它试图把账号级全局用户画像放进 Hermes Profile 内，并通过拆 `memories/agents/<agent_id>/`、拦截 `target=user`、新增 `PROFILE.md` 来实现多智能体隔离。这与 Hermes 的真实契约冲突。

经核实，Hermes 的隔离单位是**完整物理 `HERMES_HOME`**，不是 `memories/` 子目录。`MEMORY.md`、`USER.md`、`SOUL.md`、sessions、skills、credentials、Curator、gateway、cron、logs、cache 都属于某个 Installation 的私有可写状态。Aera 可以在 Hermes 外围增加全局画像能力，但不得把 Hermes 私有 `USER.md` 改造成全局画像，也不得拦截 Hermes 的原生写入。

因此，v2.0 采用新的边界：

```text
Aera 账号级存储（所有 HERMES_HOME 之外）
├── global-profile.json        # 唯一全局用户行为画像，Aera-owned
├── history/                   # 版本、撤销、冲突记录
├── audit/                     # 治理动作审计
├── conversations/             # renderer run 的冻结快照
├── sessions/                  # Profile + Hermes session 的持久快照别名
└── candidates/                # P3：身份/画像候选，不保存原始对话全文

Hermes Profile A（一个 Installation 一个完整 HERMES_HOME）
├── SOUL.md
├── memories/MEMORY.md
├── memories/USER.md
├── sessions/
├── skills/
├── credentials / provider config
├── Curator / gateway / cron / logs / caches
└── 其他 Hermes 原生状态

Hermes Profile B
└── 同样完整、物理隔离、可独立自我进化
```

### 1.1 当前分支实际实施状态（2026-07-26）

| 能力                      | 当前代码状态                                                                                       | 验收状态 / 余项                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Agent 独立身份            | 已实现任意名称、`profile-meta.json` + `SOUL.md` 受控块、revision、备份/撤销、改名后旧 session 失效 | 已完成隔离真实 UI 改名与跨 Agent 不串名验收  |
| Agent 私有 `USER.md` 修复 | 已实现单 Profile 预览、逐字编辑、确认、哈希并发保护、备份/撤销                                     | 真实受污染数据由用户主动决定，程序不自动迁移 |
| 账号级全局画像            | 已实现账号分区、白名单、显式 UI/`/global`、版本/history/audit/rollback、安全过滤及自然语言确认闭环 | 已完成隔离真实 UI 确认、落盘与跨 Agent 读取  |
| 会话只读注入              | 已实现确定性 envelope 追加、冻结快照、Hermes session 持久绑定、transport 固定与降级继续            | 已完成第二 Profile 新会话冻结快照验收        |
| Hermes 底座               | Runtime 生产代码零修改；行为门禁覆盖临时指令 provenance 与正常 Memory/USER/review/Skills/Curator   | 已观察真实私有 USER 写入；最终门禁仍须持续跑 |

### 1.2 面向用户的硬验收宗旨

这项能力不是存储结构演示，必须同时满足四个用户结果；任一项失败都不能称为完成。

1. **好用**：用户可直接在普通聊天里表达“当前 Agent 叫什么、以后如何称呼我”，无需理解 `SOUL.md`、`USER.md` 或全局画像文件；
2. **解决问题**：确认后当前 Agent 身份立即生效，账号级称呼在其他 Agent 的新会话中自动可用，且不会把一个 Agent 的名称共享出去；
3. **不破坏 Hermes**：候选识别、确认卡和外置画像均为 Aera 旁路能力，不得替换、等待、清理或审批 Hermes 的 Memory、USER、Skills、Curator 与 Background Review；
4. **傻瓜式且可控**：一句话只产生一张合并确认卡，用户一次确认或拒绝；系统不因模型猜测自动修改身份或扩散账号级信息。

### 1.3 隔离真实 UI 验收记录（2026-07-26）

本次只使用临时 `HERMES_HOME` 与 Electron `userData`，未触碰真实用户 Profile。测试名称与称呼均为一次性验收数据，不是业务常量。

- 用户在普通聊天中一次表达当前 Agent 名称和共享称呼；Hermes 先完成正常回复，并通过原生 Memory 工具更新该 Agent 私有 `memories/USER.md`；
- Hermes 成功回复结束后，renderer 才显示一张合并确认卡；卡片分别展示“当前智能体的名字”和“所有智能体对你的称呼”；
- 确认后，当前 Profile 的 `SOUL.md` 受控身份块与 `profile-meta.json` 更新，全局称呼写入账号级 `global-profile.json`，候选状态变为 `confirmed`；
- Aera 确认流程未改写 Hermes `MEMORY.md`、Skills 或 Curator；Hermes 写入私有 `USER.md` 的原生行为保留；
- 切换到第二个独立 Profile 后，新会话冻结快照包含共享称呼，不包含第一个 Agent 的名称；第二 Profile 的 `SOUL.md` 与 `profile-meta.json` SHA-256 在验收前后完全一致；
- 失败回合不显示确认卡，切换 Profile 后旧卡不串入新 Agent；这些边界同时由 renderer 回归测试覆盖。

## 2. 已核实的不可变事实

| 事实                                                                                              | 依据                                                         | 设计影响                                                                  |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 每个 runnable Agent installation 拥有一个 writable Hermes Profile，且映射到一个物理 `HERMES_HOME` | `docs/agentera-runtime-profile-contract.md`                  | 多智能体隔离必须是完整 Profile 隔离，不能只拆 memory 子目录               |
| Hermes `memories/MEMORY.md` 与 `memories/USER.md` 均为原生持久学习文件，并进入下一会话系统提示    | `aera-runtime/tools/memory_tool.py`                          | Aera 不能拦截、延迟或改写 `target=user`                                   |
| Background review 会询问是否保存用户 persona、偏好、期望与工作风格                                | `aera-runtime/agent/background_review.py`                    | Hermes 自我学习本来包括 USER.md；拦 `target=user` 会破坏红线              |
| `SOUL.md` 是 Profile 根目录文件，不是 `memories/agents/<id>/SOUL.md`                              | Hermes Profile 契约与桌面 profile 读写逻辑                   | per-agent persona 应通过独立 Profile 实现，而不是重写 SOUL 路径           |
| MemoryProvider 只能有一个外部 provider，`on_memory_write` 是写后镜像通知                          | `aera-runtime/agent/memory_provider.py`、`memory_manager.py` | GlobalProfileGovernor 不能实现为 MemoryProvider，也不能占用 provider 插槽 |
| 桌面端已有 `HermesConversationEnvelope` 可向 API/Runs 请求注入额外 instructions                   | `aera/src/main/hermes.ts`                                    | 全局画像应作为 Aera 外部只读快照注入，不进入 Hermes 私有文件              |

## 3. 设计目标

| #   | 目标                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------ |
| G1  | 每个 Agent Installation 使用完整独立 Hermes Profile（完整 `HERMES_HOME`），保留 Hermes 原生自我学习与状态隔离            |
| G2  | 账号级仅有一份 Aera-owned 全局用户行为画像，供所有 Agent 只读加载                                                        |
| G3  | 全局画像不使用、不替代、不同步 Hermes `USER.md`；Hermes `USER.md` 保持每个 Profile 私有                                  |
| G4  | 普通聊天只能生成 Agent 身份/全局画像候选；候选必须经用户确认，只有 `/agent name`、`/global set` 或 UI 明确操作可直接写入 |
| G5  | 新会话启动时加载版本固定的全局画像快照，会话期间不变，保证提示缓存稳定                                                   |
| G6  | 任何跨边界沉淀都经过 Aera 治理闸门：分类、确认、版本化、审计、可撤销                                                     |

## 4. 数据模型

### 4.1 Hermes 私有 Profile（每 Installation 一份）

Hermes Profile 完整保留，Aera 不拦截任何原生写入。

| 文件/目录                                    | 归属              | 写者                                                                                                          | 语义                                                |
| -------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `SOUL.md`                                    | 当前 Installation | 用户或 Aera 明确的 UI/配置流程（非自动自我进化输出：无证据表明 memory tool / background review 会自动演化它） | 该 Agent 的身份、人格与运行风格                     |
| `memories/MEMORY.md`                         | 当前 Installation | Hermes memory tool / background review                                                                        | Agent 的经验、环境事实、工具习惯、任务沉淀          |
| `memories/USER.md`                           | 当前 Installation | Hermes memory tool / background review                                                                        | 该 Agent 对用户的私有认识（偏好、称呼、工作方式等） |
| `skills/` / Curator / sessions / credentials | 当前 Installation | Hermes 原生机制                                                                                               | 技能学习、会话、凭据、运行状态                      |

注意：如果某个 Agent 误把自己的名称写入 `USER.md`，它只影响该 Agent 的私有 Profile，不会污染账号级全局画像。需求和测试中的名称都只是示例，不形成生产常量或特殊匹配规则。

### 4.2 Aera 全局用户画像（账号级一份）

```json
{
  "schemaVersion": 1,
  "profileVersion": 7,
  "updatedAt": "2026-07-25T12:00:00Z",
  "entries": [
    {
      "id": "communication_style.conclusion_first",
      "category": "communication_style",
      "content": "用户偏好先给结论，再展开理由。",
      "source": "user_explicit",
      "confidence": 1.0,
      "createdAt": "2026-07-25T12:00:00Z",
      "updatedAt": "2026-07-25T12:00:00Z"
    }
  ]
}
```

| 字段                   | 说明                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `schemaVersion`        | 文件结构版本                                                   |
| `profileVersion`       | 每次写入递增，注入会话时固定版本                               |
| `entries[].category`   | 白名单分类：沟通风格、决策习惯、风险偏好、工作方式、工具偏好等 |
| `entries[].source`     | `user_explicit` / `candidate_confirmed` / `imported`           |
| `entries[].confidence` | 明确声明为 1.0；推断型经用户确认后写入时保留原始候选置信度     |

### 4.3 候选库

候选库保存结构化信号，不保存原始对话全文。

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "decision": "pending",
  "proposals": [
    {
      "kind": "agent_identity",
      "profileId": "agent-profile-id",
      "proposedDisplayName": "用户给当前 Agent 的任意名称",
      "summary": "将当前 Agent 命名为用户确认的名称",
      "confidence": 1
    },
    {
      "kind": "global_profile",
      "profileId": "agent-profile-id",
      "proposedValue": "用户要求的称呼",
      "entry": {
        "id": "communication_style.preferred_address",
        "category": "communication_style",
        "content": "Address the user as the confirmed value."
      },
      "summary": "让所有 Agent 使用用户确认的称呼",
      "confidence": 1
    }
  ],
  "createdAt": "2026-07-26T01:00:00.000Z",
  "expiresAt": "2026-08-25T01:00:00.000Z"
}
```

隐私规则：候选库不得保存原始 transcript、完整用户输入、工具输出、附件或敏感内容，只保存边界受限的结构化 proposal。MVP 固定存储在 Electron `userData/agentera-global-profile/<userId>/candidates/` 账号分区，文件权限 `0600`，由主进程根据已认证账号和当前 Profile 派生作用域；renderer 不能指定账号、路径或写入目标。pending 候选 30 天后标记为 expired；物理垃圾回收属于后续存储维护，不得被描述为当前已实现。Cloud 同步另开加密且用户授权的方案。

## 5. 写入与沉淀规则

### 5.1 Hermes 原生学习链路

```text
用户与某 Agent 对话
  → Hermes 原生 memory tool / background review
  → 自由写入该 Agent 自己的 MEMORY.md / USER.md
  → 该 Agent 下次会话读到自己的私有学习结果
```

Aera 不拦截、不延迟、不审批这条链路。

这意味着 Hermes 可能把同一句混合指令完整沉淀进当前 Agent 的私有 `USER.md`，形成与结构化身份/全局画像语义重叠的私有记录。Aera 不自动删除、拆分或迁移这条原生学习结果，因为任何自动清理都会改变 Hermes 的自我进化行为；如用户需要修复，只能进入 §10 P0 所述的单 Profile、可预览、可撤销修复流程。

### 5.2 全局画像显式写入

只有两种写入可直接进入全局画像：

| 入口                        | 行为                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| UI 全局画像编辑             | 用户直接编辑 Aera 全局画像，写入 `global-profile.json` 并生成 history 快照 |
| `/global set <key> <value>` | 结构化命令，写入 Aera 全局画像，生成版本与审计                             |

自然语言中的“以后所有智能体都……”或“当前 Agent 以后叫……”不直接落盘；Aera 只生成待确认候选。确认全局画像候选后写入账号画像；确认 Agent 身份候选后调用与 `/agent name` 相同的显式身份服务。这避免误识别直接扩散或修改 Agent 身份。

`/global` 命令的实现位置约束：它是 **Desktop/Aera 命令**，在消息进入 Hermes transcript 前由桌面端截获处理；不得修改 `aera-runtime` 的 slash-command registry，命令文本不得进入 Hermes 会话（否则会被 Background Review 学习）。

### 5.3 推断型候选

```text
Aera 先立即启动正常 Hermes 请求
  → 只观察当前提交的可见用户文本（不干预 Hermes）
  → 本地高置信分类器提取 Agent 身份/全局画像短摘要候选
  → 写入 Aera candidates/
  → Hermes 回复生成期间暂存，不显示、不允许确认
  → 回复结束后把一张合并确认卡追加在回复之后
  → 用户一次确认或拒绝
  → 身份候选调用显式改名；画像候选版本化写入 global-profile.json
```

约束（候选提取契约，全部强制）：

- MVP 使用本地确定性、高精度规则，仅识别明确指令；不得为泛化而把原始文本再次上传给 LLM；未来 LLM 提取器必须单独 opt-in；
- 只消费允许的可见用户文本；不读系统提示、工具输入输出、附件、文件内容与秘密；
- 不保存、不上传原始对话；
- renderer 在 Hermes 请求已经发出后以 fire-and-forget 启动提取，绝不 await 候选 IPC；提取失败、拒绝或无结果都不得延迟回答、Background Review 或会话关闭；
- 候选卡保存在独立的 renderer-only `candidateMessages` 覆盖层，只在渲染时与聊天消息组成 `visibleMessages`；它不进入 Hermes 历史、session、导出内容或后续 `send-message`；
- 每次普通聊天提交都会生成 `turnId`；候选必须绑定该 `turnId`，且只有匹配的 assistant reply 具有非空最终内容、无 `pending`、无 `error`，并完成一次 busy → idle 周期后才显示；失败回合直接丢弃；
- 即使识别先于 loading render 完成，也必须等待上述成功回合闭环，确保确认卡排在对应 Hermes 回复之后，而不是被后续流事件覆盖或错误挂到另一轮回复；
- 候选暂存与确认均绑定提取时的 Profile；切换 Agent 后旧候选不得出现在新 Agent，主进程再次校验 batch 中所有 proposal 的 Profile；
- 推断型候选一律强制用户确认，不自动晋升；
- 任何候选结果都不得直接或间接写回 Hermes（含 MEMORY.md/USER.md/Skills/Curator）；
- 候选提取器不作为 MemoryProvider，不参与 Hermes memory manager。

## 6. 会话读取与注入

### 6.1 注入方式

新会话启动时，Aera 桌面端读取 `global-profile.json` 当前版本，构造只读系统说明，并通过 `HermesConversationEnvelope.instructions` 注入会话。

```text
Conversation start
  → resolve agentInstallationId → runtimeProfileId → HERMES_HOME
  → read Aera global-profile.json profileVersion=N
  → build read-only global profile instruction block
  → compose 到现有 envelope（确定性 composer 追加）
  → persist 会话快照（见下）
  → Hermes 会话使用该快照；会话中途与恢复均不变
```

**会话快照持久化（强制）**：首次创建 conversation 时必须持久化：

```text
conversationKey / bindingId
globalProfileVersion
renderedSnapshot          # 渲染后的字节内容
snapshotSha256
```

renderer 的 `runId` 只在当前挂载周期稳定，不能作为跨重启的唯一持久键。当前实现先按 identity-revision-scoped `runId` 创建快照；Hermes 返回 session 后，立即建立 `account + Profile + Hermes session` 的持久别名。历史会话以新 `runId` 打开时，必须通过有效 session 绑定恢复同一份渲染字节，并在发生冲突时拒绝重绑。

对本功能上线前已经存在、且没有快照别名的 Hermes session，首次接入时固定为空快照；不能把“当前最新画像”中途塞进旧历史。之后恢复会话必须复用同一份字节内容（按 sha256 校验），不得每轮重新读取最新 `global-profile.json`——否则用户在另一窗口修改画像后，同一会话的系统提示会发生变化，破坏 Hermes 的冻结快照、提示缓存与学习一致性。

**Envelope 合成（强制）**：现有 `HermesConversationEnvelope` 已承载 Official Agent 的签名版本与策略说明（`hermes-adapter.ts` 的 `composePublishedInstructions`）。全局画像块必须通过确定性 composer **追加**，不得覆盖或修改原有 `instructions` 内容。

验收测试（至少四个）：

1. 中途更新画像，旧 conversation 的 envelope 字节不变；
2. 新 conversation 使用新版本；
3. 全局画像缺失或损坏时 Hermes 正常继续（不阻塞聊天）；
4. Official Agent 原有签名说明与策略内容未被覆盖。

如果使用 TUI/Dashboard 路径暂不支持 envelope，则该请求必须设置 `requireBoundApiTransport=true` 或补齐 gateway envelope 支持后再走 gateway。当前 Desktop 对非空画像、Installed Agent envelope、已显式改名的 identity revision 都固定使用 bound API transport；账号画像随后更新或清空不会改变当前 conversation 的 transport。不能为了注入全局画像而写入 Hermes `USER.md`。

### 6.2 注入文本格式

```text
[System note: AgentEra global user behavior profile]
This block is read-only context supplied by AgentEra.
Do not edit it with the memory tool. Do not copy, summarize, sync, or persist
any part of this block into MEMORY.md, USER.md, Skills, or Curator.
Version: 7
- 用户偏好中文沟通，技术术语可保留英文。
- 用户偏好先给结论，再展开理由。
- 用户执行破坏性操作前需要确认。
[/System note]
```

**直接回流禁令（强制）**：Aera 注入块只能进入 Runtime 的 `ephemeral_system_prompt`/请求时 system instructions；不得进入 Hermes session transcript、Background Review 的 `messages_snapshot`、Memory、USER、Skills 或 Curator。Runtime 验收必须同时证明：注入哨兵出现在模型请求中，但不出现在持久 transcript 与 review 输入中；同一轮真实用户消息、正常 memory tool 写入和 Background Review 触发仍保持原样。

**能力边界（不得虚假承诺）**：LLM 看过画像后，理论上可能主动在前台工具调用中转述或改写其中的事实。若要从语义上绝对阻止，只能拦截/审批/重写 Hermes 的原生写入，或剥夺 Memory/Skills 工具，这会直接破坏本方案的自我进化红线。因此本方案保证“无系统直接持久化、无 Background Review 直接摄入”，并用提示约束降低模型主动复制风险；不声称在不干预 Hermes 写入的前提下实现不可证明的语义信息流隔离。

安全要求：注入文本必须做长度限制、敏感信息过滤和 prompt-injection 扫描；它是 Aera-owned 只读上下文，不是 Hermes memory。

## 7. Agent 身份与 Profile 映射

### 7.1 身份绑定

私有可写状态必须绑定：

```text
agentInstallationId → runtimeProfileId → physical HERMES_HOME
```

`definition_id` 是模板/角色身份，不适合作为私有可写状态的唯一 key。同一 Definition 可被多次安装、跨设备安装或重装；若绑定 Definition，会合并本应独立的自我进化状态。

### 7.2 显式改名与立即生效

Agent 的显示名称最终只能通过显式身份操作改变，不从普通 Memory 写入中自动修改。普通聊天可以产生一个高置信身份候选，但必须由用户确认；确认后调用同一显式身份服务。

Profile 编辑与 `/agent name <任意名称>` 统一执行：原子更新 `profile-meta.json` 与 `SOUL.md` 受控身份块、递增 identity revision、保留原人格内容并生成可撤销备份。事件发出后界面立即更新；当前 renderer transcript 保留，但下一次回复使用新 revision 的底层 Hermes session。需求或测试中的具体名称只是示例。

### 7.3 重装后的记忆延续

如果产品希望“同一角色重装后可延续记忆”，应做显式迁移流程，而不是默认共用同一 Profile。

```text
用户重装同一 Definition
  → 桌面提示：是否从旧 installation 迁移 Hermes Profile？
  → 用户确认
  → same-owner clone / import（不得跨 owner、不得静默复制凭据）
  → 新 installation 获得独立 HERMES_HOME
```

这与 Runtime Profile Contract 的 same-owner clone 规则一致。

## 8. 画像治理器边界

### 8.1 不作为 MemoryProvider

GlobalProfileGovernor 是 Aera 组件，不注册为 Hermes MemoryProvider。

原因：

- MemoryProvider 只能有一个外部 provider，治理器占用该插槽会与 RetainDB、Hindsight、Mem0、Supermemory 等互斥；
- `on_memory_write` 是写后镜像通知，不能实现写前治理；
- 治理器不应参与 Hermes memory manager 生命周期，避免影响自我学习链路。

### 8.2 运行位置

推荐实现为 Aera 主进程服务：

```text
src/main/agentera-global-profile/
├── manager.ts          # 画像读写、版本、审计
├── candidate-manager.ts# 账号分区候选、确认状态、保留期
├── classifier.ts       # 本地高置信候选分类；未来 LLM 必须 opt-in
├── ipc-contract.ts     # 输入输出契约
└── tests
```

它可以读取桌面端可见的会话事件和 RuntimeBinding 元数据，但不得写入 Hermes Profile 内任何文件。

## 9. 权限矩阵

| 操作                          | Hermes         | Aera GlobalProfileGovernor | 用户                    |
| ----------------------------- | -------------- | -------------------------- | ----------------------- |
| 写当前 Agent `MEMORY.md`      | ✅ 自由        | ❌                         | ✅ 通过 Hermes/UI       |
| 写当前 Agent `USER.md`        | ✅ 自由        | ❌                         | ✅ 通过 Hermes/UI       |
| 写当前 Agent `SOUL.md`        | ✅/UI 现有能力 | ❌                         | ✅                      |
| 写全局 `global-profile.json`  | ❌             | ✅（仅确认后）             | ✅ UI/`/global set`     |
| 读取全局画像快照              | ✅ 只读上下文  | ✅                         | ✅                      |
| 读取其他 Agent Hermes Profile | ❌             | ❌（除显式迁移/备份流程）  | ✅ 通过本地文件/管理 UI |

## 10. 实施分期

### P0 — 文档、数据修复与隔离核验（当天）

1. 将本设计文档替换 v1.x，标记 v1.x 为阻塞方案；
2. 被污染 `USER.md` 的修复：**仅限用户主动发起的单 Profile 修复流程**——不作为自动迁移或安装脚本；先预览、备份、确认，可撤销；不得由 GlobalProfileGovernor 执行；“是用户信息还是 Agent 身份”由用户确认，不自动把内容搬入 `SOUL.md`；
3. **隔离不变量现场核验**（非未来功能，而是现行强制契约——安装链路已实现 Installation↔Profile 一对一绑定与冲突拒绝，见 `agentera-profile-binding.ts` / `installation-manager.ts`）：核验所有 runnable Installation 的 canonical Profile path 唯一；发现共享时阻止该 Installation 启动，而非留待后补；
4. 不开启全量 `memory.write_approval`，不拦截 `target=user`。

### P1 — Aera 外置全局画像只读注入（周级）

1. 新增 `agentera-global-profile` 主进程服务与存储；
2. 设置页新增全局画像展示/编辑/历史回滚；
3. 聊天启动时按 §6.1 的合成与持久化规则注入只读画像快照（确定性 composer 追加 + 会话快照持久化）；
4. `/global show` 与 `/global set` 作为桌面命令接入（不改 runtime slash registry，命令不进 transcript）；
5. 验收：§6.1 的四个快照/合成测试 + §6.2 回流断言；不修改 Hermes `MEMORY.md/USER.md/SOUL.md` 的任何写入路径；现有 Hermes 自学习测试与 runtime compatibility gate 必须全绿。

### P2 — Profile 生命周期补齐（迭代级）

1. 补齐 same-owner clone / 记忆迁移流程（重装同一 Definition 时显式询问，不默认共用 Profile）；
2. Conversation start 固定绑定一个 Runtime Profile，运行中不切换（回归断言）；
3. 持续验收：两个 installations 不共享 Memory、USER、SOUL、skills、sessions、credentials、Curator、gateway、cron、logs、caches。

### P3 — 候选治理与人工确认（迭代级）

1. **已实现**：从当前提交的可见用户文本 fire-and-forget 提取结构化候选，不保存原始对话，不延迟 Hermes；
2. **已实现**：MVP 只输出 `agent_identity` / `global_profile` 两类高置信 proposal；普通聊天返回 null，不持久化 `agent_private` 或 `ephemeral` 分类结果；
3. **已实现**：候选使用独立 renderer-only 覆盖层，并以 `turnId` 绑定匹配的成功 Hermes 回合；回复失败不显示、回复结束后才显示，且不进入 Hermes 历史或下一次请求；
4. **已实现**：一次确认把身份 proposal 路由到显式改名服务，把画像 proposal 以 `candidate_confirmed` 来源版本化写入全局画像；任一步失败均按确认前文件字节补偿回滚；
5. **已实现**：拒绝、过期、重复、跨账号与跨 Profile 候选均 fail closed；候选文件权限 `0600`，不含原始 transcript；
6. **未纳入本期**：更宽泛的行为推断继续关闭；若未来启用，须先做独立 opt-in、影子评估与准确率门禁，不影响当前明确指令闭环。

## 11. 明确删除的 v1.x 设计

| v1.x 设计                              | 处理 | 原因                                          |
| -------------------------------------- | ---- | --------------------------------------------- |
| `memories/agents/<agent_id>/` 拆分     | 删除 | Hermes 隔离单位是完整 HERMES_HOME             |
| 用 Hermes `USER.md` 作为全局画像       | 删除 | `USER.md` 是 Profile 私有原生学习文件         |
| 拦截 `target=user`                     | 删除 | 会延迟/改变 Hermes 原生学习                   |
| `PROFILE.md` 放入 Hermes Profile       | 删除 | 与 USER.md 职责重叠，造成第二套学习引擎       |
| `profile_governor` 作为 MemoryProvider | 删除 | 占用唯一外部 provider 且无法写前治理          |
| 自动晋升推断画像                       | 删除 | 推断型必须用户确认，避免扩散临时行为          |
| definition_id 作为私有记忆 key         | 删除 | 私有可写状态绑定 installation/runtime_profile |

## 12. 保留的 v1.x 设计资产

| 保留项                 | 新位置                                    |
| ---------------------- | ----------------------------------------- |
| 行为画像白名单         | `agentera-global-profile/classifier.ts`   |
| 版本历史 / 撤销 / 审计 | Aera-owned `history/` 与 `audit/`         |
| `/global` 命令         | 桌面斜杠命令系统                          |
| 新会话只读快照         | `HermesConversationEnvelope.instructions` |
| 影子模式与人工标注     | P3 候选治理                               |
| 组织空间画像分叉问题   | 仍为产品决策，需与企业数据边界一致        |

## 13. 开放问题

1. MVP 存储已确定为 Electron `userData/agentera-global-profile/<userId>/`；Cloud 加密同步属于独立后续方案。
2. 组织空间画像是否分叉：个人画像是否可进入企业上下文？建议分叉为 `personal_global_profile` 与 `organization_work_profile`。
3. Same-owner clone 的 UX：重装 Agent 时是否默认询问迁移旧 Profile，是否允许复制凭据。
4. Dashboard/TUI 后续是否原生支持 `HermesConversationEnvelope`；在支持前，任何需要 envelope 或 identity revision 追踪的 conversation 都强制 bound API transport。
5. expired 候选的物理垃圾回收策略尚未实现；当前只会 fail closed 并持久标记 `expired`，不得把它与账号数据彻底删除混为一谈。

## 14. 验收红线

- 任意实现不得修改 `aera-runtime/tools/memory_tool.py` 的 `target=user` 与 `target=memory` 落盘语义；
- 任意实现不得替换、延迟、审批 Hermes background review 的 memory/skill 写入；
- 任意实现不得把 Aera 全局画像写入任何 Hermes `HERMES_HOME`；
- 任意实现不得修改 `aera-runtime` 的 MemoryProvider 机制、原生文件路径或 slash-command registry；**如实施过程中发现需要修改上述任一项，视为架构越界，立即停止实施并回到设计评审**；
- 生产逻辑优先位于 Aera Desktop 主进程及现有 Envelope 组合链路；当前 Runtime 已有 `ephemeral_system_prompt` provenance，先通过行为测试锁定，不为本功能新增 Memory/Skill 拦截器；
- Runtime compatibility gate 必须双向证明：画像指令不进入持久 transcript/review 输入，且 Hermes prompt cache、正常 Memory/USER 写入、background review、skill、Curator、Profile invariants 全部保持；
- `aera-runtime/tests/test_ephemeral_context_self_evolution.py` 是本功能新增的行为契约测试；除该测试外，当前功能不得要求修改 Runtime 生产代码；
- renderer 确认卡必须保持 renderer-only，并绑定对应成功回合的 `turnId`；不得把卡片、候选摘要或确认结果伪装成对话消息送入 Hermes；
- 如 Aera 全局画像注入失败，会话应继续使用 Hermes 原生 Profile，不阻塞用户聊天。
