/**
 * 💰 结算播报（settlement carry）——issue #4 的验收断言。
 *
 * 这里钉住四件事：
 *  1. 逐腿金额与手算一致（纯函数 + 归集层，误差 < 1e-6）；
 *  2. Spread 腿把两所 perp 都列在自己下面，无持仓的所如实写「无」；
 *  3. 播报文本的硬格式：每条 Boros 腿同时给 USD 与币数量 `±$X.XX（±N.COIN）`；
 *  4. 游标幂等（同一窗口只发一次）、失败重试、无累计字段。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BorosCollateralZone,
  BorosMarket,
  BorosSettlementLedger,
  BorosSettlementRow,
} from '../../src/core/boros/client';
import {
  buildSettlementCarry,
  carryWindow,
  formatSettlementCarry,
  readSettlementCarryConfig,
  readSettlementCarryWindow,
  runSettlementCarryPass,
  signedCoin,
  signedUsd,
  YEAR_SEC,
  annualizePeriodRate,
  periodRateOfAnnual,
  periodEndSec,
  inSettlementWindow,
  bookRowPeriodEndSec,
  nextRunDelayMs,
  BOUNDARY_GRACE_SEC,
  type SettlementCarryDeps,
  type SettlementCarryReaders,
  type SettlementCarryWindow,
} from '../../src/server/notify/settlementCarry';

// ---------------------------------------------------------------------------
// fixture：一个 8h 窗口的 Boros 结算 + CrossEx 账本（金额都可手算）
// ---------------------------------------------------------------------------

/** 对齐到 UTC 08:00 的时间戳：28800 × 59028 = 1700006400。 */
const TO = 1_700_006_400;
const FROM = TO - 28_800;
const NOW_MS = TO * 1000;

const market = (over: Partial<BorosMarket> & Pick<BorosMarket, 'marketId' | 'base'>): BorosMarket => ({
  tokenId: 1,
  name: `${over.base} market`,
  venue: 'Hyperliquid',
  maturity: 1_800_000_000,
  paymentPeriod: 3600,
  settleFeeApr: 0.001,
  markApr: 0.05,
  floatingApr: 0.05,
  midApr: 0.05,
  notionalOi: 100,
  takerFeeRate: 0.0005,
  maxRateDeviationApr: 0.01,
  state: 'Normal',
  assetMarkPriceUsd: 100_000,
  kIM: 0.5,
  kMM: 0.1,
  imTickThresh: 2,
  imTickStep: 2,
  tThreshSec: 86_400,
  spreadVenues: null,
  ...over,
});

const MARKETS: BorosMarket[] = [
  market({ marketId: 155, base: 'BTC', venue: 'Hyperliquid', tokenId: 1, assetMarkPriceUsd: 100_000 }),
  market({ marketId: 158, base: 'BTC', venue: 'Gate', tokenId: 1, assetMarkPriceUsd: 100_000 }),
  market({
    marketId: 200,
    base: 'ETH',
    venue: 'Hyperliquid',
    tokenId: 2,
    assetMarkPriceUsd: 3_000,
    spreadVenues: ['HYPERLIQUID', 'GATE'],
  }),
  market({ marketId: 300, base: 'LTC', venue: 'Bybit', tokenId: 3, assetMarkPriceUsd: 1 }),
];
const MARKET_BY_ID = new Map(MARKETS.map((m) => [m.marketId, m]));

const row = (
  marketId: number,
  timeSec: number,
  settlementToken: number,
  /**
   * venue 自己回报的 `settlementRate`：**不带符号**、且是**每期**值。
   * fixture 里刻意把它填成与现金流符号/量级都不一致的值——实现不得使用它。
   */
  venueReportedRate: number,
  positionAbs = 1,
): BorosSettlementRow => ({
  id: `${marketId}:${timeSec}`,
  marketAcc: `acc-${marketId}`,
  tokenId: 0,
  marketId,
  timeSec,
  positionAbs,
  settlementToken,
  feeToken: 0,
  settlementRate: venueReportedRate,
});

/**
 * 结算落账延迟：Boros 在**期终后**约 118s 才把结算写进 feed（实测），所以
 * 事件的 `timeSec` 永远落在期终之后——归窗必须按期终，不按落账时刻。
 */
const SETTLE_LAG = 118;
/** 账本行落账延迟：CrossEx 账本行同样晚约 2 分钟（`createTime` ≠ 期终）。 */
const BOOK_LAG = 132;
/** 期终（`hourStart` 是 UTC 整点）：`FROM + hourStart + n × 3600`。 */
const periodEnd = (n: number): number => FROM + n * 3600;

/** 窗口 (FROM, TO] 内的结算 + 两条窗口外的诱饵（上一期 / 下一期）。 */
const SETTLEMENTS: BorosSettlementRow[] = [
  // HL 每小时一条，期终 01:00…08:00 → 8 条都归本窗口（最后一条落账已在窗口之后）
  ...Array.from({ length: 8 }, (_, i) => row(155, periodEnd(i + 1) + SETTLE_LAG, -0.000004, 0.05)),
  row(158, periodEnd(1) + SETTLE_LAG, 0.000011, 0.03),
  row(200, periodEnd(2) + SETTLE_LAG, -0.0005, 0.0292, 30),
  row(300, periodEnd(3) + SETTLE_LAG, -0.42, 0.01, 100),
];

/** 诱饵：期终 = FROM（上一期）与 TO + 3600（下一期）——按 `timeSec` 归窗会误收。 */
const DECOY_SETTLEMENTS: BorosSettlementRow[] = [
  row(155, FROM + SETTLE_LAG, -0.9, 0.05),
  row(158, TO + 3600 + SETTLE_LAG, 0.5, 0.03),
];

