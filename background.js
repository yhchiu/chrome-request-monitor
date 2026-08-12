// Background service worker for Chrome extension
importScripts('rule-id.js'); // createRuleId, shared with the options page
importScripts('request-types.js'); // KNOWN_REQUEST_TYPES and normalizeRequestTypes

// Captured URLs, kept per tab rather than in one shared list.
//
// They used to share a single list trimmed to the storage limit, so a tab
// making many matching requests evicted everything every other tab had
// captured. The popup shows the current tab by default, which meant that on a
// busy profile the view a user actually looks at was almost always empty.
//
// A Map keeps its insertion order, so re-inserting a tab whenever it captures
// something leaves the least recently active tab first. That is what makes the
// bounds below cheap to apply.
const foundUrlsByTab = new Map();
let foundUrlsTotal = 0;

// How many tabs keep a list of their own. Without this, ten thousand tabs each
// holding the storage limit would be far more than the Service Worker should
// carry.
const MAX_TRACKED_TABS = 50;

// A ceiling on everything held at once, whatever the per tab limit is set to.
// It also bounds the backup write, since that serializes the lot.
const MAX_TOTAL_FOUND_URLS = 2000;

let monitorSettings = {
  enabled: true
};

// Rules the user is currently showing. null means every rule, an array means
// only those ids, and an empty array means none of them.
let focusedRuleIds = null;

// Whether the focus above came from the user rather than from the default
let focusSetByUser = false;

// Data settings
let dataSettings = {
  maxStorageLimit: 100
};

// The rules, kept in memory and ready to test against a URL. Reading them from
// storage per request costs a round trip to the browser process, and a busy
// profile makes thousands of requests a second, so the read happens once here
// and again whenever the rules change.
let compiledRules = [];

// Turn a stored rule into a function that tests a URL with no per request
// setup. A regex rule used to be recompiled on every request, which is by far
// the most expensive part of matching.
function compileRule(rule) {
  if (rule.type === 'contains') {
    return { rule: rule, matches: url => url.includes(rule.value) };
  }

  if (rule.type === 'startswith') {
    return { rule: rule, matches: url => url.startsWith(rule.value) };
  }

  if (rule.type === 'endswith') {
    return { rule: rule, matches: url => url.endsWith(rule.value) };
  }

  if (rule.type === 'regex') {
    try {
      const regex = new RegExp(rule.value, 'i');
      return { rule: rule, matches: url => regex.test(url) };
    } catch (error) {
      // Reported once when the rule is compiled rather than on every request
      console.error(`[${chrome.i18n.getMessage('extensionName')}] Invalid regex pattern:`, rule.value);
      return { rule: rule, matches: () => false };
    }
  }

  // An unknown type matches nothing, the same as before
  return { rule: rule, matches: () => false };
}

function setCompiledRules(rules) {
  compiledRules = rules.map(compileRule);
}

// Load the rules into memory. Runs after the id migration so the rule kept with
// each captured URL always carries an id.
async function initializeRules() {
  try {
    const result = await chrome.storage.sync.get(['urlRules']);
    setCompiledRules(result.urlRules || []);
  } catch (error) {
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to load rules:`, error);
    compiledRules = [];
  }
}

// Load whether monitoring is on. Part of startup, because the default is on and
// a request handled against that default captures URLs the user asked not to
// have captured.
async function initializeMonitorSettings() {
  try {
    const result = await chrome.storage.sync.get(['monitorEnabled']);
    monitorSettings.enabled = result.monitorEnabled !== false; // Default to true
  } catch (error) {
    // Left on, which is the default and what the read used to fall back to. A
    // transient storage error should not quietly stop monitoring altogether.
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to load monitor settings:`, error);
  }
}

// The resource types being watched. null means every type, which is the
// default: the extension exists to notice requests, so it starts by noticing
// all of them.
let requestTypes = null;

