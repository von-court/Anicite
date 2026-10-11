import {
  ArrowLeftRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  Globe,
  MousePointerClick,
  MoveVertical,
  Settings as SettingsIcon,
  Zap,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';

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
import { SETTINGS_KEY } from '../../lib/constants';
import { getLocalDateKey } from '../../lib/date';
import { Favicon } from '../../lib/FaviconComponent';
import { formatDuration } from '../../lib/format';
import {
  aggregateByCategory,
  aggregateByHour,
  aggregateByPeriod,
  type AggregatedStats,
  type CategoryStats,
  type HourlyCell,
  type HourlyPatternData,
  type Period,
} from '../../lib/insights';
import { DEFAULT_SETTINGS, type Settings } from '../../lib/settings';
import {
  applyPageChanges,
  getSettings,
  getStore,
  type Store,
} from '../../lib/storage';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7days', label: '7 Days' },
  { value: '30days', label: '30 Days' },
  { value: 'all', label: 'All Time' },
];

type SortMetric = 'time' | 'clicks' | 'scroll' | 'switches';

const SORT_OPTIONS: { value: SortMetric; label: string; icon: typeof Clock }[] =
  [
    { value: 'time', label: 'Active time', icon: Clock },
    { value: 'clicks', label: 'Clicks', icon: MousePointerClick },
    { value: 'scroll', label: 'Scroll intensity', icon: MoveVertical },
    { value: 'switches', label: 'Tab switches', icon: ArrowLeftRight },
  ];

const CATEGORY_COLORS: Record<Category, { bg: string; text: string }> = {
  productive: { bg: 'bg-emerald-500', text: 'text-emerald-500' },
  social: { bg: 'bg-blue-500', text: 'text-blue-500' },
  entertainment: { bg: 'bg-purple-500', text: 'text-purple-500' },
  shopping: { bg: 'bg-amber-500', text: 'text-amber-500' },
  reference: { bg: 'bg-fuchsia-500', text: 'text-fuchsia-500' },
  other: { bg: 'bg-zinc-400', text: 'text-zinc-400' },
};

const SITES_PER_PAGE = 10;

function DonutChart({
  data,
  hoveredCategory,
  onHover,
}: {
  data: CategoryStats[];
  hoveredCategory: Category | null;
  onHover: (category: Category | null) => void;
}) {
  const size = 160;
  const strokeWidth = 20;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  // Find the largest category for center display
  const largestCategory = data.length > 0 ? data[0] : null;
  const displayCategory =
    hoveredCategory !== null
      ? data.find((d) => d.category === hoveredCategory)
      : largestCategory;

  const segments = useMemo(() => {
    const result: {
      category: Category;
      length: number;
      offset: number;
      color: string;
    }[] = [];
    let currentOffset = 0;

    // Add small gaps between segments
    const gapAngle = data.length > 1 ? 3 : 0; // degrees
    const gapLength = (gapAngle / 360) * circumference;
    const totalGaps = data.length * gapLength;
    const availableCircumference = circumference - totalGaps;

    for (const item of data) {
      const length = (item.percentage / 100) * availableCircumference;
      result.push({
        category: item.category,
        length,
        offset: currentOffset,
        color: CATEGORY_SVG_COLORS[item.category],
      });
      currentOffset += length + gapLength;
    }

    return result;
  }, [data, circumference]);

  return (
    <div className="relative p-2">
      <svg
        width={size}
        height={size}
        className="shrink-0 -rotate-90 overflow-visible"
        style={{ overflow: 'visible' }}
      >
        {/* Background track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-muted/30"
        />
        {/* Segments */}
        {segments.map((seg) => {
          const isHovered = hoveredCategory === seg.category;
          const isOtherHovered =
            hoveredCategory !== null && hoveredCategory !== seg.category;
          return (
            <circle
              key={seg.category}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth={isHovered ? strokeWidth + 4 : strokeWidth}
              strokeDasharray={`${seg.length} ${circumference - seg.length}`}
              strokeDashoffset={-seg.offset}
              strokeLinecap="round"
              className="cursor-pointer transition-all duration-200"
              style={{
                opacity: isOtherHovered ? 0.4 : 1,
                filter: isHovered
                  ? `drop-shadow(0 0 8px ${seg.color}60)`
                  : 'none',
              }}
              onMouseEnter={() => onHover(seg.category)}
              onMouseLeave={() => onHover(null)}
            />
          );
        })}
      </svg>
      {/* Center label */}
      {displayCategory && (
        <div className="pointer-events-none absolute inset-2 flex flex-col items-center justify-center">
          <span
            className="text-2xl font-bold tabular-nums"
            style={{ color: CATEGORY_SVG_COLORS[displayCategory.category] }}
          >
            {displayCategory.percentage.toFixed(0)}%
          </span>
          <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
            {CATEGORIES[displayCategory.category].label}
          </span>
        </div>
      )}
    </div>
  );
}

