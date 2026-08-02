// Dark Night - service worker
// Owns the keyboard shortcut, the toolbar badge, the pre-paint stylesheet
// registration, and injection into tabs that were already open.

const DEFAULTS = { enabled: true, disabledSites: [] };
const EARLY_ID = "dark-night-early";
const HOSTNAME = /^[a-z0-9.-]+$/i;
const PAGES = ["http://*/*", "https://*/*"];

const bare = (host) => String(host).replace(/^www\./, "");

// Mirrors siteDisabled() in content.js and matches() in the popup.
function hostExcluded(host, disabledSites) {
  const h = bare(host);
  return disabledSites.some((entry) => {
    const d = bare(entry);
    return h === d || h.endsWith("." + d);
  });
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch (e) {
    return null;
  }
}

// The badge answers "why does this page look the way it does": blank when the
// theme is on, "off" when the master switch is off, "site" when this specific
// site is excluded. Without the per-site state a successful "Disable for this
// site" looked identical to nothing having happened.
async function paintBadge(tab, state) {
  const host = tab && tab.url ? hostOf(tab.url) : null;
  let text = "";
  if (!state.enabled) text = "off";
  else if (host && hostExcluded(host, state.disabledSites)) text = "site";
  try {
    await chrome.action.setBadgeText({ tabId: tab.id, text });
  } catch (e) {
    /* the tab closed mid-flight */
  }
}

async function readState() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return {
    enabled: stored.enabled !== false,
    disabledSites: Array.isArray(stored.disabledSites) ? stored.disabledSites : []
  };
}

// Self-contained, like the other two steps reconcile() runs: a transient tabs
// failure must not take the pre-paint registration or tab adoption down with
// it, and it must not surface as a bare unhandled rejection either.
async function refreshBadges() {
  try {
    const state = await readState();
    // The global default covers tabs that never get an explicit update.
    chrome.action.setBadgeText({ text: state.enabled ? "" : "off" });
    chrome.action.setBadgeBackgroundColor({ color: "#5c6063" });
    const tabs = await chrome.tabs.query({ active: true });
    await Promise.all(tabs.map((tab) => paintBadge(tab, state)));
  } catch (e) {
    console.warn("Dark Night: badge not updated -", e.message);
  }
}

// Chrome applies registered content-script CSS before first paint, which
// chrome.storage cannot do - it is asynchronous. Keeping the registration in
// step with `enabled` and `disabledSites` is what prevents the white flash
// without darkening pages the user opted out of.
async function readAndSyncEarlyCss() {
  const { enabled, disabledSites } = await readState();
  let registered = [];
  try {
    registered = await chrome.scripting.getRegisteredContentScripts({ ids: [EARLY_ID] });
  } catch (e) {
    /* nothing registered yet */
  }

  if (!enabled) {
    if (registered.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [EARLY_ID] });
    }
    return;
  }

  const excludeMatches = disabledSites
    .map(bare)
    .filter((d) => HOSTNAME.test(d))
    .flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);

  const spec = {
    id: EARLY_ID,
    matches: PAGES,
    css: ["early.css"],
    runAt: "document_start",
    allFrames: true
  };
  if (excludeMatches.length) spec.excludeMatches = excludeMatches;

  const current = registered.length ? registered[0].excludeMatches || [] : [];

  // updateContentScripts() merges only the properties it is handed, so an empty
  // exclusion list cannot be expressed as an update: the previous
  // excludeMatches would survive and a site that had been re-enabled would keep
  // flashing white on every load, permanently. Re-registering is the only way to
  // clear them - but only when there is something to clear, or every worker
  // start would drop and re-add the sheet and a page loading in that window
  // would flash white.
  if (registered.length && !excludeMatches.length) {
    if (!current.length) return; // already correct - leave it alone
    await chrome.scripting.unregisterContentScripts({ ids: [EARLY_ID] });
    registered = [];
  }

  if (registered.length) await chrome.scripting.updateContentScripts([spec]);
  else await chrome.scripting.registerContentScripts([spec]);
}

// A worker woken *by* a settings change runs both the top-level reconcile and
// the onChanged listener. Unserialized, both would see nothing registered and
// both would call registerContentScripts - the second failing on a duplicate id.
let earlyQueue = Promise.resolve();
function syncEarlyCss() {
  earlyQueue = earlyQueue
    .then(readAndSyncEarlyCss)
    .catch((e) => console.warn("Dark Night: pre-paint stylesheet not updated -", e.message));
  return earlyQueue;
}

// Declarative content scripts do not run in tabs that were already open, so
// after an install, update or re-enable those tabs would keep a stylesheet no
// live script owns. Re-injecting adopts them instead; content.js ignores the
// second instance in any frame that already has one.
async function injectExistingTabs() {
  const tabs = await chrome.tabs.query({ url: PAGES });
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting
        .executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["content.js"]
        })
        .catch(() => {
          /* restricted page (Web Store, PDF viewer, ...) - skip it */
        })
    )
  );
}

// Runs once per extension load. chrome.storage.session is dropped when the
// extension is disabled, reloaded or updated but survives service-worker
// restarts, which is exactly the signal needed: adopt open tabs on the enable
// cycle without re-injecting into every tab on every idle wake.
async function adoptOpenTabsOnce() {
  try {
    const { adopted } = await chrome.storage.session.get({ adopted: false });
    if (adopted) return;
    await injectExistingTabs();
    // Flagged only once the pass actually completed, so a failure here is
    // retried on the next worker start rather than being remembered as done.
    // A concurrent second pass is harmless: content.js ignores a second
    // instance in any frame that already has one.
    await chrome.storage.session.set({ adopted: true });
  } catch (e) {
    console.warn("Dark Night: could not adopt open tabs -", e.message);
  }
}

async function reconcile() {
  await refreshBadges();
  await syncEarlyCss();
  await adoptOpenTabsOnce();
}

// Read-modify-write against shared storage: serialized so two fast presses of
// the shortcut are two toggles rather than one.
let toggleQueue = Promise.resolve();
chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-dark") return;
  toggleQueue = toggleQueue
    .then(async () => {
      const { enabled } = await readState();
      await chrome.storage.sync.set({ enabled: !enabled });
    })
    .catch((e) => console.warn("Dark Night: toggle failed -", e.message));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.enabled || changes.disabledSites) {
    refreshBadges();
    syncEarlyCss();
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    await paintBadge(await chrome.tabs.get(tabId), await readState());
  } catch (e) {
    /* tab gone */
  }
});

// No filter argument. `properties` is a Firefox extension to this event; Chrome
// supports no filters here and throws "This event does not support filters"
// straight out of addListener. At top level that took the entire worker down -
// registration failed with status 15, and every line below it, both runtime
// listeners and the reconcile() call, never ran at all. The badge went stale on
// navigation, the pre-paint stylesheet was never registered and open tabs were
// never adopted, while the declarative content script kept theming pages, so
// the extension looked like it was working.
//
// The guard therefore lives in the callback: every favicon, title and audible
// change wakes the worker and is discarded on the next line. That is the cost
// of the event being unfiltered on this browser, and it is a great deal cheaper
// than the worker not running.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.url && info.status !== "complete") return;
  await paintBadge(tab, await readState());
});

chrome.runtime.onInstalled.addListener(reconcile);
chrome.runtime.onStartup.addListener(reconcile);

// Runs on every service-worker start, including the disable/re-enable cycle
// that fires neither onInstalled nor onStartup and would otherwise leave the
// badge asserting the opposite of the real state.
reconcile();
