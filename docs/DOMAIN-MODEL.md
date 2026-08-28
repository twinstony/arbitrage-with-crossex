# 领域模型 — CrossEx Boros Terminal

> 本文是项目的完整领域模型：子域划分、核心概念、状态机、不变量与外部契约。
> 术语速查见根目录 [CONTEXT.md](../CONTEXT.md)（纯词汇表）；执行引擎的工程论证见
> [MAKER-HEDGE.md](./MAKER-HEDGE.md)；面向操作的说明见 [USER_GUIDE.md](./USER_GUIDE.md)；
> 架构决策见 [docs/adr/](./adr/)。

---

## 1. 领域概述

**一句话**：这是一个**跨所固定资金费率套利终端**——在 Boros（Pendle 的资金费率市场）上发现并锁定同一标的不同交易所资金费率的价差，用 Gate CrossEx 的统一保证金 perp 对冲掉浮动与价格风险，并管理从发现到到期平仓的完整生命周期。

**经济本质**（4 腿套利，全部同名义本金 N）：

| 腿 | 交易所 | 方向 | 效果 |
|---|---|---|---|
| L1 perp SHORT | 交易所 A | 收 A 浮动资金费 | 与 L3 的浮动义务对冲 |
| L2 perp LONG | 交易所 B | 付 B 浮动资金费 | 与 L4 的浮动义务对冲 |
| L3 Boros SHORT FR | A 的费率市场 | **收**固定 rate_A | 击中 bids 成交 |
| L4 Boros LONG FR | B 的费率市场 | **付**固定 rate_B | 抬动 asks 成交 |

每个交易所内浮动项对消，两个 perp 互相对消价格风险 → 净敞口 = **锁定价差
`rate_A − rate_B`**，持续到到期。真正属于用户的是：**扣完全部成本后、按占用资金
年化的净固定收益（netFixedAprOnCapital）**。

**Fixed ≠ risk-free**：CEX 托管风险、统一保证金风险、价差发散清算风险、Boros
清算风险、执行腿未对冲风险（见 USER_GUIDE §4）。

---

## 2. 子域地图

```
┌─ 机会子域（发现）─────────────────────────────┐
│ opportunities: arb group → pair 定价 → 净年化 │
└──────────────┬───────────────────────────────┘
               │ "Execute it" 预填
┌──────────────▼───────────────────────────────┐
│ 交易子域（执行）                              │
│  ├─ Boros 两腿市价/限价入场（boros/pair）      │
│  ├─ CrossEx 单笔/篮子预览（actions/preview）   │
│  └─ 执行引擎（engine: Deal 状态机 + reconcile）│ ← 真金白银的 correct 核心
└──────────────┬───────────────────────────────┘
               │ 成交记录（deal 日志 + venue fill history）
┌──────────────▼───────────────────────────────┐
│ 持仓与收益子域（监控）                         │
│  ├─ Strategy 求解（returns）                  │
│  ├─ 切分（partition: atom/tranche/pin）        │
│  └─ 时钟 / 资金口径 / 展示门控                 │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│ 通知子域（push）—— 复用上面全部口径            │
│ notify: 定时扫描 → Top-N pair → TG/fwalert    │
└───────────────────────────────────────────────┘
```

支撑设施：`estimate/`（成交模拟与费用估算）、`numbers.ts`（十进制定点数）、
`clients.ts`（Gate/Boros 客户端）、SQLite（引擎账本）。

---

## 3. 机会子域

- **Arb group（= Opportunity）**：同抵押品 + 同到期 + 同标的、≥2 个市场的分组。
  一个 group 含多个 **Pair**（两两市场的 SHORT/LONG 组合）。
- 定价 = 对选定名义本金走书（walk the book）得到**可执行**的锁定率（不是中间价），
  减去全部可建模成本：Boros taker 费、结算费、价格冲击；perp 进出场费、滑点；
  杠杆上限约束（风险限额表）。
- 产出两个年化口径：**Fixed APR on capital**（排序与告警唯一口径）与
  **Fixed APR on notional**（展示）。
- **输入降级为 null + 一句人话原因**（`reasons`），从不猜测；Gate 未配置时仍能
  Boros-only 定价（市场视图不 503）。
- 用户可选假设（不ional、perp 进出场方式、Boros 入场方式、VIP 费率档）——同一
  组合是**不同的计算**。

---

## 4. 交易子域

### 4.1 Boros 两腿入场（`boros/pair.ts`）

在一个价差上双腿击书：`spread = exec_short − exec_long − fees`。
- 方向纪律：exec 率对收固定腿越高越好、对付固定腿越差越好——滑点在数轴上反向、
  在价差上同向，**两侧容差相加**（`worstSpreadApr = estSpread − (slipShort + slipLong)`）。
