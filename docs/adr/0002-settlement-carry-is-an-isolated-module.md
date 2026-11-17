# 结算播报独立成模块：零冲突优先于复用（settlementCarry.ts）

Boros 官方结算提醒只播报 Boros 一个账户（币结算：「Net −0.0000506 BTC」），
用户会把「Boros 付币」误读成亏损，而同期 CrossEx perp 的资金费正好等额进 U——
两者相加才等于锁定的息差。因此需要一条合并播报：每 8 小时结束时，把 Boros
结算与同期 CrossEx 资金费/手续费配对成一条 fwalert 文本。

本仓库是上游 `pendle-finance/arbitrage-with-crossex` 的 fork，需要频繁同步。
上游改动集中在 `server/routes/assetView.ts`、`core/boros/client.ts`、
`server/notify/scanner.ts` 这些正好也需要复用的文件上。

决定：播报逻辑整体放进**一个新模块** `src/server/notify/settlementCarry.ts`，
既有文件只动 `src/server/index.ts`（1 行 import + 1 处启动调用）；模块所需的
CrossEx 账本读取（约 30 行）在模块内**自带一份**，不从 `assetView.ts` 抽取；
配置由模块自己读 `process.env`，不改 `scanner.ts` 的 `readNotifyConfig`。

## Considered Options

- **在 `assetView.ts` 里抽出 `listCrossexAccountBook` 供两处复用**（DRY 的直觉
  答案）：语义更干净，但把播报和上游最活跃的文件焊在一起——每次上游改账本读取
  （分页、`from` 语义、去重注释）都要解一次冲突，且冲突解错会同时污染持仓页。
- **改造 `scanner.ts` 的调度**，把 8h 窗口并进同一个扫描链：会让一个「每 5 分钟
  的机会扫描」载上「每 8 小时的窗口结算」，任一方的节奏调整都牵动另一方。
- **独立模块 + 自带账本读取**（本决定）：重复 30 行换取零冲突面；窗口调度、
  游标、审计全部私有，上游合并时只会碰到 `index.ts` 的 2 行。

## Consequences

- `git diff --stat` 对上游是「1 个文件 2 行 + 新文件」，合并成本可预测。
- 账本读取有两份实现（assetView 与本模块）。它们读的是同一份 Gate 账本、同一
  字段语义；分页参数变化时**两边都要看一眼**——这是本决定明码标价的代价。
- `sendFwAlert` 的 `event` 字段写死为 `Boros_APR_Alert`，而 `fwalert.ts` 属于
  不允许改动上游文件，因此结算播报沿用 `Boros_APR_Alert`（消费端只渲染
  `details`，整条消息都在那个字段里）。要改用新的 `Boros_Settlement_Carry`
  事件，得先让上游接受 `sendFwAlert` 增加事件参数。
- 金额符号以 `BorosSettlementEvent.settlementToken` 的定义为准：**带符号净额**
  （+ = 账户收到，一笔收益；− = 付出），且已扣当期手续费。所以 Boros 腿
  USD = `settlementToken × tokenPrice`，不再二次减 fee，也不取反。
- 「实际价差」**是浮动腿的实现率，不是结算净额**（审阅第 2 轮阻塞项）：结算净额
  `settlement` = 锁定 − 浮动（空头），拿它当「实际」会把「少赚/多赚」判反。每期口径：

  ```
  fixed = |entryApr| × paymentPeriod / YEAR_SEC        // 锁定腿折成每期
  net   = Σsettlement / Σ|仓位|                        // 每期净额（带符号）
  fee   = Σfee / Σ|仓位|                               // 每期费率的成本
  float = fixed − net − fee（空头） / fixed + net + fee（多头）
  actualApr = float × YEAR_SEC / paymentPeriod × sideSign
  ```

  实测（2026-11-17 00:00–08:00 UTC）：BTC entryApr 4.0967%、净额 −2.0555%（年化）、
  浮动实现率 **5.95%/年**（锁定 4.10% → 少赚 1.86pp）；ETH **6.58%/年**（锁定 3.66% → 少赚 2.92pp）。
- **归期按期终，不按落账时刻**（审阅第 2 轮阻塞项）：三源落账都比期终晚——Boros 结算
  晚约 118s（每 8h 一次，00:01:58 落的是 [16:00, 00:00) 那期），CrossEx 账本行晚约 2 分钟
  （8h 所的 `businessId` 尾缀就是期终 epoch，如 `…_1794873600`；HL 的每小时行尾缀是整点）。
  统一规则：`期终 = floor(t / paymentPeriod) × paymentPeriod`，取 `期终 ∈ (from, to]` 的记录。
  账本行的期终取 `businessId` 尾缀（须像样 epoch，否则退回 `createTime`——利息行是纯 id）。
  调度宽限因此必须 ≥ 实测落账延迟：`BOUNDARY_GRACE_SEC = 180`（原 60s 结构上永远拿不到
  本窗口自己的结算）。
- 「实际价差」的两件易错事（审阅第 1 轮打回的两个阻塞项，长期有效）：
  1. **每期 vs 年化**：`BorosSettlementEvent.settlementRate` 是**每期**收益率
     （实测逐位等于 `|settlement| / |positionSize|`；8h 市场就是 8h 的收益率），
     而锁定价差 `entryApr` 是年化 APR。两者相减前必须按该市场的 `paymentPeriod`
     年化（`× 365d / paymentPeriod`），否则 8h 市场的实际价差被低估约 1000 倍。
  2. **该字段不带符号**（付出窗口也是正数）：每期净额一律由现金流
     `settlementToken / |position|` 推出，不用 venue 回报的 `settlementRate` 的符号。
  这两条只在 `settlementCarry.ts` 内处理——`core/boros/client.ts` 的字段注释仍是
  上游的写法（写明「年化」），本模块以实测行为为准，不改上游文件。
- 播报与审计一律**不做累计统计**：单腿大额获利的窗口会污染累计口径，干扰
  「本窗口是少赚还是多赚」的判断。审计每行只记本窗口事实。
