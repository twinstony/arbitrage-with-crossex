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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sendFwAlert } from '../../src/server/notify/fwalert';
import {
  createSettlementCarryDeps,
  readSettlementCarryConfig,
  runSettlementCarryPass,
  type SettlementCarryDeps,
} from '../../src/server/notify/settlementCarry';

const TO = 1_700_006_400;
const WINDOW = { windowFromSec: TO + 28_800, windowToSec: TO + 57_600 };

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
});

/** 一条已配好的窗口 fixture：一条 Boros 腿 + 一个 perp 资金费行。 */
const windowFixture = {
  legs: [
    {
      marketId: 155,
      base: 'BTC',
      venue: 'HYPERLIQUID',
      spreadVenues: null,
      side: 'SHORT',
      coin: 'BTC',
      settlementToken: -0.000032,
      feeToken: 0,
      tokenPriceUsd: 100_000,
      entryApr: 0.05,
      positionAbs: 0.1,
      settlementRate: 0.05,
    },
  ],
  perps: [{ base: 'BTC', venue: 'HYPERLIQUID', side: 'SHORT', fundingUsd: 4.05, feesUsd: -0.05 }],
  unattributedUsd: 0,
  incompleteLedger: false,
};

function deps(over: Partial<SettlementCarryDeps> = {}): SettlementCarryDeps {
  return {
    config: { webhook: { url }, intervalSec: 28_800 },
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
    // 首次运行只对齐游标，不发消息
    expect((await runSettlementCarryPass(deps())).status).toBe('idle');
    expect(capture).toHaveLength(0);

    const posted = await runSettlementCarryPass(deps(advance(57_600)));
    expect(posted.status).toBe('posted');
    expect(capture).toHaveLength(1);
    expect(capture[0]!.event).toBe('Boros_APR_Alert');
    expect(capture[0]!.coin).toBe('BTC');
    expect(capture[0]!.details).toContain('💰 结算播报');
    expect(capture[0]!.details).toContain('Boros HL 空 -$3.20（-0.0000320 BTC）');
    expect(capture[0]!.details).toContain('perp  HL 空 +$4.00');

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
    expect(state.lastRunSec).toBe(TO + 57_600);
  });

  it('webhook 返回 5xx 时记为未发出（httpOk=false），游标不前进', async () => {
    await runSettlementCarryPass(deps());
    webhookOk = false;
    const failed = await runSettlementCarryPass(deps(advance(57_600)));
    expect(failed.status).toBe('failed');
    expect(capture).toHaveLength(1); // 请求确实发出去了
    const cursor = JSON.parse(fs.readFileSync(path.join(dataDir, 'settlement-carry-cursor.json'), 'utf8'));
    expect(cursor.lastPostedWindowSec).toBe(TO);
    expect(cursor.pending.fromSec).toBe(TO + 28_800);
    const audit = fs
      .readFileSync(path.join(dataDir, 'audit', 'settlement-carry.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(audit.at(-1)!.httpOk).toBe(false);
    expect(audit.at(-1)!.posted).toBe(false);
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
