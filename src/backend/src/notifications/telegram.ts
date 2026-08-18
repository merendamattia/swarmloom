import { redactSecrets } from "../core/secrets.ts";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type TelegramOptions = {
  token: string;
  chatId: string;
  fetch?: Fetch;
};

export function createTelegramNotifier(options: TelegramOptions) {
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    async send(event: { type: string; message: string; id: string }) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${options.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: options.chatId,
            text: `${escapeHtml(event.type)}\n${escapeHtml(event.message)}`.slice(0, 4_096),
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });
        if (!response.ok) {
          throw new Error(`Telegram request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(redactSecrets(message, { TELEGRAM_BOT_TOKEN: options.token }));
      }
    },
  };
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
