import type { ContentScriptDefinition } from 'wxt';
import { defineContentScript } from 'wxt/sandbox';

import { SETTINGS_KEY } from '../lib/constants';
import { getLocalDateKey, getLocalHourKey } from '../lib/date';
import type { PingMessage, PingResponse } from '../lib/messaging';
import { sendUpdateStats } from '../lib/messaging';
import { isHostExcluded } from '../lib/settings';
import { getSettings } from '../lib/storage';
import { getUrlParts } from '../lib/url';

const FLUSH_INTERVAL_MS = 5000;

function isContextValid(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}

const contentScript: ContentScriptDefinition = defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  async main() {
    if (!isContextValid()) return;

    let settings;
    try {
      settings = await getSettings();
    } catch {
      return;
    }

    const hasConsent = settings.onboarding.consentConfirmed;
    if (!hasConsent) return;

    let enabled = settings.enabled;
    let excludeHosts = settings.excludeHosts;
    let trackingMode = settings.trackingMode;
    const dataGranularity = settings.dataGranularity;

    let urlParts = getUrlParts(window.location.href, dataGranularity);

    if (!enabled || isHostExcluded(urlParts.host, excludeHosts)) return;

    let stopped = false;
    let intervalId: number | undefined;
    let flushInProgress = false;
    let navigationInProgress = false;

    let activeMs = 0;
    let windowFocused = document.hasFocus();
    const shouldTrackNow =
      document.visibilityState === 'visible' &&
      (trackingMode === 'visible' || windowFocused);
    let lastActiveAt = shouldTrackNow ? Date.now() : null;
    let clicks = 0;
    let scrollDistance = 0;
    let lastScrollY = window.scrollY;
    let tabSwitches = 0;

    let lastFlushedActiveMs = 0;
    let lastFlushedClicks = 0;
    let lastFlushedTabSwitches = 0;
    let lastFlushedScrollDistance = 0;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };

    const updateScrollDistance = () => {
      const currentScrollY = window.scrollY;
      const delta = Math.abs(currentScrollY - lastScrollY);
      if (delta > 0 && window.innerHeight > 0) {
        scrollDistance += delta / window.innerHeight;
      }
      lastScrollY = currentScrollY;
    };

    const flush = async (isUnload = false) => {
      if (stopped || !isContextValid()) {
        stop();
        return;
      }

      if (flushInProgress && !isUnload) return;
      flushInProgress = true;

      // Fallback URL change detection for browsers without Navigation API
      if (!navigationInProgress && !isUnload) {
        const currentUrlParts = getUrlParts(
          window.location.href,
          dataGranularity
        );
        if (currentUrlParts.key !== urlParts.key) {
          flushInProgress = false;
          void handleUrlChange();
          return;
        }
      }

      if (!enabled || isHostExcluded(urlParts.host, excludeHosts)) {
        flushInProgress = false;
        return;
      }

      const now = Date.now();

      const shouldBeTracking =
        document.visibilityState === 'visible' &&
        (trackingMode === 'visible' || windowFocused);
      if (shouldBeTracking && !lastActiveAt) {
        lastActiveAt = now;
      }

      const totalActiveMs = lastActiveAt
        ? activeMs + (now - lastActiveAt)
        : activeMs;
      const deltaActiveMs = Math.max(0, totalActiveMs - lastFlushedActiveMs);
      const deltaClicks = Math.max(0, clicks - lastFlushedClicks);
      const deltaTabSwitches = Math.max(
        0,
        tabSwitches - lastFlushedTabSwitches
      );
      const deltaScrollDistance = Math.max(
        0,
        scrollDistance - lastFlushedScrollDistance
      );

      if (
        deltaActiveMs === 0 &&
        deltaClicks === 0 &&
        deltaTabSwitches === 0 &&
        deltaScrollDistance === 0
      ) {
        flushInProgress = false;
        return;
      }

      const prevFlushedActiveMs = lastFlushedActiveMs;
      const prevFlushedClicks = lastFlushedClicks;
      const prevFlushedTabSwitches = lastFlushedTabSwitches;
      const prevFlushedScrollDistance = lastFlushedScrollDistance;

      lastFlushedActiveMs = totalActiveMs;
      lastFlushedClicks = clicks;
      lastFlushedTabSwitches = tabSwitches;
      lastFlushedScrollDistance = scrollDistance;

      try {
        const response = await sendUpdateStats({
          key: urlParts.key,
          url: urlParts.url,
          host: urlParts.host,
          path: urlParts.path,
          dateKey: getLocalDateKey(),
          hourKey: getLocalHourKey(),
          delta: {
            activeMs: deltaActiveMs,
            clicks: deltaClicks,
            scrollDistance: deltaScrollDistance,
            tabSwitches: deltaTabSwitches,
          },
        });

        if (!response.success) {
          lastFlushedActiveMs = prevFlushedActiveMs;
          lastFlushedClicks = prevFlushedClicks;
          lastFlushedTabSwitches = prevFlushedTabSwitches;
          lastFlushedScrollDistance = prevFlushedScrollDistance;

          if (
            response.error?.includes('Extension context invalidated') ||
            response.error?.includes('Receiving end does not exist')
          ) {
            stop();
          }
        }
      } catch {
        lastFlushedActiveMs = prevFlushedActiveMs;
        lastFlushedClicks = prevFlushedClicks;
        lastFlushedTabSwitches = prevFlushedTabSwitches;
        lastFlushedScrollDistance = prevFlushedScrollDistance;
        stop();
      } finally {
        flushInProgress = false;
      }
    };

    const handleVisibilityChange = () => {
      if (stopped) return;
      const now = Date.now();

      if (document.visibilityState === 'hidden') {
        if (lastActiveAt) {
          activeMs += now - lastActiveAt;
          lastActiveAt = null;
        }
        tabSwitches += 1;
        void flush();
      } else {
        const shouldTrack = trackingMode === 'visible' || windowFocused;
        if (!lastActiveAt && shouldTrack) {
          lastActiveAt = now;
        }
      }
    };

    const handleFocus = () => {
      windowFocused = true;
      if (stopped || trackingMode !== 'focused') return;
      if (!lastActiveAt && document.visibilityState === 'visible') {
        lastActiveAt = Date.now();
      }
    };

    const handleBlur = () => {
      windowFocused = false;
      if (stopped || trackingMode !== 'focused') return;
      if (lastActiveAt) {
        activeMs += Date.now() - lastActiveAt;
        lastActiveAt = null;
      }
    };

    const resetMetrics = () => {
      if (lastActiveAt) {
        lastActiveAt = null;
      }
      activeMs = 0;
      clicks = 0;
      scrollDistance = 0;
      tabSwitches = 0;
      lastFlushedActiveMs = 0;
      lastFlushedClicks = 0;
      lastFlushedScrollDistance = 0;
      lastFlushedTabSwitches = 0;
    };

    const handleUrlChange = async () => {
      if (stopped || navigationInProgress) return;

      const newUrlParts = getUrlParts(window.location.href, dataGranularity);

      if (newUrlParts.key === urlParts.key) return;

      navigationInProgress = true;

      try {
        if (lastActiveAt) {
          activeMs += Date.now() - lastActiveAt;
          lastActiveAt = null;
        }
        await flush();

        urlParts = newUrlParts;
        resetMetrics();

        if (!enabled || isHostExcluded(newUrlParts.host, excludeHosts)) {
          return;
        }

        if (
          document.visibilityState === 'visible' &&
          (trackingMode === 'visible' || windowFocused)
        ) {
          lastActiveAt = Date.now();
        }

        try {
          await sendUpdateStats({
            key: newUrlParts.key,
            url: newUrlParts.url,
            host: newUrlParts.host,
            path: newUrlParts.path,
            dateKey: getLocalDateKey(),
            hourKey: getLocalHourKey(),
            delta: {
              visits: 1,
            },
          });
        } catch {
          // Failed to record visit for new URL
        }
      } finally {
        navigationInProgress = false;
      }
    };

    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (stopped || areaName !== 'local') return;
      const next = changes[SETTINGS_KEY]?.newValue;
      if (!next) return;

      const newEnabled = Boolean(next.enabled);
      const newExcludeHosts = next.excludeHosts ?? [];
      const wasExcluded =
        !enabled || isHostExcluded(urlParts.host, excludeHosts);
      const isNowExcluded =
        !newEnabled || isHostExcluded(urlParts.host, newExcludeHosts);

      if (isNowExcluded && !wasExcluded) {
        resetMetrics();
      } else if (!isNowExcluded && wasExcluded) {
        resetMetrics();
        if (
          document.visibilityState === 'visible' &&
          (next.trackingMode === 'visible' || windowFocused)
        ) {
          lastActiveAt = Date.now();
        }
      }

      enabled = newEnabled;
      excludeHosts = newExcludeHosts;
      trackingMode = next.trackingMode ?? 'focused';
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);

    window.addEventListener('pagehide', () => {
      if (lastActiveAt) {
        activeMs += Date.now() - lastActiveAt;
        lastActiveAt = null;
      }
      void flush(true);
    });

    document.addEventListener('click', () => {
      if (!stopped) clicks += 1;
    });

    window.addEventListener('scroll', updateScrollDistance, { passive: true });

    // SPA navigation detection via Navigation API (Chrome 102+)
    // Use 'currententrychange' which fires for all same-document navigations
    // including pushState/replaceState (unlike 'navigatesuccess' which only
    // fires for full navigations)
    const nav = (globalThis as { navigation?: EventTarget }).navigation;
    if (nav && typeof nav.addEventListener === 'function') {
      nav.addEventListener('currententrychange', () => {
        void handleUrlChange();
      });
    }

    // Fallback: popstate for back/forward navigation
    window.addEventListener('popstate', () => {
      void handleUrlChange();
    });

    intervalId = window.setInterval(() => {
      void flush();
    }, FLUSH_INTERVAL_MS);

    try {
      chrome.storage.onChanged.addListener(handleStorageChange);
    } catch {
      stop();
      return;
    }

    const handlePing = (
      message: PingMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: PingResponse) => void
    ) => {
      if (message.type === 'PING') {
        sendResponse({ active: !stopped });
        return true;
      }
      return false;
    };

    try {
      chrome.runtime.onMessage.addListener(handlePing);
    } catch {
      stop();
      return;
    }

    try {
      const response = await sendUpdateStats({
        key: urlParts.key,
        url: urlParts.url,
        host: urlParts.host,
        path: urlParts.path,
        dateKey: getLocalDateKey(),
        hourKey: getLocalHourKey(),
        delta: {
          visits: 1,
        },
      });

      if (!response.success) {
        stop();
        return;
      }
    } catch {
      stop();
      return;
    }

    updateScrollDistance();

    window.addEventListener('beforeunload', () => {
      if (lastActiveAt) {
        activeMs += Date.now() - lastActiveAt;
        lastActiveAt = null;
      }
      void flush(true);
      stop();
    });
  },
});

export default contentScript;
