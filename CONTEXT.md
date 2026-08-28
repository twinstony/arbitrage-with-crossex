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
