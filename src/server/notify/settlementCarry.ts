/**
 * 💰 结算播报（settlement carry broadcast）—— 每 8 小时把 **Boros 结算** 与
 * **CrossEx 同期的 perp 资金费/手续费** 合并成一条 fwalert 文本推送。
 *
 * 为什么要有这个东西：Boros 官方结算提醒只播报 Boros 一个账户（例如
 * 「Paid 5.95% | Recv 4.1% | Net −0.0000506 BTC」）。一期结算里 Boros 侧付币，
 * 恰恰说明同期 perp 侧收了等额的 U——两者相加才是锁定的息差。分开看会把
 * 「形态」误读成「亏损」。所以本模块按 **Boros 结算腿** 为主键，把同窗口的
 * CrossEx 资金费/手续费配对进来，逐腿给出 USD 金额与币的数量增减，并附
 * 「锁定价差 vs 实际价差」的对照。
 *
 * 设计约束（issue #4，针对上游频繁同步的 fork 需要零冲突）：
 *
 *  - 新增逻辑全部在本文件（+ 单测 + `data/` 下的游标/审计/心跳文件），
 *    既有文件只动 `src/server/index.ts` 的两行。
 *  - CrossEx 账本读取在这里**自带一份**（`listCrossexAccountBook` 及其分页），
 *    刻意不从 `routes/assetView.ts` 抽取：那 40 行重复换来的是 assetView 零改动，
 *    上游改它时本文件不会冲突，也不会有人为了本模块去改 assetView 的语义。
 *  - 配置自己读 `process.env`，不改 `notify/scanner.ts` 的 `readNotifyConfig`。
 *  - 不新增 HTTP 路由；心跳写 `data/settlement-carry-state.json`。
 *
 * 口径（与 `docs/DOMAIN-MODEL.md` §8 一致）：
 *  - 内部以**币**计，USD 只是展示层换算（`settlementToken × tokenPrice`）。
 *  - `BorosSettlementEvent.settlementToken` 是**带符号的净额**，实测定义就是
 *    `yieldReceived − yieldPaid − fee`（已扣当期手续费，+ = 账户收到、− = 付出），
 *    因此 USD = `settlementToken × tokenPrice`，**不再二次减 fee、也不乘 (−1)**。
 *    （issue #4 §4 里那个 `× (−1)` 是笔误：字段本身已带符号。）
 *  - perp 侧 `fundingUsd + feesUsd` 同样带符号（Gate 账本 `change` 字段原样求和，
 *    付出为负）。
 *  - **每期 vs 年化**：Boros 的 `settlementRate` 是**每期**收益率（8h 市场就是
 *    8h 的收益率，实测逐位等于 `|settlement| / |positionSize|`），而 `entryApr`
 *    是**年化** APR。两者必须同口径才能相减，所以「实际价差」一律按该市场的
 *    `paymentPeriod` 年化：`× 365d / paymentPeriod`。
 *  - **符号取自现金流，不信 `settlementRate`**：该字段不带符号（付出窗口也是正数），
 *    所以每期费率由 `settlementToken / |positionAbs|` 推出——符号即结算方向。
 *  - **实际价差 = 浮动腿的实现率，不是结算净额**：净额 = 锁定 − 浮动（空头），
 *    直接拿净额当「实际」会把「少赚/多赚」判反。空头 `fixed − 净额 − 费率`、
 *    多头 `净额 + fixed + 费率`（`fixed` = `|entryApr|` 折成每期值，净额/费率
 *    按 |仓位| 归一），再按 `side` 取号与 `lockedApr` 相减。
 *  - **归期按期终，不按落账时刻**：期终 = `floor(t / paymentPeriod) × paymentPeriod`。
 *    Boros 结算落账比期终晚约 2 分钟（实测 118s），CrossEx 账本行同样晚约 2 分钟，
 *    两源都按 `期终 ∈ (from, to]` 归窗——否则配对的两侧各差一期/一小时。
 *    账本行的期终取 `businessId` 尾缀的 epoch（venue 自己记的期终）。
 *  - **不做累计统计**：一个窗口就是一段时间里的现金流，累计口径会被单腿大额
 *    获利污染，干扰判断。
 *
 * webhook：复用 `fwalert.ts` 的 `sendFwAlert`。它的 `event` 字段固定为
 * `Boros_APR_Alert`，而 fwalert.ts 属于上游文件（本次不允许修改），因此按 issue
 * 给出的回退方案沿用 `Boros_APR_Alert`——消费端只渲染 `details`，整条消息都在
 * 那一个字段里。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOROS_TOKEN_SYMBOLS,
  createRequestPacer,
  fetchBorosCollaterals,
  fetchBorosMarkets,
  fetchBorosMarketsByIds,
  norm18,
  resolveBorosFetch,
  resolveCollateralPricesUsd,
  settlementWindow,
  syncSettlementLedger,
  type BorosCollateralZone,
  type BorosMarket,
  type BorosSettlementLedger,
  type FetchLike,
} from '../../core/boros/client';
import { normalizeVenue, type PerpPositionLike } from '../../core/boros/venue';
import { makeClientsIfConfigured, type Clients } from '../../core/clients';
import { parseSymbol } from '../../core/numbers';
import { readOwnerJson, writeOwnerOnlyJson } from '../secretFile';
import { fmtUsd } from './display';
import { readFwAlertConfig, sendFwAlert, type FwAlertConfig } from './fwalert';

// ---------------------------------------------------------------------------
// 配置与调度
// ---------------------------------------------------------------------------

/** 播报窗口：固定 8 小时，与各所自己的结算周期解耦（HL 每小时 8 条并进一个窗口）。 */
export const WINDOW_SEC = 8 * 3600;
/** 下限 1 小时：更密的节奏不会产生新窗口（同一窗口只发一次）。 */
const MIN_INTERVAL_SEC = 3600;
const DEFAULT_INTERVAL_SEC = WINDOW_SEC;
/** 一个窗口最多重试几个周期（issue #4 §6）。按「周期」计，不按 HTTP 请求计。 */
const MAX_ATTEMPTS = 3;
/** 失败后的短退避（issue #8）：下一次尝试不再等到下一个 8h 边界。 */
const DEFAULT_RETRY_BACKOFF_SEC = 300;
/** 退避下限：更密的节奏只会白敲已挂的接口。 */
const MIN_RETRY_BACKOFF_SEC = 30;

/**
 * 边界取数的有限重试（issue #8 缺陷 2）：本机约 1/3 新建 HTTPS 连接会在 TLS
 * 握手阶段失败（ninja-tun 透明代理），单次取数就会周期性丢掉一整期播报。
 * 只重试「没有拿到判决」的网络类错误，3 次、间隔 2s。
 */
const READ_ATTEMPTS = 3;
const READ_RETRY_DELAY_MS = 2_000;

export interface SettlementCarryConfig {
  /** 未配置 `APR_ALERT_WEBHOOK_URL` 时为 null——此时不启动。 */
  webhook: FwAlertConfig | null;
  intervalSec: number;
  /** 失败后多久重试同一窗口（`SETTLEMENT_CARRY_RETRY_BACKOFF_SEC`，默认 300s）。 */
  retryBackoffSec: number;
}

/** 开关关闭 / 未设置 → null（安装即无成本）。 */
export function readSettlementCarryConfig(
  env: NodeJS.ProcessEnv = process.env,
): SettlementCarryConfig | null {
  const on = /^(1|on|true|yes)$/i.test((env.SETTLEMENT_CARRY_ENABLED ?? '').trim());
  if (!on) return null;
  const raw = Number(env.SETTLEMENT_CARRY_INTERVAL_SECONDS);
  const intervalSec =
    Number.isFinite(raw) && raw > 0 ? Math.max(MIN_INTERVAL_SEC, raw) : DEFAULT_INTERVAL_SEC;
  const rawBackoff = Number(env.SETTLEMENT_CARRY_RETRY_BACKOFF_SEC);
  const retryBackoffSec =
    Number.isFinite(rawBackoff) && rawBackoff > 0
      ? Math.max(MIN_RETRY_BACKOFF_SEC, rawBackoff)
      : DEFAULT_RETRY_BACKOFF_SEC;
  return { webhook: readFwAlertConfig(env), intervalSec, retryBackoffSec };
}

/**
 * 刚结束的那个 8h 窗口：UTC 的 0/8/16 点对齐，返回 `[fromSec, toSec)`。
 *
 * 游标契约（与 `runSettlementCarryPass` 的幂等闸门共用一套口径）：
 * `lastPostedWindowSec` 记的是「已处理的最后一个窗口的**起点**」，即 `carryWindow().fromSec`，
 * 闸门比较的也是 `fromSec`。历史上这里曾写成窗口终点（= 下一个窗口的起点），
 * 结果下一个窗口被误判为已处理而静默跳过（issue #6）。
 */
export function carryWindow(nowSec: number): { fromSec: number; toSec: number } {
  const toSec = Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;
  return { fromSec: toSec - WINDOW_SEC, toSec };
}