// Whether a request's type is one the user asked to watch.
//
// This is what actually decides, rather than the filter the listener was
// registered with. The listener has to be registered in the first turn after
// the Service Worker starts or the events it wants would not wake it, and the
// stored types cannot be read that early, so it starts wide and is narrowed
// afterwards. Between those two moments the wide filter is still in force.
function isTypeWatched(type) {
  return requestTypes === null || requestTypes.includes(type);
}

async function initializeRequestTypes() {
  try {
    const result = await chrome.storage.sync.get(['requestTypes']);
    requestTypes = normalizeRequestTypes(result.requestTypes);
  } catch (error) {
    // Watching everything is the default and the safer answer: a storage error
    // should not quietly stop the monitor noticing things.
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to load request types:`, error);
    requestTypes = null;
  }
}

// null means every rule; anything that is not an array is read the same way
function normalizeFocusedRuleIds(value) {
  return Array.isArray(value) ? value : null;
}

// Whether a rule falls inside the current focus
function isRuleFocused(ruleId) {
  return focusedRuleIds === null || focusedRuleIds.includes(ruleId);
}

// How many tabs are messaged at once. A broadcast used to send one message per
// tab from a single synchronous loop, so a profile with ten thousand tabs open
// queued ten thousand messages before the browser process answered any of them.
const BROADCAST_BATCH_SIZE = 50;

// Send a message to a known set of tabs, a batch at a time. Kept apart from the
// query below because not every broadcast has to ask which tabs exist: a caller
// that already knows its recipients pays nothing to find them.
async function broadcastToTabIds(tabIds, message) {
  for (let start = 0; start < tabIds.length; start += BROADCAST_BATCH_SIZE) {
    const batch = tabIds.slice(start, start + BROADCAST_BATCH_SIZE);

    // Waiting between batches bounds how many messages are in flight and gives
    // the Service Worker room to answer requests while the broadcast runs.
    await Promise.all(batch.map(tabId => chrome.tabs.sendMessage(tabId, message).catch(() => {
      // Ignore errors for tabs that don't have the content script
    })));
  }
}

// Tabs that have been sent an overlay and so may still be showing one.
//
// The focus broadcast only has to reach these. A tab with nothing on screen has
// nothing to take away, and asking the browser which tabs exist in order to
// find that out costs more the more tabs are open, while what the broadcast can
// actually achieve does not grow at all: on a profile with ten thousand tabs
// open, the few holding an overlay are still only a few.
//
// Being too generous here is harmless. A tab whose overlays have already timed
// out just receives a message that finds nothing to remove. Being too strict is
// what leaves an overlay stranded, so an entry is dropped only once the tab is
// gone rather than on a guess about when its overlays expired.
const overlayTabIds = new Set();

// A ceiling, so the set cannot grow for as long as the Service Worker lives.
const MAX_OVERLAY_TABS = 100;

function rememberOverlayTab(tabId) {
  // A Set keeps its insertion order, so re-inserting moves the tab to the end
  // and leaves the tab shown longest ago first, which is the one to drop. Same
  // approach as the bound on foundUrlsByTab.
  overlayTabIds.delete(tabId);
  overlayTabIds.add(tabId);

  if (overlayTabIds.size > MAX_OVERLAY_TABS) {
    overlayTabIds.delete(overlayTabIds.values().next().value);
  }
}

// Tell the tabs showing an overlay about the new focus, so overlays for rules
// that are no longer shown disappear instead of lingering until they time out.
//
// A Service Worker restart empties the set, which quietly turns this back into
// waiting for the timeout. That is the right trade: the worker is only stopped
// once it has been idle a while, by which point the overlays this would have
// taken away have usually timed out anyway, and remembering them across a
// restart would put a storage write on the path every captured request takes.
function broadcastFocusedRules() {
  return broadcastToTabIds(Array.from(overlayTabIds), {
    action: 'updateFocusedRules',
    focusedRuleIds: focusedRuleIds
  });
}

// Drop focused ids whose rule is gone. Rules can also be deleted on another
// device, which arrives as a sync change rather than through the options page,
// and an id pointing at a rule that no longer exists matches nothing, which
// silences every overlay. Widening back to every rule mirrors what the options
// page does for a local delete: deleting a rule is not a request to silence
// the rest.
function reconcileFocusWithRules(rules) {
  if (focusedRuleIds === null) {
    return;
  }

  const knownIds = focusedRuleIds.filter(id => rules.some(rule => rule.id === id));

  // Nothing was dropped. This also leaves an empty focus alone, which is a
  // deliberate "show nothing" rather than a stale value.
  if (knownIds.length === focusedRuleIds.length) {
    return;
  }

  focusedRuleIds = knownIds.length > 0 ? knownIds : null;
  broadcastFocusedRules();
  chrome.storage.local.set({ focusedRuleIds: focusedRuleIds }).catch((error) => {
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to save focused rules:`, error);
  });
}