const LEDGER: BorosSettlementLedger = {
  rows: [...SETTLEMENTS, ...DECOY_SETTLEMENTS],
  coversFromSec: FROM,
};

const zone = (
  positions: Array<{ marketId: number; side: 0 | 1; size: number; fixedApr: number }>,
): BorosCollateralZone => ({
  // size 带符号：SHORT 仓位的 notionalSize 是负数（core/boros/client.ts）
  tokenId: 1,
  isolated: [],
  cross: {
    isCross: true,
    marketAcc: 'acc-cross',
    netBalance: '10000000000000000000',
    marketPositions: positions.map((p) => ({
      marketId: p.marketId,
      side: p.side,
      notionalSize: String(BigInt(Math.round(p.size * 1e18))),
      fixedApr: p.fixedApr,
      markApr: 0.05,
      pnl: { rateSettlementPnl: '0', unrealisedPnl: '0' },
      positionInitialMargin: '1000000000000000000',
    })),
  },
});

const ZONES: BorosCollateralZone[] = [
  zone([
    { marketId: 155, side: 1, size: -1, fixedApr: 0.05 },
    { marketId: 158, side: 0, size: 1, fixedApr: 0.029 },
    { marketId: 200, side: 1, size: -30, fixedApr: 0.001 },
    { marketId: 300, side: 1, size: -100, fixedApr: 0.01 },
  ]),
];

/** 当前持仓：positionId → symbol（venue/base 由此解析）。 */
const POSITIONS = [
  { positionId: 'pidBtcHl', symbol: 'HYPERLIQUID_PERP_BTC_USDT', positionSide: 'SHORT', positionQty: '-1' },
  { positionId: 'pidBtcGate', symbol: 'GATE_PERP_BTC_USDT', positionSide: 'LONG', positionQty: '1' },
  { positionId: 'pidEthHl', symbol: 'HYPERLIQUID_PERP_ETH_USDT', positionSide: 'SHORT', positionQty: '-30' },
  { positionId: 'pidEthGate', symbol: 'GATE_PERP_ETH_USDT', positionSide: 'LONG', positionQty: '30' },
];

interface BookRow {
  statementType: 'FUNDING_FEE' | 'FEE';
  businessId: string;
  change: string;
  exchangeType?: string;
  createTime?: string;
}

/**
 * 账本行：`businessId` 尾缀是 venue 记的**期终** epoch，`createTime` 是落账时刻
 * （期终 + 132s）。按 `createTime` 归窗会把本窗口的 perp 行错归到窗口外。
 */
const book = (statementType: 'FUNDING_FEE' | 'FEE', positionId: string, periodEndSec: number, change: string): BookRow => ({
  statementType,
  businessId: `${positionId}_${periodEndSec}`,
  change,
  createTime: String(periodEndSec + BOOK_LAG),
});

const BOOK: BookRow[] = [
  book('FUNDING_FEE', 'pidBtcHl', periodEnd(1), '4.05'),
  book('FEE', 'pidBtcHl', periodEnd(1), '-0.05'),
  book('FUNDING_FEE', 'pidBtcGate', periodEnd(1), '-0.8'),
  book('FEE', 'pidBtcGate', periodEnd(1), '0.01'),
  book('FUNDING_FEE', 'pidEthHl', periodEnd(2), '1.9'),
  book('FUNDING_FEE', 'pidEthGate', periodEnd(2), '-0.36'),
];

/** 诱饵：期终 = FROM（上一期）与 TO + 3600（下一期）的行不能进本窗口。 */
const DECOY_BOOK: BookRow[] = [
  book('FUNDING_FEE', 'pidBtcHl', FROM, '99'),
  book('FUNDING_FEE', 'pidBtcHl', TO + 3600, '88'),
];

const ALL_BOOK: BookRow[] = [...BOOK, ...DECOY_BOOK];

function readers(over: Partial<SettlementCarryReaders> = {}): SettlementCarryReaders {
  return {
    markets: async () => MARKETS,
    marketsByIds: async (ids) => new Map(ids.filter((id) => MARKET_BY_ID.has(id)).map((id) => [id, MARKET_BY_ID.get(id)!])),
    settlementLedger: async () => LEDGER,
    collateralZones: async () => ZONES,
    accountBook: async (statementType) => ({
      rows: ALL_BOOK.filter((r) => r.statementType === statementType).map((r) => ({ ...r })),
      capped: false,
    }),
    positions: async () => POSITIONS,
    historyPositions: async () => [],
    ...over,
  };
}

const readWindow = async (over: Partial<SettlementCarryReaders> = {}): Promise<SettlementCarryWindow> =>
  readSettlementCarryWindow(readers(over), FROM, TO);

// ---------------------------------------------------------------------------
// 1. 逐腿金额（手算对照）
// ---------------------------------------------------------------------------

