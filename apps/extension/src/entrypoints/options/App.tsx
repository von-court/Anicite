import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  EyeOff,
  FolderArchive,
  Globe,
  HardDrive,
  Lock,
  Plus,
  Search,
  Server,
  Shield,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import {
  CATEGORIES,
  type Category,
  CATEGORY_LIST,
  CATEGORY_SVG_COLORS,
  getCategoryForHost,
} from '../../lib/categories';
import { SETTINGS_KEY, STORE_VERSION } from '../../lib/constants';
import { getLocalDateKey } from '../../lib/date';
import { Favicon } from '../../lib/FaviconComponent';
import {
  DEFAULT_SETTINGS,
  isValidHost,
  normalizeHost,
  type Settings,
  type TrackingMode,
} from '../../lib/settings';
import {
  aggregateByHost,
  applyPageChanges,
  clearStore,
  deleteOlderThan,
  getSettings,
  getStorageUsage,
  getStore,
  type PageStats,
  type StorageUsage,
  type Store,
  updateSettings,
} from '../../lib/storage';
type ExportFormat = 'json' | 'csv';
type ExportDateRange = 'all' | '7d' | '30d' | '90d';
type CategorySortOption = 'activity' | 'name' | 'recent';

const CATEGORY_SITES_PER_PAGE = 10;