// Give stored rules a stable id and convert the legacy index based rule filter.
// Runs on every Service Worker start because rules can also arrive from another
// device through sync storage. Safe to repeat: it only writes when something is
// missing.
async function migrateRuleIds() {
  try {
    const result = await chrome.storage.sync.get(['urlRules', 'selectedRule']);
    const rules = result.urlRules || [];
    const selectedRule = result.selectedRule || 'all';
    const updates = {};

    if (rules.some(rule => !rule.id)) {
      updates.urlRules = rules.map(rule => rule.id ? rule : { ...rule, id: createRuleId() });
    }

    // Legacy filters stored the rule's array index, which silently points at a
    // different rule once any earlier rule is deleted. Convert it once to the
    // matching id, or drop it when the index no longer resolves.
    if (selectedRule !== 'all' && /^\d+$/.test(selectedRule)) {
      const migratedRules = updates.urlRules || rules;
      const targetRule = migratedRules[parseInt(selectedRule, 10)];
      updates.selectedRule = targetRule ? targetRule.id : 'all';
    }

    if (Object.keys(updates).length > 0) {
      await chrome.storage.sync.set(updates);
    }
  } catch (error) {
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to migrate rule ids:`, error);
  }
}

// Move the old single rule filter to the focused rule set in local storage.
// The filter used to live in sync storage, but it changes as often as the user
// switches context and sync storage rejects frequent writes.
async function migrateFocusedRules() {
  try {
    const [syncResult, localResult] = await Promise.all([
      chrome.storage.sync.get(['selectedRule', 'urlRules']),
      chrome.storage.local.get(['focusedRuleIds'])
    ]);

    if (syncResult.selectedRule === undefined) {
      return;
    }

    // Local storage wins when both exist, which happens once another device
    // syncs an old value in after this one has already migrated.
    if (localResult.focusedRuleIds === undefined) {
      // The rule named by the old filter may have been deleted on another
      // device before this one migrated. Carrying that id across would leave a
      // focus that matches nothing and shows nothing at all.
      const rules = syncResult.urlRules || [];
      const targetExists = rules.some(rule => rule.id === syncResult.selectedRule);

      await chrome.storage.local.set({
        focusedRuleIds: syncResult.selectedRule === 'all' || !targetExists
          ? null
          : [syncResult.selectedRule]
      });
    }

    await chrome.storage.sync.remove(['selectedRule']);
  } catch (error) {
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to migrate focused rules:`, error);
  }
}