function getScrollIntensity(
  scrollDistance: number | undefined,
  activeMs: number
): number | null {
  const distance = scrollDistance ?? 0;
  const activeMinutes = activeMs / 60000;
  if (activeMinutes < 0.1) return null;
  const intensity = distance / activeMinutes;
  if (!Number.isFinite(intensity)) return null;
  return intensity;
}

function formatScrollIntensity(intensity: number | null): string {
  if (intensity === null) return '–';
  return intensity.toFixed(1) + '/min';
}

function EmptyState({ period }: { period: Period }) {
  const message =
    period === 'today'
      ? 'Start browsing to see your activity for today.'
      : 'No activity recorded for this period.';

  return <p className="text-muted-foreground mt-4 text-sm">{message}</p>;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_LABELS = ['12am', '3am', '6am', '9am', '12pm', '3pm', '6pm', '9pm'];

function formatHour(hour: number): string {
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  if (hour < 12) return `${hour}am`;
  return `${hour - 12}pm`;
}

function HeatmapCell({
  cell,
  dayLabel,
}: {
  cell: HourlyCell;
  dayLabel: string;
}) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div
      className={`heatmap-cell heatmap-${cell.intensity} relative`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      role="gridcell"
    >
      {showTooltip && (
        <div className="bg-popover text-popover-foreground border-border absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded border px-2 py-1 text-xs shadow-md">
          <div className="font-medium">
            {dayLabel} {formatHour(cell.hour)}
          </div>
          <div className="text-muted-foreground">
            {cell.stats.activeMs > 0
              ? formatDuration(cell.stats.activeMs)
              : 'No activity'}
          </div>
        </div>
      )}
    </div>
  );
}

