/** `.env`: ADMIN_TELEGRAM_ID — bitta yoki vergul bilan bir nechta ID */
export function isAdminTelegram(userId: number | undefined): boolean {
  const raw = process.env.ADMIN_TELEGRAM_ID?.trim();
  if (!raw || userId === undefined) return false;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.includes(userId.toString());
}