// Load the focused rules into memory so requests can be filtered without
// touching storage
async function initializeFocusedRules() {
  try {
    const result = await chrome.storage.local.get(['focusedRuleIds']);
    // The popup can change the focus while this read is still in flight, and
    // that choice is newer than anything storage can tell us.
    if (focusSetByUser) {
      return;
    }
    focusedRuleIds = normalizeFocusedRuleIds(result.focusedRuleIds);
  } catch (error) {
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to load focused rules:`, error);
    focusedRuleIds = null;
  }
}

// Migrations run in order: rule ids first, because the focused rule migration
// reads a filter that the first one may still be converting from an index.
async function migrateStoredData() {
  await migrateRuleIds();
  await migrateFocusedRules();
  await initializeFocusedRules();
  await initializeRules();
}

// Group a flat list of captured URLs back into the per tab lists.
//
// The backup is written flat, which is also the shape it had before the lists
// were split per tab, so a backup written by an older version restores without
// needing to be converted.
function restoreFoundUrls(urls) {
  foundUrlsByTab.clear();
  foundUrlsTotal = 0;

  urls.forEach(urlData => {
    const existing = foundUrlsByTab.get(urlData.tabId) || [];
    existing.push(urlData);
    foundUrlsByTab.set(urlData.tabId, existing);
    foundUrlsTotal += 1;
  });
}

// Everything captured, oldest first, for the views that are not limited to a
// single tab. The lists are per tab, so the combined order has to be restored.
function allFoundUrls() {
  const all = [];
  foundUrlsByTab.forEach(urls => {
    urls.forEach(urlData => all.push(urlData));
  });
  return all.sort((a, b) => a.timestamp - b.timestamp);
}

// Drop everything captured by the tab that has been quiet the longest
function forgetLeastRecentTab() {
  const oldestTabId = foundUrlsByTab.keys().next().value;
  foundUrlsTotal -= foundUrlsByTab.get(oldestTabId).length;
  foundUrlsByTab.delete(oldestTabId);
}

// Bring what is held back inside the limits. Called after a capture and after
// the user changes the limit.
function enforceFoundUrlLimits() {
  const perTabLimit = dataSettings.maxStorageLimit;

  foundUrlsByTab.forEach(urls => {
    if (urls.length > perTabLimit) {
      foundUrlsTotal -= urls.length - perTabLimit;
      urls.splice(0, urls.length - perTabLimit);
    }
  });

  // Never down to nothing: the tab that just captured something has to survive
  // its own capture, whatever the limits are set to.
  while (foundUrlsByTab.size > 1 &&
         (foundUrlsByTab.size > MAX_TRACKED_TABS || foundUrlsTotal > MAX_TOTAL_FOUND_URLS)) {
    forgetLeastRecentTab();
  }
}

// Initialize from persistent storage when Service Worker starts
async function initializeFoundUrls() {
  try {
    const result = await chrome.storage.session.get(['foundUrls']);
    restoreFoundUrls(result.foundUrls || []);
  } catch (error) {
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to initialize found URLs from storage:`, error);
    restoreFoundUrls([]);
  }
}

// How long a backup is held back so the writes that arrive in the meantime are
// written once instead of one at a time.
//
// The backup exists only so a Service Worker restart does not lose what was
// captured, and it is read once at startup, so nothing depends on it being
// current to the millisecond. Writing on every match instead serialized the
// whole list, which can hold a thousand entries, as often as URLs matched.
const BACKUP_DELAY_MS = 1000;

let backupTimer = null;

