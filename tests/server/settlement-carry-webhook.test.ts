/**
 * 💰 结算播报 —— 可隔离运行 + 出站记录（V2/V3 契约）。
 *
 * 这里不碰任何真实交易所：窗口数据是 fixture，webhook 指向本机 mock，
 * 游标/审计/心跳写在临时 `ARB_DATA_DIR` 里。断言的是「真的发出去了」——
 * 出站 HTTP 请求体、审计里的 `posted/httpOk`，而不是只信格式化字符串。
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendFwAlert } from '../../src/server/notify/fwalert';
import {
  createSettlementCarryDeps,
  readSettlementCarryConfig,
  runSettlementCarryPass,
  type SettlementCarryDeps,
  type SettlementCarryWindow,
} from '../../src/server/notify/settlementCarry';

const TO = 1_700_006_400;
const WINDOW = { windowFromSec: TO, windowToSec: TO + 28_800 };

interface Captured {
  event?: string;
  coin?: string;
  details?: string;
}

let server: http.Server;
let url = '';
const capture: Captured[] = [];
let webhookOk = true;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += String(chunk)));
    req.on('end', () => {
      try {
        capture.push(JSON.parse(body) as Captured);
      } catch {
        capture.push({});
      }
      res.statusCode = webhookOk ? 200 : 500;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/alert`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let dataDir = '';

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-carry-e2e-'));
  capture.length = 0;
  webhookOk = true;
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ARB_DATA_DIR;
  delete process.env.SETTLEMENT_CARRY_ENABLED;
  delete process.env.APR_ALERT_WEBHOOK_URL;
  delete process.env.BOROS_ROOT_ADDRESS;
  delete process.env.SETTLEMENT_CARRY_RETRY_BACKOFF_SEC;
  vi.unstubAllGlobals();
});

/**
 * 一条已配好的窗口 fixture：真实窗口 2026-11-17 00:00–08:00 UTC 的 BTC 腿
 * （审阅意见引用的原始 API 读数，常量手算，不复用生产公式）。
 *
 *  - settlement = −5.0636496593742e-05 BTC（=−$3.288 @ 64935）、fee = 4.926940639269e-6
 *  - positionAbs = 2.6975、entryApr = 0.040966846136、paymentPeriod = 28800（年化 ×1095）
 *  - 浮动腿实现率 = fixed − 净额 − 费率 = 3.7412644873e-5 + 1.8772e-5 − 1.8265e-6
 *    = 5.4358e-5/期 → ×1095 = **+5.95%/年**（锁定 +4.10%/年，差额 +1.86pp → 少赚）
 *  - perp 同期资金费 9.447 + 手续费 0.05 → 本期合计 = −3.288 + 9.497 = **+6.21**
 */
const windowFixture: SettlementCarryWindow = {
  legs: [
    {
      marketId: 233,
      base: 'BTC',
      venue: 'HYPERLIQUID',
      spreadVenues: null,
      side: 'SHORT',
      coin: 'BTC',
      settlementToken: -5.0636496593742e-05,
      feeToken: 4.926940639269e-6,
      // 每期率 = 现金流 / |仓位|（单条结算，窗口内只有一期）
      netPeriodRate: -5.0636496593742e-05 / 2.6975,
      feePeriodRate: 4.926940639269e-6 / 2.6975,
      tokenPriceUsd: 64_935,
      entryApr: 0.040966846136,
      positionAbs: 2.6975,
      paymentPeriodSec: 28_800,
    },
  ],
  perps: [{ base: 'BTC', venue: 'HYPERLIQUID', side: 'SHORT', fundingUsd: 9.447, feesUsd: 0.05 }],
  unattributedUsd: 0,
  incompleteLedger: false,
};

function deps(over: Partial<SettlementCarryDeps> = {}): SettlementCarryDeps {
  return {
    config: { webhook: { url }, intervalSec: 28_800, retryBackoffSec: 300 },
    dataDir,
    now: () => TO * 1000,
    readWindow: async () => windowFixture,
    // 真的走一遍 sendFwAlert：出站 HTTP 到本机 mock
    sendWebhook: (details, coin) => sendFwAlert({ url }, details, coin),
    log: () => {},
    error: () => {},
    ...over,
  };
}

const advance = (offsetSec: number) => ({ now: () => (TO + offsetSec) * 1000 });