- 单位纪律：Boros 侧一切金额以**抵押品代币**计（保证金桶的计价单位）；滑点容差
  用 **APR 分数**报价（书以"率"为价格空间，率相对容差在不同水平书上含义不同）。
- agent key 架构：终端只持有**委托交易密钥**（不能提币），根私钥永不落库。

### 4.2 CrossEx 单笔/篮子（`actions/preview`）

- `resolveActions`：无副作用的完整解析（规则、数量、价格、配对校验），问题呈现为
  结构化 **violations**（硬违禁才拒绝执行），预览把所有问题内联渲染。
- 预览 = 解析 + 成交估算（book walking + 费率）——估算仅供参考，violation 才拦截。

### 4.3 执行引擎（`engine/`）—— 正确性核心

**Deal（= PairRow，意图行）**：一切交易（maker+hedge 对、双腿市价对、单开、平仓）
都是一种 Deal——"把 A 腿收敛到目标量，同时让 B 腿（若存在）对冲 A 的每一分成交"。

- **Leg A** = 获取腿（OPENING 时是 POC maker；CONVERTING 时是 taker 分片）；
  **Leg B** = 对冲腿（市价/IOC，反向敞口）；单腿 Deal 时 B 为 null。
- 用户命令（Stop / Convert / Re-peg / resume）**只改意图行**（level 触发，非事件）。

**状态机**（PairMode）：

```
OPENING ──deadline / convert-now──► CONVERTING ──residual 完成──► DONE
OPENING ──用户 stop / 交易所需撤销──► STOPPING ──settled──► DONE
OPENING|CONVERTING ──对冲墙──► HALTED ──人工 resume──► STOPPING
OPENING ──目标满仓且已对冲──► DONE
```

**订单状态**：`PENDING → OPEN → CLOSED`；`PENDING → DEAD`（确定性拒绝/证实不存在）。
刻意**不存在** PENDING_CANCEL / SUBMITTING / RETRYING——撤销幂等触发、效果被观察，
与 cancel 竞速的成交由"对冲到最终 cum"自动捕获。

**核心协议**（详见 MAKER-HEDGE.md）：
- **预留记账（reservation accounting）**：`reserved = PENDING/OPEN 时记全额
  （悲观——只会露出欠对冲，绝不超额对冲），CLOSED 记实成交，DEAD 记 0`。
- **Write-ahead 提交**：先 INSERT PENDING（fsynced）再发 wire；结局**三态**
  （ok / 业务性 reject 白名单 / **unknown=一切其它**，默认存疑而非失败）。
- **冻结规则**：任何订单命运未卜时禁止一切新开仓；只有撤销类动作可以绕过。
- **解除梯子**：按 id 探查 → 失败读不解任何事 → 权威 not-found 且超时窗后做
  **可证明覆盖**的符号过滤 sweep → covered-and-absent 才 DEAD。
- **开放世界解码**：未知状态串 → quarantine（隔离冻结）+ 告警，绝不猜终态。
- **单一写者**：一个 setTimeout 链 reconcile loop 是唯一突变者，每 tick 至多一次
  wire 突变；恢复即普通 tick（无恢复模块）。
- **墙（wall）**：A 腿反复失败（POC 拒绝/whiff）与 B 腿对冲失败共享退避 + 阈值
  告警/HALT 机制，防止无限重试。
- **诚实完成**：Deal 可以带着低于最小可提交量的残余完成，但残余存在会被**点名**
  （unacquired residual / unhedged）——"named beats idling"。

**数字纪律**：全引擎十进制定点（bigint fx），**只向下取整**、无任何 round-up 路径；
一切规则快照在创建时冻结进 Deal。

---

## 5. 持仓与收益子域

- **Strategy**：一个 Boros 地址在同一到期上的 4 腿聚合。现金流按**腿的实际带符号
  现金流求和**（不"对消浮动"），perp 腿价格 MtM 被刻意排除（delta-neutral 下两腿
  uPnL 对消，入场差价已作为 pair 级 entry slippage 计一次）。
- **时钟（clock）**：年化的起算点，默认 Boros 开仓时刻，可被用户覆盖。perp 腿的
  资金费从时钟起点重基（account-book funding ledger），Gate 的累计计数器只作
  有警告的回退。
