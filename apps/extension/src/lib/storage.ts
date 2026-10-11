import {
  PAGE_KEY_PREFIX,
  SETTINGS_KEY,
  STORAGE_KEY,
  STORE_VERSION,
} from './constants';
import { getLocalDateKey } from './date';
import { DEFAULT_SETTINGS, type Settings } from './settings';

export type StatsTotals = {
  visits: number;
  sessions: number;
  activeMs: number;
  clicks: number;
  scrollDistance: number;
  tabSwitches: number;
};

export type PageStats = {
  key: string;
  url: string;
  host: string;
  path?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  totals: StatsTotals;
  byDate: Record<string, StatsTotals>;
  byHour: Record<string, StatsTotals>;
};

export type Store = {
  version: number;
  pages: Record<string, PageStats>;
};

function emptyTotals(): StatsTotals {
  return {
    visits: 0,
    sessions: 0,
    activeMs: 0,
    clicks: 0,
    scrollDistance: 0,
    tabSwitches: 0,
  };
}

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<Settings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    onboarding: {
      ...DEFAULT_SETTINGS.onboarding,
      ...(stored?.onboarding ?? {}),
    },
    siteCategories: {
      ...DEFAULT_SETTINGS.siteCategories,
      ...(stored?.siteCategories ?? {}),
    },
  };
}

export async function setSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function updateSettings(
  partial: Partial<Settings>
): Promise<Settings> {
  const current = await getSettings();
  const next = {
    ...current,
    ...partial,
    onboarding: {
      ...current.onboarding,
      ...(partial.onboarding ?? {}),
    },
    siteCategories:
      partial.siteCategories !== undefined
        ? partial.siteCategories
        : current.siteCategories,
  };
  await setSettings(next);
  return next;
}

type StorageChanges = { [key: string]: chrome.storage.StorageChange };

export function pageStorageKey(key: string): string {
  return PAGE_KEY_PREFIX + key;
}

function legacyPages(stored: unknown): Record<string, PageStats> | undefined {
  const legacy = stored as Store | undefined;
  if (!legacy?.pages) return undefined;
  if (legacy.version === STORE_VERSION) return legacy.pages;
  if (legacy.version !== 1) return undefined;

  const pages: Record<string, PageStats> = {};
  for (const [key, page] of Object.entries(legacy.pages)) {
    pages[key] = { ...page, byHour: {} };
  }
  return pages;
}

/**
 * Moves the legacy single-key store to one key per page. The legacy key is
 * removed only after every page is written, so an interrupted run is simply
 * repeated. Only the background may call this, and before it writes any page:
 * a re-run overwrites the page keys with the legacy values.
 */
export async function migrateLegacyStore(): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const pages = legacyPages(result[STORAGE_KEY]);
  if (!pages) return;

  const items: Record<string, PageStats> = {};
  for (const [key, page] of Object.entries(pages)) {
    items[pageStorageKey(key)] = page;
  }
  await chrome.storage.local.set(items);
  await chrome.storage.local.remove(STORAGE_KEY);
}

/** Reads every page. For the extension's own pages only: cost is O(store). */
export async function getStore(): Promise<Store> {
  const all = await chrome.storage.local.get(null);
  // Not migrated yet: page keys, where present, are at least as new.
  const pages = legacyPages(all[STORAGE_KEY]) ?? {};

  for (const [storageKey, value] of Object.entries(all)) {
    if (storageKey.startsWith(PAGE_KEY_PREFIX)) {
      pages[storageKey.slice(PAGE_KEY_PREFIX.length)] = value as PageStats;
    }
  }

  return { version: STORE_VERSION, pages };
}

/**
 * Applies the page keys of a storage.onChanged event to `pages` in place.
 * Returns whether any page changed.
 */
export function applyPageChanges(
  pages: Record<string, PageStats>,
  changes: StorageChanges
): boolean {
  let changed = false;
  for (const [storageKey, change] of Object.entries(changes)) {
    if (!storageKey.startsWith(PAGE_KEY_PREFIX)) continue;
    const key = storageKey.slice(PAGE_KEY_PREFIX.length);
    if (change.newValue) {
      pages[key] = change.newValue as PageStats;
    } else {
      delete pages[key];
    }
    changed = true;
  }
  return changed;
}

export type StatsDelta = {
  visits?: number;
  activeMs?: number;
  clicks?: number;
  scrollDistance?: number;
  tabSwitches?: number;
};

export async function clearStore(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove([
    STORAGE_KEY,
    ...Object.keys(all).filter((key) => key.startsWith(PAGE_KEY_PREFIX)),
  ]);
}

