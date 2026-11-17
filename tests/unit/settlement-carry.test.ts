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
  settlementRate: number,
  positionAbs = 0.1,
): BorosSettlementRow => ({
  id: `${marketId}:${timeSec}`,
  marketAcc: `acc-${marketId}`,
  tokenId: 0,
  marketId,
  timeSec,
  positionAbs,
  settlementToken,
  feeToken: 0,
  settlementRate,
});

/** 窗口起点后每小时的 8 条 HL 结算（-0.0000040 BTC 各一条）+ 其它腿各 1 条。 */
const SETTLEMENTS: BorosSettlementRow[] = [
  ...Array.from({ length: 8 }, (_, i) => row(155, FROM + 600 + i * 3600, -0.000004, 0.05)),
  row(158, FROM + 900, 0.000011, 0.03),
  row(200, FROM + 1200, -0.0005, 0.0292),
  row(300, FROM + 1500, -0.42, 0.01, 100),
];

const LEDGER: BorosSettlementLedger = { rows: SETTLEMENTS, coversFromSec: FROM };

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
    { marketId: 155, side: 1, size: -0.1, fixedApr: 0.05 },
    { marketId: 158, side: 0, size: 0.1, fixedApr: 0.029 },
    { marketId: 200, side: 1, size: -0.1, fixedApr: 0.001 },
    { marketId: 300, side: 1, size: -100, fixedApr: 0.01 },
  ]),
];

/** 当前持仓：positionId → symbol（venue/base 由此解析）。 */
const POSITIONS = [
  { positionId: 'pidBtcHl', symbol: 'HYPERLIQUID_PERP_BTC_USDT', positionSide: 'SHORT', positionQty: '-0.1' },
  { positionId: 'pidBtcGate', symbol: 'GATE_PERP_BTC_USDT', positionSide: 'LONG', positionQty: '0.1' },
  { positionId: 'pidEthHl', symbol: 'HYPERLIQUID_PERP_ETH_USDT', positionSide: 'SHORT', positionQty: '-0.1' },
  { positionId: 'pidEthGate', symbol: 'GATE_PERP_ETH_USDT', positionSide: 'LONG', positionQty: '0.1' },
];

interface BookRow {
  statementType: 'FUNDING_FEE' | 'FEE';
  businessId: string;
  change: string;
  exchangeType?: string;
  createTime?: string;
}

const BOOK: BookRow[] = [
  { statementType: 'FUNDING_FEE', businessId: 'pidBtcHl_1700001000', change: '4.05', createTime: String(FROM + 600) },
  { statementType: 'FEE', businessId: 'pidBtcHl_1700001001', change: '-0.05', createTime: String(FROM + 700) },
  { statementType: 'FUNDING_FEE', businessId: 'pidBtcGate_1700001100', change: '-0.8', createTime: String(FROM + 800) },
  { statementType: 'FEE', businessId: 'pidBtcGate_1700001101', change: '0.01', createTime: String(FROM + 900) },
  { statementType: 'FUNDING_FEE', businessId: 'pidEthHl_1700001200', change: '1.9', createTime: String(FROM + 1000) },
  { statementType: 'FUNDING_FEE', businessId: 'pidEthGate_1700001300', change: '-0.36', createTime: String(FROM + 1100) },
  // 窗口外的行必须被丢掉
  { statementType: 'FUNDING_FEE', businessId: 'pidBtcHl_1700001400', change: '99', createTime: String(TO + 60) },
];

function readers(over: Partial<SettlementCarryReaders> = {}): SettlementCarryReaders {
  return {
    markets: async () => MARKETS,
    marketsByIds: async (ids) => new Map(ids.filter((id) => MARKET_BY_ID.has(id)).map((id) => [id, MARKET_BY_ID.get(id)!])),
    settlementLedger: async () => LEDGER,
    collateralZones: async () => ZONES,
    accountBook: async (statementType) => ({
      rows: BOOK.filter((r) => r.statementType === statementType).map((r) => ({ ...r })),
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

    // 锁定价差 = Σ(|entryApr| × w × side) / Σw = (0.05×0.1 − 0.029×0.1)/0.2
    expect(btc.lockedApr!).toBeCloseTo(0.0105, 9);
    // 实际价差 = (0.05×0.1 + 0.03×0.1)/0.2
    expect(btc.actualApr!).toBeCloseTo(0.04, 9);
    expect(btc.verdict).toBe('少赚');

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
        ...BOOK.filter((r) => r.statementType === statementType).map((r) => ({ ...r })),
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
    expect(out).toContain('  本期合计 +$1.11 ｜锁定 1.05%/年 vs 实际 4.00%/年 → 「少赚」');
    expect(out).toContain('ETH（Spread：HL-Gate）');
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
