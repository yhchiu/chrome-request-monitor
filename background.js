// Background service worker for Chrome extension
let foundUrlsCache = []; // Memory cache for fast access
let monitorSettings = {
  enabled: true
};

// Rules the user is currently showing. null means every rule, an array means
// only those ids, and an empty array means none of them.
let focusedRuleIds = null;

// Data settings
let dataSettings = {
  maxStorageLimit: 100
};

// null means every rule; anything that is not an array is read the same way
function normalizeFocusedRuleIds(value) {
  return Array.isArray(value) ? value : null;
}

// Whether a rule falls inside the current focus
function isRuleFocused(ruleId) {
  return focusedRuleIds === null || focusedRuleIds.includes(ruleId);
}

// Generate a stable identifier for a rule
function createRuleId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
      chrome.storage.sync.get(['selectedRule']),
      chrome.storage.local.get(['focusedRuleIds'])
    ]);

    if (syncResult.selectedRule === undefined) {
      return;
    }

    // Local storage wins when both exist, which happens once another device
    // syncs an old value in after this one has already migrated.
    if (localResult.focusedRuleIds === undefined) {
      await chrome.storage.local.set({
        focusedRuleIds: syncResult.selectedRule === 'all' ? null : [syncResult.selectedRule]
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
}

// Initialize from persistent storage when Service Worker starts
async function initializeFoundUrls() {
  try {
    const result = await chrome.storage.session.get(['foundUrls']);
    foundUrlsCache = result.foundUrls || [];
  } catch (error) {
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to initialize found URLs from storage:`, error);
    foundUrlsCache = [];
  }
}

// Add URL with hybrid caching strategy
async function addFoundUrl(urlData) {
  // Immediately add to memory cache for fast access
  foundUrlsCache.push(urlData);
  
  // Limit cache size in memory
  if (foundUrlsCache.length > dataSettings.maxStorageLimit) {
    foundUrlsCache = foundUrlsCache.slice(-dataSettings.maxStorageLimit);
  }
  
  // Asynchronously backup to persistent storage
  setTimeout(async () => {
    try {
      await chrome.storage.session.set({ 
        foundUrls: foundUrlsCache 
      });
    } catch (error) {
      console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to backup URLs to storage:`, error);
    }
  }, 0);
}

// Clear URLs from both cache and storage
async function clearFoundUrls() {
  foundUrlsCache = [];
  try {
    await chrome.storage.session.remove(['foundUrls']);
  } catch (error) {
    console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to clear URLs from storage:`, error);
  }
}

// Initialize on Service Worker startup
initializeFoundUrls();
migrateStoredData();

// Initialize monitor settings from storage
chrome.storage.sync.get(['monitorEnabled'], (result) => {
  monitorSettings.enabled = result.monitorEnabled !== false; // Default to true
});

// Initialize data settings from storage
chrome.storage.sync.get(['dataSettings'], (result) => {
  const settings = result.dataSettings || {
    maxStorageLimit: 100
  };
  dataSettings = settings;
});

// Listen for web requests
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    // Check if monitoring is enabled
    if (!monitorSettings.enabled) {
      return;
    }
    
    // Get user-defined rules from storage
    const result = await chrome.storage.sync.get(['urlRules']);
    const rules = result.urlRules || [];
    
    if (rules.length === 0) return;
    
    // Check if URL matches any rule (always check all rules and filter later in display)
    const matchedRule = rules.find(rule => {
      if (rule.type === 'contains') {
        return details.url.includes(rule.value);
      } else if (rule.type === 'regex') {
        try {
          const regex = new RegExp(rule.value, 'i');
          return regex.test(details.url);
        } catch (e) {
          console.error(`[${chrome.i18n.getMessage('extensionName')}] Invalid regex pattern:`, rule.value);
          return false;
        }
      } else if (rule.type === 'startswith') {
        return details.url.startsWith(rule.value);
      } else if (rule.type === 'endswith') {
        return details.url.endsWith(rule.value);
      }
      return false;
    });
    
    if (matchedRule) {
      // Get tab information to include title and determine if we can message this tab
      let tabTitle = chrome.i18n.getMessage('unknown') || 'Unknown';
      let tabUrl = '';
      let canSendOverlay = false;
      try {
        const tab = await chrome.tabs.get(details.tabId);
        tabTitle = tab.title || chrome.i18n.getMessage('unknown') || 'Unknown';
        tabUrl = tab.url || '';
        // Only message tabs that are http/https pages (content scripts can't run on chrome://, extensions, web store, etc.)
        canSendOverlay = /^https?:\/\//i.test(tabUrl);
      } catch (error) {
        console.warn(`[${chrome.i18n.getMessage('extensionName')}] Could not get tab title:`, error);
      }
      
      const urlData = {
        url: details.url,
        timestamp: Date.now(),
        rule: matchedRule,
        tabId: details.tabId,
        tabTitle: tabTitle
      };
      
      // Store the found URL using hybrid caching
      await addFoundUrl(urlData);
      
      // Send message to content script to show overlay (only when eligible)
      if (typeof details.tabId === 'number' && details.tabId >= 0 && canSendOverlay) {
        try {
          await chrome.tabs.sendMessage(details.tabId, {
            action: 'showUrlOverlay',
            data: urlData
          });
        } catch (error) {
          // Content script may not be injected yet or page is restricted; skip logging as error to reduce noise
          console.warn(`[${chrome.i18n.getMessage('extensionName')}] Skipped sending overlay to this tab:`, { tabId: details.tabId, url: tabUrl, reason: error?.message });
        }
      }
    }
  },
  { urls: ["<all_urls>"] }
);

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
    chrome.storage.local.set({ focusedRuleIds: focusedRuleIds }).then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to save focused rules:`, error);
      sendResponse({ success: false });
    });
    return true; // Keep the message channel open for async response
  } else if (request.action === 'getOverlaySettings') {
    // Handle overlay settings asynchronously
    chrome.storage.sync.get(['overlaySettings'], function(result) {
      const settings = result.overlaySettings || {
        maxOverlays: 5,
        timeoutSeconds: 30,
        position: 'top-right',
        opacity: 0.95
      };
      sendResponse({ settings: settings });
    });
    return true; // Keep the message channel open for async response
  } else if (request.action === 'getI18nMessage') {
    // Handle i18n message requests from content scripts
    const message = chrome.i18n.getMessage(request.key, request.substitutions);
    sendResponse({ message: message });
  }
});

