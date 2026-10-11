/// <reference types="node" />
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { STORAGE_KEY } from './constants';
import { getLocalDateKey, getLocalHourKey } from './date';
import type { Message, StatsResponse } from './messaging';
import type { PageStats, Store } from './storage';

type Listener = (
  message: Message,
  sender: unknown,
  sendResponse: (response: StatsResponse) => void
) => boolean;

const size = (value: unknown) => JSON.stringify(value ?? null).length;

/** In-memory chrome.storage.local that counts what crosses the API. */
function installFakeChrome() {
  const data = new Map<string, unknown>();
  const changeListeners: Array<(changes: object, area: string) => void> = [];
  const messageListeners: Listener[] = [];
  const io = { written: 0, dispatched: 0, failRemove: false };

  const dispatch = (changes: Record<string, object>) => {
    if (Object.keys(changes).length === 0) return;
    io.dispatched += size(changes);
    for (const listener of changeListeners) listener(changes, 'local');
  };

  const local = {
    async get(keys: null | string | string[]) {
      const wanted =
        keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of wanted) {
        if (data.has(key)) result[key] = structuredClone(data.get(key));
      }
      return result;
    },
    async set(items: Record<string, unknown>) {
      io.written += size(items);
      const changes: Record<string, object> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data.get(key), newValue: value };
        data.set(key, structuredClone(value));
      }
      dispatch(changes);
    },
    async remove(keys: string | string[]) {
      if (io.failRemove) throw new Error('interrupted');
      const changes: Record<string, object> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (!data.has(key)) continue;
        changes[key] = { oldValue: data.get(key) };
        data.delete(key);
      }
      dispatch(changes);
    },
  };

  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local,
      onChanged: {
        addListener: (l: (changes: object, area: string) => void) =>
          changeListeners.push(l),
      },
    },
    runtime: {
      onMessage: { addListener: (l: Listener) => messageListeners.push(l) },
      onInstalled: { addListener: () => {} },
    },
  };

  return { data, io, messageListeners };
}

function legacyStore(pageCount: number): Store {
  const totals = {
    visits: 3,
    sessions: 1,
    activeMs: 123456,
    clicks: 12,
    scrollDistance: 4.5,
    tabSwitches: 2,
  };
  const pages: Record<string, PageStats> = {};
  for (let i = 0; i < pageCount; i++) {
    const key = `site${i % 200}.example.com/some/path/${i}`;
    pages[key] = {
      key,
      url: `https://${key}`,
      host: `site${i % 200}.example.com`,
      path: `/some/path/${i}`,
      firstSeenAt: 1,
      lastSeenAt: 2,
      totals: { ...totals },
      byDate: { '2020-01-01': { ...totals } },
      byHour: {
        '2020-01-01T09': { ...totals },
        '2020-01-01T10': { ...totals },
      },
    };
  }
  return { version: 2, pages };
}

let fake: ReturnType<typeof installFakeChrome>;
let bootId = 0;

/** Starts a fresh background service worker and returns its flush entry point. */
async function bootBackground() {
  const before = fake.messageListeners.length;
  const mod = await import(`../entrypoints/background.ts?boot=${bootId++}`);
  mod.default.main();
  const listener = fake.messageListeners[before];
  return (key: string, delta: object) =>
    new Promise<StatsResponse>((resolve) => {
      listener(
        {
          type: 'UPDATE_STATS',
          payload: {
            key,
            url: `https://${key}`,
            host: key.split('/')[0],
            dateKey: TODAY,
            hourKey: HOUR,
            delta,
          },
        },
        {},
        resolve
      );
    });
}

const PAGES = 1900;
const TODAY = getLocalDateKey();
const HOUR = getLocalHourKey();
const KEY = 'site7.example.com/some/path/7';

beforeEach(() => {
  fake = installFakeChrome();
});

test('a flush costs O(one page), not O(store)', async () => {
  const legacy = legacyStore(PAGES);
  fake.data.set(STORAGE_KEY, legacy);
  const flush = await bootBackground();
  assert.deepEqual(await flush(KEY, { activeMs: 5000 }), { success: true });

  fake.io.written = 0;
  fake.io.dispatched = 0;
  assert.deepEqual(await flush(KEY, { activeMs: 5000 }), { success: true });

  console.log(
    `store ${size(legacy)} B / ${PAGES} pages: flush wrote ${fake.io.written} B, onChanged carried ${fake.io.dispatched} B`
  );
  assert.ok(fake.io.written < 4096, `flush wrote ${fake.io.written} B`);
  assert.ok(
    fake.io.dispatched < 8192,
    `onChanged carried ${fake.io.dispatched} B`
  );
});

