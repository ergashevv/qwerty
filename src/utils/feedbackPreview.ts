/** Matn so‘rovi uchun analytics / dashboard: bot javobining qisqa ko‘rinishi */

export function buildBotReplyPreview(d: {
  uzTitle: string;
  title: string;
  plotUz: string;
}): string {
  const titleLine = d.uzTitle && d.uzTitle !== d.title ? `${d.uzTitle} / ${d.title}` : d.title || d.uzTitle;
  const plot = (d.plotUz || '').slice(0, 500);
  const suffix = (d.plotUz || '').length > 500 ? '…' : '';
  return (titleLine + '\n\n' + plot + suffix).slice(0, 2000);
}
