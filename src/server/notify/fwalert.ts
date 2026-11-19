/**
 * fwalert.com webhook channel — the threshold-alert side of the opportunity
 * scanner. Mirrors crypto_price_alert's send_fw_alert: a fire-and-forget POST
 * of a JSON payload whose `details` field carries the whole human-readable
 * message (the receiving side renders only that), with failures logged rather
 * than thrown.
 *
 * The webhook target is assumed reachable directly (fwalert is a public
 * relay); it deliberately does not honour TG_PROXY — Telegram is the only
 * channel behind the local proxy.
 */

/**
 * 20s（原 10s）：2026-11-19 的生产事故里手工补发时见过 POST 在 10s 处被
 * 客户端切断（`The operation was aborted due to timeout`），紧接着重跑立刻成功
 * ——中继只是慢，不是死。放大到 20s 让慢响应正常落到答案上，而不是制造一次假失败。
 */
const TIMEOUT_MS = 20_000;
/**
 * 「没拿到判决」时重试一次（issue #8 缺陷 3）：网络错误（TLS 抖动）或超时被切断，
 * 都是**未确认送达**；同一周期内再试一次比等下一个周期便宜得多。
 * 收到 4xx/5xx 则不重试：判决已经到手，重复发送反而有重复播报的风险。
 */
const RETRY_DELAY_MS = 1_000;

export interface FwAlertConfig {
  url: string;
}

/** Null when APR_ALERT_WEBHOOK_URL is unset/blank — an unconfigured channel. */
export function readFwAlertConfig(env: NodeJS.ProcessEnv = process.env): FwAlertConfig | null {
  const url = env.APR_ALERT_WEBHOOK_URL?.trim();
  return url ? { url } : null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 一次 POST；抛错 = 没拿到 HTTP 判决（可安全重试）。 */
async function postOnce(cfg: FwAlertConfig, body: string): Promise<boolean> {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res.ok;
}

/**
 * POST one alert. `details` is the entire effective message (the reader only
 * consumes this field); `coin`/`event` ride along for payload compatibility
 * with the reference consumer.
 */
export async function sendFwAlert(cfg: FwAlertConfig, details: string, coin: string): Promise<boolean> {
  const body = JSON.stringify({ event: 'Boros_APR_Alert', coin, details });
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await postOnce(cfg, body);
    } catch (err) {
      const last = attempt >= 2;
      console.error(
        `[notify] webhook send failed${last ? '' : ', retrying once'}: ${(err as Error).message}`,
      );
      if (last) return false;
      await sleep(RETRY_DELAY_MS);
    }
  }
}