test('migrating the legacy store loses nothing', async () => {
  const legacy = legacyStore(PAGES);
  fake.data.set(STORAGE_KEY, legacy);
  const flush = await bootBackground();
  await flush(KEY, { activeMs: 5000, clicks: 1 });

  const { getStore } = await import('./storage');
  const store = await getStore();
  assert.equal(Object.keys(store.pages).length, PAGES);
  for (const [key, page] of Object.entries(legacy.pages)) {
    if (key !== KEY) assert.deepEqual(store.pages[key], page);
  }
  assert.equal(store.pages[KEY].totals.activeMs, 123456 + 5000);
  assert.equal(store.pages[KEY].totals.clicks, 13);
  assert.equal(store.pages[KEY].byDate[TODAY].activeMs, 5000);
  assert.deepEqual(
    store.pages[KEY].byDate['2020-01-01'],
    legacy.pages[KEY].byDate['2020-01-01']
  );
  assert.equal(fake.data.has(STORAGE_KEY), false);
});

test('an interrupted migration is retried without losing data', async () => {
  const legacy = legacyStore(50);
  fake.data.set(STORAGE_KEY, legacy);
  const { getStore } = await import('./storage');

  fake.io.failRemove = true;
  let flush = await bootBackground();
  const failed = await flush(KEY, { activeMs: 5000 });
  assert.equal(failed.success, false);
  assert.deepEqual((await getStore()).pages, legacy.pages);

  fake.io.failRemove = false;
  flush = await bootBackground();
  assert.deepEqual(await flush(KEY, { activeMs: 5000 }), { success: true });
  const store = await getStore();
  assert.equal(Object.keys(store.pages).length, 50);
  assert.equal(store.pages[KEY].totals.activeMs, 123456 + 5000);
  assert.equal(fake.data.has(STORAGE_KEY), false);
});

test('a v1 store gains byHour on migration', async () => {
  const legacy = legacyStore(3);
  for (const page of Object.values(legacy.pages)) {
    delete (page as Partial<PageStats>).byHour;
  }
  fake.data.set(STORAGE_KEY, { ...legacy, version: 1 });
  const flush = await bootBackground();
  await flush(KEY, { activeMs: 1 });

  const { getStore } = await import('./storage');
  const store = await getStore();
  assert.deepEqual(store.pages['site0.example.com/some/path/0'].byHour, {});
  assert.equal(store.pages[KEY].byHour[HOUR].activeMs, 1);
});

test('sessions start on first visit and after a 30 minute gap', async () => {
  const flush = await bootBackground();
  const { getStore } = await import('./storage');
  const sessions = async () => (await getStore()).pages[KEY].totals.sessions;

  await flush(KEY, { visits: 1 });
  assert.equal(await sessions(), 1);
  await flush(KEY, { visits: 1 });
  assert.equal(await sessions(), 1);

  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 60 * 1000;
  try {
    await flush(KEY, { visits: 1 });
  } finally {
    Date.now = realNow;
  }
  assert.equal(await sessions(), 2);
});

test('clearing and pruning work on per-page keys', async () => {
  const flush = await bootBackground();
  const { clearStore, deleteOlderThan, getStore } = await import('./storage');
  fake.data.set(STORAGE_KEY, legacyStore(5));
  await flush(KEY, { activeMs: 5000 });

  assert.equal(await deleteOlderThan(30), 5);
  const pruned = await getStore();
  assert.deepEqual(Object.keys(pruned.pages), [KEY]);
  assert.equal(pruned.pages[KEY].totals.activeMs, 5000);

  fake.data.set('anicite:settings', { enabled: true });
  await clearStore();
  assert.deepEqual((await getStore()).pages, {});
  assert.deepEqual([...fake.data.keys()], ['anicite:settings']);
});

test('open pages follow per-page change events without reloading', async () => {
  const flush = await bootBackground();
  const { aggregateByHost, applyPageChanges, clearStore, getStore } =
    await import('./storage');
  await flush(KEY, { activeMs: 5000 });
  await flush('site7.example.com/other', { activeMs: 1000 });
  const { pages } = await getStore();

  let events = 0;
  chrome.storage.onChanged.addListener((changes) => {
    if (applyPageChanges(pages, changes)) events++;
  });

  await flush(KEY, { activeMs: 2000 });
  assert.equal(events, 1);
  assert.equal(pages[KEY].totals.activeMs, 7000);
  assert.equal(aggregateByHost(pages)[0].totals.activeMs, 8000);
  assert.equal(aggregateByHost(pages)[0].totals.activeMs, 8000);
  assert.deepEqual(pages, (await getStore()).pages);

  await clearStore();
  assert.deepEqual(pages, {});
});