describe('buildSettlementCarry · 金额', () => {
  it('每腿 USD 与币数量都与手算一致', async () => {
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...(await readWindow()) });

    expect(report.coins.map((c) => c.base)).toEqual(['BTC', 'ETH', 'LTC']);
    const btc = report.coins[0]!;
    const hl = btc.legs.find((l) => l.venue === 'HYPERLIQUID')!;
    // 8 × -0.000004 BTC × $100k = -$3.20
    expect(hl.settlementToken).toBeCloseTo(-0.000032, 12);
    expect(hl.borosUsd!).toBeCloseTo(-3.2, 6);
    expect(hl.perps).toHaveLength(1);
    expect(hl.perps[0]!.fundingUsd).toBeCloseTo(4.05, 6);
    expect(hl.perps[0]!.feesUsd).toBeCloseTo(-0.05, 6);
    expect(hl.perps[0]!.usd).toBeCloseTo(4.0, 6);
    expect(hl.subtotalUsd!).toBeCloseTo(0.8, 6);

    const gate = btc.legs.find((l) => l.venue === 'GATE')!;
    expect(gate.borosUsd!).toBeCloseTo(1.1, 6); // +0.000011 BTC × $100k
    expect(gate.perps[0]!.usd).toBeCloseTo(-0.79, 6);
    expect(gate.subtotalUsd!).toBeCloseTo(0.31, 6);
    expect(btc.totalUsd!).toBeCloseTo(1.11, 6);

    // 锁定价差 = Σ(|entryApr| × w × side) / Σw = (0.05×8 − 0.029×8)/16
    expect(btc.lockedApr!).toBeCloseTo(0.0105, 9);
    // 实际价差 = 浮动腿实现率（每期）× 8760（3600s 周期），按 side 取号后加权：
    //   HL（空）: fixed 0.05/8760 + 净额 4e-6 → +9.7078e-6/期 → +8.504%/年
    //   Gate（多）: fixed 0.029/8760 + 净额 1.1e-5 → +1.4311e-5/期 → 取负号 → −12.536%/年
    //   加权：(8.504% × 8 − 12.536% × 8) / 16 = −2.016%/年
    expect(hl.floatPeriodRate).toBeCloseTo(9.707762557077626e-6, 15);
    expect(hl.actualApr!).toBeCloseTo(0.08504, 9);
    expect(hl.netPeriodRate).toBeCloseTo(-4e-6, 15);
    expect(hl.fixedPeriodRate).toBeCloseTo(0.05 / 8760, 15);
    expect(gate.actualApr!).toBeCloseTo(-0.12536, 9);
    expect(btc.actualApr!).toBeCloseTo(-0.02016, 9);
    // 实际 − 锁定 = −3.07pp < 0 → 「多赚」（浮动腿比锁定的固定腿跑得差）
    expect(btc.deltaApr!).toBeCloseTo(-0.03066, 9);
    expect(btc.verdict).toBe('多赚');

    // LTC 用 USDT 结算：币种取结算代币，不是 base。
    const ltc = report.coins[2]!;
    expect(ltc.legs[0]!.coin).toBe('USDT');
    expect(ltc.legs[0]!.borosUsd!).toBeCloseTo(-0.42, 6);
    expect(ltc.legs[0]!.perps).toHaveLength(0);
    expect(ltc.hasPerp).toBe(false);
  });

  it('窗口外的账本行不进来', async () => {
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...(await readWindow()) });
    const boros = report.coins.flatMap((c) => c.legs).reduce((s, l) => s + (l.borosUsd ?? 0), 0);
    const perp = report.coins.flatMap((c) => c.legs).flatMap((l) => l.perps).reduce((s, p) => s + p.usd, 0);
    expect(boros + perp).toBeCloseTo(-3.2 + 1.1 - 1.5 - 0.42 + 4.0 - 0.79 + 1.9 - 0.36, 6);
  });
});

// ---------------------------------------------------------------------------
// 2. Spread 腿 & 缺 perp 的所
// ---------------------------------------------------------------------------

describe('buildSettlementCarry · 配对', () => {
  it('Spread 腿把两所 perp 都列在自己下面', async () => {
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...(await readWindow()) });
    const eth = report.coins.find((c) => c.base === 'ETH')!;
    expect(eth.spreadVenues).toEqual(['HYPERLIQUID', 'GATE']);
    expect(eth.legs).toHaveLength(1); // 一条腿即一整个 Spread 市场
    const leg = eth.legs[0]!;
    expect(leg.perps.map((p) => p.venue).sort()).toEqual(['GATE', 'HYPERLIQUID']);
    expect(leg.perps.reduce((s, p) => s + p.usd, 0)).toBeCloseTo(1.9 - 0.36, 6);
    expect(leg.subtotalUsd!).toBeCloseTo(-1.5 + 1.54, 6);
  });

  it('单所市场只列一所；该所无持仓时 perps 为空（不补 0）', async () => {
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...(await readWindow()) });
    const btc = report.coins.find((c) => c.base === 'BTC')!;
    for (const leg of btc.legs) expect(leg.perps).toHaveLength(1);
    const ltc = report.coins.find((c) => c.base === 'LTC')!;
    expect(ltc.legs[0]!.perps).toEqual([]);
    expect(ltc.legs[0]!.subtotalUsd!).toBeCloseTo(-0.42, 6); // 只有 Boros 侧，未被隐藏
  });

  const withExtraRow = (extra: BookRow): Partial<SettlementCarryReaders> => ({
    accountBook: async (statementType) => ({
      rows: [
        ...ALL_BOOK.filter((r) => r.statementType === statementType).map((r) => ({ ...r })),
        ...(statementType === extra.statementType ? [{ ...extra }] : []),
      ],
      capped: false,
    }),
  });

  it('无法归属的账本行如实计数，不静默丢弃', async () => {
    const withStray = await readWindow(
      withExtraRow({ statementType: 'FUNDING_FEE', businessId: 'unknown', change: '0.5', createTime: String(FROM + 100) }),
    );
    expect(withStray.unattributedUsd).toBeCloseTo(0.5, 6);
  });

  it('该所只有一条腿时，未 join 上的行按 venue 归属；多腿时歧义不猜', async () => {
    // Bybit 在本窗口只有 LTC 一条腿 → 可以归属
    const single = await readWindow(
      withExtraRow({
        statementType: 'FEE',
        businessId: 'orphan',
        exchangeType: 'BYBIT',
        change: '-0.02',
        createTime: String(FROM + 200),
      }),
    );
    expect(single.unattributedUsd).toBe(0);
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...single });
    const ltc = report.coins.find((c) => c.base === 'LTC')!;
    expect(ltc.legs[0]!.perps).toHaveLength(1);
    expect(ltc.legs[0]!.perps[0]!.feesUsd).toBeCloseTo(-0.02, 6);
    expect(report.unattachedPerpUsd).toBe(0);

    // HL 在本窗口有 BTC 与 ETH 两条腿 → 歧义，不猜，落到 unattributed 并如实播报
    const ambiguous = await readWindow(
      withExtraRow({
        statementType: 'FEE',
        businessId: 'orphan',
        exchangeType: 'HYPERLIQUID',
        change: '-0.02',
        createTime: String(FROM + 200),
      }),
    );
    expect(ambiguous.unattributedUsd).toBeCloseTo(-0.02, 6);
  });
});

