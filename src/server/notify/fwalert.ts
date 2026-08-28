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
const TIMEOUT_MS = 10_000;

export interface FwAlertConfig {
  url: string;
}

/** Null when APR_ALERT_WEBHOOK_URL is unset/blank — an unconfigured channel. */
export function readFwAlertConfig(env: NodeJS.ProcessEnv = process.env): FwAlertConfig | null {
  const url = env.APR_ALERT_WEBHOOK_URL?.trim();
  return url ? { url } : null;
}

/**
 * POST one alert. `details` is the entire effective message (the reader only
 * consumes this field); `coin`/`event` ride along for payload compatibility
 * with the reference consumer.
 */
export async function sendFwAlert(cfg: FwAlertConfig, details: string, coin: string): Promise<boolean> {
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'Boros_APR_Alert', coin, details }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch (err) {
    console.error(`[notify] webhook send failed: ${(err as Error).message}`);
    return false;
  }
}
