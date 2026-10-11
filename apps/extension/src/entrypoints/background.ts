import type { BackgroundDefinition } from 'wxt';
import { defineBackground } from 'wxt/sandbox';

import { SETTINGS_KEY } from '../lib/constants';
import type { Message, StatsResponse } from '../lib/messaging';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { PageStats, StatsDelta } from '../lib/storage';
import {
  migrateLegacyStore,
  pageStorageKey,
  setSettings,
} from '../lib/storage';

const SESSION_GAP_MS = 30 * 60 * 1000;

function emptyTotals() {
  return {
    visits: 0,
    sessions: 0,
    activeMs: 0,
    clicks: 0,
    scrollDistance: 0,
    tabSwitches: 0,
  };
}

class StatsWriteQueue {
  private queue: Array<{
    payload: {
      key: string;
      url: string;
      host: string;
      path?: string;
      dateKey: string;
      hourKey: string;
      delta: StatsDelta;
    };
    resolve: (response: StatsResponse) => void;
  }> = [];
  private processing = false;
  private migrated = false;

  enqueue(
    payload: {
      key: string;
      url: string;
      host: string;
      path?: string;
      dateKey: string;
      hourKey: string;
      delta: StatsDelta;
    },
    resolve: (response: StatsResponse) => void
  ): void {
    this.queue.push({ payload, resolve });
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length);

      try {
        if (!this.migrated) {
          await migrateLegacyStore();
          this.migrated = true;
        }

        const pages: Record<string, PageStats> = await chrome.storage.local.get(
          batch.map(({ payload }) => pageStorageKey(payload.key))
        );

        const now = Date.now();

        for (const { payload } of batch) {
          const { key, url, host, path, dateKey, hourKey, delta } = payload;

          const storageKey = pageStorageKey(key);
          const existing = pages[storageKey];
          const page: PageStats = existing ?? {
            key,
            url,
            host,
            path,
            firstSeenAt: now,
            lastSeenAt: now,
            totals: emptyTotals(),
            byDate: {},
            byHour: {},
          };

          if (!page.byHour) {
            page.byHour = {};
          }

          const day = page.byDate[dateKey] ?? emptyTotals();
          const hour = page.byHour[hourKey] ?? emptyTotals();

          const visits = delta.visits ?? 0;
          const isNewSession =
            !existing || now - existing.lastSeenAt > SESSION_GAP_MS;
          const sessions = visits > 0 && isNewSession ? 1 : 0;
          const activeMs = delta.activeMs ?? 0;
          const clicks = delta.clicks ?? 0;
          const tabSwitches = delta.tabSwitches ?? 0;

          page.totals.visits += visits;
          page.totals.sessions += sessions;
          page.totals.activeMs += activeMs;
          page.totals.clicks += clicks;
          page.totals.tabSwitches += tabSwitches;

          day.visits += visits;
          day.sessions += sessions;
          day.activeMs += activeMs;
          day.clicks += clicks;
          day.tabSwitches += tabSwitches;

          hour.visits += visits;
          hour.sessions += sessions;
          hour.activeMs += activeMs;
          hour.clicks += clicks;
          hour.tabSwitches += tabSwitches;

          if (typeof delta.scrollDistance === 'number') {
            page.totals.scrollDistance += delta.scrollDistance;
            day.scrollDistance += delta.scrollDistance;
            hour.scrollDistance += delta.scrollDistance;
          }

          page.lastSeenAt = now;
          page.byDate[dateKey] = day;
          page.byHour[hourKey] = hour;
          pages[storageKey] = page;
        }

        await chrome.storage.local.set(pages);

        for (const { resolve } of batch) {
          resolve({ success: true });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        for (const { resolve } of batch) {
          resolve({ success: false, error: errorMsg });
        }
      }
    }

    this.processing = false;
  }
}

const writeQueue = new StatsWriteQueue();

function handleMessage(
  message: Message,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: StatsResponse) => void
): boolean {
  if (message.type === 'UPDATE_STATS') {
    writeQueue.enqueue(message.payload, sendResponse);
    return true;
  }

  return false;
}

const background: BackgroundDefinition = defineBackground(() => {
  chrome.runtime.onMessage.addListener(handleMessage);

  chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason !== 'install') {
      return;
    }

    const existing = await chrome.storage.local.get(SETTINGS_KEY);
    if (!existing[SETTINGS_KEY]) {
      await setSettings(DEFAULT_SETTINGS);
    }

    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  });
});

export default background;