// Back the cache up to session storage, coalescing anything that arrives while
// a write is already waiting to go out
function scheduleBackup() {
  if (backupTimer !== null) {
    return;
  }

  backupTimer = setTimeout(async () => {
    backupTimer = null;
    try {
      await chrome.storage.session.set({
        foundUrls: allFoundUrls()
      });
    } catch (error) {
      console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to backup URLs to storage:`, error);
    }
  }, BACKUP_DELAY_MS);
}

// Add URL with hybrid caching strategy
function addFoundUrl(urlData) {
  const existing = foundUrlsByTab.get(urlData.tabId) || [];

  // Removing before setting is what moves this tab to the end of the map, so
  // the tab that has been quiet the longest stays at the front
  foundUrlsByTab.delete(urlData.tabId);

  existing.push(urlData);
  foundUrlsTotal += 1;
  foundUrlsByTab.set(urlData.tabId, existing);

  enforceFoundUrlLimits();
  scheduleBackup();
}

// Clear URLs from both cache and storage
async function clearFoundUrls() {
  foundUrlsByTab.clear();
  foundUrlsTotal = 0;

  // A backup that is still waiting would write the emptied cache straight back
  // over the removal
  if (backupTimer !== null) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }

  try {
    await chrome.storage.session.remove(['foundUrls']);
  } catch (error) {
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to clear URLs from storage:`, error);
  }
}

// Initialize on Service Worker startup.
//
// A request is what wakes the Service Worker, so the listener below can run
// before this has finished. Everything that matches, captures or reads waits on
// startupReady first.
//
// Without it, the monitor switch would still be the "on" default and would
// capture for a user who had turned it off, the focus would still be the "every
// rule" default and would show overlays the user has hidden, the rules would
// still be empty and would match nothing, and restoring the captured URLs would
// clear whatever a request had captured in the meantime, because the restore
// replaces what is held rather than adding to it.
//
// The catch keeps those waiters from hanging if the initialization ever
// rejects.
const startupReady = Promise.all([
  initializeFoundUrls(),
  initializeMonitorSettings(),
  initializeRequestTypes().then(applyRequestTypeFilter),
  migrateStoredData()
]).catch(() => {});

// Whether the promise above has settled. A busy profile makes thousands of
// requests a second, and awaiting a promise that resolved long ago still costs
// a microtask on every one of them. Once startup is done this is a single
// boolean test instead.
let startupDone = false;
startupReady.then(() => {
  startupDone = true;
});

// Initialize data settings from storage
chrome.storage.sync.get(['dataSettings'], (result) => {
  const settings = result.dataSettings || {
    maxStorageLimit: 100
  };
  dataSettings = settings;
});

// The title and url of the tabs we have seen, so a match does not have to ask
// the browser for them. Every match used to cost a round trip, on top of the
// one the rules already cost.
//
// The cache is filled as tabs report themselves and on the first match for a
// tab we have not seen, which is what makes it survive a Service Worker
// restart: the map starts empty every time and fills itself back in.
const tabInfoCache = new Map();

function rememberTab(tab) {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) {
    return;
  }

  tabInfoCache.set(tab.id, {
    title: tab.title || '',
    url: tab.url || ''
  });
}

// What we know about a tab, or null when there is nothing to know
async function getTabInfo(tabId) {
  // Requests that belong to no tab, from a Service Worker for instance, carry
  // -1. Asking about that always threw, so every one of them used to cost a
  // failed round trip and a warning.
  if (typeof tabId !== 'number' || tabId < 0) {
    return null;
  }

  const cached = tabInfoCache.get(tabId);
  if (cached) {
    return cached;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    rememberTab({ ...tab, id: tabId });
    return tabInfoCache.get(tabId) || null;
  } catch (error) {
    console.warn(`[${chrome.i18n.getMessage('extensionName')}] Could not get tab title:`, error);
    return null;
  }
}

// Keep the cache current. A title changes as a page loads, and the entry has to
// go when the tab does or the map would grow for as long as the Service Worker
// lives.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  rememberTab(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabInfoCache.delete(tabId);
  // A closed tab took its overlays with it, so there is nothing left to reach
  overlayTabIds.delete(tabId);
});