// ---------------------------------------------------------------------------
// 3. 8h 汇总
// ---------------------------------------------------------------------------

describe('8h 窗口', () => {
  it('HL 每小时 8 条结算全部落进同一窗口，合计等于逐条相加', async () => {
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...(await readWindow()) });
    const hl = report.coins[0]!.legs.find((l) => l.venue === 'HYPERLIQUID')!;
    const perEvent = SETTLEMENTS.filter((r) => r.marketId === 155).map((r) => r.settlementToken);
    expect(perEvent).toHaveLength(8);
    expect(hl.settlementToken).toBeCloseTo(perEvent.reduce((s, v) => s + v, 0), 12);
  });

  it('窗口对齐 UTC 0/8/16', () => {
    expect(carryWindow(TO)).toEqual({ fromSec: FROM, toSec: TO });
    expect(carryWindow(TO + 1)).toEqual({ fromSec: FROM, toSec: TO });
    expect(carryWindow(TO - 1)).toEqual({ fromSec: FROM - 28_800, toSec: FROM });
  });

  it('下一次运行踩在 UTC 0/8/16 边界（窗口一结束就播，而不是启动时刻 +8h）', () => {
    // 启动于 12:00、间隔 8h：下一步是边界 16:00，不是 20:00
    const noon = (TO - 14_400) * 1000;
    expect(nextRunDelayMs(noon, 28_800)).toBe((14_400 + BOUNDARY_GRACE_SEC) * 1000);
    // 间隔更短（失败重试）→ 不被边界拉到更远
    expect(nextRunDelayMs(noon, 3_600)).toBe(3_600 * 1000);
    // 刚好死在边界上 → 下一次是下一个边界
    expect(nextRunDelayMs(TO * 1000, 28_800)).toBe((28_800 + BOUNDARY_GRACE_SEC) * 1000);
  });

  it('边界宽限不短于实测落账延迟（Boros 118s、账本 ~2 分钟）', () => {
    expect(BOUNDARY_GRACE_SEC).toBeGreaterThanOrEqual(180);
    expect(BOUNDARY_GRACE_SEC).toBeGreaterThan(118);
  });
});

// ---------------------------------------------------------------------------
// 3.4 归期：期终 ∈ (from, to]（审阅第 2 轮阻塞项 2）
// ---------------------------------------------------------------------------