// Async function to handle getFoundUrls request
async function handleGetFoundUrls(request, sendResponse) {
  try {
    // Always use the most up-to-date data from memory cache
    let filteredUrls = foundUrlsCache;
    
    // Keep only the focused rules. Each stored URL keeps the rule it matched,
    // so the id is enough on its own: no lookup against the current rules, and
    // editing a rule later does not hide the URLs it already matched.
    if (focusedRuleIds !== null) {
      filteredUrls = filteredUrls.filter(
        urlData => urlData.rule && focusedRuleIds.includes(urlData.rule.id)
      );
    }
    
    if (request.currentTabOnly) {
      // Get current active tab
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      
      if (activeTab) {
        // Filter URLs by current tab ID
        const currentTabUrls = filteredUrls.filter(urlData => urlData.tabId === activeTab.id);
        sendResponse({ urls: currentTabUrls });
      } else {
        sendResponse({ urls: [] });
      }
    } else {
      sendResponse({ urls: filteredUrls });
    }
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
    // Update monitor settings
    if (changes.monitorEnabled) {
      monitorSettings.enabled = changes.monitorEnabled.newValue;
    }

    // Update data settings
    if (changes.dataSettings) {
      dataSettings = changes.dataSettings.newValue;
      
      // Immediately apply new storage limit if current cache exceeds it
      if (foundUrlsCache.length > dataSettings.maxStorageLimit) {
        foundUrlsCache = foundUrlsCache.slice(-dataSettings.maxStorageLimit);
        
        // Sync the trimmed cache back to persistent storage
        chrome.storage.session.set({ 
          foundUrls: foundUrlsCache 
        }).catch((error) => {
          console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to sync updated cache to storage:`, error);
        });
      }
    }
    
    // Update overlay settings
    if (changes.overlaySettings) {
      const newSettings = changes.overlaySettings.newValue;
      // Notify all tabs about the settings change
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'updateOverlaySettings',
            settings: newSettings
          }).catch(() => {
            // Ignore errors for tabs that don't have the content script
          });
        });
      });
    }
  }
});

// Enhanced cleanup with hybrid storage management
setInterval(async () => {
  if (foundUrlsCache.length > dataSettings.maxStorageLimit) {
    foundUrlsCache = foundUrlsCache.slice(-dataSettings.maxStorageLimit);
    
    // Sync the cleaned cache back to persistent storage
    try {
      await chrome.storage.session.set({ 
        foundUrls: foundUrlsCache 
      });
    } catch (error) {
      console.error(`[${chrome.i18n.getMessage('extensionName')}] Failed to sync cleaned cache to storage:`, error);
    }
  }
}, 60000); // Check every minute