// Listen for web requests
async function handleBeforeRequest(details) {
  // Wait for the stored settings before deciding anything, including whether
  // to capture at all: the monitor switch defaults to on, and a URL captured
  // against that default cannot be taken back the way a shown overlay can.
  // This also puts the match below after the id migration, so the rule
  // snapshot kept with the URL always carries an id and can be matched
  // against a focus later. The listener is not blocking, so this delays only
  // our own work: the request still goes ahead and is still captured.
  if (!startupDone) {
    await startupReady;
  }

  // Check if monitoring is enabled
  if (!monitorSettings.enabled) {
    return;
  }

  // The registered filter may still be the wide one the worker starts with,
  // so the type is checked here rather than trusted to it
  if (!isTypeWatched(details.type)) {
    return;
  }

  if (compiledRules.length === 0) return;

  // Check if URL matches any rule (always check all rules and filter later in display)
  const matched = compiledRules.find(entry => entry.matches(details.url));

  if (matched) {
    const matchedRule = matched.rule;
    // Get tab information to include title and determine if we can message this tab
    const tabInfo = await getTabInfo(details.tabId);
    const tabTitle = (tabInfo && tabInfo.title) || chrome.i18n.getMessage('unknown') || 'Unknown';
    const tabUrl = (tabInfo && tabInfo.url) || '';
    // Only message tabs that are http/https pages (content scripts can't run on chrome://, extensions, web store, etc.)
    const canSendOverlay = /^https?:\/\//i.test(tabUrl);

    const urlData = {
      url: details.url,
      timestamp: Date.now(),
      rule: matchedRule,
      tabId: details.tabId,
      tabTitle: tabTitle
    };
    
    // Store the found URL using hybrid caching
    addFoundUrl(urlData);
    
    // Send message to content script to show overlay (only when eligible).
    // A rule outside the current focus is still recorded above, it just does
    // not interrupt the page.
    if (isRuleFocused(matchedRule.id) &&
        typeof details.tabId === 'number' && details.tabId >= 0 && canSendOverlay) {
      try {
        await chrome.tabs.sendMessage(details.tabId, {
          action: 'showUrlOverlay',
          data: urlData
        });
        // Only once the send lands. A rejection means no content script took
        // it, so there is no overlay there to take away later.
        rememberOverlayTab(details.tabId);
      } catch (error) {
        // Content script may not be injected yet or page is restricted; skip logging as error to reduce noise
        console.warn(`[${chrome.i18n.getMessage('extensionName')}] Skipped sending overlay to this tab:`, { tabId: details.tabId, url: tabUrl, reason: error?.message });
      }
    }
  }
}

// Watching everything, which is what the listener starts with. Registering has
// to happen in the first turn after the Service Worker starts, or a request of
// a type nothing is listening for would not wake it, and the stored types
// cannot be read that quickly.
const WIDE_REQUEST_FILTER = { urls: ["<all_urls>"] };

chrome.webRequest.onBeforeRequest.addListener(handleBeforeRequest, WIDE_REQUEST_FILTER);

// The types the listener is currently registered for, so an unchanged setting
// does not tear the listener down and put it back for nothing
let registeredRequestTypes = null;

// Compared by value, not by identity: normalizeRequestTypes builds a fresh
// array every time, so the same setting arriving again is never the same object.
// The order is canonical, which is what lets this compare position by position.
function sameRequestTypes(left, right) {
  if (left === right) {
    return true;
  }

  if (left === null || right === null) {
    return false;
  }

  return left.length === right.length && left.every((type, index) => type === right[index]);
}