/**
 * 边界后的宽限：期终到落账有延迟，实测 Boros 结算晚 118s、CrossEx 账本约 2 分钟。
 * 取 180s（≥ 实测值 + 余量）：早于它跑，本窗口自己的结算还没进 feed。
 */
export const BOUNDARY_GRACE_SEC = 180;

/**
 * 成功路径的下一次运行延迟：踩在 **UTC 0/8/16 边界**（窗口一结束就播，而不是
 * 「启动时刻 + 8h」那种相位漂移的落点），但不晚于 `intervalSec`。
 *
 * 失败路径**不**走它——`intervalSec` 默认 8h 时，`min` 的结果必然是下一个边界，
 * 一次 TLS 抖动就要等 8h（issue #8）。失败走 `nextDelayAfterPass` 的短退避。
 */
export function nextRunDelayMs(nowMs: number, intervalSec: number): number {
  const nowSec = Math.floor(nowMs / 1000);
  const nextBoundarySec = (Math.floor(nowSec / WINDOW_SEC) + 1) * WINDOW_SEC + BOUNDARY_GRACE_SEC;
  const toBoundaryMs = (nextBoundarySec - nowSec) * 1000;
  // 失败重试节奏：`intervalSec` 比「到下一个边界 + 宽限」短时按它走（同一窗口内重试），
  // 否则踩边界。上限必须含宽限，否则最后一次重试落在边界整点——那时本窗口的结算还没进 feed。
  const intervalMs = intervalSec * 1000;
  const cadenceMs = intervalMs < WINDOW_SEC * 1000 ? intervalMs : (WINDOW_SEC + BOUNDARY_GRACE_SEC) * 1000;
  return Math.max(1_000, Math.min(cadenceMs, toBoundaryMs));
}

/**
 * 一个周期跑完后，下一次尝试的延迟（`schedule()` 的唯一决定点）。
 *
 * 失败（读失败 / 发送失败 / 审计不可写 / 周期崩溃）→ 短退避：同一窗口内几分钟后
 * 再试，而不是等到下一个 8h 边界（issue #8 缺陷 1）。成功（含 idle/empty，窗口
 * 已处理）→ 踩下一个 UTC 边界，与历史行为逐位一致。
 */
export function nextDelayAfterPass(
  nowMs: number,
  config: SettlementCarryConfig,
  result: Pick<CarryPassResult, 'status'>,
): number {
  if (result.status === 'failed') return Math.max(1_000, config.retryBackoffSec * 1000);
  return nextRunDelayMs(nowMs, config.intervalSec);
}

/**
 * 只有「没有拿到判决」的错误才重试：网络类（TLS 抖动、连接重置、超时）以及不带
 * category 的未知错误。429 与 4xx 是判决（再敲一遍也一样），不重试。
 */
