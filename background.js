// Dark Night - service worker
// Owns the keyboard shortcut, the pre-paint stylesheet registration, and
// injection into tabs that were already open.

const DEFAULTS = { enabled: true, disabledSites: [] };
const EARLY_ID = "dark-night-early";
const HOSTNAME = /^[a-z0-9.-]+$/i;
const PAGES = ["http://*/*", "https://*/*"];

const bare = (host) => String(host).replace(/^www\./, "");

async function readState() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return {
    enabled: stored.enabled !== false,
    disabledSites: Array.isArray(stored.disabledSites) ? stored.disabledSites : []
  };
}

// Nothing may cover the toolbar icon, so the extension never shows a badge.
// This clears any text a previous version left on the action, globally and on
// the tabs it was painted per-tab.
async function clearBadges() {
  try {
    await chrome.action.setBadgeText({ text: "" });
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {})
      )
    );
  } catch (e) {
    console.warn("Dark Night: badge not cleared -", e.message);
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
  await clearBadges();
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
    syncEarlyCss();
  }
});

chrome.runtime.onInstalled.addListener(reconcile);
chrome.runtime.onStartup.addListener(reconcile);

// Runs on every service-worker start, including the disable/re-enable cycle
// that fires neither onInstalled nor onStartup and would otherwise leave the
// pre-paint registration out of step with the real state.
reconcile();