describe('结算播报 · 隔离运行', () => {
  it('webhook 指向本地 mock 时能完整跑通（首次对齐 → 下一个完整窗口播报）', async () => {
    // 首次运行只对齐游标（写到刚结束窗口的起点），不发消息
    expect((await runSettlementCarryPass(deps())).status).toBe('idle');
    expect(capture).toHaveLength(0);

    // 紧接的下一个边界：这一窗口完整可读 → 播报（issue #6：曾被闸门静默吞掉）
    const posted = await runSettlementCarryPass(deps(advance(28_800)));
    expect(posted.status).toBe('posted');
    expect(capture).toHaveLength(1);
    expect(capture[0]!.event).toBe('Boros_APR_Alert');
    expect(capture[0]!.coin).toBe('BTC');
    expect(capture[0]!.details).toContain('💰 结算播报');
    expect(capture[0]!.details).toContain('Boros HL 空 -$3.29（-0.0000506 BTC）');
    expect(capture[0]!.details).toContain('perp  HL 空 +$9.50');
    // 锁定（年化 APR）vs 实际（浮动腿实现率按 8h 周期年化）：真实常量 +4.10% vs +5.95%
    expect(capture[0]!.details).toContain('锁定 +4.10%/年 vs 实际 +5.95%/年');
    expect(capture[0]!.details).toContain('→ 「少赚」');
    expect(capture[0]!.details).toContain('本期合计 +$6.21');

    // 审计记录了「确实发出、且 HTTP 成功」
    const audit = fs
      .readFileSync(path.join(dataDir, 'audit', 'settlement-carry.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const last = audit.at(-1)!;
    expect(last.windowFromSec).toBe(WINDOW.windowFromSec);
    expect(last.posted).toBe(true);
    expect(last.httpOk).toBe(true);
    expect(Array.isArray(last.legs)).toBe(true);

    // 心跳推进
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'settlement-carry-state.json'), 'utf8'));
    expect(state.lastRunSec).toBe(TO + 28_800);
  });

  it('webhook 返回 5xx 时记为未发出（httpOk=false），游标不前进', async () => {
    await runSettlementCarryPass(deps());
    webhookOk = false;
    const failed = await runSettlementCarryPass(deps(advance(28_800)));
    expect(failed.status).toBe('failed');
    expect(capture).toHaveLength(1); // 请求确实发出去了
    const cursor = JSON.parse(fs.readFileSync(path.join(dataDir, 'settlement-carry-cursor.json'), 'utf8'));
    expect(cursor.lastPostedWindowSec).toBe(TO - 28_800); // 首启对齐写窗口起点
    expect(cursor.pending.fromSec).toBe(TO);
    const audit = fs
      .readFileSync(path.join(dataDir, 'audit', 'settlement-carry.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(audit.at(-1)!.httpOk).toBe(false);
    expect(audit.at(-1)!.posted).toBe(false);
  });
});

describe('fwalert · 超时/网络失败重试一次（issue #8 缺陷 3）', () => {
  const cfg = { url: 'http://127.0.0.1:9/unused' };
  const tlsReset = (): Error => Object.assign(new Error('fetch failed: SSL connect error'), { name: 'TypeError' });
  const timedOut = (): Error => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

  it('TLS 抖动一次后第二次成功 → 返回 true，一共 2 次请求', async () => {
    const attempts: string[] = [];
    const fetchMock = vi.fn(async () => {
      attempts.push('call');
      if (attempts.length === 1) throw tlsReset();
      return { ok: true } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendFwAlert(cfg, 'details', 'BTC')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('超时被切断后重试一次（生产事故里的 `aborted due to timeout`）', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw timedOut();
      return { ok: true } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendFwAlert(cfg, 'details', 'BTC')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('两次都失败 → false（不再第三次），交给周期级短退避', async () => {
    const fetchMock = vi.fn(async () => {
      throw tlsReset();
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendFwAlert(cfg, 'details', 'BTC')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('收到非 2xx 判决时不重试（判决已到，重复发送有重复播报风险）', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendFwAlert(cfg, 'details', 'BTC')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('结算播报 · 配置与隔离', () => {
  it('默认关闭；开启后路径可被 env 覆盖（V3）', () => {
    expect(createSettlementCarryDeps({})).toBeNull();
    process.env.SETTLEMENT_CARRY_ENABLED = 'on';
    process.env.APR_ALERT_WEBHOOK_URL = url;
    process.env.BOROS_ROOT_ADDRESS = `0x${'ab'.repeat(20)}`;
    process.env.ARB_DATA_DIR = dataDir;
    const built = createSettlementCarryDeps()!;
    expect(built).not.toBeNull();
    expect(built.dataDir).toBe(dataDir);
    expect(readSettlementCarryConfig()!.intervalSec).toBe(28_800);
  });
});
