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
 *  - `BorosSettlementEvent.settlementToken` 是**带符号的净额**（+ = 账户收到，
 *    一笔收益；− = 付出），且已扣掉当期手续费（见 core/boros/client.ts 的定义），
 *    因此 USD = `settlementToken × tokenPrice`，不再二次减 fee。
 *  - perp 侧 `fundingUsd + feesUsd` 同样带符号（Gate 账本 `change` 字段原样求和，
 *    付出为负）。
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
/** 一个窗口最多重试几个周期（issue #4 §6）。 */
const MAX_ATTEMPTS = 3;

export interface SettlementCarryConfig {
  /** 未配置 `APR_ALERT_WEBHOOK_URL` 时为 null——此时不启动。 */
  webhook: FwAlertConfig | null;
  intervalSec: number;
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
  return { webhook: readFwAlertConfig(env), intervalSec };
}

/** 刚结束的那个 8h 窗口：UTC 的 0/8/16 点对齐，返回 `[fromSec, toSec)`。 */
export function carryWindow(nowSec: number): { fromSec: number; toSec: number } {
  const toSec = Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;
  return { fromSec: toSec - WINDOW_SEC, toSec };
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
  /** 结算代币 → USD；null = 该代币没有可靠币价（不猜、不当 1）。 */
  tokenPriceUsd: number | null;
  /** 开仓锁定的固定年化（APR 小数）；仓位已平掉时为 null。 */
  entryApr: number | null;
  /** 窗口内最近一次结算时的 |仓位|（币），实际价差的权重。 */
  positionAbs: number;
  /** 窗口内规模加权的结算年化率（按 venue 回报原样使用）。 */
  settlementRate: number;
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
  subtotalUsd: number | null;
  lockedApr: number | null;
  actualApr: number | null;
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
          leg.entryApr !== null && Number.isFinite(leg.entryApr) && w > 0
            ? Math.abs(leg.entryApr) * sideSign(leg.side)
            : null,
        actualApr:
          Number.isFinite(leg.settlementRate) && w > 0 ? leg.settlementRate : null,
      };
    });
    // 单腿市场的 lockedApr/actualApr 是「一条腿自己的率」，不是价差——
    // 价差只在同一币的多腿（或 Spread 腿对两所）之间才有意义，见下方聚合。
    const pricedLegs = outLegs.filter((l) => l.subtotalUsd !== null);
    const totalUsd = pricedLegs.length === 0 ? null : pricedLegs.reduce((s, l) => s + (l.subtotalUsd ?? 0), 0);
    const lockedWeight = legs.reduce(
      (s, l) => s + (l.entryApr !== null && Number.isFinite(l.entryApr) ? weightOf(l) : 0),
      0,
    );
    const lockedNumer = legs.reduce(
      (s, l) =>
        s +
        (l.entryApr !== null && Number.isFinite(l.entryApr) && weightOf(l) > 0
          ? Math.abs(l.entryApr) * weightOf(l) * sideSign(l.side)
          : 0),
      0,
    );
    const actualWeight = legs.reduce(
      (s, l) => s + (Number.isFinite(l.settlementRate) ? weightOf(l) : 0),
      0,
    );
    const actualNumer = legs.reduce(
      (s, l) => s + (Number.isFinite(l.settlementRate) ? l.settlementRate * weightOf(l) : 0),
      0,
    );
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
const aprYear = (apr: number): string => `${(apr * 100).toFixed(2)}%/年`;

/** 一条腿在播报里的 venue 标签（Spread 腿给两所）。 */
const legLabel = (leg: SettlementCarryLegOut): string =>
  (leg.spreadVenues ?? [leg.venue]).map(venueLabel).join('+');

/**
 * 纯函数：报告 → 播报文本。
 *
 * 格式硬性要求（issue #4）：凡是 Boros 腿的行，必须同时给出 USD 金额与币的
 * 数量增减，写法固定为 `±$X.XX（±N.COIN）`；该 venue 没有 perp 腿时写
 * 「perp 无（该所无持仓）」，不补 0、不隐藏、不影响其他腿。
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
      lines.push(
        `  Boros ${venueLabel(leg.venue)} ${sideLabel(leg.side)} ${usd}（${signedCoin(leg.settlementToken, leg.coin)}）`,
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
    // 比较的是一个孤立的 Boros 率，不是价差——不如不给。
    const compare =
      coin.hasPerp && coin.lockedApr !== null && coin.actualApr !== null && coin.verdict !== null
        ? ` ｜锁定 ${aprYear(coin.lockedApr)} vs 实际 ${aprYear(coin.actualApr)} → 「${coin.verdict}」`
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

/** createTime 可能是秒或毫秒。 */
const epochToSec = (n: number): number => (n < 1e12 ? Math.floor(n) : Math.floor(n / 1000));

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
 * Boros 侧：`settlementWindow` 给出每腿每期的结算，窗口内按 marketId 合并；
 * entryApr / |仓位| 来自当前持仓（仓位已在窗口内平掉时为 null——不猜）。
 * CrossEx 侧：账本按 `businessId → positionId → 仓位 → venue` 归到所，
 * Spread 腿会被展开到两所（见 buildSettlementCarry）。
 */