function TodayHourlyChart({ data }: { data: HourlyPatternData }) {
  const today = new Date().getDay();
  const currentHour = new Date().getHours();
  const todayRow = data.grid[today];

  if (!data.hasData) {
    return (
      <p className="text-muted-foreground mt-4 text-sm">
        Hourly activity will appear as you browse today.
      </p>
    );
  }

  const maxMs = Math.max(...todayRow.map((c) => c.stats.activeMs), 1);

  return (
    <div className="mt-4">
      <div className="flex h-24 items-end gap-[2px]">
        {todayRow.map((cell, i) => {
          const height =
            cell.stats.activeMs > 0
              ? Math.max((cell.stats.activeMs / maxMs) * 100, 8)
              : 4;
          return (
            <div
              key={i}
              className="group relative flex-1"
              style={{ height: '100%' }}
            >
              <div
                className={`heatmap-cell-bar absolute bottom-0 w-full rounded-t transition-all heatmap-${cell.intensity}`}
                style={{ height: `${height}%` }}
              />
              <div className="bg-popover text-popover-foreground border-border absolute bottom-full left-1/2 z-20 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded border px-2 py-1 text-xs shadow-md group-hover:block">
                <div className="font-medium">{formatHour(cell.hour)}</div>
                <div className="text-muted-foreground">
                  {cell.stats.activeMs > 0
                    ? formatDuration(cell.stats.activeMs)
                    : 'No activity'}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-[2px]">
        {todayRow.map((_, i) => (
          <div key={i} className="flex flex-1 justify-center">
            {i === currentHour && (
              <div className="bg-primary h-1 w-1 rounded-full" />
            )}
          </div>
        ))}
      </div>
      <div className="text-muted-foreground mt-1 flex justify-between text-[10px]">
        <span>12am</span>
        <span>6am</span>
        <span>12pm</span>
        <span>6pm</span>
        <span>11pm</span>
      </div>
    </div>
  );
}

function Heatmap({ data }: { data: HourlyPatternData }) {
  if (!data.hasData) {
    return (
      <p className="text-muted-foreground mt-4 text-sm">
        Hourly patterns will appear as you browse.
      </p>
    );
  }

  return (
    <div className="mt-4 w-full">
      {/* Hour labels row */}
      <div className="mb-1 flex">
        <div className="w-10 shrink-0" />
        <div className="grid-cols-24 grid flex-1">
          {[0, 3, 6, 9, 12, 15, 18, 21].map((hour, i) => (
            <div
              key={hour}
              className="text-muted-foreground col-span-3 text-[10px]"
            >
              {HOUR_LABELS[i]}
            </div>
          ))}
        </div>
      </div>

      {/* Grid rows */}
      <div className="space-y-0.5">
        {DAY_LABELS.map((day, dayIndex) => (
          <div key={day} className="flex items-center">
            <div className="text-muted-foreground w-10 shrink-0 text-[10px]">
              {day}
            </div>
            <div className="grid-cols-24 grid flex-1 gap-[2px]">
              {data.grid[dayIndex].map((cell) => (
                <HeatmapCell
                  key={`${dayIndex}-${cell.hour}`}
                  cell={cell}
                  dayLabel={day}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Legend - centered */}
      <div className="mt-4 flex justify-center">
        <div className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
          <span>Less</span>
          <div className="heatmap-cell heatmap-none" />
          <div className="heatmap-cell heatmap-low" />
          <div className="heatmap-cell heatmap-medium" />
          <div className="heatmap-cell heatmap-high" />
          <div className="heatmap-cell heatmap-peak" />
          <span>More</span>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [period, setPeriod] = useState<Period>('today');
  const [sortBy, setSortBy] = useState<SortMetric>('time');
  const [data, setData] = useState<AggregatedStats | null>(null);
  const [categoryStats, setCategoryStats] = useState<CategoryStats[]>([]);
  const [hourlyData, setHourlyData] = useState<HourlyPatternData | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [hoveredCategory, setHoveredCategory] = useState<Category | null>(null);
  const [activeCategoryFilters, setActiveCategoryFilters] = useState<
    Set<Category>
  >(new Set());
  const [expandedSite, setExpandedSite] = useState<string | null>(null);
  const [sitesPage, setSitesPage] = useState(0);
  const [isPending, startTransition] = useTransition();
  const periodRef = useRef<Period>('today');
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const storeRef = useRef<Store | null>(null);

  const updateFromStore = useCallback((store: Store) => {
    const aggregated = aggregateByPeriod(store, periodRef.current);
    setData(aggregated);
    const catStats = aggregateByCategory(
      store,
      periodRef.current,
      settingsRef.current.siteCategories
    );
    setCategoryStats(catStats);
    const hourly = aggregateByHour(store, periodRef.current);
    setHourlyData(hourly);
  }, []);

  useEffect(() => {
    periodRef.current = period;
    const loadData = async () => {
      setIsLoading(true);
      const [store, loadedSettings] = await Promise.all([
        getStore(),
        getSettings(),
      ]);
      settingsRef.current = loadedSettings;
      setSettings(loadedSettings);
      storeRef.current = store;
      updateFromStore(store);
      setIsLoading(false);
    };
    void loadData();
  }, [period, updateFromStore]);

  useEffect(() => {
    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (areaName !== 'local') return;

      if (changes[SETTINGS_KEY]?.newValue) {
        const newSettings = changes[SETTINGS_KEY].newValue as Settings;
        settingsRef.current = newSettings;
        setSettings(newSettings);
      }

      const store = storeRef.current;
      if (store && applyPageChanges(store.pages, changes)) {
        updateFromStore(store);
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [updateFromStore]);

  const handlePeriodChange = (newPeriod: Period) => {
    startTransition(() => {
      setPeriod(newPeriod);
    });
  };

  const todayKey = getLocalDateKey();

  const maxDayMs =
    data?.byDate.reduce((max, d) => Math.max(max, d.stats.activeMs), 0) ?? 0;

  const availableCategories = useMemo(() => {
    if (!data?.topSites) return [];
    const cats = new Set<Category>();
    for (const site of data.topSites) {
      cats.add(getCategoryForHost(site.host, settings.siteCategories));
    }
    return CATEGORY_LIST.filter((c) => cats.has(c));
  }, [data, settings.siteCategories]);

  const sortedSites = useMemo(() => {
    if (!data?.topSites) return [];

    const getSortValue = (site: (typeof data.topSites)[number]): number => {
      switch (sortBy) {
        case 'time':
          return site.stats.activeMs;
        case 'clicks':
          return site.stats.clicks;
        case 'scroll':
          return (
            getScrollIntensity(
              site.stats.scrollDistance,
              site.stats.activeMs
            ) ?? 0
          );
        case 'switches':
          return site.stats.tabSwitches;
        default:
          return site.stats.activeMs;
      }
    };

    let sites = [...data.topSites].sort(
      (a, b) => getSortValue(b) - getSortValue(a)
    );

    if (activeCategoryFilters.size > 0) {
      sites = sites.filter((site) => {
        const cat = getCategoryForHost(site.host, settings.siteCategories);
        return activeCategoryFilters.has(cat);
      });
    }

    return sites;
  }, [data, sortBy, activeCategoryFilters, settings.siteCategories]);

  const maxSortValue = useMemo(() => {
    if (sortedSites.length === 0) return 0;
    const first = sortedSites[0];
    switch (sortBy) {
      case 'time':
        return first.stats.activeMs;
      case 'clicks':
        return first.stats.clicks;
      case 'scroll':
        return (
          getScrollIntensity(
            first.stats.scrollDistance,
            first.stats.activeMs
          ) ?? 0
        );
      case 'switches':
        return first.stats.tabSwitches;
      default:
        return first.stats.activeMs;
    }
  }, [sortedSites, sortBy]);

  const formatSortValue = (site: (typeof sortedSites)[number]): string => {
    switch (sortBy) {
      case 'time':
        return formatDuration(site.stats.activeMs);
      case 'clicks':
        return `${site.stats.clicks} clicks`;
      case 'scroll':
        return formatScrollIntensity(
          getScrollIntensity(site.stats.scrollDistance, site.stats.activeMs)
        );
      case 'switches':
        return `${site.stats.tabSwitches} switches`;
      default:
        return formatDuration(site.stats.activeMs);
    }
  };

  const getSiteProgress = (site: (typeof sortedSites)[number]): number => {
    if (maxSortValue === 0) return 0;
    switch (sortBy) {
      case 'time':
        return (site.stats.activeMs / maxSortValue) * 100;
      case 'clicks':
        return (site.stats.clicks / maxSortValue) * 100;
      case 'scroll': {
        const intensity =
          getScrollIntensity(site.stats.scrollDistance, site.stats.activeMs) ??
          0;
        return (intensity / maxSortValue) * 100;
      }
      case 'switches':
        return (site.stats.tabSwitches / maxSortValue) * 100;
      default:
        return (site.stats.activeMs / maxSortValue) * 100;
    }
  };

  const totalPages = Math.max(
    1,
    Math.ceil(sortedSites.length / SITES_PER_PAGE)
  );

  const paginatedSites = useMemo(() => {
    const start = sitesPage * SITES_PER_PAGE;
    return sortedSites.slice(start, start + SITES_PER_PAGE);
  }, [sortedSites, sitesPage]);

  useEffect(() => {
    setSitesPage(0);
    setExpandedSite(null);
  }, [sortBy, activeCategoryFilters, period]);

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

  if (isLoading && !data) {
    return (
      <div className="bg-background text-foreground min-h-screen px-6 py-12">
        <div className="mx-auto max-w-2xl">
          <header className="mb-8">
            <div className="flex items-start justify-between">
              <div>
                <div className="bg-muted h-3 w-16 animate-pulse rounded" />
                <div className="bg-muted mt-3 h-7 w-24 animate-pulse rounded" />
                <div className="bg-muted mt-2 h-4 w-52 animate-pulse rounded" />
              </div>
              <div className="bg-muted h-9 w-9 animate-pulse rounded-md" />
            </div>
          </header>
          <div className="mb-6 flex gap-2">
            {PERIODS.map((p) => (
              <div
                key={p.value}
                className="bg-muted h-8 w-16 animate-pulse rounded"
              />
            ))}
          </div>
          <div className="space-y-6">
            <div className="card">
              <div className="bg-muted h-4 w-20 animate-pulse rounded" />
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="bg-muted h-10 w-10 animate-pulse rounded-lg" />
                    <div>
                      <div className="bg-muted h-3 w-10 animate-pulse rounded" />
                      <div className="bg-muted mt-1 h-5 w-12 animate-pulse rounded" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="bg-muted h-4 w-28 animate-pulse rounded" />
              <div className="bg-muted mt-1 h-3 w-44 animate-pulse rounded" />
              <div className="mt-4 space-y-1">
                {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="bg-muted h-3 w-8 animate-pulse rounded" />
                    <div className="bg-muted h-3 flex-1 animate-pulse rounded" />
                  </div>
                ))}
              </div>
            </div>
            {[1, 2].map((i) => (
              <div key={i} className="card">
                <div className="bg-muted h-4 w-24 animate-pulse rounded" />
                <div className="bg-muted mt-1 h-3 w-32 animate-pulse rounded" />
                <div className="mt-4 space-y-3">
                  {[1, 2, 3].map((j) => (
                    <div
                      key={j}
                      className="bg-muted h-6 w-full animate-pulse rounded"
                    />
                  ))}
                </div>
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
        <header className="mb-8">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-primary text-xs font-semibold uppercase tracking-widest">
                Anicite
              </p>
              <h1 className="mt-2 text-2xl font-semibold">Insights</h1>
              <p className="text-muted-foreground mt-1 text-sm">
                Your browsing activity at a glance.
              </p>
            </div>
            <button
              className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-md p-2 transition-colors"
              onClick={() =>
                chrome.tabs.create({
                  url: chrome.runtime.getURL('options.html'),
                })
              }
              title="Settings"
              type="button"
            >
              <SettingsIcon className="h-5 w-5" />
            </button>
          </div>
        </header>

        <div className="mb-6 flex gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              className={`btn btn-sm ${period === p.value ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => handlePeriodChange(p.value)}
              type="button"
            >
              {p.label}
            </button>
          ))}
        </div>

        <div
          className={`space-y-6 transition-opacity duration-150 ${isPending ? 'opacity-60' : 'opacity-100'}`}
        >
          <section className="card">
            <h2 className="text-sm font-semibold">Overview</h2>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="flex items-center gap-3">
                <div className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                  <Clock className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Active</p>
                  <p className="text-lg font-semibold">
                    {formatDuration(data?.totals.activeMs ?? 0)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                  <Eye className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Visits</p>
                  <p className="text-lg font-semibold">
                    {data?.totals.visits ?? 0}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                  <Zap className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Productive</p>
                  <p className="text-lg font-semibold">
                    {(() => {
                      const productiveMs = categoryStats
                        .filter(
                          (c) =>
                            c.category === 'productive' ||
                            c.category === 'reference'
                        )
                        .reduce((sum, c) => sum + c.stats.activeMs, 0);
                      const totalMs = data?.totals.activeMs ?? 0;
                      return totalMs > 0
                        ? `${Math.round((productiveMs / totalMs) * 100)}%`
                        : '–';
                    })()}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                  <Globe className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Sites</p>
                  <p className="text-lg font-semibold">
                    {data?.totals.sitesCount ?? 0}
                  </p>
                </div>
              </div>
            </div>
          </section>

          {categoryStats.length > 1 && (
            <section className="card">
              <h2 className="text-sm font-semibold">Time by Category</h2>
              <p className="text-muted-foreground mt-1 text-xs">
                Activity breakdown by site category
              </p>
              <div className="mt-6 flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:justify-center">
                {/* Donut Chart */}
                <div className="flex-shrink-0">
                  <DonutChart
                    data={categoryStats}
                    hoveredCategory={hoveredCategory}
                    onHover={setHoveredCategory}
                  />
                </div>
                {/* Legend */}
                <div className="w-full max-w-[280px] space-y-3">
                  {categoryStats.map((cat) => {
                    const isHovered = hoveredCategory === cat.category;
                    const isOtherHovered =
                      hoveredCategory !== null &&
                      hoveredCategory !== cat.category;
                    return (
                      <div
                        key={cat.category}
                        className="group cursor-pointer rounded-lg px-3 py-2 transition-all duration-200"
                        style={{
                          backgroundColor: isHovered
                            ? `${CATEGORY_SVG_COLORS[cat.category]}15`
                            : 'transparent',
                          opacity: isOtherHovered ? 0.5 : 1,
                        }}
                        onMouseEnter={() => setHoveredCategory(cat.category)}
                        onMouseLeave={() => setHoveredCategory(null)}
                        role="listitem"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span
                              className="h-3 w-3 shrink-0 rounded-full transition-transform duration-200"
                              style={{
                                backgroundColor:
                                  CATEGORY_SVG_COLORS[cat.category],
                                transform: isHovered
                                  ? 'scale(1.2)'
                                  : 'scale(1)',
                              }}
                            />
                            <span className="text-sm font-medium">
                              {CATEGORIES[cat.category].label}
                            </span>
                          </div>
                          <span className="text-muted-foreground text-xs font-medium">
                            {formatDuration(cat.stats.activeMs)}
                          </span>
                        </div>
                        {/* Mini progress bar */}
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/5">
                          <div
                            className="h-full rounded-full transition-all duration-300"
                            style={{
                              width: `${cat.percentage}%`,
                              backgroundColor:
                                CATEGORY_SVG_COLORS[cat.category],
                              opacity: isHovered ? 1 : 0.7,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          <section className="card">
            <h2 className="text-sm font-semibold">
              {period === 'today' ? "Today's Activity" : 'Hourly Patterns'}
            </h2>
            <p className="text-muted-foreground mt-1 text-xs">
              {period === 'today'
                ? 'Your hourly activity breakdown for today'
                : "When you're most active during the week"}
            </p>
            {hourlyData &&
              (period === 'today' ? (
                <TodayHourlyChart data={hourlyData} />
              ) : (
                <Heatmap data={hourlyData} />
              ))}
          </section>

          {period !== 'today' && (
            <section className="card">
              <h2 className="text-sm font-semibold">Daily Activity</h2>
              <p className="text-muted-foreground mt-1 text-xs">
                Active time per day
              </p>
              {data && data.byDate.length > 0 ? (
                <div className="mt-4 space-y-1.5">
                  {data.byDate.map((day) => {
                    const pct =
                      maxDayMs > 0 ? (day.stats.activeMs / maxDayMs) * 100 : 0;
                    const isToday = day.date === todayKey;
                    const hasActivity = day.stats.activeMs > 0;
                    return (
                      <div
                        key={day.date}
                        className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs transition-colors"
                        style={
                          isToday
                            ? {
                                backgroundColor:
                                  'color-mix(in oklch, var(--primary) 6%, transparent)',
                              }
                            : undefined
                        }
                      >
                        <span
                          className={`w-16 shrink-0 ${isToday ? 'text-primary font-semibold' : 'text-muted-foreground'}`}
                        >
                          {day.label}
                        </span>
                        <div
                          className="h-2 flex-1 overflow-hidden rounded-full"
                          style={{
                            backgroundColor:
                              'color-mix(in oklch, var(--muted) 60%, transparent)',
                          }}
                        >
                          {hasActivity && (
                            <div
                              className={`bg-primary h-full rounded-full transition-all duration-300 ${isToday ? '' : 'opacity-70'}`}
                              style={{ width: `${Math.max(pct, 2)}%` }}
                            />
                          )}
                        </div>
                        <span
                          className={`w-14 shrink-0 text-right tabular-nums ${isToday ? 'text-primary font-semibold' : hasActivity ? 'font-medium' : 'text-muted-foreground'}`}
                        >
                          {formatDuration(day.stats.activeMs)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState period={period} />
              )}
            </section>
          )}

          <section className="card">
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-sm font-semibold">Top Sites</h2>
              <Select
                value={sortBy}
                onValueChange={(val) => setSortBy(val as SortMetric)}
              >
                <SelectTrigger className="h-7 w-[150px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {SORT_OPTIONS.map((opt) => (
                    <SelectItem
                      key={opt.value}
                      value={opt.value}
                      className="text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <opt.icon className="h-3.5 w-3.5 opacity-70" />
                        <span>{opt.label}</span>
                      </div>
                    </SelectItem>
                  ))}
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
                    </button>
                  );
                })}
              </div>
            )}

            {paginatedSites.length > 0 ? (
              <div className="mt-4 space-y-1">
                {paginatedSites.map((site, index) => {
                  const pct = getSiteProgress(site);
                  const category = getCategoryForHost(
                    site.host,
                    settings.siteCategories
                  );
                  const isExpanded = expandedSite === site.key;
                  return (
                    <div
                      key={site.key}
                      className="hover:bg-muted/50 -mx-1 cursor-pointer rounded-md px-1 py-1.5 transition-colors"
                      onClick={() =>
                        setExpandedSite(isExpanded ? null : site.key)
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setExpandedSite(isExpanded ? null : site.key);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="text-muted-foreground w-5 shrink-0 text-xs leading-snug">
                            {sitesPage * SITES_PER_PAGE + index + 1}.
                          </span>
                          <Favicon host={site.host} size={16} />
                          <span className="truncate font-medium leading-snug">
                            {site.host}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-muted-foreground text-xs">
                            {formatSortValue(site)}
                          </span>
                          <ChevronDown
                            className={`text-muted-foreground h-3.5 w-3.5 transition-transform duration-200 ${
                              isExpanded ? 'rotate-180' : ''
                            }`}
                          />
                        </div>
                      </div>
                      <div className="ml-7 mt-1">
                        <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                          <div
                            className="h-full rounded-full transition-all duration-300"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: CATEGORY_SVG_COLORS[category],
                            }}
                          />
                        </div>
                      </div>
                      <div
                        className={`overflow-hidden transition-all duration-200 ${
                          isExpanded
                            ? 'mt-2 max-h-40 opacity-100'
                            : 'max-h-0 opacity-0'
                        }`}
                      >
                        <div className="ml-7 grid grid-cols-3 gap-x-4 gap-y-2 pb-1">
                          <div>
                            <p className="text-muted-foreground text-[10px]">
                              Active Time
                            </p>
                            <p className="text-xs font-medium">
                              {formatDuration(site.stats.activeMs)}
                            </p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-[10px]">
                              Visits
                            </p>
                            <p className="text-xs font-medium">
                              {site.stats.visits}
                            </p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-[10px]">
                              Clicks
                            </p>
                            <p className="text-xs font-medium">
                              {site.stats.clicks}
                            </p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-[10px]">
                              Scroll Intensity
                            </p>
                            <p className="text-xs font-medium">
                              {formatScrollIntensity(
                                getScrollIntensity(
                                  site.stats.scrollDistance,
                                  site.stats.activeMs
                                )
                              )}
                            </p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-[10px]">
                              Tab Switches
                            </p>
                            <p className="text-xs font-medium">
                              {site.stats.tabSwitches}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState period={period} />
            )}

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-center gap-3">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground p-1 transition-colors disabled:opacity-30"
                  disabled={sitesPage === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSitesPage((p) => p - 1);
                  }}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {sitesPage + 1} of {totalPages}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground p-1 transition-colors disabled:opacity-30"
                  disabled={sitesPage >= totalPages - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSitesPage((p) => p + 1);
                  }}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
