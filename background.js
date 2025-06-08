// Background service worker for Chrome extension
let foundUrlsCache = []; // Memory cache for fast access
let monitorSettings = {
  enabled: true,
  selectedRule: 'all'
};

// Data settings
let dataSettings = {
  maxStorageLimit: 100
};

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

// Initialize monitor settings from storage
chrome.storage.sync.get(['monitorEnabled', 'selectedRule'], (result) => {
  monitorSettings.enabled = result.monitorEnabled !== false; // Default to true
  monitorSettings.selectedRule = result.selectedRule || 'all';
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
      const urlData = {
        url: details.url,
        timestamp: Date.now(),
        rule: matchedRule,
        tabId: details.tabId
      };
      
      // Store the found URL using hybrid caching
      await addFoundUrl(urlData);
      
      // Send message to content script to show overlay
      try {
        await chrome.tabs.sendMessage(details.tabId, {
          action: 'showUrlOverlay',
          data: urlData
        });
      } catch (error) {
        console.error(`[${chrome.i18n.getMessage('extensionName')}] Could not send message to content script:`, error);
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
  } else if (request.action === 'getOverlaySettings') {
    // Handle overlay settings asynchronously
    chrome.storage.sync.get(['overlaySettings'], function(result) {
      const settings = result.overlaySettings || {
        maxOverlays: 5,
        timeoutSeconds: 30
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
    
    // Filter by rule if specified
    if (request.ruleFilter && request.ruleFilter !== 'all') {
      const ruleIndex = parseInt(request.ruleFilter);
      // Get current rules from storage
      const result = await chrome.storage.sync.get(['urlRules']);
      const rules = result.urlRules || [];
      
      if (rules[ruleIndex]) {
        const targetRule = rules[ruleIndex];
        filteredUrls = foundUrlsCache.filter(urlData => {
          // Compare by type and value (the essential parts of a rule)
          return urlData.rule.type === targetRule.type && 
                 urlData.rule.value === targetRule.value;
        });
      } else {
        filteredUrls = [];
      }
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
  if (areaName === 'sync') {
    // Update monitor settings
    if (changes.monitorEnabled) {
      monitorSettings.enabled = changes.monitorEnabled.newValue;
    }
    if (changes.selectedRule) {
      monitorSettings.selectedRule = changes.selectedRule.newValue;
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