const DATE_RANGE_LABELS: Record<ExportDateRange, string> = {
  all: 'All time',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

function getDateRangeFilter(range: ExportDateRange): (date: string) => boolean {
  if (range === 'all') return () => true;

  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = getLocalDateKey(cutoff);

  return (date: string) => date >= cutoffStr;
}

function convertToCSV(
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

const CATEGORY_COLORS: Record<Category, { bg: string; text: string }> = {
  productive: { bg: 'bg-emerald-500', text: 'text-emerald-500' },
  social: { bg: 'bg-blue-500', text: 'text-blue-500' },
  entertainment: { bg: 'bg-purple-500', text: 'text-purple-500' },
  shopping: { bg: 'bg-amber-500', text: 'text-amber-500' },
  reference: { bg: 'bg-fuchsia-500', text: 'text-fuchsia-500' },
  other: { bg: 'bg-zinc-400', text: 'text-zinc-400' },
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [trackedSites, setTrackedSites] = useState<PageStats[]>([]);
  const pagesRef = useRef<Record<string, PageStats> | null>(null);
  const [categorySearch, setCategorySearch] = useState('');
  const [newHost, setNewHost] = useState('');
  const [hostError, setHostError] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [clearSuccess, setClearSuccess] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportDateRange, setExportDateRange] =
    useState<ExportDateRange>('all');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('json');
  const [exportSuccess, setExportSuccess] = useState<ExportFormat | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);

  const [pruneDays, setPruneDays] = useState('30');
  const [isPruning, setIsPruning] = useState(false);
  const [pruneSuccess, setPruneSuccess] = useState<string | null>(null);
  const [isPrivacyExpanded, setIsPrivacyExpanded] = useState(false);

  const [categorySortBy, setCategorySortBy] =
    useState<CategorySortOption>('activity');
  const [activeCategoryFilters, setActiveCategoryFilters] = useState<
    Set<Category>
  >(new Set());
  const [categorySitesPage, setCategorySitesPage] = useState(0);

  const categoryCounts = useMemo(() => {
    const counts: Record<Category, number> = {
      productive: 0,
      social: 0,
      entertainment: 0,
      shopping: 0,
      reference: 0,
      other: 0,
    };
    for (const site of trackedSites) {
      const cat = getCategoryForHost(site.host, settings.siteCategories);
      counts[cat]++;
    }
    return counts;
  }, [trackedSites, settings.siteCategories]);

  const availableCategories = useMemo(
    () => CATEGORY_LIST.filter((c) => categoryCounts[c] > 0),
    [categoryCounts]
  );

  const processedCategorySites = useMemo(() => {
    let sites = [...trackedSites];

    const search = categorySearch.toLowerCase().trim();
    if (search) {
      sites = sites.filter((site) => site.host.toLowerCase().includes(search));
    }

    if (activeCategoryFilters.size > 0) {
      sites = sites.filter((site) => {
        const cat = getCategoryForHost(site.host, settings.siteCategories);
        return activeCategoryFilters.has(cat);
      });
    }

    switch (categorySortBy) {
      case 'activity':
        sites.sort((a, b) => b.totals.activeMs - a.totals.activeMs);
        break;
      case 'name':
        sites.sort((a, b) => a.host.localeCompare(b.host));
        break;
      case 'recent':
        sites.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
        break;
    }

    return sites;
  }, [
    trackedSites,
    categorySearch,
    activeCategoryFilters,
    categorySortBy,
    settings.siteCategories,
  ]);

  const categoryTotalPages = Math.max(
    1,
    Math.ceil(processedCategorySites.length / CATEGORY_SITES_PER_PAGE)
  );

  const paginatedCategorySites = useMemo(() => {
    const start = categorySitesPage * CATEGORY_SITES_PER_PAGE;
    return processedCategorySites.slice(start, start + CATEGORY_SITES_PER_PAGE);
  }, [processedCategorySites, categorySitesPage]);

  useEffect(() => {
    setCategorySitesPage(0);
  }, [categorySearch, activeCategoryFilters, categorySortBy]);

  const toggleCategoryFilter = (category: Category) => {
    setActiveCategoryFilters((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  useEffect(() => {
    const init = async () => {
      const [storedSettings, store, usage] = await Promise.all([
        getSettings(),
        getStore(),
        getStorageUsage(),
      ]);
      setSettings(storedSettings);
      setStorageUsage(usage);

      pagesRef.current = store.pages;
      const sites = aggregateByHost(store.pages);
      setTrackedSites(sites);
      setIsLoading(false);
    };
    void init();
  }, []);

  useEffect(() => {
    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (areaName !== 'local') return;

      if (changes[SETTINGS_KEY]?.newValue) {
        setSettings(changes[SETTINGS_KEY].newValue as Settings);
      }

      const pages = pagesRef.current;
      if (pages && applyPageChanges(pages, changes)) {
        const sites = aggregateByHost(pages);
        setTrackedSites(sites);

        // Refresh storage usage
        void getStorageUsage().then(setStorageUsage);
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, []);

  const handleToggleTracking = async () => {
    const next = await updateSettings({ enabled: !settings.enabled });
    setSettings(next);
  };

  const handleTrackingModeChange = async (mode: TrackingMode) => {
    const next = await updateSettings({ trackingMode: mode });
    setSettings(next);
  };

  const handleAddExclusion = async () => {
    setHostError(null);
    const host = normalizeHost(newHost);

    if (!host) {
      setNewHost('');
      return;
    }

    if (!isValidHost(host)) {
      setHostError('Enter a valid domain (e.g., example.com)');
      return;
    }

    if (settings.excludeHosts.includes(host)) {
      setHostError('This site is already excluded');
      return;
    }

    const next = await updateSettings({
      excludeHosts: [...settings.excludeHosts, host],
    });
    setSettings(next);
    setNewHost('');
  };

  const handleRemoveExclusion = async (host: string) => {
    const next = await updateSettings({
      excludeHosts: settings.excludeHosts.filter((h) => h !== host),
    });
    setSettings(next);
  };

  const handleClearData = async () => {
    setIsClearing(true);
    try {
      await clearStore();
      setTrackedSites([]);
      setClearSuccess(true);
      setTimeout(() => setClearSuccess(false), 3000);
      // Refresh storage usage
      const usage = await getStorageUsage();
      setStorageUsage(usage);
    } finally {
      setIsClearing(false);
      setShowClearConfirm(false);
    }
  };

  const handleCategoryChange = async (host: string, category: Category) => {
    const newCategories = { ...settings.siteCategories };
    const defaultCategory = getCategoryForHost(host, {});

    if (category === defaultCategory) {
      delete newCategories[host];
    } else {
      newCategories[host] = category;
    }

    const next = await updateSettings({ siteCategories: newCategories });
    setSettings(next);
  };

  const handleResetCategories = async () => {
    const next = await updateSettings({ siteCategories: {} });
    setSettings(next);
  };

  const handleExportData = async (format: ExportFormat) => {
    setIsExporting(true);
    try {
      const [store, currentSettings] = await Promise.all([
        getStore(),
        getSettings(),
      ]);

      const dateFilter = getDateRangeFilter(exportDateRange);
      const dateStr = new Date().toISOString().split('T')[0];
      const rangeSuffix =
        exportDateRange === 'all' ? '' : `-${exportDateRange}`;
      let blob: Blob;
      let filename: string;

      if (format === 'csv') {
        const csv = convertToCSV(store, currentSettings, dateFilter);
        blob = new Blob([csv], { type: 'text/csv' });
        filename = `anicite-export-${dateStr}${rangeSuffix}.csv`;
      } else {
        const filteredPages: typeof store.pages = {};
        for (const [key, page] of Object.entries(store.pages)) {
          const filteredByDate: typeof page.byDate = {};
          for (const [date, stats] of Object.entries(page.byDate)) {
            if (dateFilter(date)) {
              filteredByDate[date] = stats;
            }
          }
          if (Object.keys(filteredByDate).length > 0) {
            filteredPages[key] = { ...page, byDate: filteredByDate };
          }
        }

        const exportData = {
          meta: {
            exportedAt: new Date().toISOString(),
            version: STORE_VERSION,
            sitesCount: Object.keys(filteredPages).length,
            dateRange: exportDateRange,
          },
          settings: currentSettings,
          data: { ...store, pages: filteredPages },
        };
        blob = new Blob([JSON.stringify(exportData, null, 2)], {
          type: 'application/json',
        });
        filename = `anicite-export-${dateStr}${rangeSuffix}.json`;
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportSuccess(format);
      setTimeout(() => setExportSuccess(null), 3000);
    } finally {
      setIsExporting(false);
    }
  };

  const handlePruneData = async () => {
    if (
      !window.confirm(
        `Are you sure you want to delete all data older than ${pruneDays} days? This cannot be undone.`
      )
    ) {
      return;
    }

    setIsPruning(true);
    try {
      const days = parseInt(pruneDays, 10);
      const count = await deleteOlderThan(days);
      const store = await getStore();
      pagesRef.current = store.pages;
      const sites = aggregateByHost(store.pages);
      setTrackedSites(sites);
      const usage = await getStorageUsage();
      setStorageUsage(usage);

      setPruneSuccess(
        `Cleanup complete. Removed old data from ${count} sites.`
      );
      setTimeout(() => setPruneSuccess(null), 3000);
    } finally {
      setIsPruning(false);
    }
  };

  if (isLoading) {
    return (
      <div className="bg-background text-foreground min-h-screen px-6 py-12">
        <div className="mx-auto max-w-2xl">
          <header className="mb-10">
            <div className="bg-muted h-3 w-16 animate-pulse rounded" />
            <div className="bg-muted mt-3 h-7 w-32 animate-pulse rounded" />
            <div className="bg-muted mt-2 h-4 w-64 animate-pulse rounded" />
          </header>
          <div className="space-y-8">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="card">
                <div className="bg-muted h-5 w-24 animate-pulse rounded" />
                <div className="bg-muted mt-2 h-3 w-48 animate-pulse rounded" />
                <div className="bg-muted mt-4 h-10 w-full animate-pulse rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background text-foreground min-h-screen px-6 py-12">
      <div className="mx-auto max-w-2xl">
        <header className="mb-10">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-primary text-xs font-semibold uppercase tracking-widest">
                Anicite
              </p>
              <h1 className="mt-2 text-2xl font-semibold">Settings</h1>
              <p className="text-muted-foreground mt-1 text-sm">
                Manage your tracking preferences and data.
              </p>
            </div>
            <button
              className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-md p-2 transition-colors"
              onClick={() =>
                chrome.tabs.create({
                  url: chrome.runtime.getURL('insights.html'),
                })
              }
              title="Insights"
              type="button"
            >
              <BarChart3 className="h-5 w-5" />
            </button>
          </div>
        </header>

        <div className="space-y-8">
          <section className="card overflow-hidden p-0">
            <div
              className={`flex items-center justify-between gap-4 p-4 transition-colors ${
                settings.enabled
                  ? 'from-primary/10 via-primary/5 bg-gradient-to-r to-transparent'
                  : 'bg-amber-500/8'
              }`}
            >
              <div className="flex items-center gap-3">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-xl transition-colors"
                  style={{
                    backgroundColor: settings.enabled
                      ? 'oklch(from var(--success) l c h / 0.15)'
                      : 'rgb(245 158 11 / 0.15)',
                  }}
                >
                  <svg
                    className={`h-5 w-5 transition-colors ${
                      settings.enabled
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-amber-500'
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"
                    />
                  </svg>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold">Tracking</h2>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                        settings.enabled
                          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                          : 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {settings.enabled ? 'Active' : 'Paused'}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {settings.enabled
                      ? 'Monitoring your browsing activity'
                      : 'Data collection is paused'}
                  </p>
                </div>
              </div>
              <button
                className="switch"
                data-state={settings.enabled ? 'checked' : 'unchecked'}
                onClick={handleToggleTracking}
                type="button"
                aria-label="Toggle tracking"
              >
                <span className="switch-thumb" />
              </button>
            </div>

            <div className="border-border border-t p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-medium">Time Measurement</h3>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    When to count time on pages
                  </p>
                </div>
                <div className="bg-muted flex gap-1 rounded-lg p-1">
                  <button
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                      settings.trackingMode === 'focused'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => void handleTrackingModeChange('focused')}
                    type="button"
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M7.5 3.75H6A2.25 2.25 0 003.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0120.25 6v1.5m0 9V18A2.25 2.25 0 0118 20.25h-1.5m-9 0H6A2.25 2.25 0 013.75 18v-1.5M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                    Focused
                  </button>
                  <button
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                      settings.trackingMode === 'visible'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => void handleTrackingModeChange('visible')}
                    type="button"
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                    Visible
                  </button>
                </div>
              </div>

              <div className="bg-muted/50 mt-4 min-h-[4.5rem] rounded-lg px-3 py-2.5">
                <p className="text-muted-foreground text-xs leading-relaxed">
                  {settings.trackingMode === 'focused' ? (
                    <>
                      <span className="text-foreground font-medium">
                        Focused mode:
                      </span>{' '}
                      Time counts only when the browser window is active. Best
                      for measuring focused attention.
                    </>
                  ) : (
                    <>
                      <span className="text-foreground font-medium">
                        Visible mode:
                      </span>{' '}
                      Time counts whenever the tab is visible, even if another
                      app is focused. Useful for background media or
                      multi-monitor setups.
                    </>
                  )}
                </p>
              </div>
            </div>
          </section>

          <section className="card overflow-hidden p-0">
            <div className="flex items-center justify-between gap-4 p-4">
              <div className="flex items-center gap-3">
                <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-xl">
                  <EyeOff className="text-muted-foreground h-5 w-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold">Excluded Sites</h2>
                    {settings.excludeHosts.length > 0 && (
                      <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-semibold">
                        {settings.excludeHosts.length} site
                        {settings.excludeHosts.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Sites in this list won't be tracked
                  </p>
                </div>
              </div>
              {settings.excludeHosts.length > 1 && (
                <button
                  className="text-muted-foreground hover:text-destructive flex items-center gap-1 text-xs transition-colors"
                  onClick={async () => {
                    if (
                      window.confirm(
                        'Are you sure you want to remove all excluded sites?'
                      )
                    ) {
                      const next = await updateSettings({ excludeHosts: [] });
                      setSettings(next);
                    }
                  }}
                  type="button"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear all
                </button>
              )}
            </div>

            <div className="border-border border-t p-4">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Globe className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
                  <input
                    type="text"
                    className={`input w-full pl-9 ${hostError ? 'border-destructive focus:border-destructive' : ''}`}
                    placeholder="Enter a domain to exclude..."
                    value={newHost}
                    onChange={(e) => {
                      setNewHost(e.target.value);
                      setHostError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void handleAddExclusion();
                      }
                    }}
                  />
                </div>
                <button
                  className="btn btn-primary flex items-center gap-1.5"
                  onClick={() => void handleAddExclusion()}
                  type="button"
                >
                  <Plus className="h-4 w-4" />
                  Add
                </button>
              </div>
              {hostError && (
                <p className="text-destructive mt-2 flex items-center gap-1.5 text-xs">
                  <span className="bg-destructive inline-block h-1 w-1 rounded-full" />
                  {hostError}
                </p>
              )}

              {settings.excludeHosts.length > 0 ? (
                <div className="mt-4 space-y-1.5">
                  {settings.excludeHosts.map((host) => (
                    <div
                      key={host}
                      className="border-border bg-muted/30 hover:bg-muted/50 hover:border-muted-foreground/20 group flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-all"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="bg-background flex h-7 w-7 shrink-0 items-center justify-center rounded-md shadow-sm">
                          <Favicon host={host} size={16} />
                        </div>
                        <div className="min-w-0">
                          <span className="block truncate text-sm font-medium leading-tight">
                            {host}
                          </span>
                          <span className="text-muted-foreground text-[10px]">
                            Includes all subdomains
                          </span>
                        </div>
                      </div>
                      <button
                        className="text-muted-foreground hover:text-destructive hover:bg-destructive flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-all hover:opacity-[0.1]"
                        onClick={() => void handleRemoveExclusion(host)}
                        type="button"
                        title="Remove from exclusion list"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-6 flex flex-col items-center justify-center py-6 text-center">
                  <div className="bg-muted/50 mb-4 flex h-16 w-16 items-center justify-center rounded-2xl">
                    <Shield className="text-muted-foreground h-8 w-8" />
                  </div>
                  <h3 className="text-sm font-medium">
                    All sites are being tracked
                  </h3>
                  <p className="text-muted-foreground mt-1 max-w-[240px] text-xs">
                    Add domains above to exclude specific sites from tracking.
                  </p>
                </div>
              )}
            </div>
          </section>

          <section className="card overflow-hidden p-0">
            <div className="flex items-center gap-3 p-4">
              <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-xl">
                <Tags className="text-muted-foreground h-5 w-5" />
              </div>
              <div>
                <h2 className="font-semibold">Site Categories</h2>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Categorize your sites to see time breakdowns in Insights
                </p>
              </div>
            </div>

            {trackedSites.length > 0 ? (
              <div className="border-border border-t p-4">
                <div className="flex items-center gap-2">
                  {trackedSites.length > 5 && (
                    <div className="relative flex-1">
                      <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
                      <input
                        type="text"
                        className="input w-full pl-9"
                        placeholder="Search sites..."
                        value={categorySearch}
                        onChange={(e) => setCategorySearch(e.target.value)}
                      />
                    </div>
                  )}
                  <Select
                    value={categorySortBy}
                    onValueChange={(val) =>
                      setCategorySortBy(val as CategorySortOption)
                    }
                  >
                    <SelectTrigger className="h-[2.25rem] w-[150px] shrink-0 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="activity" className="text-xs">
                        Most active
                      </SelectItem>
                      <SelectItem value="name" className="text-xs">
                        Name (A-Z)
                      </SelectItem>
                      <SelectItem value="recent" className="text-xs">
                        Recently seen
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {availableCategories.length > 1 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {availableCategories.map((cat) => {
                      const isActive = activeCategoryFilters.has(cat);
                      return (
                        <button
                          key={cat}
                          type="button"
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all ${
                            isActive
                              ? CATEGORY_COLORS[cat].text
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                          style={
                            isActive
                              ? {
                                  backgroundColor: `${CATEGORY_SVG_COLORS[cat]}15`,
                                }
                              : undefined
                          }
                          onClick={() => toggleCategoryFilter(cat)}
                        >
                          <span
                            className={`h-2 w-2 rounded-full ${CATEGORY_COLORS[cat].bg}`}
                            style={{ opacity: isActive ? 1 : 0.5 }}
                          />
                          {CATEGORIES[cat].label}
                          <span className="text-muted-foreground text-[10px]">
                            {categoryCounts[cat]}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {paginatedCategorySites.length > 0 ? (
                  <div className="mt-4 space-y-2">
                    {paginatedCategorySites.map((site) => {
                      const category = getCategoryForHost(
                        site.host,
                        settings.siteCategories
                      );
                      return (
                        <div
                          key={site.key}
                          className="border-border bg-muted/30 flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <Favicon host={site.host} size={16} />
                            <span className="min-w-0 truncate text-sm leading-snug">
                              {site.host}
                            </span>
                          </div>
                          <div className="relative shrink-0">
                            <Select
                              value={category}
                              onValueChange={(val) =>
                                void handleCategoryChange(
                                  site.host,
                                  val as Category
                                )
                              }
                            >
                              <SelectTrigger
                                className={`h-7 w-[130px] border-none bg-transparent p-0 text-xs shadow-none hover:bg-transparent focus:ring-0 ${CATEGORY_COLORS[category].text}`}
                              >
                                <div className="flex items-center gap-2">
                                  <SelectValue />
                                </div>
                              </SelectTrigger>
                              <SelectContent align="end">
                                {CATEGORY_LIST.map((cat) => (
                                  <SelectItem
                                    key={cat}
                                    value={cat}
                                    className="text-xs"
                                  >
                                    <div className="flex items-center gap-2">
                                      <span
                                        className={`h-2 w-2 shrink-0 rounded-full ${CATEGORY_COLORS[cat].bg}`}
                                      />
                                      <span>{CATEGORIES[cat].label}</span>
                                    </div>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-muted-foreground mt-6 text-center text-xs">
                    No sites match your filters.
                  </p>
                )}

                <div className="mt-4 flex items-center justify-between">
                  <p className="text-muted-foreground text-xs">
                    {processedCategorySites.length} site
                    {processedCategorySites.length !== 1 ? 's' : ''}
                    {(categorySearch || activeCategoryFilters.size > 0) &&
                      ' found'}
                  </p>

                  {categoryTotalPages > 1 && (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground p-1 transition-colors disabled:opacity-30"
                        disabled={categorySitesPage === 0}
                        onClick={() => setCategorySitesPage((p) => p - 1)}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {categorySitesPage + 1} of {categoryTotalPages}
                      </span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground p-1 transition-colors disabled:opacity-30"
                        disabled={categorySitesPage >= categoryTotalPages - 1}
                        onClick={() => setCategorySitesPage((p) => p + 1)}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>

                {Object.keys(settings.siteCategories).length > 0 && (
                  <button
                    className="text-muted-foreground mt-2 text-xs hover:underline"
                    onClick={() => void handleResetCategories()}
                    type="button"
                  >
                    Reset all to defaults
                  </button>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground p-4 pt-0 text-xs">
                No tracked sites yet. Browse the web to start tracking.
              </p>
            )}
          </section>

          {/* Data Management Section */}
          <section className="card overflow-hidden p-0">
            <div className="flex items-center gap-3 p-4">
              <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-xl">
                <FolderArchive className="text-muted-foreground h-5 w-5" />
              </div>
              <div>
                <h2 className="font-semibold">Data Management</h2>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Manage your locally stored browsing data
                </p>
              </div>
            </div>

            <div className="border-border border-t p-4">
              {/* Storage Usage Sub-section */}
              {storageUsage && (
                <div className="border-border bg-muted/30 rounded-lg border p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="bg-background flex h-8 w-8 items-center justify-center rounded-lg shadow-sm">
                        <Database className="text-muted-foreground h-4 w-4" />
                      </div>
                      <div>
                        <span className="text-sm font-medium">Storage</span>
                        <p className="text-muted-foreground text-[10px]">
                          Local browser storage
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-lg font-semibold tabular-nums">
                        {formatBytes(storageUsage.bytesInUse)}
                      </span>
                      <p className="text-muted-foreground text-[10px]">
                        Unlimited capacity
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Export & Prune Row */}
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {/* Export Card */}
                <div className="border-border bg-muted/30 rounded-lg border p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="bg-background flex h-8 w-8 items-center justify-center rounded-lg shadow-sm">
                        <Download className="text-muted-foreground h-4 w-4" />
                      </div>
                      <div>
                        <span className="text-sm font-medium">Export</span>
                        <p className="text-muted-foreground text-[10px]">
                          Download your data
                        </p>
                      </div>
                    </div>
                    <div className="bg-muted flex gap-0.5 rounded-md p-0.5">
                      <button
                        type="button"
                        className={`rounded px-2 py-1 text-[10px] font-medium transition-all ${
                          exportFormat === 'json'
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                        onClick={() => setExportFormat('json')}
                      >
                        JSON
                      </button>
                      <button
                        type="button"
                        className={`rounded px-2 py-1 text-[10px] font-medium transition-all ${
                          exportFormat === 'csv'
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                        onClick={() => setExportFormat('csv')}
                      >
                        CSV
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 space-y-3">
                    <Select
                      value={exportDateRange}
                      onValueChange={(val) =>
                        setExportDateRange(val as ExportDateRange)
                      }
                    >
                      <SelectTrigger className="h-9 w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(
                          Object.entries(DATE_RANGE_LABELS) as [
                            ExportDateRange,
                            string,
                          ][]
                        ).map(([value, label]) => (
                          <SelectItem
                            key={value}
                            value={value}
                            className="text-xs"
                          >
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <button
                      className="btn btn-primary h-9 w-full text-xs"
                      onClick={() => void handleExportData(exportFormat)}
                      disabled={isExporting}
                      type="button"
                    >
                      {isExporting ? 'Exporting...' : 'Export'}
                    </button>
                    {exportSuccess && (
                      <p className="text-success text-[11px]">
                        Exported as {exportSuccess.toUpperCase()}
                      </p>
                    )}
                  </div>
                </div>

                {/* Prune Card */}
                <div className="border-border bg-muted/30 rounded-lg border p-4">
                  <div className="flex items-center gap-2.5">
                    <div className="bg-background flex h-8 w-8 items-center justify-center rounded-lg shadow-sm">
                      <Trash2 className="text-muted-foreground h-4 w-4" />
                    </div>
                    <div>
                      <span className="text-sm font-medium">Prune History</span>
                      <p className="text-muted-foreground text-[10px]">
                        Clean up old data
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 space-y-3">
                    <Select value={pruneDays} onValueChange={setPruneDays}>
                      <SelectTrigger className="h-9 w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="7" className="text-xs">
                          Older than 7 days
                        </SelectItem>
                        <SelectItem value="30" className="text-xs">
                          Older than 30 days
                        </SelectItem>
                        <SelectItem value="90" className="text-xs">
                          Older than 3 months
                        </SelectItem>
                        <SelectItem value="180" className="text-xs">
                          Older than 6 months
                        </SelectItem>
                        <SelectItem value="365" className="text-xs">
                          Older than 1 year
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <button
                      className="btn btn-primary h-9 w-full text-xs"
                      onClick={() => void handlePruneData()}
                      disabled={isPruning}
                      type="button"
                    >
                      {isPruning ? 'Cleaning...' : 'Clean Up'}
                    </button>
                    {pruneSuccess && (
                      <p className="text-success text-[11px]">{pruneSuccess}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Danger Zone Section */}
          <section className="card overflow-hidden p-0">
            <div className="flex items-center gap-3 p-4">
              <div
                className="flex h-10 w-10 items-center justify-center rounded-xl"
                style={{
                  backgroundColor:
                    'oklch(from var(--destructive) l c h / 0.15)',
                }}
              >
                <AlertTriangle className="text-destructive h-5 w-5" />
              </div>
              <div>
                <h2 className="font-semibold">Danger Zone</h2>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Irreversible actions. Proceed with caution.
                </p>
              </div>
            </div>

            <div className="border-border border-t p-4">
              {showClearConfirm ? (
                <div className="space-y-3">
                  <div
                    className="rounded-lg px-3 py-3"
                    style={{
                      backgroundColor:
                        'oklch(from var(--destructive) l c h / 0.1)',
                    }}
                  >
                    <p className="text-destructive text-sm font-medium">
                      Are you sure? This will permanently delete all stored
                      browsing data.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="btn btn-destructive"
                      onClick={() => void handleClearData()}
                      disabled={isClearing}
                      type="button"
                    >
                      {isClearing ? 'Clearing...' : 'Yes, clear all data'}
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() => setShowClearConfirm(false)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  className="bg-background/50 flex items-center justify-between gap-4 rounded-lg border px-4 py-3"
                  style={{
                    borderColor: 'oklch(from var(--destructive) l c h / 0.2)',
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="flex h-9 w-9 items-center justify-center rounded-lg"
                      style={{
                        backgroundColor:
                          'oklch(from var(--destructive) l c h / 0.15)',
                      }}
                    >
                      <Trash2 className="text-destructive h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">Clear all data</p>
                      <p className="text-muted-foreground text-xs">
                        Delete all browsing history and statistics
                      </p>
                    </div>
                  </div>
                  <button
                    className="btn btn-destructive shrink-0"
                    onClick={() => setShowClearConfirm(true)}
                    type="button"
                  >
                    Clear data
                  </button>
                </div>
              )}

              {clearSuccess && (
                <p className="text-success mt-3 text-xs">
                  All browsing data has been cleared.
                </p>
              )}
            </div>
          </section>

          {/* Privacy Section - Collapsible */}
          <section className="card overflow-hidden p-0">
            <button
              type="button"
              className="hover:bg-muted/30 flex w-full items-center justify-between gap-3 p-4 text-left transition-colors"
              onClick={() => setIsPrivacyExpanded(!isPrivacyExpanded)}
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15">
                  <Shield className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <h2 className="font-semibold">Privacy First</h2>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    How Anicite protects your data
                  </p>
                </div>
              </div>
              <ChevronDown
                className={`text-muted-foreground h-5 w-5 shrink-0 transition-transform duration-200 ${
                  isPrivacyExpanded ? 'rotate-180' : ''
                }`}
              />
            </button>

            {isPrivacyExpanded && (
              <div className="border-border border-t p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  {/* Local Storage */}
                  <div className="border-border bg-muted/30 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <HardDrive className="text-muted-foreground h-4 w-4" />
                      <span className="text-sm font-medium">100% Local</span>
                    </div>
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      All data stays in your browser. Nothing leaves your
                      device.
                    </p>
                  </div>

                  {/* No Server */}
                  <div className="border-border bg-muted/30 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Server className="text-muted-foreground h-4 w-4" />
                      <span className="text-sm font-medium">No Servers</span>
                    </div>
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      Zero network requests. No accounts, no sync, no tracking.
                    </p>
                  </div>

                  {/* URL Sanitization */}
                  <div className="border-border bg-muted/30 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Globe className="text-muted-foreground h-4 w-4" />
                      <span className="text-sm font-medium">
                        URL Sanitization
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      Only the domain address is stored. Query strings and
                      hashes are stripped.
                    </p>
                  </div>

                  {/* Incognito */}
                  <div className="border-border bg-muted/30 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <EyeOff className="text-muted-foreground h-4 w-4" />
                      <span className="text-sm font-medium">
                        Incognito Blocked
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      Extension is disabled in incognito mode by design.
                    </p>
                  </div>

                  {/* Data Control */}
                  <div className="border-border bg-muted/30 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Lock className="text-muted-foreground h-4 w-4" />
                      <span className="text-sm font-medium">Full Control</span>
                    </div>
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      Export or delete your data anytime. You own everything.
                    </p>
                  </div>

                  {/* What's Tracked */}
                  <div className="border-border bg-muted/30 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Database className="text-muted-foreground h-4 w-4" />
                      <span className="text-sm font-medium">Minimal Data</span>
                    </div>
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      Visits, time, clicks, scrolls, tab switches. Nothing
                      personal.
                    </p>
                  </div>
                </div>

                <p className="text-muted-foreground mt-4 text-center text-xs">
                  Anicite is open source.{' '}
                  <a
                    href="https://github.com/CarboxyDev/anicite"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Verify our privacy claims in the code
                  </a>
                  .
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