describe('归期按期终（不按落账时刻）', () => {
  it('期终纯函数', () => {
    // 8h 市场：期终前的落账属于「已结束的那一期」（该期终 = FROM）
    expect(periodEndSec(FROM + 28_745, 28_800)).toBe(FROM);
    // 落账晚于期终（结算在期终后 118s 才进 feed）→ 期终仍是 TO
    expect(periodEndSec(TO + 118, 28_800)).toBe(TO);
    // 小时行：每个整点各一期
    expect(periodEndSec(FROM + 3_718, 3_600)).toBe(FROM + 3_600);
    // 周期未知 → 不猜，退化为落账时刻
    expect(periodEndSec(FROM + 100, 0)).toBe(FROM + 100);
  });

  it('窗口左边开：期终等于 from 的是上一期', () => {
    expect(inSettlementWindow(FROM, FROM, TO)).toBe(false);
    expect(inSettlementWindow(TO, FROM, TO)).toBe(true);
    expect(inSettlementWindow(TO + 3_600, FROM, TO)).toBe(false);
  });

  it('账本行期终取 businessId 尾缀的 epoch，取不到才退回 createTime', () => {
    // 8h 所：尾缀 1794873600 = 00:00 期终，落账 00:02:12
    expect(bookRowPeriodEndSec({ businessId: 'pid_1794873600', createTime: '1794873732' })).toBe(1_794_873_600);
    // 毫秒尾缀同样解析成秒
    expect(bookRowPeriodEndSec({ businessId: 'pid_1794873600000', createTime: '1794873732' })).toBe(1_794_873_600);
    // 尾缀不是 epoch → 退回落账时刻（不猜期终）
    expect(bookRowPeriodEndSec({ businessId: 'FUNDING_abc', createTime: String(FROM) })).toBe(FROM);
    expect(bookRowPeriodEndSec({ businessId: '', createTime: String(FROM) })).toBe(FROM);
    // 真实账本里有不带期终的业务键（利息行是纯 id，不是时间）→ 同样退回 createTime
    expect(bookRowPeriodEndSec({ businessId: '2233970825805568', createTime: String(FROM) })).toBe(FROM);
  });

  it('Boros 结算按自身期终归窗：落账在窗口后的本窗口结算仍算本期，上一期/下一期的诱饵被排除', async () => {
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...(await readWindow()) });
    const hl = report.coins.find((c) => c.base === 'BTC')!.legs.find((l) => l.venue === 'HYPERLIQUID')!;
    // 8 条小时结算（期终 01:00…08:00），最后一条落账已在窗口之后
    expect(hl.settlementToken).toBeCloseTo(-0.000032, 12);
    // 诱饵（期终 = FROM 的 -0.9、期终 = TO+3600 的 +0.5）均未计入
    expect(report.coins.find((c) => c.base === 'BTC')!.legs.find((l) => l.venue === 'GATE')!.settlementToken)
      .toBeCloseTo(0.000011, 12);
  });

  it('账本行按其期终归窗：createTime 落在窗口后仍归本期，期终在窗口外的行被排除', async () => {
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...(await readWindow()) });
    const hl = report.coins.find((c) => c.base === 'BTC')!.legs.find((l) => l.venue === 'HYPERLIQUID')!;
    // createTime = 期终 + 132s，但期终在窗口内 → 计入；两条诱饵（+99 / +88）不计入
    expect(hl.perps[0]!.usd).toBeCloseTo(4.0, 9);
    expect(report.unattachedPerpUsd).toBe(0);
    expect(report.unattributedUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3.5 浮动腿实现率 + 同期归集（审阅第 2 轮的两个阻塞项 —— 真实窗口常量）
// ---------------------------------------------------------------------------

/**
 * 真实账户 2026-11-17 00:00–08:00 UTC 的原始结算字段（审阅意见引用的原始 API 读数）：
 *
 * | market | positionSize | yieldReceived   | yieldPaid    | fee            | settlement(=recv−paid−fee) |
 * | 233 BTC | 2.6975       | 1.00920609545527e-4 | 1.466301655e-4 | 4.926940639269e-6 | −5.0636496593742e-5 |
 * | 232 ETH | 30           | 1.001404268910152e-3 | 1.802754e-3 | 5.479452054795e-5 | −8.561442516e-4 |
 *
 * 两条都是**空头**（`positionSize` 为负），`entryApr`（该仓 fixedApr）= 0.040966846136 / 0.036551255815，
 * 且 `yieldReceived / |position| × 1095` 与 `entryApr` 逐位吻合 ⇒ `yieldReceived` 就是锁定腿。
 * 周期 28800s，年化因子 = 365×24×3600 / 28800 = **1095**。
 * 真实币价（推算自审阅意见的 USD 读数）：BTC 64935、ETH 1825。
 *
 * 手算（常量，不 import 生产公式）：
 *  - 固定腿每期率 fixed = entryApr / 1095 → BTC 3.7412644873e-5、ETH 3.3380142297e-5
 *  - 净额每期率 net = settlement / |position| → BTC −1.8772e-5、ETH −2.8538e-5
 *  - 费率 fee = fee / |position| → BTC 1.8265e-6、ETH 1.8265e-6
 *  - 浮动腿实现率 float = fixed − net − fee（空头）→ BTC 5.4358e-5、ETH 6.0092e-5
 *  - 年化（×1095）→ 实际价差 **+5.95%/年**、**+6.58%/年**（锁定 4.10% / 3.66%）
 *    ⇒ 差额 +1.86pp / +2.92pp，两个币都是「少赚」。
 *  - 同期合并金额：BTC −3.2881 + 9.4970 = **+6.2089**、ETH −1.5623 + 3.3488 = **+1.7865**
 *    （与锁定预期 6.5533 / 1.8276 的偏差 −5.3% / −2.2%，即同一期两侧对得上）。
 */
const REAL_PRICE_BTC = 64_935;
const REAL_PRICE_ETH = 1_825;
const REAL_PAYMENT_PERIOD = 28_800;

const REAL_MARKETS: BorosMarket[] = [
  market({
    marketId: 233,
    base: 'BTC',
    venue: 'Hyperliquid',
    tokenId: 1,
    paymentPeriod: REAL_PAYMENT_PERIOD,
    assetMarkPriceUsd: REAL_PRICE_BTC,
  }),
  market({
    marketId: 232,
    base: 'ETH',
    venue: 'Hyperliquid',
    tokenId: 2,
    paymentPeriod: REAL_PAYMENT_PERIOD,
    assetMarkPriceUsd: REAL_PRICE_ETH,
  }),
];

/**
 * 本窗口自己的结算是 `TO + 118s` 落账的那条（期终 = TO）；`FROM + 118s` 那条
 * 期终 = FROM，属于上一期——按 `timeSec` 归窗的旧实现就是拿错了这一条。
 */
const REAL_LEDGER: BorosSettlementLedger = {
  rows: [
    {
      ...row(233, TO + 118, -5.0636496593742e-05, 1.2020139145038e-05, 2.6975),
      feeToken: 4.926940639269e-6,
    },
    {
      ...row(232, TO + 118, -8.561442516e-4, 6.6350241721259e-05, 30),
      feeToken: 5.479452054795e-5,
    },
    // 诱饵：上一期（期终 = FROM）
    { ...row(233, FROM + 118, -3.2424325343742e-05, 1.2020139145038e-05, 2.6975), feeToken: 4.926940639269e-6 },
    { ...row(232, FROM + 118, -1.990507251637798e-03, 6.6350241721259e-05, 30), feeToken: 5.479452054795e-5 },
  ],
  coversFromSec: FROM,
};

const realWindow = (): Promise<SettlementCarryWindow> =>
  readSettlementCarryWindow(
    readers({
      markets: async () => REAL_MARKETS,
      marketsByIds: async () => new Map(),
      settlementLedger: async () => REAL_LEDGER,
      // 真实账户的 entryApr：BTC 0.040966846136、ETH 0.036551255815，两条都是空头。
      collateralZones: async () => [
        zone([
          { marketId: 233, side: 1, size: -2.6975, fixedApr: 0.040966846136 },
          { marketId: 232, side: 1, size: -30, fixedApr: 0.036551255815 },
        ]),
      ],
      positions: async () => [
        { positionId: 'btcHl', symbol: 'HYPERLIQUID_PERP_BTC_USDT', positionSide: 'SHORT', positionQty: '-2.6975' },
        { positionId: 'ethHl', symbol: 'HYPERLIQUID_PERP_ETH_USDT', positionSide: 'SHORT', positionQty: '-30' },
      ],
      // 同期 perp 现金流：期终 = TO 的账本行，落账在 TO + 132s。
      accountBook: async (statementType) => ({
        rows:
          statementType === 'FUNDING_FEE'
            ? [
                book('FUNDING_FEE', 'btcHl', TO, '9.4470'),
                book('FUNDING_FEE', 'ethHl', TO, '3.3488'),
                // 诱饵：上一期的 perp 行（期终 = FROM），落账就在窗口内——旧实现会误收。
                book('FUNDING_FEE', 'btcHl', FROM, '-6.1885'),
                book('FUNDING_FEE', 'ethHl', FROM, '1.5623'),
              ]
            : [book('FEE', 'btcHl', TO, '0.05')],
        capped: false,
      }),
    }),
    FROM,
    TO,
  );

describe('浮动腿实现率（真实窗口数字）', () => {
  it('年化因子按 market 的 paymentPeriod：8h 市场 ×1095', () => {
    expect(YEAR_SEC / REAL_PAYMENT_PERIOD).toBe(1095);
    expect(annualizePeriodRate(-2e-5, REAL_PAYMENT_PERIOD)).toBeCloseTo(-0.0219, 12);
    // 周期不同年化就不同（没年化时两者会相等）
    expect(annualizePeriodRate(1e-5, 3_600) / annualizePeriodRate(1e-5, REAL_PAYMENT_PERIOD)).toBeCloseTo(8, 12);
    // 周期缺失 → NaN（不猜）
    expect(annualizePeriodRate(1e-5, 0)).toBeNaN();
    // 年化 APR → 每期值（与实际价差的推导方向相反）
    expect(periodRateOfAnnual(0.040966846136, REAL_PAYMENT_PERIOD)).toBeCloseTo(3.7412644873e-5, 15);
    expect(periodRateOfAnnual(0.040966846136, 0)).toBeNaN();
  });

  it('实际价差 = 浮动腿实现率（BTC +5.95%/年、ETH +6.58%/年），不是结算净额', async () => {
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...(await realWindow()) });
    const btc = report.coins.find((c) => c.base === 'BTC')!.legs[0]!;
    // 净额（旧实现误当「实际」的就是它）：settlement / |position| = −1.8772e-5/期 → −2.06%/年
    expect(btc.netPeriodRate).toBeCloseTo(-1.877163914504e-5, 15);
    expect(btc.fixedPeriodRate).toBeCloseTo(3.7412644873e-5, 15);
    expect(btc.feePeriodRate).toBeCloseTo(1.8264840183e-6, 15);
    // 浮动腿实现率 = fixed − 净额 − 费率（空头）
    expect(btc.floatPeriodRate).toBeCloseTo(5.4357800000e-5, 12);
    expect(btc.actualApr!).toBeCloseTo(5.9521791e-2, 7);
    expect(btc.lockedApr!).toBeCloseTo(0.040966846136, 12);

    const eth = report.coins.find((c) => c.base === 'ETH')!.legs[0]!;
    expect(eth.floatPeriodRate).toBeCloseTo(6.0091800000e-5, 12);
    expect(eth.actualApr!).toBeCloseTo(6.5800521e-2, 7);
    expect(eth.lockedApr!).toBeCloseTo(0.036551255815, 12);
  });

  it('两个币都是「少赚」（浮动腿跑赢锁定的固定腿）', async () => {
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...(await realWindow()) });
    const btc = report.coins.find((c) => c.base === 'BTC')!;
    const eth = report.coins.find((c) => c.base === 'ETH')!;
    expect(btc.deltaApr!).toBeCloseTo(1.855494e-2, 6);
    expect(eth.deltaApr!).toBeCloseTo(2.9249265e-2, 7);
    expect(btc.verdict).toBe('少赚');
    expect(eth.verdict).toBe('少赚');
    const out = formatSettlementCarry(report);
    expect(out).toContain('锁定 +4.10%/年 vs 实际 +5.95%/年');
    expect(out).toContain('锁定 +3.66%/年 vs 实际 +6.58%/年');
    expect(out).toContain('→ 「少赚」');
    expect(out).not.toContain('实际 0.00%/年');
  });

  it('同期归集：本期合计 BTC ≈ +$6.21、ETH ≈ +$1.79，与锁定预期的偏差 < 10%', async () => {
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...(await realWindow()) });
    const btc = report.coins.find((c) => c.base === 'BTC')!;
    const eth = report.coins.find((c) => c.base === 'ETH')!;
    // Boros 结算（settlementToken × 币价）+ 同期 perp 资金费
    expect(btc.totalUsd!).toBeCloseTo(6.2089, 3);
    expect(eth.totalUsd!).toBeCloseTo(1.7865, 3);
    // 不变式：本期合并金额 ≈ 锁定 APR × 名义 × 期长（残差 = fee 与逐期差）
    const windowYears = REAL_PAYMENT_PERIOD / YEAR_SEC;
    const btcLockedUsd = 0.040966846136 * 2.6975 * REAL_PRICE_BTC * windowYears;
    const ethLockedUsd = 0.036551255815 * 30 * REAL_PRICE_ETH * windowYears;
    expect(Math.abs(btc.totalUsd! - btcLockedUsd) / btcLockedUsd).toBeLessThan(0.1);
    expect(Math.abs(eth.totalUsd! - ethLockedUsd) / ethLockedUsd).toBeLessThan(0.1);
  });

  it('上一期的结算与 perp 行都不进本期（否则金额差 2–4 倍）', async () => {
    const w = await realWindow();
    // 只有本窗口两条结算腿，诱饵未被计入
    expect(w.legs).toHaveLength(2);
    expect(w.legs.find((l) => l.marketId === 233)!.settlementToken).toBeCloseTo(-5.0636496593742e-5, 17);
    expect(w.legs.find((l) => l.marketId === 232)!.settlementToken).toBeCloseTo(-8.561442516e-4, 16);
    // perp：期终 = TO 的两个 inflow；期终 = FROM 的两条诱饵不进
    expect(w.perps.map((p) => p.base).sort()).toEqual(['BTC', 'ETH']);
    expect(w.perps.find((p) => p.base === 'BTC')!.fundingUsd).toBeCloseTo(9.447, 9);
    expect(w.perps.find((p) => p.base === 'BTC')!.feesUsd).toBeCloseTo(0.05, 9);
    expect(w.perps.find((p) => p.base === 'ETH')!.fundingUsd).toBeCloseTo(3.3488, 9);
    expect(w.unattributedUsd).toBe(0);
  });
});