export async function readSettlementCarryWindow(
  readers: SettlementCarryReaders,
  fromSec: number,
  toSec: number,
): Promise<SettlementCarryWindow> {
  const live = await readers.markets();
  const ledger = await readers.settlementLedger(fromSec);
  const win = settlementWindow(ledger, fromSec);
  const events = win.events.filter((e) => e.timeSec < toSec);

  // 已到期市场会从 live 列表消失，但它在本窗口的结算仍需元数据。
  const marketById = new Map<number, BorosMarket>(live.map((m) => [m.marketId, m]));
  const missing = [...new Set(events.map((e) => e.marketId))].filter((id) => !marketById.has(id));
  if (missing.length > 0) {
    for (const [id, m] of await readers.marketsByIds(missing)) marketById.set(id, m);
  }
  const markets = [...marketById.values()];
  const prices = resolveCollateralPricesUsd(markets);

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

  // 窗口内按 marketId 合并：Σ结算、Σ费用、规模加权率、最近一次 |仓位|。
  const agg = new Map<
    number,
    { settlementToken: number; feeToken: number; rateWeight: number; rateNumer: number; lastSec: number; lastAbs: number }
  >();
  for (const ev of events) {
    const a = agg.get(ev.marketId) ?? {
      settlementToken: 0,
      feeToken: 0,
      rateWeight: 0,
      rateNumer: 0,
      lastSec: 0,
      lastAbs: 0,
    };
    a.settlementToken += ev.settlementToken;
    a.feeToken += ev.feeToken;
    if (Number.isFinite(ev.settlementRate) && ev.positionAbs > 0) {
      a.rateWeight += ev.positionAbs;
      a.rateNumer += ev.settlementRate * ev.positionAbs;
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
      tokenPriceUsd: prices.get(market.tokenId) ?? null,
      entryApr: open?.entryApr ?? null,
      positionAbs: a.lastAbs > 0 ? a.lastAbs : (open?.sizeToken ?? 0),
      settlementRate: a.rateWeight > 0 ? a.rateNumer / a.rateWeight : Number.NaN,
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
  const toMs = toSec * 1000;
  const funding = await readers.accountBook('FUNDING_FEE', fromMs, toMs);
  const fees = await readers.accountBook('FEE', fromMs, toMs);

  const perpAgg = new Map<string, SettlementCarryPerpFlow>();
  let unattributedUsd = 0;
  const addRow = (row: CarryBookRow, statementType: 'FUNDING_FEE' | 'FEE'): void => {
    const usd = fin(row.change);
    if (usd === 0) return;
    const t = epochToSec(fin(row.createTime));
    if (t > 0 && (t < fromSec || t >= toSec)) return;
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
  /** 已处理（播报过或明确放弃）的最大窗口起点；null = 从未运行。 */
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

/** 审计（V2）：每窗口一行，只记本窗口事实，**不含累计字段**。 */
function appendAudit(dataDir: string, line: Record<string, unknown>): void {
  try {
    const dir = path.join(dataDir, AUDIT_DIR);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, AUDIT_FILE), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`[settlement-carry] audit append failed: ${(err as Error).message}`);
  }
}

/**
 * 跑一个周期。**不补发历史窗口**：首次运行只把游标对齐到刚跨过的边界；
 * 之后每个周期处理「刚结束的那个 8h 窗口」，同一窗口只发一次（游标断言）。
 * 发送失败时游标不前进，下个周期重试同一窗口，最多 3 个周期后放弃并写失败标记。
 */
export async function runSettlementCarryPass(deps: SettlementCarryDeps): Promise<CarryPassResult> {
  if (!deps.config.webhook) return { status: 'disabled' };
  const nowSec = Math.floor(deps.now() / 1000);
  writeHeartbeat(deps.dataDir, nowSec);
  const { fromSec, toSec } = carryWindow(nowSec);
  const cursor = readCursor(deps.dataDir);

  // 首次运行：不补发历史，只对齐到下一个边界。
  if (cursor.lastPostedWindowSec === null && cursor.pending === null) {
    writeCursor(deps.dataDir, { lastPostedWindowSec: toSec, pending: null });
    appendAudit(deps.dataDir, {
      windowFromSec: fromSec,
      windowToSec: toSec,
      ranAtSec: nowSec,
      legs: [],
      posted: false,
      httpOk: null,
      note: 'first-run-align',
    });
    deps.log('[settlement-carry] first run — cursor aligned, no historical window posted');
    return { status: 'idle', windowFromSec: fromSec, windowToSec: toSec };
  }

  const target = cursor.pending ?? { fromSec, toSec, attempts: 0 };
  if (cursor.lastPostedWindowSec !== null && target.fromSec <= cursor.lastPostedWindowSec) {
    return { status: 'idle', windowFromSec: target.fromSec, windowToSec: target.toSec };
  }

  let window: SettlementCarryWindow;
  try {
    window = await deps.readWindow(target.fromSec, target.toSec);
  } catch (err) {
    deps.error('[settlement-carry] window read failed', err);
    // 读不到就不算「发不出去」：游标不动，下个周期再试同一窗口（同样计次）。
    const attempts = target.attempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    writeCursor(deps.dataDir, {
      lastPostedWindowSec: giveUp ? target.fromSec : cursor.lastPostedWindowSec,
      pending: giveUp ? null : { ...target, attempts },
    });
    appendAudit(deps.dataDir, {
      windowFromSec: target.fromSec,
      windowToSec: target.toSec,
      ranAtSec: nowSec,
      legs: [],
      posted: false,
      httpOk: null,
      attempts,
      note: 'read-failed',
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
      perpUsd: l.perps.reduce((s, p) => s + p.usd, 0),
      subtotalUsd: l.subtotalUsd,
      hasPerp: l.perps.length > 0,
    })),
  );

  // 本窗口没有任何 Boros 结算事件 → 不发播报，但审计照写。
  if (report.coins.length === 0) {
    writeCursor(deps.dataDir, { lastPostedWindowSec: target.fromSec, pending: null });
    appendAudit(deps.dataDir, {
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
    return { status: 'empty', windowFromSec: target.fromSec, windowToSec: target.toSec };
  }

  const details = formatSettlementCarry(report);
  const coin = report.coins.map((c) => c.base).join(',');
  const ok = await deps.sendWebhook(details, coin || 'SETTLEMENT');
  const attempts = target.attempts + (ok ? 0 : 1);
  appendAudit(deps.dataDir, {
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
  if (ok) {
    writeCursor(deps.dataDir, { lastPostedWindowSec: target.fromSec, pending: null });
    deps.log(`[settlement-carry] posted window ${target.fromSec}–${target.toSec} (${report.coins.length} coins)`);
    return { status: 'posted', windowFromSec: target.fromSec, windowToSec: target.toSec, details };
  }
  // 发送失败：游标不动，下个周期重试同一窗口；3 个周期后放弃并留失败标记。
  const giveUp = attempts >= MAX_ATTEMPTS;
  writeCursor(deps.dataDir, {
    lastPostedWindowSec: giveUp ? target.fromSec : cursor.lastPostedWindowSec,
    pending: giveUp ? null : { ...target, attempts },
  });
  if (giveUp) {
    appendAudit(deps.dataDir, {
      windowFromSec: target.fromSec,
      windowToSec: target.toSec,
      ranAtSec: nowSec,
      legs: [],
      posted: false,
      httpOk: false,
      attempts,
      note: 'give-up',
    });
  }
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
        .catch((err: unknown) => runtime.error('[settlement-carry] pass crashed', err))
        .finally(() => {
          if (!stopped) schedule(runtime.config.intervalSec * 1000);
        });
    }, ms);
  };
  // 首次延迟 30s（同 scanner 的 boot grace）：它只做「游标对齐到刚跨过的边界」，
  // 不读网络。越早对齐，启动后第一个**完整观测**的窗口就越早播报。
  schedule(opts.firstDelayMs ?? BOOT_ALIGN_DELAY_MS);
  runtime.log(
    `[settlement-carry] enabled — every ${runtime.config.intervalSec}s, 8h windows at UTC 00/08/16`,
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