export type StorageUsage = {
  bytesInUse: number;
  /** With unlimitedStorage permission, there's no fixed quota. This is a soft reference limit for UI purposes. */
  quotaBytes: number | null;
  percentUsed: number | null;
};

/**
 * With the unlimitedStorage permission, chrome.storage.local has no fixed quota.
 * We set quotaBytes/percentUsed to null to indicate unlimited storage.
 * The UI can then display just the current usage without misleading quota warnings.
 */
export async function getStorageUsage(): Promise<StorageUsage> {
  const bytesInUse = await chrome.storage.local.getBytesInUse(null);

  return {
    bytesInUse,
    quotaBytes: null,
    percentUsed: null,
  };
}

/**
 * Aggregate pages by host to deduplicate entries with different paths.
 * Returns an array of PageStats aggregated by host, sorted by total active time (descending).
 */
export function aggregateByHost(pages: Record<string, PageStats>): PageStats[] {
  const hostMap = new Map<string, PageStats>();

  for (const page of Object.values(pages)) {
    const existing = hostMap.get(page.host);
    if (existing) {
      // Aggregate totals
      existing.totals.activeMs += page.totals.activeMs;
      existing.totals.visits += page.totals.visits;
      existing.totals.sessions += page.totals.sessions;
      existing.totals.clicks += page.totals.clicks;
      existing.totals.scrollDistance += page.totals.scrollDistance;
      existing.totals.tabSwitches += page.totals.tabSwitches;
      if (page.lastSeenAt > existing.lastSeenAt) {
        existing.lastSeenAt = page.lastSeenAt;
      }
    } else {
      hostMap.set(page.host, {
        ...page,
        key: page.host, // Use host as the key for deduplication
        totals: { ...page.totals },
      });
    }
  }

  return Array.from(hostMap.values()).sort(
    (a, b) => b.totals.activeMs - a.totals.activeMs
  );
}

/**
 * Deletes data older than the specified number of days.
 * Recalculates totals based on remaining data.
 * Returns the number of pages affected (pruned).
 */
export async function deleteOlderThan(days: number): Promise<number> {
  const store = await getStore();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffKey = getLocalDateKey(cutoffDate);

  let affectedCount = 0;
  const updated: Record<string, PageStats> = {};
  const removed: string[] = [];

  for (const [key, page] of Object.entries(store.pages)) {
    const newByDate: Record<string, StatsTotals> = {};
    const newByHour: Record<string, StatsTotals> = {};
    let pageChanged = false;

    // Filter byDate - Keep dates >= cutoffKey
    for (const [date, stats] of Object.entries(page.byDate)) {
      if (date >= cutoffKey) {
        newByDate[date] = stats;
      } else {
        pageChanged = true;
      }
    }

    // Filter byHour - Keep hours where date part >= cutoffKey
    for (const [hour, stats] of Object.entries(page.byHour)) {
      const datePart = hour.split('T')[0];
      if (datePart >= cutoffKey) {
        newByHour[hour] = stats;
      } else {
        pageChanged = true;
      }
    }

    if (pageChanged) {
      // If no data left, we could delete the page entirely if we wanted strict cleanup.
      // However, we might want to keep the record that we visited this site (metadata).
      // For now, let's keep the page entry but with reduced totals.
      // If NO data is left at all (empty byDate), we can decide:
      // Option A: Delete page key entirely.
      // Option B: Keep page with 0 stats.
      // Let's go with Option A for "Cleanup" - if no recent history, forget it.

      if (Object.keys(newByDate).length === 0) {
        affectedCount++;
        removed.push(pageStorageKey(key));
        continue;
      }

      affectedCount++;

      // Recalculate totals from scratch based on remaining data
      const newTotals = emptyTotals();
      for (const stats of Object.values(newByDate)) {
        newTotals.visits += stats.visits;
        newTotals.sessions += stats.sessions;
        newTotals.activeMs += stats.activeMs;
        newTotals.clicks += stats.clicks;
        newTotals.scrollDistance += stats.scrollDistance;
        newTotals.tabSwitches += stats.tabSwitches;
      }

      updated[pageStorageKey(key)] = {
        ...page,
        totals: newTotals,
        byDate: newByDate,
        byHour: newByHour,
        // We do strictly update lastSeenAt? probably not needed,
        // as lastSeenAt should reflect the true last visit.
        // If the last visit was > 30 days ago, and we delete it...
        // effectively the page is gone due to the check above (Object.keys(newByDate).length === 0).
        // So this block is for pages that have SOME data remaining.
      };
    }
  }

  await chrome.storage.local.set(updated);
  await chrome.storage.local.remove(removed);

  return affectedCount;
}
