import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULTS, sanitize, type Settings } from "@/lib/settings";

type Patch = Partial<Settings>;
type Changes = Record<string, { newValue?: unknown }>;

export interface SettingsApi {
  settings: Settings;
  loaded: boolean;
  currentSite: string | null;
  nativeDark: boolean;
  status: string;
  statusIsError: boolean;
  save: (patch: Patch, opts?: { defer?: boolean }) => void;
  setStatus: (message: string, isError?: boolean) => void;
}

export function useSettings(): SettingsApi {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [currentSite, setCurrentSite] = useState<string | null>(null);
  const [nativeDark, setNativeDark] = useState(false);
  const [status, setStatusText] = useState("");
  const [statusIsError, setStatusIsError] = useState(false);
  const tabId = useRef<number | null>(null);

  // Refs, not state: these are read inside callbacks that must see the latest
  // value without re-subscribing.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const queued = useRef<Patch>({});
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRef = useRef(false);
  const pending = useRef<Changes | null>(null);

  const setStatus = useCallback((message: string, isError = false) => {
    setStatusText(message);
    setStatusIsError(isError);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    if (message) statusTimer.current = setTimeout(() => setStatusText(""), 4000);
  }, []);

  // chrome.storage.sync allows 120 writes/minute and 1800/hour. A slider drag
  // emits an event per step, so those writes are coalesced - otherwise the quota
  // is exceeded and the rejected writes are lost. Nothing writes outside here.
  const flush = useCallback(() => {
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = null;
    const patch = queued.current;
    queued.current = {};
    if (!Object.keys(patch).length) return;
    chrome.storage.sync.set(patch, () => {
      if (!chrome.runtime.lastError) return;
      // The write was rejected, so the UI is now showing something that is not
      // stored. Re-read the truth rather than leave a lie on screen.
      setStatus("Could not save - retrying from stored settings", true);
      chrome.storage.sync.get(DEFAULTS, (stored) => setSettings(sanitize(stored)));
    });
  }, [setStatus]);

  // Only a slider drag needs coalescing. A deliberate one-off action - the
  // master switch, the engine, a per-site exclusion - is written straight
  // through, so it cannot be lost if the popup closes milliseconds later.
  const save = useCallback(
    (patch: Patch, opts: { defer?: boolean } = {}) => {
      setSettings((prev) => sanitize({ ...prev, ...patch }));
      queued.current = { ...queued.current, ...patch };
      if (writeTimer.current) clearTimeout(writeTimer.current);
      if (opts.defer) writeTimer.current = setTimeout(flush, 200);
      else flush();
    },
    [flush]
  );

  // The content script's top-frame instance knows whether the page measured as
  // already dark. No script there (a chrome:// page, a fresh install before
  // adoption) leaves lastError set and the flag simply stays false.
  // onSettled fires once the answer is in (or is never coming), so the caller
  // can gate the first paint on it - see the initial load below.
  const queryNativeDark = useCallback((onSettled?: () => void) => {
    if (tabId.current === null || !chrome.tabs?.sendMessage) {
      onSettled?.();
      return;
    }
    chrome.tabs.sendMessage(tabId.current, { type: "dark-night:status" }, (resp) => {
      if (!chrome.runtime.lastError && resp) setNativeDark(!!resp.nativeDark);
      onSettled?.();
    });
  }, []);

  // The content script re-measures whenever one of these changes - they are the
  // exact set its storage.onChanged handler reacts to - so the popup has to
  // re-ask or it keeps rendering a verdict taken under the previous policy.
  // Re-enabling a site that turns out to be natively dark was the visible case:
  // the page correctly stepped aside while the popup showed no banner at all
  // and no way to reach the override. Delayed a tick so the measurement lands
  // before the question.
  const policy = [
    settings.enabled,
    settings.autoSkipNativeDark,
    settings.disabledSites.join(" "),
    settings.forcedSites.join(" ")
  ].join("|");
  const policySeen = useRef<string | null>(null);
  useEffect(() => {
    if (policySeen.current === null) {
      policySeen.current = policy;
      return;
    }
    if (policySeen.current === policy) return;
    policySeen.current = policy;
    const t = setTimeout(queryNativeDark, 150);
    return () => clearTimeout(t);
  }, [policy, queryNativeDark]);

  const applyChanges = useCallback((changes: Changes) => {
    setSettings((prev) => {
      const merged: Record<string, unknown> = { ...prev };
      for (const [key, { newValue }] of Object.entries(changes)) {
        // A key still queued locally is mid-write; the echo of our own value is
        // authoritative but a stale remote one would clobber the user's input.
        if (key in queued.current) continue;
        merged[key] = newValue !== undefined ? newValue : (DEFAULTS as never)[key];
      }
      return sanitize(merged);
    });
  }, []);

  useEffect(() => {
    // A keyboard toggle, another window, or another device can change settings
    // while the popup is open; without this the popup shows - and then writes
    // back - a stale snapshot.
    const onChanged = (changes: Changes, area: string) => {
      if (area !== "sync") return;
      // A change can land between the initial read being issued and its
      // callback. Dropping it would leave the popup showing a snapshot that was
      // already stale on arrival.
      if (!loadedRef.current) {
        pending.current = { ...(pending.current ?? {}), ...changes };
        return;
      }
      applyChanges(changes);
    };
    chrome.storage.onChanged.addListener(onChanged);

    chrome.storage.sync.get(DEFAULTS, (stored) => {
      setSettings(sanitize(stored));
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        let themable = false;
        try {
          const url = new URL(tab.url as string);
          if (url.protocol === "http:" || url.protocol === "https:") {
            themable = true;
            setCurrentSite(url.hostname);
            tabId.current = tab.id ?? null;
          }
        } catch {
          /* chrome:// pages, or site access withheld so tab.url is unreadable */
        }

        const finishLoad = () => {
          loadedRef.current = true;
          setLoaded(true);
          // Replay anything that landed while the read was in flight.
          if (pending.current) {
            const replay = pending.current;
            pending.current = null;
            applyChanges(replay);
          }
        };

        if (!themable) {
          finishLoad();
          return;
        }
        // The native-dark answer has to be known before the first paint, not
        // after: arriving once the popup is already on screen adds the banner
        // below it, and every layout-tracked control further down visibly
        // slides to follow. A content script that never answers must not
        // block the popup forever, so it gets one chance before opening anyway.
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          finishLoad();
        };
        queryNativeDark(settle);
        setTimeout(settle, 200);
      });
    });

    // The popup is torn down the moment it loses focus - commit anything pending.
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    return () => {
      chrome.storage.onChanged.removeListener(onChanged);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flush);
    };
  }, [applyChanges, flush, queryNativeDark]);

  return { settings, loaded, currentSite, nativeDark, status, statusIsError, save, setStatus };
}
