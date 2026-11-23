import { getCategoryForHost } from './categories';
import { getLocalDateKey } from './date';
import type { Settings } from './settings';
import type { Store } from './storage';

/** The ExportDateRange labels in the options page: 'all', '7d', '30d' or '90d'. */
export type ExportDateRange = 'all' | '7d' | '30d' | '90d';

export function getDateRangeFilter(range: ExportDateRange): (date: string) => boolean {
  if (range === 'all') return () => true;

  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = getLocalDateKey(cutoff);

  return (date: string) => date >= cutoffStr;
}

export function convertToCSV(
  store: Store,
  settings: Settings,
  dateFilter: (date: string) => boolean
): string {
  const headers = [
    'host',
    'path',
    'category',
    'date',
    'visits',
    'sessions',
    'activeMs',
    'activeMinutes',
    'clicks',
    'scrollDistance',
    'tabSwitches',
  ];

  const rows: string[][] = [];

  for (const page of Object.values(store.pages)) {
    const category = getCategoryForHost(page.host, settings.siteCategories);

    for (const [date, stats] of Object.entries(page.byDate)) {
      if (!dateFilter(date)) continue;
      rows.push([
        page.host,
        page.path ?? '',
        category,
        date,
        String(stats.visits),
        String(stats.sessions),
        String(stats.activeMs),
        String(Math.round(stats.activeMs / 60000)),
        String(stats.clicks),
        String(stats.scrollDistance),
        String(stats.tabSwitches),
      ]);
    }
  }

  rows.sort((a, b) => {
    const dateCompare = b[3].localeCompare(a[3]);
    if (dateCompare !== 0) return dateCompare;
    return Number(b[6]) - Number(a[6]);
  });

  const escape = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  return [
    headers.join(','),
    ...rows.map((row) => row.map(escape).join(',')),
  ].join('\n');
}
