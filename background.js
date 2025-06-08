// Background service worker for Chrome extension
let foundUrls = [];

// Listen for web requests
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    // Get user-defined rules from storage
    const result = await chrome.storage.sync.get(['urlRules']);
    const rules = result.urlRules || [];
    
    if (rules.length === 0) return;
    
    // Check if URL matches any rule
    const matchedRule = rules.find(rule => {
      if (rule.type === 'contains') {
        return details.url.includes(rule.value);
      } else if (rule.type === 'regex') {
        try {
          const regex = new RegExp(rule.value, 'i');
          return regex.test(details.url);
        } catch (e) {
          console.error('Invalid regex pattern:', rule.value);
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
      
      // Store the found URL
      foundUrls.push(urlData);
      
      // Send message to content script to show overlay
      try {
        await chrome.tabs.sendMessage(details.tabId, {
          action: 'showUrlOverlay',
          data: urlData
        });
      } catch (error) {
        console.log('Could not send message to content script:', error);
      }
    }
  },
  { urls: ["<all_urls>"] }
);

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getFoundUrls') {
    if (request.currentTabOnly) {
      // Get current active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        if (activeTab) {
          // Filter URLs by current tab ID
          const currentTabUrls = foundUrls.filter(urlData => urlData.tabId === activeTab.id);
          sendResponse({ urls: currentTabUrls });
        } else {
          sendResponse({ urls: [] });
        }
      });
      // Return true to indicate that the response is sent asynchronously
      return true;
    } else {
    sendResponse({ urls: foundUrls });
    }
  } else if (request.action === 'clearFoundUrls') {
    foundUrls = [];
    sendResponse({ success: true });
  } else if (request.action === 'getOverlaySettings') {
    // Get overlay settings from storage
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

// Listen for storage changes to update content scripts when overlay settings change
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.overlaySettings) {
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
});

// Clean up old URLs (keep only last 100)
setInterval(() => {
  if (foundUrls.length > 100) {
    foundUrls = foundUrls.slice(-100);
  }
}, 60000); // Check every minute 