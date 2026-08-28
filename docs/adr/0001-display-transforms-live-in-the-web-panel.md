# 展示变换以 web 面板为唯一实现，服务端直接 import（display.ts）

web UI 的每个数字 = API 响应 + 浏览器端的展示变换（`opportunityFilters.toRows` 的
pair 平铺/可行性/排序、`strategyMath` 的成本开关与 Fixed APY、`fmt` 的数字格式、
`marginParts` 的 IM/MM）。通知消息（Telegram/fwalert）要求数字与卡片完全一致，而
服务端手工复刻这些变换已被证实必然漂移——两个线上口径 bug（exitMode 差异、
Fixed APY 口径）与一个门控缺失都源于此。

因此决定：这些变换只存在一份实现，物理上放在 `web/src`（面板是 source of
truth），服务端通过 `src/server/notify/display.ts` 薄层 re-export 直接 import。
新通知字段如果需要变换，先找 web 侧是否已有；没有就在 web 侧建共享纯函数（如
`strategyMath.fixedAprOnCapital`），两侧同时消费，不允许服务端手抄。

## Considered Options

- **服务端手抄变换逻辑**（最初做法）：实现局部、无跨构建耦合，但已三次产生
  口径漂移，且每次都等到用户对着 UI 报数才发现。
- **从 web UI 抓取渲染结果**（SPA 无独立数据源）：脆弱且间接，否决。
- **共享纯函数模块**（本决定）：变换单一实现；代价是服务端依赖 web/src 的纯
  模块（`opportunityFilters` / `strategyMath` / `lib/fmt` / `lib/margin`），
  这些模块必须保持无浏览器 API（React 组件文件不能被服务端 import，故
  `marginParts` 已提取到 `lib/margin.ts`）。

## Consequences

- 修改 web 卡片口径时，TG 消息自动跟随，无需（也不允许）同步改动通知代码。
- 已知边界：面板上由浏览器 localStorage 保存的用户设置（退出成本开关、入场
  成本假设、筛选器）对服务端不可见——通知一律按面板默认值（roll/include）计算。
- 两处类型 seam 靠 JSON 契约对齐（`web/src/api/types.ts` 手工镜像服务端
  payload 类型），`display.ts` 边界上的 cast 是契约而非猜测。
