# Arbitrage with CrossEx

扫描 Boros 固定资金费率套利机会、定价 4 腿交易并执行（CrossEx maker/hedge）的工具。

## Language

### 套利与定价

**Opportunity（机会）**:
一个 Boros arb group（同抵押品 + 同到期 + 同标的、≥2 个市场）在选定名义本金下的定价结果，含全部成本。一个 group 提供多个两两组合的 Pair。
_Avoid_: deal（deal 专指已开仓的交易，即 positions/pair）、trade

**Pair（可交易组合）**:
一个 Opportunity 内两个 Boros 市场的 SHORT/LONG 组合，是独立可执行的交易，有自己的净年化。web 卡片与 TG 摘要都以 Pair 为展示与排序单位；可行性规则：资金口径净固定年化为有限且非负。
_Avoid_: 机会（不指明 group 或 pair 时）

**Fixed APR on capital（资金口径净固定年化）**:
扣除全部成本后、按交易占用资金（Boros 初始保证金 + perp 初始保证金）年化的净收益。机会排序与告警阈值的唯一口径。
_Avoid_: headline APR、净收益（未指明口径时）

**Fixed APR on notional（名义口径净固定年化）**:
同一净收益按每腿名义本金年化的口径，数字因杠杆而更高。仅作展示，不用于排序或告警。
_Avoid_: APR（不加限定词时一律指 capital 口径）

### 持仓

**Strategy（策略）**:
一个 Boros 地址在同一到期上的持仓聚合：Boros SHORT/LONG 腿及其对应的 perp 对冲腿。web 持仓卡片与 TG 持仓段都以 Strategy 为单位。
_Avoid_: position（指单腿持仓）、deal（引擎里一笔已开仓的交易）

**Perp overlay（perp 叠加）**:
把 Gate 账户的 perp 持仓叠加到 Boros 腿上、使 Strategy 完整的过程。缺失时策略退化为仅 Boros 腿，对冲状态无从验证。
_Avoid_: 对冲数据、账户同步

**Fully hedged（完全对冲）**:
Boros 腿之间、perp 腿之间、两层之间的规模比全部匹配的状态。它是展示门控的钥匙：未完全对冲时，Fixed APY、到期预期 PnL、Capital 必须隐藏——半仓名义上的全周期投影读起来像好交易。PnL now 是真实现金流，任何状态下都可见。
_Avoid_: partial（partial 是未匹配的中间态，不是这个问题）

**Fixed APY（卡片口径年化）**:
到期预期 PnL 按资金、在完整生命周期（开仓 → 到期）上的年化。与机会定价里的 Fixed APR on capital 不同：策略的时钟从实际开仓起算，且直接对冲不完整时被门控隐藏。两者数字不同且都合法，混用是历史 bug 源。
_Avoid_: 与 Fixed APR on capital 互换使用

**Margin utilization（保证金占用率）**:
CrossEx 保证金账户的 IM（初始保证金占余额比）与 MM（维持保证金占余额比），定义为保证金 ÷ 余额——刻意不采用 Gate 的 MarginRate 字段，那些是覆盖率（方向相反）。
_Avoid_: margin rate、健康率（不指明定义时）

**Degraded view（降级视图）**:
输入缺失时的诚实降级：perp overlay 不可得 → 仅 Boros 腿；机会的某项输入不可得 → null 加一句人话原因。降级视图的数字必须门控或标注，从不猜测。
_Avoid_: 空数据、错误（降级不是错误，是有意为之的可信降级）

### 执行引擎

**Deal**:
一切交易（maker+hedge 对、双腿市价对、单开、平仓）的统一形态：把 A 腿收敛到目标量，同时让 B 腿（若存在）对冲 A 的每一分成交。意图行是唯一被用户命令编辑的东西。
_Avoid_: order（order 是 Deal 发出的单笔订单）、trade、pair（另指可交易组合）

**Leg A / Leg B**:
A = 获取腿（OPENING 时 POC maker，CONVERTING 后 taker 分片）；B = 对冲腿（市价/IOC，反向敞口）；单腿 Deal 无 B。对冲语义是“对冲 A 的实成交”，不是“对冲目标量”。
_Avoid_: 主腿/次腿

**Freeze（冻结）**:
任何订单命运未卜时禁止一切新开仓的规则；只有撤销类动作可绕过。Pessimism 预留只会露出欠对冲，绝不超额对冲。
_Avoid_: 暂停、停止（Stop 是用户命令）

**Quarantine（隔离）**:
交易所需返回无法分类的状态串时，订单冻结冻结等待后续可读状态解除；绝不猜终态。
_Avoid_: 失败（隔离不是终态）

**Re-peg**:
移动未成交 maker 的限价意图。'touch' 跟随盘口，'fixed' 是用户指定价；撤销旧单重挂是唯一实现。
_Avoid_: 改价、追价

**Convert（转换）**:
OPENING 超时或手动触发后：撤销 maker，剩余目标用 taker 分片完成。超时与手动是同一代码路径。
_Avoid_: 强平、市价清仓

**Hedge wall（对冲墙）**:
对冲腿连续零成交失败时递增的计数与退避，越过阈值即 HALT（终态待人工）。A 腿的同类预算独立计数。
_Avoid_: 重试上限（墙是状态，不是参数）

### 切分与收益

**Execution（执行）**:
“哪些单是一起下的”这一事实对象——一组绑定的 atom。分组先于卡片切分，否则一次交易的两腿会落到两张卡上。置信来自不可思异性而非出处。
_Avoid_: order、deal

**Tranche / Atom**:
Atom 是书本的组成单元（一笔 perp 仓位或 Boros 仓位的一股）；Tranche 是一个 venue 腿归属某一策略的那一部分。切分从执行记录重建，无记录时按接近度猜测并明说。
_Avoid_: 份额（未区分是否有记录支撑）

**Clock（时钟）**:
年化的起算点，默认 Boros 开仓时刻，可被用户覆盖；perp 腿资金费从时钟起点重基。
_Avoid_: 开始时间（未指明影响范围）

**Capital basis（资金口径）**:
Boros 侧资金的两种读法：Posted balance（抵押账户余额分摊）与 Margin used（仅腿占用 IM）；影响一切仓位 APR。
_Avoid_: 本金（未指明读法时）

**Venue max leverage（交易所最大杠杆）**:
某所某标的风险限额表允许设置的最高杠杆，各交易所各不相同。统一保证金下，leg 的杠杆设定只是保证金效率旋钮（IM = 名义/杠杆），不改变敞口与对冲质量；资本模型一律按各腿自身最大杠杆计，得出的是理论最低资金占用。
_Avoid_: 杠杆风险（敞口由名义本金决定，与杠杆设定无关）

### 通知

**Scan（扫描）**:
对全部 Boros arb groups 的完整定价遍历，产出一组 Opportunity。
_Avoid_: 检查、监控（scan 是一次定价计算，不是状态巡检）

**Threshold crossing（越线）**:
一个 Opportunity 的 Fixed APR on capital 首次 ≥ 告警阈值的事件。每次越线触发一次 Webhook 告警。
_Avoid_: 触发告警（告警是越线的动作，不是状态）

**Re-arm（重臂）**:
机会的 Fixed APR on capital 跌回阈值以下时清除其已告警状态，使其再次越线时可重新告警。
_Avoid_: 重置、恢复