describe('降级视图', () => {
  it('结算代币无币价：行尾显式标注「该腿无币价，USD 未计」', () => {
    const report = buildSettlementCarry({
      windowFromSec: FROM,
      windowToSec: TO,
      legs: [
        {
          marketId: 999,
          base: 'BTC',
          venue: 'HYPERLIQUID',
          spreadVenues: null,
          side: 'SHORT',
          coin: 'token99',
          settlementToken: 100,
          feeToken: 0,
          tokenPriceUsd: null,
          entryApr: 0.05,
          positionAbs: 1,
          netPeriodRate: 1e-5,
          feePeriodRate: 0,
          paymentPeriodSec: 28_800,
        },
      ],
      perps: [{ base: 'BTC', venue: 'HYPERLIQUID', side: 'SHORT', fundingUsd: 1, feesUsd: 0 }],
    });
    const out = formatSettlementCarry(report);
    expect(out).toContain('  Boros HL 空 —（+100.0000 token99） · 该腿无币价，USD 未计');
    expect(out).toContain('（部分腿无币价，未计入）');
  });
});

// ---------------------------------------------------------------------------
// 4. 播报文本格式
// ---------------------------------------------------------------------------

describe('formatSettlementCarry', () => {
  it('每条 Boros 行都同时含 USD 与币数量', async () => {
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...(await readWindow()) });
    const out = formatSettlementCarry(report);
    const borosLines = out.split('\n').filter((l) => l.trimStart().startsWith('Boros '));
    expect(borosLines).toHaveLength(4);
    for (const line of borosLines) {
      expect(line).toMatch(/\$[-\d.,]+（[-+]?[\d.]+ [A-Z]+）/);
    }
    // 反例：只给 USD 不给币数量的行必须判失败
    expect('  Boros HL 空 -$3.20').not.toMatch(/\$[-\d.,]+（[-+]?[\d.]+ [A-Z]+）/);
  });

  it('文本骨架与样例一致（分块、小计、本期合计、对照）', async () => {
    const report = buildSettlementCarry({ windowFromSec: FROM, windowToSec: TO, ...(await readWindow()) });
    const out = formatSettlementCarry(report);
    expect(out).toContain('💰 结算播报 · 11-14 16:00–00:00 UTC（8h 窗口）');
    expect(out).toContain('BTC');
    expect(out).toContain('  Boros HL 空 -$3.20（-0.0000320 BTC）');
    expect(out).toContain('  perp  HL 空 +$4.00');
    expect(out).toContain('  → HL 小计 +$0.80');
    expect(out).toContain('  Boros Gate 多 +$1.10（+0.0000110 BTC）');
    expect(out).toContain('  → Gate 小计 +$0.31');
    expect(out).toContain('  本期合计 +$1.11 ｜锁定 +1.05%/年 vs 实际 -2.02%/年（差额 -3.07%/年）→ 「多赚」');
    expect(out).toContain('ETH（Spread：HL-Gate）');
    // Spread 腿一腿对两所：只写一所会让人以为缺腿（审阅意见）。
    expect(out).toContain('  Boros Spread（HL+Gate） 空 ');
    expect(out).toContain('LTC');
    expect(out).toContain('  perp  无（该所无持仓）');
    expect(out).toContain('  本期合计 -$0.42'); // 无 perp → 不给「锁定 vs 实际」对照
    expect(out).not.toMatch(/累计|cumulative|lifetime/i);
  });

  it('带符号格式', () => {
    expect(signedUsd(1.1)).toBe('+$1.10');
    expect(signedUsd(-3.28)).toBe('-$3.28');
    expect(signedUsd(0)).toBe('$0.00');
    expect(signedCoin(-0.000051, 'BTC')).toBe('-0.0000510 BTC');
    expect(signedCoin(0.0000171, 'BTC')).toBe('+0.0000171 BTC');
  });
});

