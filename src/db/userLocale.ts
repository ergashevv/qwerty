import { getPostgresPool } from './postgres';
import type { BotLocale } from '../i18n/locale';
import { DEFAULT_LOCALE, isBotLocale } from '../i18n/locale';

export async function getUserLocale(telegramId: number): Promise<BotLocale> {
  const r = await getPostgresPool().query(`SELECT locale FROM users WHERE telegram_id = $1`, [telegramId]);
  const raw = (r.rows[0] as { locale?: string } | undefined)?.locale;
  return isBotLocale(raw) ? raw : DEFAULT_LOCALE;
}

export async function setUserLocale(telegramId: number, locale: BotLocale): Promise<void> {
  await getPostgresPool().query(`UPDATE users SET locale = $1 WHERE telegram_id = $2`, [locale, telegramId]);
}