- **切分（partition）**：一个 venue 腿同时服务多个策略时（Gate 报混合均价、
  Boros 报混合固定率），从**执行记录**重建 tranches：本地 deal 日志 + venue fill
  history（fill 的 text 带本引擎写的 client id，可回join）。
  - 配对原子（**atom**）→ 绑定成 **execution**（"哪些单是一起下的"——分组先于
    卡片切分，否则一次交易的两腿会落到两张卡上）。
  - **置信来自不可思异性而非出处**：对手侧、异所、数量匹配、时间接近这些独立
    信号共同构成"这就是跨所对冲"的证据——身份只是最不可思异的巧合。
  - 无记录可依时按价格/时间**接近度猜测并明说**（split unconfirmed）： crossing
    成本报 **unknown** 而非估计；locked spread 回退混合率。
  - 用户纠错：**Pin size**（钉住后其余重新求解）、**Detach**（两腿不是一策略 →
    双双报 unhedged）、**Back to automatic**；pin 被缩量时**钳位并报告**，绝不静默
    缩放；孤儿数量获得自己的 unhedged box。
- **资金口径（capital basis）**：perp 侧恒为初始保证金；Boros 侧两种读法——
  **Posted balance**（抵押账户余额分摊）vs **Margin used**（仅腿占用的 IM），
  按浏览器记忆，影响一切 APR。
- **展示门控（sizing gate）**：未 **fully hedged** 时隐藏 Fixed APY / PnL at
  maturity / Capital（半仓名义上的全周期投影读起来像好交易），只留 PnL now 与
  对冲提示。通知消息（TG）镜像同一门控。

---

## 6. 通知子域

- **Scan**：定时（默认 300s）经同一 `/api/opportunities` 管线全量定价。
- 展示与排序**直接 import web 面板的变换代码**（`display.ts` re-export
  `toRows` / `fmt` / `marginParts` / `fixedAprOnCapital`）——面板是口径的唯一
  source of truth，服务端手抄必然漂移（ADR-0001；已三次教训）。
- **Telegram**：每轮 Top-5 pair 脉冲 + 持仓汇总（同一消息）；**fwalert webhook**：
  仅 pair 首次**越线**（capital APR ≥ 阈值）时告警，内存去重、跌回重臂。
- 失败纪律：扫描失败/降级（一个 pair 都没定价出）静默重试（60s，最多 5 次）；
  真实无机会（定价了但全负）是有序态，不追；策略 payload 降级（perp overlay
  缺失）时按门控隐藏数字并原样携带警告。
- 已知边界：面板浏览器本地设置（成本开关等）对服务端不可见——通知按面板默认值
  （roll/include）计算。

---

## 7. 外部系统与端口

| 外部系统 | 角色 | 适配 |
|---|---|---|
| **Gate CrossEx** | perp 执行与账户（统一保证金） | 官方 SDK（axios，直连）；凭据热切换 |
| **Boros（Pendle）** | 资金费率市场：市场/订单簿/交易/抵押区/交易历史 | 公开 REST（fetch，经代理）；下单用委托 agent key |
| 各所行情（Binance/OKX/Bybit/Hyperliquid…） | perp 腿的公开 book | `estimate/books` 拉取 |
| SQLite | 引擎账本（意图 + write-ahead 订单注册表 + 观察事实 + 告警） | 单文件、EXCLUSIVE 锁兼单实例守卫 |

引擎与 venue 的全部交互收敛于 **VenuePort** 六边形端口（create/cancel/getOrder/
sweep/touch/refPrice），读三态、写三态，"unknown"永远存在——仿真 venue 用同一
端口做崩溃注入测试。

---

## 8. 数字与单位约定（全局）

- **APR 一律是每年小数分数**（0.30 = 30%），永不为百分数；`fmtPct` 只在展示层转换。
- **USD 金额**：正 = 利好持有者；带符号字段逐一注明。
- Boros 模块内金额以**抵押品代币**为单位，USD 是展示层换算。
- 滑点容差以 **APR 分数**表达（书以率为价格空间），从不用"率的百分比"。
- 十进制数用 bigint fx 定点表示，字符串为传输格式；引擎内无浮点。

---

## 9. 决策索引

| 决策 | 位置 |
|---|---|
| 展示变换以 web 面板为唯一实现，服务端直接 import | [ADR-0001](./adr/0001-display-transforms-live-in-the-web-panel.md) |
| 执行引擎：一个循环、一个账本、一个写者；write-ahead 协议；开放世界解码 | docs/MAKER-HEDGE.md（hazard → 机制对照表） |
| 配对置信来自不可思异性而非出处 | `core/boros/grouping.ts` 模块注释 |
| perps anchor / 匹配单仓位而非净额 / closes FIFO | `core/boros/partition.ts` 教义 |
| 通知口径以面板为准、用户设置不可见 | [ADR-0001] Consequences |