// ---------------------------------------------------------------------------
// 5. 游标 / 审计 / 心跳
// ---------------------------------------------------------------------------

describe('runSettlementCarryPass', () => {
  let dataDir = '';

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-carry-'));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const makeDeps = (
    over: Partial<SettlementCarryDeps> = {},
    send: (details: string, coin: string) => Promise<boolean> = async () => true,
  ): SettlementCarryDeps => ({
    config: { webhook: { url: 'http://127.0.0.1:9/unused' }, intervalSec: 28_800 },
    dataDir,
    now: () => NOW_MS,
    readWindow: async () => readWindow(),
    sendWebhook: send,
    log: () => {},
    error: () => {},
    ...over,
  });

  const cursor = (): { lastPostedWindowSec: number | null; pending: { fromSec: number; attempts: number } | null } =>
    JSON.parse(fs.readFileSync(path.join(dataDir, 'settlement-carry-cursor.json'), 'utf8'));

  const auditLines = (): Array<Record<string, unknown>> =>
    fs
      .readFileSync(path.join(dataDir, 'audit', 'settlement-carry.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('首次运行只对齐游标，不补发历史', async () => {
    const send = vi.fn(async () => true);
    const res = await runSettlementCarryPass(makeDeps({}, send));
    expect(res.status).toBe('idle');
    expect(send).not.toHaveBeenCalled();
    expect(cursor().lastPostedWindowSec).toBe(TO);
    expect(auditLines()[0]!.note).toBe('first-run-align');
  });

  it('同一窗口只发一次（幂等）', async () => {
    const send = vi.fn(async () => true);
    const at = (offsetSec: number) => makeDeps({ now: () => (TO + offsetSec) * 1000 }, send);
    await runSettlementCarryPass(at(0)); // first-run align：游标停在刚跨过的边界
    expect(cursor().lastPostedWindowSec).toBe(TO);
    // 下一个边界：这个窗口只被观测过一部分 → 跳过
    expect((await runSettlementCarryPass(at(28_800))).status).toBe('idle');
    expect(send).not.toHaveBeenCalled();
    // 再下一个边界：完整观测的窗口 → 播报
    expect((await runSettlementCarryPass(at(57_600))).status).toBe('posted');
    expect(send).toHaveBeenCalledTimes(1);
    expect(cursor().lastPostedWindowSec).toBe(TO + 28_800);
    // 同一窗口再跑一次：不再发
    expect((await runSettlementCarryPass(at(0))).status).toBe('idle');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('发送失败不前进游标，下个周期重试同一窗口，3 次后放弃', async () => {
    const fail = vi.fn(async () => false);
    const at = (offsetSec: number) => makeDeps({ now: () => (TO + offsetSec) * 1000 }, fail);
    await runSettlementCarryPass(at(0)); // align at TO

    expect((await runSettlementCarryPass(at(57_600))).status).toBe('failed');
    expect(cursor().pending?.fromSec).toBe(TO + 28_800);
    expect(cursor().lastPostedWindowSec).toBe(TO);
    expect((await runSettlementCarryPass(at(86_400))).status).toBe('failed');
    expect(cursor().pending?.attempts).toBe(2);
    // 第 3 次失败 → 放弃该窗口并留下失败标记（游标前进到该窗口起点，不重复卡死）
    expect((await runSettlementCarryPass(at(115_200))).status).toBe('failed');
    expect(cursor().pending).toBeNull();
    expect(cursor().lastPostedWindowSec).toBe(TO + 28_800);
    expect(auditLines().some((l) => l.note === 'give-up')).toBe(true);
  });

  it('本窗口没有 Boros 结算 → 不发播报，但审计照写', async () => {
    const send = vi.fn(async () => true);
    await runSettlementCarryPass(makeDeps({}, send)); // align
    const empty = makeDeps(
      {
        now: () => (TO + 57_600) * 1000,
        readWindow: async () => ({ legs: [], perps: [], unattributedUsd: 0, incompleteLedger: false }),
      },
      send,
    );
    expect((await runSettlementCarryPass(empty)).status).toBe('empty');
    expect(send).not.toHaveBeenCalled();
    expect(auditLines().at(-1)!.note).toBe('no-settlement');
  });

  it('审计每行只记本窗口事实，无累计字段', async () => {
    await runSettlementCarryPass(makeDeps());
    const posted = await runSettlementCarryPass(
      makeDeps({ now: () => (TO + 57_600) * 1000 }, async () => true),
    );
    expect(posted.status).toBe('posted');
    const line = auditLines().at(-1)!;
    expect(line.windowFromSec).toBe(TO + 28_800);
    expect(line.windowToSec).toBe(TO + 57_600);
    expect(line.posted).toBe(true);
    expect(line.httpOk).toBe(true);
    expect(Array.isArray(line.legs)).toBe(true);
    expect(Object.keys(line)).not.toContain('cumulative');
    expect(JSON.stringify(line)).not.toMatch(/累计|cumulative|lifetime/i);
  });

  it('心跳每周期推进', async () => {
    await runSettlementCarryPass(makeDeps());
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'settlement-carry-state.json'), 'utf8'));
    expect(state.lastRunSec).toBe(TO);
    await runSettlementCarryPass(makeDeps({ now: () => (TO + 3600) * 1000 }, async () => true));
    const state2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'settlement-carry-state.json'), 'utf8'));
    expect(state2.lastRunSec).toBe(TO + 3600);
  });

  it('未配置 webhook → 不运行', async () => {
    const res = await runSettlementCarryPass({
      ...makeDeps(),
      config: { webhook: null, intervalSec: 28_800 },
    });
    expect(res.status).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// 6. 配置
// ---------------------------------------------------------------------------

describe('readSettlementCarryConfig', () => {
  it('默认关闭；开启后默认 8h，下限 1h', () => {
    expect(readSettlementCarryConfig({})).toBeNull();
    expect(readSettlementCarryConfig({ SETTLEMENT_CARRY_ENABLED: 'off' })).toBeNull();
    const on = readSettlementCarryConfig({
      SETTLEMENT_CARRY_ENABLED: 'on',
      APR_ALERT_WEBHOOK_URL: 'http://127.0.0.1:1/hook',
    })!;
    expect(on.webhook?.url).toBe('http://127.0.0.1:1/hook');
    expect(on.intervalSec).toBe(28_800);
    const tiny = readSettlementCarryConfig({
      SETTLEMENT_CARRY_ENABLED: 'on',
      SETTLEMENT_CARRY_INTERVAL_SECONDS: '60',
      APR_ALERT_WEBHOOK_URL: 'http://127.0.0.1:1/hook',
    })!;
    expect(tiny.intervalSec).toBe(3600);
    // 开关开着但没 webhook：配置存在、webhook 为 null（启动处会告警）
    expect(readSettlementCarryConfig({ SETTLEMENT_CARRY_ENABLED: 'on' })!.webhook).toBeNull();
  });
});
