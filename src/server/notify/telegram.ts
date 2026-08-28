/**
 * Telegram notification channel — the outbound side of the opportunity
 * scanner. Mirrors the semantics of the reference implementation in
 * crypto_price_alert's telegram_notifier.py: bot-API sendMessage with
 * parse_mode=HTML, link previews off, a 10s timeout, an optional HTTP(S)
 * proxy, and failures that log rather than throw (a dead channel must never
 * take the scanner down).
 *
 * The bot token never appears in a log line or error message.
 */
import { ProxyAgent, request } from 'undici';

const TIMEOUT_MS = 10_000;

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  /** Pre-built proxy dispatcher (undici ProxyAgent); null = send direct. */
  dispatcher: ProxyAgent | null;
}

/**
 * Read TG_BOT_TOKEN / TG_CHAT_ID / TG_PROXY / TG_ENABLED. Null when the
 * channel is disabled or half-configured — a token without a chat id (or the
 * reverse) is not an error the user needs shouted at boot, it is just an
 * unconfigured channel.
 */
export function readTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  if (env.TG_ENABLED === '0') return null;
  const botToken = env.TG_BOT_TOKEN?.trim() ?? '';
  const chatId = env.TG_CHAT_ID?.trim() ?? '';
  if (!botToken || !chatId) return null;
  const proxyUri = env.TG_PROXY?.trim() || null;
  let dispatcher: ProxyAgent | null = null;
  if (proxyUri) {
    try {
      dispatcher = new ProxyAgent(proxyUri);
    } catch (err) {
      // Malformed proxy URI: send direct rather than disable the channel, and
      // say so once — the user set a proxy because direct does not work.
      console.error(
        `⚠️  TG_PROXY is not a usable proxy URI — sending direct instead (${(err as Error).message})`,
      );
      dispatcher = null;
    }
  }
  return { botToken, chatId, dispatcher };
}

/** Send one HTML message. Returns whether Telegram accepted it (HTTP 200). */
export async function sendTelegramMessage(cfg: TelegramConfig, text: string): Promise<boolean> {
  try {
    const res = await request(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      dispatcher: cfg.dispatcher ?? undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.statusCode === 200) return true;
    // The body names the actual problem (bad token, wrong chat id, 429 …) —
    // a bare status would send the user hunting. It never contains the token.
    const body = await res.body.text().catch(() => '');
    console.error(`[notify] telegram rejected the message: HTTP ${res.statusCode} ${body.slice(0, 300)}`);
    return false;
  } catch (err) {
    // Deliberately does not quote the config: the URL embeds the bot token.
    console.error(`[notify] telegram send failed: ${(err as Error).message}`);
    return false;
  }
}