// Narrow what Chrome delivers to the types being watched.
//
// The handler already ignores the rest, so this changes no behaviour. What it
// saves is the delivery itself: a filtered out request never crosses into the
// Service Worker, which is the cost worth avoiding when a profile has many tabs
// making requests.
function applyRequestTypeFilter() {
  if (sameRequestTypes(registeredRequestTypes, requestTypes)) {
    return;
  }

  registeredRequestTypes = requestTypes;

  const filter = requestTypes === null
    ? WIDE_REQUEST_FILTER
    : { urls: ["<all_urls>"], types: requestTypes };

  chrome.webRequest.onBeforeRequest.removeListener(handleBeforeRequest);

  try {
    chrome.webRequest.onBeforeRequest.addListener(handleBeforeRequest, filter);
  } catch (error) {
    // A type Chrome does not know makes addListener throw. The listener has
    // already been taken off by this point, so put it back watching everything
    // rather than leave nothing listening at all.
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to narrow the request filter:`, error);
    registeredRequestTypes = null;
    chrome.webRequest.onBeforeRequest.addListener(handleBeforeRequest, WIDE_REQUEST_FILTER);
  }
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getFoundUrls') {
    // Handle the request asynchronously
    handleGetFoundUrls(request, sendResponse);
    return true; // Keep the message channel open for async response
  } else if (request.action === 'clearFoundUrls') {
    clearFoundUrls().then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to clear URLs:`, error);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep the message channel open for async response
  } else if (request.action === 'updateMonitorSettings') {
    // Update monitor settings
    monitorSettings = request.settings;
    sendResponse({ success: true });
  } else if (request.action === 'getMonitorSettings') {
    sendResponse({ settings: monitorSettings });
  } else if (request.action === 'setFocusedRules') {
    // Update the in-memory copy before responding so the caller's next query
    // already sees the new focus.
    focusedRuleIds = normalizeFocusedRuleIds(request.focusedRuleIds);
    focusSetByUser = true;
    broadcastFocusedRules();
    chrome.storage.local.set({ focusedRuleIds: focusedRuleIds }).then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to save focused rules:`, error);
      sendResponse({ success: false });
    });
    return true; // Keep the message channel open for async response
  }
});

// Async function to handle getFoundUrls request
async function handleGetFoundUrls(request, sendResponse) {
  try {
    // The popup can ask before the stored focus has been read, which would
    // answer with an unfiltered list
    await startupReady;

    // Always use the most up-to-date data from memory cache
    let filteredUrls;

    if (request.currentTabOnly) {
      // Get current active tab
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      // One tab's captures are a lookup now rather than a scan of everything
      filteredUrls = activeTab ? (foundUrlsByTab.get(activeTab.id) || []) : [];
    } else {
      filteredUrls = allFoundUrls();
    }

    // Keep only the focused rules. Each stored URL keeps the rule it matched,
    // so the id is enough on its own: no lookup against the current rules, and
    // editing a rule later does not hide the URLs it already matched.
    if (focusedRuleIds !== null) {
      filteredUrls = filteredUrls.filter(
        urlData => urlData.rule && focusedRuleIds.includes(urlData.rule.id)
      );
    }

    // The popup builds a row for every entry it is handed, so give it no more
    // than the limit the user set. Across every tab there can now be more than
    // that held.
    if (filteredUrls.length > dataSettings.maxStorageLimit) {
      filteredUrls = filteredUrls.slice(-dataSettings.maxStorageLimit);
    }

    sendResponse({ urls: filteredUrls });
  } catch (error) {
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Error in handleGetFoundUrls:`, error);
    sendResponse({ urls: [] });
  }
}

// Listen for storage changes to update monitor settings
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.focusedRuleIds) {
    focusedRuleIds = normalizeFocusedRuleIds(changes.focusedRuleIds.newValue);
  }

  if (areaName === 'sync') {
    // Rules can be deleted on another device, so the focus has to be checked
    // against what is left
    if (changes.urlRules) {
      const rules = changes.urlRules.newValue || [];
      // This is what keeps the in memory rules current, so a request never has
      // to read them back from storage
      setCompiledRules(rules);
      reconcileFocusWithRules(rules);
    }

    // Update monitor settings
    if (changes.monitorEnabled) {
      monitorSettings.enabled = changes.monitorEnabled.newValue;
    }

    // Update the types being watched, and narrow what Chrome delivers to match
    if (changes.requestTypes) {
      requestTypes = normalizeRequestTypes(changes.requestTypes.newValue);
      applyRequestTypeFilter();
    }

    // Update data settings
    if (changes.dataSettings) {
      dataSettings = changes.dataSettings.newValue;

      // Immediately apply the new limit to what is already held
      enforceFoundUrlLimits();
      scheduleBackup();
    }

    // Overlay settings are not relayed. Every content script is given the same
    // change event, so each tab picks its own up without a message from here.
  }
});