const isTransientReadError = (err: unknown): boolean => {
  const category = (err as { category?: unknown } | null)?.category;
  return category === undefined || category === 'network';
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 边界取数：对瞬时网络失败做有限重试（issue #8 缺陷 2）。
 *
 * 计次语义不变：`attempts` 数的是失败**周期**，重试发生在同一周期内。
 */
async function readWindowWithRetry(
  deps: SettlementCarryDeps,
  fromSec: number,
  toSec: number,
): Promise<SettlementCarryWindow> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.readWindow(fromSec, toSec);
    } catch (err) {
      if (attempt >= READ_ATTEMPTS || !isTransientReadError(err)) throw err;
      deps.log(
        `[settlement-carry] window read failed (attempt ${attempt}/${READ_ATTEMPTS}),` +
          ` retrying in ${(deps.readRetryDelayMs ?? READ_RETRY_DELAY_MS) / 1000}s:` +
          ` ${(err as Error).message}`,
      );
      await sleep(deps.readRetryDelayMs ?? READ_RETRY_DELAY_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数：数据归集结果 → 逐腿金额（V4 契约：可独立调用、无副作用）
// ---------------------------------------------------------------------------

/** 一条在本窗口有结算的 Boros 腿（同一 marketId 的多次结算已合并）。 */
export interface SettlementCarryLeg {
  marketId: number;
  /** 标的币（BTC/ETH/LTC…），播报按它分块。 */
  base: string;
  /** Boros 市场的主 venue（Spread 市场取两所的第一所）。 */
  venue: string;
  /** Spread 市场：一腿等价两所 perp，两所资金费都列在这条腿下。 */
  spreadVenues: [string, string] | null;
  /** 仓位方向；窗口内平掉且无当前持仓时为 null（不猜）。 */
  side: 'SHORT' | 'LONG' | null;
  /** 结算代币符号（抵押品，可能是 USDT——与 base 不一定相同）。 */
  coin: string;
  /** 窗口内净结算，币计，带符号（+ = 收到）。 */
  settlementToken: number;
  /** 窗口内结算手续费，币计，正数成本（仅记录：settlementToken 已扣过它）。 */
  feeToken: number;
  /**
   * 结算净额的**每期**率（带符号，`Σsettlement / Σ|仓位|`）：同一窗口多条结算
   * （小时市场 8 条）时是每期平均值，不是总和——年化用每期值，USD 合计用
   * `settlementToken`。刻意不用 venue 的 `settlementRate`（它不带符号）。
   */
  netPeriodRate: number;
  /** 手续费的**每期**率（正数成本，`Σfee / Σ|仓位|`）。 */
  feePeriodRate: number;
  /** 结算代币 → USD；null = 该代币没有可靠币价（不猜、不当 1）。 */
  tokenPriceUsd: number | null;
  /** 开仓锁定的固定年化（APR 小数）；仓位已平掉时为 null。 */
  entryApr: number | null;
  /** 窗口内最近一次结算时的 |仓位|（币），实际价差的权重。 */
  positionAbs: number;
  /**
   * 该市场的结算周期（秒）：每期率按它年化，固定腿 APR 也按它折成每期值；
   * 0 = 无法判定（不猜）。
   */
  paymentPeriodSec: number;
}

/** 一条与某 (base, venue) 对应的 perp 同期现金流。 */
export interface SettlementCarryPerpFlow {
  base: string;
  venue: string;
  /** 仓位方向；账本行无法归到仓位时为 null。 */
  side: 'LONG' | 'SHORT' | null;
  /** 资金费，USD，带符号（+ = 收到）。 */
  fundingUsd: number;
  /** 手续费，USD，带符号（付出手续费为负）。 */
  feesUsd: number;
}

export interface SettlementCarryPerpRow {
  venue: string;
  side: 'LONG' | 'SHORT' | null;
  fundingUsd: number;
  feesUsd: number;
  /** fundingUsd + feesUsd。 */
  usd: number;
}

export interface SettlementCarryLegOut {
  marketId: number;
  base: string;
  venue: string;
  spreadVenues: [string, string] | null;
  side: 'SHORT' | 'LONG' | null;
  coin: string;
  /** Boros 本期结算 USD；null = 结算代币无币价。 */
  borosUsd: number | null;
  /** Boros 本期结算的币数量增减（带符号）——USD 之外必须给出的那一半。 */
  settlementToken: number;
  feeToken: number;
  perps: SettlementCarryPerpRow[];
  /** borosUsd + Σ perp；Boros 侧无币价时 null。 */
  /** 本窗口最近一次结算时的 |仓位|——实际价差的权重。 */
  positionAbs: number;
  subtotalUsd: number | null;
  lockedApr: number | null;
  /** 实际价差（年化）：浮动腿实现率的每期值 × `365d / paymentPeriod`，按 side 取号。 */
  actualApr: number | null;
  /** 锁定腿的**每期**率：`|entryApr| × paymentPeriod / YEAR_SEC`（无持仓时 NaN）。 */
  fixedPeriodRate: number;
  /** 结算净额的每期率（带符号，`Σsettlement / Σ|仓位|`）：实际价差的推导中间量。 */
  netPeriodRate: number;
  /** 手续费的每期率（正数成本，`Σfee / Σ|仓位|`）。 */
  feePeriodRate: number;
  /**
   * 浮动腿的**实现率**（每期，正向收入）：空头 `fixed − 净额 − 费率`、
   * 多头 `净额 + fixed + 费率`——这才是「实际价差」的本体，净额不是。
   */
  floatPeriodRate: number;
  /** 该市场的结算周期（秒）；审计里的年化因子就是 `YEAR_SEC / paymentPeriodSec`。 */
  paymentPeriodSec: number;
}

export interface SettlementCarryCoinOut {
  base: string;
  spreadVenues: [string, string] | null;
  legs: SettlementCarryLegOut[];
  /** 本期合计（拒绝累计口径：只有这一个窗口）。 */
  totalUsd: number | null;
  /** 有腿的结算代币没有币价，合计因此不完整。 */
  incomplete: boolean;
  hasPerp: boolean;
  lockedApr: number | null;
  actualApr: number | null;
  /** 实际 − 锁定：> 0「少赚」，< 0「多赚」，0「持平」，无对照时 null。 */
  deltaApr: number | null;
  verdict: '多赚' | '少赚' | '持平' | null;
}

export interface SettlementCarryReport {
  windowFromSec: number;
  windowToSec: number;
  coins: SettlementCarryCoinOut[];
  /** 本窗口内没有任何结算腿认领的 perp 现金流（USD）——如实计数，绝不静默丢弃。 */
  unattachedPerpUsd: number;
  /** 账本行无法归属到仓位/腿的金额（USD）。 */
  unattributedUsd: number;
  /** 账本/账本分页触顶，覆盖不全（审计与正文都要说明）。 */
  incompleteLedger: boolean;
}

const sideSign = (side: 'SHORT' | 'LONG' | null): number => (side === 'SHORT' ? 1 : -1);

const weightOf = (leg: Pick<SettlementCarryLeg, 'positionAbs'>): number =>
  Number.isFinite(leg.positionAbs) && leg.positionAbs > 0 ? leg.positionAbs : 0;

/** 一年多少秒——年化因子 `YEAR_SEC / paymentPeriod` 的分子。 */
export const YEAR_SEC = 365 * 24 * 3600;

/**
 * 纯函数：每期结算率 → 年化。Boros 的结算率是**每期**值（8h 市场 = 8h 收益率），
 * 而锁定价差（`entryApr`）是年化 APR；不同口径直接相减会把实际价差低估
 * `paymentPeriod / 1 年`（8h 市场约 1000 倍）。周期缺失/非正 → NaN（不猜）。
 */
export function annualizePeriodRate(periodRate: number, paymentPeriodSec: number): number {
  if (!Number.isFinite(periodRate) || !(paymentPeriodSec > 0)) return Number.NaN;
  return (periodRate * YEAR_SEC) / paymentPeriodSec;
}

/**
 * 纯函数：年化 APR → **每期**值。锁定腿的 `entryApr` 是年化 APR，而结算现金流
 * 是每期发生的（净额、手续费都是每期数）——「实际价差」的推导要在每期口径上做，
 * 最后再年化回来。周期缺失/非正 → NaN（不猜）。
 */
export function periodRateOfAnnual(apr: number, paymentPeriodSec: number): number {
  if (!Number.isFinite(apr) || !(paymentPeriodSec > 0)) return Number.NaN;
  return (apr * paymentPeriodSec) / YEAR_SEC;
}

/**
 * 纯函数：期终（period end）——含 `timeSec` 的那一期的结束时刻。
 *
 * 三源（Boros 结算 / CrossEx 8h 账本行 / CrossEx 小时行）统一用它判「这笔钱买的是
 * 哪一期」，而不是用落账时刻：Boros 结算在期终后约 118s 才进 feed，账本行也晚约
 * 2 分钟，按落账时刻归窗会把整条播报错位一期。周期未知（≤ 0）→ 退化为 `timeSec`
 * 本身（不猜）。
 */
export function periodEndSec(timeSec: number, paymentPeriodSec: number): number {
  if (!Number.isFinite(timeSec)) return Number.NaN;
  if (!(paymentPeriodSec > 0)) return timeSec;
  return Math.floor(timeSec / paymentPeriodSec) * paymentPeriodSec;
}

/**
 * 纯函数：一份现金流是否属于窗口 `(fromSec, toSec]`——判据是它的**期终**落在里面。
 * 播报标题的窗口与「期终 ∈ 窗口」严格一致（左边开：上一期的期终等于 from，不算本期）。
 */
export function inSettlementWindow(periodEnd: number, fromSec: number, toSec: number): boolean {
  return Number.isFinite(periodEnd) && periodEnd > fromSec && periodEnd <= toSec;
}

/**
 * 纯函数：把「本窗口的 Boros 结算腿」与「同期 perp 现金流」配成播报口径的
 * 逐腿、逐币结果。没有门槛、不判断结构完备：本窗口有一条结算腿就出一条记录，
 * 该 venue 没有 perp 腿时 `perps` 为空（展示层如实写「无」，不补 0）。
 */
export function buildSettlementCarry(input: {
  windowFromSec: number;
  windowToSec: number;
  legs: readonly SettlementCarryLeg[];
  perps: readonly SettlementCarryPerpFlow[];
  unattributedUsd?: number;
  incompleteLedger?: boolean;
}): SettlementCarryReport {
  const claimed = new Set<SettlementCarryPerpFlow>();
  const byBase = new Map<string, SettlementCarryLeg[]>();
  for (const leg of input.legs) {
    const key = leg.base.trim().toUpperCase();
    const list = byBase.get(key);
    if (list) list.push(leg);
    else byBase.set(key, [leg]);
  }

  const coins: SettlementCarryCoinOut[] = [];
  for (const [base, legs] of byBase) {
    const spreadVenues = legs.find((l) => l.spreadVenues !== null)?.spreadVenues ?? null;
    const outLegs: SettlementCarryLegOut[] = legs.map((leg) => {
      // Spread 市场一腿对两所 perp：否则会被误判成「缺腿」。
      const venues = leg.spreadVenues ?? [leg.venue];
      const perps: SettlementCarryPerpRow[] = [];
      for (const venue of venues) {
        for (const flow of input.perps) {
          if (claimed.has(flow)) continue;
          if (flow.base.trim().toUpperCase() !== base) continue;
          if (normalizeVenue(flow.venue) !== normalizeVenue(venue)) continue;
          claimed.add(flow);
          perps.push({
            venue: normalizeVenue(flow.venue),
            side: flow.side,
            fundingUsd: flow.fundingUsd,
            feesUsd: flow.feesUsd,
            usd: flow.fundingUsd + flow.feesUsd,
          });
        }
      }
      // 稳定顺序：先 venue 名，再方向（无方向排前），日志/播报可复现。
      perps.sort(
        (a, b) =>
          a.venue.localeCompare(b.venue) ||
          (a.side ?? '').localeCompare(b.side ?? ''),
      );
      const borosUsd = leg.tokenPriceUsd === null ? null : leg.settlementToken * leg.tokenPriceUsd;
      const perpUsd = perps.reduce((s, p) => s + p.usd, 0);
      const w = weightOf(leg);
      const sign = leg.side === null ? Number.NaN : sideSign(leg.side);
      // 三个每期读数：锁定腿的固定率、结算净额、手续费成本（都按 |仓位| 归一）。
      const fixedPeriodRate =
        leg.entryApr !== null && Number.isFinite(leg.entryApr)
          ? periodRateOfAnnual(Math.abs(leg.entryApr), leg.paymentPeriodSec)
          : Number.NaN;
      const netPeriodRate = leg.netPeriodRate;
      const feePeriodRate = leg.feePeriodRate;
      // 浮动腿的实现率（每期）：空头 `fixed − 净额 − 费率`、多头 `净额 + fixed + 费率`。
      // 直接拿净额当「实际」正是第 2 轮打回的阻塞项：净额 = 锁定 − 浮动，方向是反的。
      const floatPeriodRate = Number.isFinite(fixedPeriodRate) && Number.isFinite(sign)
        ? fixedPeriodRate - sign * (netPeriodRate + feePeriodRate)
        : Number.NaN;
      // 实际价差 = 浮动腿实现率年化后按 side 取号（与 lockedApr 同一约定）。
      const annualizedFloat = annualizePeriodRate(floatPeriodRate, leg.paymentPeriodSec);
      return {
        marketId: leg.marketId,
        base,
        venue: normalizeVenue(leg.venue),
        spreadVenues: leg.spreadVenues,
        side: leg.side,
        coin: leg.coin,
        borosUsd,
        settlementToken: leg.settlementToken,
        feeToken: leg.feeToken,
        perps,
        subtotalUsd: borosUsd === null ? null : borosUsd + perpUsd,
        lockedApr:
          leg.entryApr !== null && Number.isFinite(leg.entryApr) && w > 0 && Number.isFinite(sign)
            ? Math.abs(leg.entryApr) * sign
            : null,
        actualApr: Number.isFinite(annualizedFloat) && w > 0 ? sign * annualizedFloat : null,
        fixedPeriodRate,
        netPeriodRate,
        feePeriodRate,
        floatPeriodRate,
        paymentPeriodSec: leg.paymentPeriodSec,
        positionAbs: leg.positionAbs,
      };
    });
    // 单腿市场的 lockedApr/actualApr 是「一条腿自己的率」，不是价差——
    // 价差只在同一币的多腿（或 Spread 腿对两所）之间才有意义，见下方聚合。
    const pricedLegs = outLegs.filter((l) => l.subtotalUsd !== null);
    const totalUsd = pricedLegs.length === 0 ? null : pricedLegs.reduce((s, l) => s + (l.subtotalUsd ?? 0), 0);
    const lockedWeight = legs.reduce(
      (s, l) => s + (l.entryApr !== null && Number.isFinite(l.entryApr) && l.side !== null ? weightOf(l) : 0),
      0,
    );
    const lockedNumer = legs.reduce(
      (s, l) =>
        s +
        (l.entryApr !== null && Number.isFinite(l.entryApr) && l.side !== null && weightOf(l) > 0
          ? Math.abs(l.entryApr) * weightOf(l) * sideSign(l.side)
          : 0),
      0,
    );
    // 实际价差同样是「逐腿年化后按 |仓位| 加权」：各市场的 paymentPeriod 可能不同，
    // 先各自年化再平均，否则短周期市场会被系统性低估。
    const actualLegs = outLegs.filter((l) => l.actualApr !== null);
    const actualWeight = actualLegs.reduce((s, l) => s + weightOf(l), 0);
    const actualNumer = actualLegs.reduce((s, l) => s + (l.actualApr ?? 0) * weightOf(l), 0);
    const lockedApr = lockedWeight > 0 ? lockedNumer / lockedWeight : null;
    const actualApr = actualWeight > 0 ? actualNumer / actualWeight : null;
    const deltaApr = lockedApr === null || actualApr === null ? null : actualApr - lockedApr;
    coins.push({
      base,
      spreadVenues,
      legs: outLegs,
      totalUsd,
      incomplete: outLegs.some((l) => l.subtotalUsd === null),
      hasPerp: outLegs.some((l) => l.perps.length > 0),
      lockedApr,
      actualApr,
      deltaApr,
      verdict:
        deltaApr === null
          ? null
          : Math.abs(deltaApr) < 1e-9
            ? '持平'
            : deltaApr > 0
              ? '少赚'
              : '多赚',
    });
  }
  coins.sort((a, b) => a.base.localeCompare(b.base));

  let unattachedPerpUsd = 0;
  for (const flow of input.perps) {
    if (claimed.has(flow)) continue;
    unattachedPerpUsd += flow.fundingUsd + flow.feesUsd;
  }
  return {
    windowFromSec: input.windowFromSec,
    windowToSec: input.windowToSec,
    coins,
    unattachedPerpUsd,
    unattributedUsd: input.unattributedUsd ?? 0,
    incompleteLedger: input.incompleteLedger === true,
  };
}

// ---------------------------------------------------------------------------
// 纯函数：播报文本（`details` 字段承载整条消息）
// ---------------------------------------------------------------------------

const VENUE_LABEL: Record<string, string> = {
  HYPERLIQUID: 'HL',
  GATE: 'Gate',
  BINANCE: 'Binance',
  BYBIT: 'Bybit',
  OKX: 'OKX',
  KRAKEN: 'Kraken',
};

/** 「HYPERLIQUID」→「HL」：播报文本要短，但缩写表有限，未知所照原样。 */
export function venueLabel(venue: string): string {
  const key = normalizeVenue(venue);
  return VENUE_LABEL[key] ?? (key || '—');
}

const sideLabel = (side: 'SHORT' | 'LONG' | null): string =>
  side === 'SHORT' ? '空' : side === 'LONG' ? '多' : '';

/** 带符号 USD：「+$1.10」「-$3.28」（0 不带符号）。 */
export function signedUsd(n: number): string {
  return n > 0 ? `+${fmtUsd(n, 2)}` : fmtUsd(n, 2);
}

/**
 * 带符号币数量：「+0.0000171 BTC」「-0.0000510 BTC」。
 *
 * 刻意不复用 `fmtTokenQty`：它把尘埃量渲染成 `<0.000001 BTC`，而结算播报的
 * 硬格式是 `±N.COIN`（issue #4 验收 4 用正则逐行断言），缺数字的行视为 bug。
 */
export function signedCoin(amount: number, symbol: string): string {
  const abs = Math.abs(amount);
  const dp = abs >= 1 ? 4 : 7;
  return `${amount < 0 ? '-' : '+'}${abs.toFixed(dp)} ${symbol}`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const utcDay = (sec: number): string => {
  const d = new Date(sec * 1000);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};
const utcClock = (sec: number): string => {
  const d = new Date(sec * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
};
const signedAprYear = (apr: number): string => `${apr > 0 ? '+' : ''}${(apr * 100).toFixed(2)}%/年`;

/**
 * 一条腿在播报里的名字：Spread 市场一腿对应**两所** perp，只写前一个 venue
 * 会让用户以为缺腿，所以写「Spread（HL+Gate）」。
 */
const borosLegName = (leg: SettlementCarryLegOut): string =>
  leg.spreadVenues
    ? `Spread（${leg.spreadVenues.map(venueLabel).join('+')}）`
    : venueLabel(leg.venue);

/** 一条腿在播报里的 venue 标签（Spread 腿给两所）。 */
const legLabel = (leg: SettlementCarryLegOut): string =>
  (leg.spreadVenues ?? [leg.venue]).map(venueLabel).join('+');

/**
 * 纯函数：报告 → 播报文本。
 *
 * 格式硬性要求（issue #4）：凡是 Boros 腿的行，必须同时给出 USD 金额与币的
 * 数量增减，写法固定为 `±$X.XX（±N.COIN）`；该 venue 没有 perp 腿时写
 * 「perp 无（该所无持仓）」，不补 0、不隐藏、不影响其他腿。
 *
 * 归降级（结算代币没有币价）在行尾显式标注「该腿无币价，USD 未计」：这类腿
 * 本就没有 USD 可写，但不能让它静默破坏上面的硬格式。
 */
export function formatSettlementCarry(report: SettlementCarryReport): string {
  const lines: string[] = [
    `💰 结算播报 · ${utcDay(report.windowFromSec)} ${utcClock(report.windowFromSec)}` +
      `–${utcClock(report.windowToSec)} UTC（${Math.round((report.windowToSec - report.windowFromSec) / 3600)}h 窗口）`,
  ];
  for (const coin of report.coins) {
    const spread = coin.spreadVenues ? `（Spread：${coin.spreadVenues.map(venueLabel).join('-')}）` : '';
    lines.push('', `${coin.base}${spread}`);
    coin.legs.forEach((leg, i) => {
      if (i > 0) lines.push('');
      const usd = leg.borosUsd === null ? '—' : signedUsd(leg.borosUsd);
      const unpriced = leg.borosUsd === null ? ' · 该腿无币价，USD 未计' : '';
      lines.push(
        `  Boros ${borosLegName(leg)} ${sideLabel(leg.side)} ${usd}（${signedCoin(leg.settlementToken, leg.coin)}）${unpriced}`,
      );
      if (leg.perps.length === 0) {
        lines.push('  perp  无（该所无持仓）');
      } else {
        for (const p of leg.perps) {
          const side = p.side === null ? '' : ` ${sideLabel(p.side)}`;
          lines.push(`  perp  ${venueLabel(p.venue)}${side} ${signedUsd(p.usd)}`);
        }
      }
      // 多腿币种逐腿给小计；单腿（含 Spread）直接落本期合计，与样例一致。
      if (coin.legs.length > 1) {
        lines.push(`  → ${legLabel(leg)} 小计 ${leg.subtotalUsd === null ? '—' : signedUsd(leg.subtotalUsd)}`);
      }
    });
    const total = coin.totalUsd === null ? '—' : signedUsd(coin.totalUsd);
    // 对照只在结构说得通时给：本窗口该币没有任何 perp 腿时，「锁定 vs 实际」
    // 比较的是一个孤立的 Boros 率，不是价差——不如不给。两边一律带符号（年化 APR），
    // 因为实际价差真的会为负（付出窗口）；差额也明写，让「多赚/少赚」可复核。
    const compare =
      coin.hasPerp && coin.lockedApr !== null && coin.actualApr !== null && coin.verdict !== null
        ? ` ｜锁定 ${signedAprYear(coin.lockedApr)} vs 实际 ${signedAprYear(coin.actualApr)}` +
          `（差额 ${signedAprYear(coin.deltaApr ?? 0)}）→ 「${coin.verdict}」`
        : '';
    const gap = coin.incomplete ? '（部分腿无币价，未计入）' : '';
    lines.push('', `  本期合计 ${total}${gap}${compare}`);
  }
  const notes: string[] = [];
  if (report.unattachedPerpUsd !== 0) {
    notes.push(`本窗口 ${signedUsd(report.unattachedPerpUsd)} 的 perp 资金费/手续费没有对应的结算腿，未列入`);
  }
  if (report.unattributedUsd !== 0) {
    notes.push(`${signedUsd(report.unattributedUsd)} 的账本行无法归属到仓位，未列入`);
  }
  if (report.incompleteLedger) {
    notes.push('账本读取触到分页上限，覆盖可能不完整');
  }
  for (const note of notes) lines.push('', `（${note}）`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 取数层：Boros 结算/仓位 + CrossEx 账本（自带账本读取，见文件头注释）
// ---------------------------------------------------------------------------

/** `account_book` 一行（只声明本模块读到的字段）。 */
export interface CarryBookRow {
  businessId?: string;
  statementType?: string;
  exchangeType?: string;
  coin?: string;
  change?: string;
  createTime?: string;
}

/** 一次窗口读取的原料（已归集，尚未配对）。 */
export interface SettlementCarryWindow {
  legs: SettlementCarryLeg[];
  perps: SettlementCarryPerpFlow[];
  unattributedUsd: number;
  incompleteLedger: boolean;
  /** 有结算事件、但市场元数据读不到的腿数（如实计数，不静默丢弃）。 */
  unresolvedLegs?: number;
}

/** 读数的注入口（测试用它替换掉全部网络访问）。 */
export interface SettlementCarryReaders {
  markets: () => Promise<BorosMarket[]>;
  marketsByIds: (ids: readonly number[]) => Promise<Map<number, BorosMarket>>;
  settlementLedger: (floorSec: number) => Promise<BorosSettlementLedger>;
  collateralZones: (markets: readonly BorosMarket[]) => Promise<BorosCollateralZone[]>;
  accountBook: (
    statementType: 'FUNDING_FEE' | 'FEE',
    fromMs: number,
    toMs: number,
  ) => Promise<{ rows: CarryBookRow[]; capped: boolean }>;
  positions: () => Promise<PerpPositionLike[]>;
  /** 窗口内平掉的仓位也要能 join（其资金费行仍在账本里）。 */
  historyPositions: () => Promise<PerpPositionLike[]>;
}

const fin = (v: string | number | undefined | null): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 账本查询的尾部余量：本窗口的账本行在期终后约 2 分钟才落账，查询上界要多读
 * 这一段。归窗由行的期终决定（见 `bookRowPeriodEndSec`），与这个余量无关。
 */
const BOOK_QUERY_LAG_SEC = 900;

/** createTime 可能是秒或毫秒。 */
const epochToSec = (n: number): number => (n < 1e12 ? Math.floor(n) : Math.floor(n / 1000));

/**
 * 一条账本行的**期终**：`businessId` 尾缀是 venue 自己记的期终 epoch
 * （8h 所 = `…_1794873600` 这样的整点批次，HL 小时行 = 每小时整点），比
 * `createTime`（落账时刻，期终后约 2 分钟）更接近「这笔钱买的是哪一期」。
 * 尾缀解析不出 epoch 时才退回 `createTime`（不猜）。
 */
export function bookRowPeriodEndSec(row: Pick<CarryBookRow, 'businessId' | 'createTime'>): number {
  const tail = String(row.businessId ?? '').split('_').pop() ?? '';
  const n = Number(tail);
  // 尾缀必须是**像样的** epoch：真实账本里也有不带期终的业务键（如利息行的
  // `businessId=2233970825805568`，纯 id 而非时间），不能把 id 当期终。
  if (Number.isFinite(n) && n > 0) {
    const sec = epochToSec(n);
    if (sec >= 1e9 && sec < 4e9) return sec;
  }
  return epochToSec(fin(row.createTime));
}

/** 账本行的仓位 id：`businessId` 形如 `<positionId>_...`（assetView 同款解析）。 */
const positionIdOf = (businessId: string): string => businessId.split('_')[0] ?? '';

interface CrossPositionInfo {
  venue: string;
  base: string;
  side: 'LONG' | 'SHORT';
}

/** positionId → { venue, base, side }，来自当前持仓与窗口内平掉的持仓。 */
function crossPositionMap(
  open: readonly PerpPositionLike[],
  closed: readonly PerpPositionLike[],
): Map<string, CrossPositionInfo> {
  const map = new Map<string, CrossPositionInfo>();
  const add = (p: PerpPositionLike): void => {
    const id = String(p.positionId ?? '');
    const { exchange, base } = parseSymbol(String(p.symbol ?? ''));
    if (!id || !base) return;
    const qty = fin(p.positionQty);
    const side: 'LONG' | 'SHORT' =
      String(p.positionSide ?? '').toUpperCase() === 'SHORT' || qty < 0 ? 'SHORT' : 'LONG';
    map.set(id, { venue: normalizeVenue(exchange), base: base.toUpperCase(), side });
  };
  for (const p of closed) add(p);
  for (const p of open) add(p); // 当前持仓优先（仓位方向的最新事实）
  return map;
}

/**
 * 一个窗口的原料归集。纯读：不写文件、不发消息。
 *
 * Boros 侧：每条结算按其**期终**（`floor(timeSec / paymentPeriod) × paymentPeriod`）
 * 归窗，而不是按 `timeSec`：结算在期终后约 118s 才进 feed，按落账时刻归窗会把整个
 * 窗口错位一期。entryApr / |仓位| 来自当前持仓（仓位已在窗口内平掉时为 null——不猜）。
 * CrossEx 侧：账本行同样按**期终**归窗（期终取 `businessId` 尾缀，见
 * `bookRowPeriodEndSec`），再按 `businessId → positionId → 仓位 → venue` 归到所，
 * Spread 腿会被展开到两所（见 `buildSettlementCarry`）。
 */
export async function readSettlementCarryWindow(
  readers: SettlementCarryReaders,
  fromSec: number,
  toSec: number,
): Promise<SettlementCarryWindow> {
  const live = await readers.markets();
  // 期终落在 (from, to] 的结算，落账时刻一定 ≥ from（期终后才有事件），
  // 所以账本从 `fromSec` 起读就够。
  const ledger = await readers.settlementLedger(fromSec);
  const win = settlementWindow(ledger, fromSec);

  // 已到期市场会从 live 列表消失，但它在本窗口的结算仍需元数据。
  const marketById = new Map<number, BorosMarket>(live.map((m) => [m.marketId, m]));
  const missing = [...new Set(win.events.map((e) => e.marketId))].filter((id) => !marketById.has(id));
  if (missing.length > 0) {
    for (const [id, m] of await readers.marketsByIds(missing)) marketById.set(id, m);
  }
  const markets = [...marketById.values()];
  const prices = resolveCollateralPricesUsd(markets);
  // 归期：元数据缺失时周期未知 → 期终退化为 timeSec（不猜，总数里如实计 unresolved）。
  const events = win.events.filter((e) =>
    inSettlementWindow(
      periodEndSec(e.timeSec, marketById.get(e.marketId)?.paymentPeriod ?? 0),
      fromSec,
      toSec,
    ),
  );

  // 当前持仓：锁定价差要的是「这条腿开仓时锁的率」与仓位规模。
  let zones: BorosCollateralZone[] = [];
  try {
    zones = await readers.collateralZones(markets);
  } catch {
    zones = []; // 仓位读不到时 lockedApr 降级为 null，不影响结算金额
  }
  const openLegs = new Map<number, { side: 'SHORT' | 'LONG'; entryApr: number | null; sizeToken: number }>();
  for (const zone of zones) {
    const groups = [...(zone.cross ? [zone.cross] : []), ...zone.isolated];
    for (const group of groups) {
      for (const p of group.marketPositions) {
        const sizeSigned = norm18(p.notionalSize);
        if (sizeSigned === 0) continue;
        openLegs.set(p.marketId, {
          side: p.side === 0 || sizeSigned > 0 ? 'LONG' : 'SHORT',
          entryApr: p.fixedApr !== null && Number.isFinite(p.fixedApr) ? p.fixedApr : null,
          sizeToken: Math.abs(sizeSigned),
        });
      }
    }
  }

  // 窗口内按 marketId 合并：Σ结算、Σ费用、规模加权每期率、最近一次 |仓位|。
  const agg = new Map<
    number,
    {
      settlementToken: number;
      feeToken: number;
      rateWeight: number;
      settlementWeighted: number;
      feeWeighted: number;
      lastSec: number;
      lastAbs: number;
    }
  >();
  for (const ev of events) {
    const a = agg.get(ev.marketId) ?? {
      settlementToken: 0,
      feeToken: 0,
      rateWeight: 0,
      settlementWeighted: 0,
      feeWeighted: 0,
      lastSec: 0,
      lastAbs: 0,
    };
    a.settlementToken += ev.settlementToken;
    a.feeToken += ev.feeToken;
    // 每期率由现金流推出：(settlementToken / |position|) × |position| = settlementToken。
    // 不用 `ev.settlementRate`：它不带符号（付出窗口也是正数），也不保证是年化值。
    // 同一窗口多条结算（小时市场 8 条）时是**每期平均率**（不是总和）——年化用它。
    if (ev.positionAbs > 0) {
      a.rateWeight += ev.positionAbs;
      a.settlementWeighted += ev.settlementToken;
      a.feeWeighted += ev.feeToken;
    }
    if (ev.timeSec >= a.lastSec) {
      a.lastSec = ev.timeSec;
      a.lastAbs = ev.positionAbs;
    }
    agg.set(ev.marketId, a);
  }

  const legs: SettlementCarryLeg[] = [];
  let unresolvedLegs = 0;
  for (const [marketId, a] of agg) {
    const market = marketById.get(marketId);
    if (!market) {
      // 连市场元数据都读不到，就无法定位 venue/币——计数并在审计里说出来。
      unresolvedLegs += 1;
      continue;
    }
    const open = openLegs.get(marketId);
    const hasWeight = a.rateWeight > 0;
    legs.push({
      marketId,
      base: market.base,
      venue: normalizeVenue(market.spreadVenues?.[0] ?? market.venue),
      spreadVenues: market.spreadVenues,
      // 方向只来自当前持仓：平掉且无持仓的腿无法判断多空，交给展示层留白。
      side: open?.side ?? null,
      coin: BOROS_TOKEN_SYMBOLS[market.tokenId] ?? `token${market.tokenId}`,
      settlementToken: a.settlementToken,
      feeToken: a.feeToken,
      netPeriodRate: hasWeight ? a.settlementWeighted / a.rateWeight : Number.NaN,
      feePeriodRate: hasWeight ? a.feeWeighted / a.rateWeight : Number.NaN,
      tokenPriceUsd: prices.get(market.tokenId) ?? null,
      entryApr: open?.entryApr ?? null,
      positionAbs: a.lastAbs > 0 ? a.lastAbs : (open?.sizeToken ?? 0),
      // 年化因子：8h 市场 = 1095×；缺周期就是 NaN，展示层不给对照而非猜一个。
      paymentPeriodSec: market.paymentPeriod,
    });
  }

  // ---- CrossEx 侧 -------------------------------------------------------
  const positions = await readers.positions();
  const closed = await readers.historyPositions();
  const posInfo = crossPositionMap(positions, closed);
  /** 该 venue 在本窗口只对应一个币时，未 join 上的账本行可以按 venue 归属。 */
  const baseByVenue = new Map<string, string | null>();
  for (const leg of legs) {
    for (const venue of leg.spreadVenues ?? [leg.venue]) {
      const key = normalizeVenue(venue);
      const base = leg.base.toUpperCase();
      const known = baseByVenue.get(key);
      baseByVenue.set(key, known === undefined || known === base ? base : null);
    }
  }

  const fromMs = fromSec * 1000;
  // 查询上界要越过窗口终点：本窗口的账本行在期终后约 2 分钟才落账，而归属仍由
  // 行的**期终**（businessId 尾缀）决定，与落账时刻无关。15 分钟是查询余量。
  const toMs = (toSec + BOOK_QUERY_LAG_SEC) * 1000;
  const funding = await readers.accountBook('FUNDING_FEE', fromMs, toMs);
  const fees = await readers.accountBook('FEE', fromMs, toMs);

  const perpAgg = new Map<string, SettlementCarryPerpFlow>();
  let unattributedUsd = 0;
  const addRow = (row: CarryBookRow, statementType: 'FUNDING_FEE' | 'FEE'): void => {
    const usd = fin(row.change);
    if (usd === 0) return;
    // 归窗判据：期终 ∈ (from, to]，与 Boros 侧同一把尺（不按落账时刻）。
    if (!inSettlementWindow(bookRowPeriodEndSec(row), fromSec, toSec)) return;
    const pid = positionIdOf(String(row.businessId ?? ''));
    const info = pid ? posInfo.get(pid) : undefined;
    const venue = info?.venue ?? normalizeVenue(String(row.exchangeType ?? ''));
    const base = info?.base ?? (venue ? (baseByVenue.get(venue) ?? null) : null);
    if (!venue || !base) {
      unattributedUsd += usd;
      return;
    }
    const side = info?.side ?? null;
    const key = `${base}|${venue}|${side ?? ''}`;
    const flow = perpAgg.get(key) ?? { base, venue, side, fundingUsd: 0, feesUsd: 0 };
    if (statementType === 'FUNDING_FEE') flow.fundingUsd += usd;
    else flow.feesUsd += usd;
    perpAgg.set(key, flow);
  };
  for (const row of funding.rows) addRow(row, 'FUNDING_FEE');
  for (const row of fees.rows) addRow(row, 'FEE');

  return {
    legs,
    perps: [...perpAgg.values()],
    unattributedUsd,
    incompleteLedger: funding.capped || fees.capped,
    unresolvedLegs,
  };
}

// ---------------------------------------------------------------------------
// 运行时：取数器、游标、审计、心跳
// ---------------------------------------------------------------------------

/** 一个结算窗口的处理结果。 */
export interface CarryPassResult {
  status: 'disabled' | 'idle' | 'posted' | 'empty' | 'failed';
  windowFromSec?: number;
  windowToSec?: number;
  details?: string;
}

export interface SettlementCarryDeps {
  config: SettlementCarryConfig;
  /** `data/` 目录：游标、心跳、审计都写在这里（测试传临时目录）。 */
  dataDir: string;
  now: () => number;
  readWindow: (fromSec: number, toSec: number) => Promise<SettlementCarryWindow>;
  /** 读重试的间隔（默认 2s）；测试传 0，避免真等待。 */
  readRetryDelayMs?: number;
  sendWebhook: (details: string, coin: string) => Promise<boolean>;
  log: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

interface CarryPending {
  fromSec: number;
  toSec: number;
  attempts: number;
}

interface CarryCursor {
  /**
   * 已处理（播报过或明确放弃）的最后一个窗口的**起点**，即 `carryWindow().fromSec`；
   * null = 从未运行。幂等闸门拿 `target.fromSec` 与它比较，两者必须同口径（issue #6）。
   */
  lastPostedWindowSec: number | null;
  /** 发送失败待重试的窗口（游标不前进）。 */
  pending: CarryPending | null;
}

const CURSOR_FILE = 'settlement-carry-cursor.json';
const STATE_FILE = 'settlement-carry-state.json';
const AUDIT_DIR = 'audit';
const AUDIT_FILE = 'settlement-carry.jsonl';

const parseCursor = (raw: unknown): CarryCursor | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const last = typeof r.lastPostedWindowSec === 'number' ? r.lastPostedWindowSec : null;
  const p = r.pending as Record<string, unknown> | null | undefined;
  const pending =
    p && typeof p === 'object' && typeof p.fromSec === 'number' && typeof p.toSec === 'number'
      ? { fromSec: p.fromSec, toSec: p.toSec, attempts: typeof p.attempts === 'number' ? p.attempts : 0 }
      : null;
  return { lastPostedWindowSec: last, pending };
};

function readCursor(dataDir: string): CarryCursor {
  return readOwnerJson(path.join(dataDir, CURSOR_FILE), parseCursor) ?? {
    lastPostedWindowSec: null,
    pending: null,
  };
}

function writeCursor(dataDir: string, cursor: CarryCursor): void {
  writeOwnerOnlyJson(path.join(dataDir, CURSOR_FILE), cursor);
}

/** 心跳（V2）：每次运行都推进 `lastRunSec`，停摆可被外部发现。 */
function writeHeartbeat(dataDir: string, lastRunSec: number): void {
  writeOwnerOnlyJson(path.join(dataDir, STATE_FILE), { lastRunSec });
}

/**
 * 审计（V2）：每窗口一行，只记本窗口事实，**不含累计字段**。
 *
 * 返回是否真的落盘：审计是幂等闸门的证据源（见 `isWindowHandled`），所以
 * 「留痕成功」必须与「游标前进」绑定 —— 写失败时调用方不能把窗口记为已处理。
 */
function appendAudit(dataDir: string, line: Record<string, unknown>): boolean {
  try {
    const dir = path.join(dataDir, AUDIT_DIR);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, AUDIT_FILE), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return true;
  } catch (err) {
    console.error(`[settlement-carry] audit append failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * 审计当前可追加吗 —— 本周期能否发送的**门票**（打开即建/追加，不写内容）。
 *
 * 理由（第 2 轮审阅阻塞项）：审计成了幂等闸门的证据源之后，「审计写不进去」
 * （ENOSPC / EROFS / EACCES、audit 被清理或轮转）不再是无害的运维事件——发出去的
 * 播报若没留痕，下个周期证不出这个窗口处理过，同一窗口会被重复播报。所以发送前
 * 先探一次可写性：不可写就本周期不发送、游标不动，等下个周期。
 */
function auditAppendable(dataDir: string): boolean {
  try {
    const dir = path.join(dataDir, AUDIT_DIR);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(path.join(dir, AUDIT_FILE), 'a', 0o600));
    return true;
  } catch (err) {
    console.error(`[settlement-carry] audit not writable: ${(err as Error).message}`);
    return false;
  }
}

/**
 * 审计里能证明「本窗口处理过」的 note 值（`posted: true` 同样算）。
 *
 * `first-run-align` 也算：首启对齐的那个窗口是**历史窗口**，按契约永不补发
 * （见 `runSettlementCarryPass` 注释），所以它必须进证据集，否则首启后在同一窗口
 * 内再运行一次（重启 / 双启）会把历史窗口补发出去——文档说 A、代码做 B。
 */
const HANDLED_NOTES = new Set([
  'first-run-align',
  'no-settlement',
  'give-up',
  'skipped-already-handled',
]);

/**
 * 本窗口是否真的处理过 —— 只认审计里的记录，不认游标数字本身。
 *
 * 理由（issue #6 缺陷 1）：旧版首启对齐把窗口**终点**写进 `lastPostedWindowSec`，
 * 而终点恰好等于紧邻的下一个窗口的**起点**；单拿数字比大小，那个窗口就被误判为
 * 「已处理」而永久丢失。窗口是否处理过是审计记录的事实（V2），不以水位线推断。
 */
function isWindowHandled(dataDir: string, fromSec: number, toSec: number): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir, AUDIT_DIR, AUDIT_FILE), 'utf8');
  } catch {
    return false;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.windowFromSec !== fromSec || row.windowToSec !== toSec) continue;
    if (row.posted === true) return true;
    if (typeof row.note === 'string' && HANDLED_NOTES.has(row.note)) return true;
  }
  return false;
}

/**
 * 跑一个周期。**不补发历史窗口**：首次运行只把游标对齐到刚结束窗口的起点，
 * 并把该窗口记为已处理（审计 `first-run-align` 进证据集）——同一窗口内的重启 /
 * 双启也不会补发它。之后每个周期处理「刚结束的那个 8h 窗口」，同一窗口只发一次
 * （游标断言，跳过也落审计 + 打日志）。发送失败时游标不前进，下个周期重试同一窗口，
 * 最多 3 个周期后放弃并写失败标记。
 *
 * 审计是本周期能否发送的门票：审计不可写时本周期不发送、游标不动（`failed`），
 * 「游标前进」与「留痕成功」始终绑定。
 */
export async function runSettlementCarryPass(deps: SettlementCarryDeps): Promise<CarryPassResult> {
  if (!deps.config.webhook) return { status: 'disabled' };
  const nowSec = Math.floor(deps.now() / 1000);
  writeHeartbeat(deps.dataDir, nowSec);
  // 门票：审计写不进去就别发（见 `auditAppendable`）——否则「已发送」无从证明，
  // 同一窗口下个周期会被当成没处理过而重复播报。
  if (!auditAppendable(deps.dataDir)) {
    deps.error('[settlement-carry] audit is not writable — no webhook sent, cursor unchanged');
    return { status: 'failed' };
  }
  const { fromSec, toSec } = carryWindow(nowSec);
  const cursor = readCursor(deps.dataDir);

  // 首次运行：不补发历史，游标对齐到**刚结束窗口的起点**（不是终点）。
  // 依据：`readWindow` 按时间区间从 API 读，窗口跨进程启动也完整可读，
  // 而且写作起点才能与闸门的 `target.fromSec` 比较口径一致。
  if (cursor.lastPostedWindowSec === null && cursor.pending === null) {
    const audited = appendAudit(deps.dataDir, {
      windowFromSec: fromSec,
      windowToSec: toSec,
      ranAtSec: nowSec,
      legs: [],
      posted: false,
      httpOk: null,
      note: 'first-run-align',
    });
    if (!audited) {
      // 没留痕就不动游标：否则「从未运行」→「已对齐」这一步没有证据。
      deps.error('[settlement-carry] first-run align not recorded — cursor unchanged, retry next cycle');
      return { status: 'failed', windowFromSec: fromSec, windowToSec: toSec };
    }
    writeCursor(deps.dataDir, { lastPostedWindowSec: fromSec, pending: null });
    deps.log(
      `[settlement-carry] first run — cursor aligned to ${fromSec} (window ${fromSec}–${toSec}), no historical window posted`,
    );
    return { status: 'idle', windowFromSec: fromSec, windowToSec: toSec };
  }

  const target = cursor.pending ?? { fromSec, toSec, attempts: 0 };
  // 幂等闸门：两道条件同时成立才算「这个窗口已经处理过」。
  //   1. 游标认为它处理过 —— 游标记的是【窗口起点】，与 `carryWindow().fromSec` 同口径；
  //   2. 审计里真有这个窗口的记录 —— 数字本身不足为凭（旧版把窗口终点写进游标时，
  //      终点恰好等于下一个窗口的起点，单看数字会把那个窗口误判成已处理：issue #6 缺陷 1）。
  // 只约束「由当前时刻推出的窗口」；`pending` 是上一周期没发完的重试，它能否再试由
  // attempts 预算决定，被闸门抦住就永远重试不了（issue #6 缺陷 3）。
  if (
    cursor.pending === null &&
    cursor.lastPostedWindowSec !== null &&
    target.fromSec <= cursor.lastPostedWindowSec &&
    isWindowHandled(deps.dataDir, target.fromSec, target.toSec)
  ) {
    // 跳过也要留痕：事后必须能区分「没跑」「跑了被跳过」「跑了发送失败」（issue #6 缺陷 2）。
    appendAudit(deps.dataDir, {
      windowFromSec: target.fromSec,
      windowToSec: target.toSec,
      ranAtSec: nowSec,
      legs: [],
      posted: false,
      httpOk: null,
      note: 'skipped-already-handled',
      lastPostedWindowSec: cursor.lastPostedWindowSec,
    });
    deps.log(
      `[settlement-carry] skip window ${target.fromSec}–${target.toSec} — already handled (cursor=${cursor.lastPostedWindowSec})`,
    );
    return { status: 'idle', windowFromSec: target.fromSec, windowToSec: target.toSec };
  }

  let window: SettlementCarryWindow;
  try {
    window = await readWindowWithRetry(deps, target.fromSec, target.toSec);
  } catch (err) {
    deps.error('[settlement-carry] window read failed', err);
    // 读不到就不算「发不出去」：游标不动，下个周期再试同一窗口（同样计次）。
    const attempts = target.attempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    const audited = appendAudit(deps.dataDir, {
      windowFromSec: target.fromSec,
      windowToSec: target.toSec,
      ranAtSec: nowSec,
      legs: [],
      posted: false,
      httpOk: null,
      attempts,
      note: 'read-failed',
    });
    // 放弃要留痕才推进游标（否则「放弃」这个事实没有记录）。`give-up` 进证据集，
    // 短退避下下一轮才能凭它认出「本窗口已放弃」而跳过——否则同一窗口会在 300s
    // 后重新计次，把 8h 里剩下的时间全部花在重试一个已放弃的窗口上。
    const giveUpRecorded = giveUp
      ? appendAudit(deps.dataDir, {
          windowFromSec: target.fromSec,
          windowToSec: target.toSec,
          ranAtSec: nowSec,
          legs: [],
          posted: false,
          httpOk: null,
          attempts,
          note: 'give-up',
        })
      : false;
    writeCursor(deps.dataDir, {
      lastPostedWindowSec: giveUp && audited && giveUpRecorded ? target.fromSec : cursor.lastPostedWindowSec,
      pending: giveUp ? null : { ...target, attempts },
    });
    return { status: 'failed', windowFromSec: target.fromSec, windowToSec: target.toSec };
  }

  if ((window.unresolvedLegs ?? 0) > 0) {
    deps.error(
      `[settlement-carry] ${window.unresolvedLegs} settled leg(s) have no market metadata — excluded from the broadcast`,
    );
  }
  const report = buildSettlementCarry({
    windowFromSec: target.fromSec,
    windowToSec: target.toSec,
    legs: window.legs,
    perps: window.perps,
    unattributedUsd: window.unattributedUsd,
    incompleteLedger: window.incompleteLedger,
  });
  const legLines = report.coins.flatMap((c) =>
    c.legs.map((l) => ({
      marketId: l.marketId,
      base: l.base,
      venue: l.venue,
      side: l.side,
      coin: l.coin,
      settlementToken: l.settlementToken,
      borosUsd: l.borosUsd,
      ...(l.borosUsd === null ? { unpriced: true } : {}),
      perpUsd: l.perps.reduce((s, p) => s + p.usd, 0),
      subtotalUsd: l.subtotalUsd,
      hasPerp: l.perps.length > 0,
      netPeriodRate: Number.isFinite(l.netPeriodRate) ? l.netPeriodRate : null,
      floatPeriodRate: Number.isFinite(l.floatPeriodRate) ? l.floatPeriodRate : null,
      fixedPeriodRate: Number.isFinite(l.fixedPeriodRate) ? l.fixedPeriodRate : null,
      feePeriodRate: Number.isFinite(l.feePeriodRate) ? l.feePeriodRate : null,
      paymentPeriodSec: l.paymentPeriodSec,
      actualApr: l.actualApr,
      lockedApr: l.lockedApr,
    })),
  );

  // 本窗口没有任何 Boros 结算事件 → 不发播报，但审计照写。
  if (report.coins.length === 0) {
    const audited = appendAudit(deps.dataDir, {
      windowFromSec: target.fromSec,
      windowToSec: target.toSec,
      ranAtSec: nowSec,
      legs: [],
      posted: false,
      httpOk: null,
      note: 'no-settlement',
      unattachedPerpUsd: report.unattachedPerpUsd,
      unattributedUsd: report.unattributedUsd,
    });
    if (!audited) {
      deps.error(
        `[settlement-carry] no-settlement row not written for window ${target.fromSec}–${target.toSec}` +
          ' — cursor unchanged, retry next cycle',
      );
      return { status: 'failed', windowFromSec: target.fromSec, windowToSec: target.toSec };
    }
    writeCursor(deps.dataDir, { lastPostedWindowSec: target.fromSec, pending: null });
    return { status: 'empty', windowFromSec: target.fromSec, windowToSec: target.toSec };
  }

  const details = formatSettlementCarry(report);
  const coin = report.coins.map((c) => c.base).join(',');
  const ok = await deps.sendWebhook(details, coin || 'SETTLEMENT');
  const attempts = target.attempts + (ok ? 0 : 1);
  const audited = appendAudit(deps.dataDir, {
    windowFromSec: target.fromSec,
    windowToSec: target.toSec,
    ranAtSec: nowSec,
    legs: legLines,
    posted: ok,
    httpOk: ok,
    ...(ok ? {} : { attempts }),
    ...(report.unattachedPerpUsd !== 0 ? { unattachedPerpUsd: report.unattachedPerpUsd } : {}),
    ...(report.unattributedUsd !== 0 ? { unattributedUsd: report.unattributedUsd } : {}),
    ...(report.incompleteLedger ? { incompleteLedger: true } : {}),
    ...((window.unresolvedLegs ?? 0) > 0 ? { unresolvedLegs: window.unresolvedLegs } : {}),
  });
  // 留痕失败 → 不推进游标（游标前进 ⟺ 审计有证据），下个周期重来。审计持续不可写时
  // 下一周期的门票会拦住发送，所以这里不会变成「重复播报」。
  if (!audited) {
    deps.error(
      `[settlement-carry] audit row not written for window ${target.fromSec}–${target.toSec}` +
        ` (webhook ${ok ? 'sent' : 'failed'}) — cursor unchanged, retry next cycle`,
    );
    return { status: 'failed', windowFromSec: target.fromSec, windowToSec: target.toSec, details };
  }
  if (ok) {
    writeCursor(deps.dataDir, { lastPostedWindowSec: target.fromSec, pending: null });
    deps.log(`[settlement-carry] posted window ${target.fromSec}–${target.toSec} (${report.coins.length} coins)`);
    return { status: 'posted', windowFromSec: target.fromSec, windowToSec: target.toSec, details };
  }
  // 发送失败：游标不动，下个周期重试同一窗口；3 个周期后放弃并留失败标记。
  const giveUp = attempts >= MAX_ATTEMPTS;
  const giveUpRecorded = giveUp
    ? appendAudit(deps.dataDir, {
        windowFromSec: target.fromSec,
        windowToSec: target.toSec,
        ranAtSec: nowSec,
        legs: [],
        posted: false,
        httpOk: false,
        attempts,
        note: 'give-up',
      })
    : false;
  // 放弃要留痕才推进游标：`give-up` 是证据集的一员，没落盘就不算处理过。
  writeCursor(deps.dataDir, {
    lastPostedWindowSec: giveUp && giveUpRecorded ? target.fromSec : cursor.lastPostedWindowSec,
    pending: giveUp ? null : { ...target, attempts },
  });
  deps.error(
    `[settlement-carry] webhook send failed for window ${target.fromSec}–${target.toSec}` +
      ` (attempt ${attempts}/${MAX_ATTEMPTS})`,
  );
  return { status: 'failed', windowFromSec: target.fromSec, windowToSec: target.toSec, details };
}

/** 启动后多久做第一次（仅对齐游标的）运行。 */
const BOOT_ALIGN_DELAY_MS = 30_000;

/** setTimeout 链（同 notify/scanner.ts）：不用 setInterval，重叠不可能发生。 */
export function startSettlementCarry(
  deps?: SettlementCarryDeps,
  opts: { firstDelayMs?: number } = {},
): { stop: () => void } | null {
  const runtime = deps ?? createSettlementCarryDeps();
  if (!runtime) return null;
  if (!runtime.config.webhook) {
    console.warn(
      '[settlement-carry] SETTLEMENT_CARRY_ENABLED=on but APR_ALERT_WEBHOOK_URL is unset — 结算播报未启动',
    );
    return null;
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (ms: number): void => {
    timer = setTimeout(() => {
      void runSettlementCarryPass(runtime)
        .catch((err: unknown) => {
          runtime.error('[settlement-carry] pass crashed', err);
          return { status: 'failed' } as CarryPassResult;
        })
        .then((result) => {
          if (stopped) return;
          const nextMs = nextDelayAfterPass(runtime.now(), runtime.config, result);
          // 失败走短退避（issue #8）：日志里能直接看出「几分钟后再试」，不是 8h。
          if (result.status === 'failed') {
            runtime.log(`[settlement-carry] retrying in ${Math.round(nextMs / 1000)}s`);
          }
          schedule(nextMs);
        });
    }, ms);
  };
  // 首次延迟 30s（同 scanner 的 boot grace）：它只做「游标对齐到刚结束窗口的起点」，
  // 不读网络。之后的落点踩在 UTC 0/8/16 边界（见 `nextRunDelayMs`），不再是「启动时刻 + 8h」。
  schedule(opts.firstDelayMs ?? BOOT_ALIGN_DELAY_MS);
  runtime.log(
    `[settlement-carry] enabled — posting at UTC 00/08/16, retry cadence ${runtime.config.retryBackoffSec}s`,
  );
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// 生产装配：自带一份 CrossEx 账本读取（刻意重复，见文件头注释）
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 1000;
const MAX_PAGES = 25;
/** 已平仓位只读最近 3 页（3000 条）——它们只用于 join 窗口内的账本行。 */
const CLOSED_POSITION_PAGES = 3;

/** `data/` 目录：`ARB_DATA_DIR` 覆盖，默认仓库根 `data/`（与 index.ts 同规则）。 */
export function defaultDataDir(): string {
  const env = process.env.ARB_DATA_DIR;
  if (env && env.trim()) return path.resolve(env);
  return fileURLToPath(new URL('../../../data', import.meta.url));
}

/**
 * 生产装配。地址来自 `BOROS_ROOT_ADDRESS`，凭据来自 `.env`；任一缺失就返回
 * null（没有可播报的账户）。`readWindow` 持有一次进程内结算账本缓存，让每
 * 个窗口只读账本头部。
 */
export function createSettlementCarryDeps(
  env: NodeJS.ProcessEnv = process.env,
  overrides: {
    now?: () => number;
    fetchImpl?: FetchLike;
    clients?: () => Clients | null;
    dataDir?: string;
  } = {},
): SettlementCarryDeps | null {
  const config = readSettlementCarryConfig(env);
  if (!config?.webhook) return null;
  const address = (env.BOROS_ROOT_ADDRESS ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const getClients = overrides.clients ?? makeClientsIfConfigured;
  const fetchImpl = resolveBorosFetch(overrides.fetchImpl);
  const dataDir = overrides.dataDir ?? defaultDataDir();
  const pace = createRequestPacer({
    perMinute: 30,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  let prevLedger: BorosSettlementLedger | undefined;

  const requireClients = (): Clients => {
    const clients = getClients();
    if (!clients) throw new Error('Gate API key is not configured');
    return clients;
  };

  const paged = async <T>(
    fetchPage: (page: number) => Promise<T[]>,
    maxPages = MAX_PAGES,
  ): Promise<{ rows: T[]; capped: boolean }> => {
    const rows: T[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await fetchPage(page);
      rows.push(...batch);
      if (batch.length < PAGE_LIMIT) return { rows, capped: false };
    }
    return { rows, capped: true };
  };

  const readers: SettlementCarryReaders = {
    markets: () => fetchBorosMarkets(fetchImpl),
    marketsByIds: (ids) => fetchBorosMarketsByIds(fetchImpl, ids),
    settlementLedger: async (floorSec) => {
      const next = await syncSettlementLedger(fetchImpl, address, 0, prevLedger, { floorSec, pace });
      prevLedger = next;
      return next;
    },
    collateralZones: (markets) => fetchBorosCollaterals(fetchImpl, address, markets as BorosMarket[]),
    // 账本读取自带一份（~30 行），刻意不从 assetView 抽取：零冲突优先。
    accountBook: async (statementType, fromMs, toMs) => {
      const clients = requireClients();
      return paged<CarryBookRow>(async (page) => {
        const { body } = await clients.crossEx.listCrossexAccountBook({
          statementType,
          from: fromMs,
          to: toMs,
          limit: PAGE_LIMIT,
          page,
        });
        return body as unknown as CarryBookRow[];
      });
    },
    positions: async () => {
      const { body } = await requireClients().crossEx.listCrossexPositions();
      return body as unknown as PerpPositionLike[];
    },
    historyPositions: async () => {
      const clients = requireClients();
      // 这里的唯一用途是「窗口内平掉的仓位」的 join；最近几页足够（venue 接口
      // 按平仓时间倒序，且窗口只有 8 小时）。全量扫描留给持仓页。
      const { rows } = await paged<PerpPositionLike>(
        async (page) => {
          const { body } = await clients.crossEx.listCrossexHistoryPositions({ page, limit: PAGE_LIMIT });
          return body as unknown as PerpPositionLike[];
        },
        CLOSED_POSITION_PAGES,
      );
      return rows;
    },
  };

  return {
    config,
    dataDir,
    now: overrides.now ?? Date.now,
    readWindow: (fromSec, toSec) => readSettlementCarryWindow(readers, fromSec, toSec),
    sendWebhook: (details, coin) => sendFwAlert(config.webhook as FwAlertConfig, details, coin),
    log: (msg) => console.log(msg),
    error: (msg, err) => console.error(err ? `${msg}: ${(err as Error).message}` : msg),
  };
}
