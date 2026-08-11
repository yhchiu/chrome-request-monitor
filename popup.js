// Popup script for Chrome extension

// Helper function to escape HTML to prevent XSS
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.toString().replace(/[&<>"']/g, function(m) { return map[m]; });
}

document.addEventListener('DOMContentLoaded', function() {
  const urlList = document.getElementById('urlList');
  const emptyState = document.getElementById('emptyState');
  const loading = document.getElementById('loading');
  const urlCount = document.getElementById('urlCount');
  const refreshBtn = document.getElementById('refreshBtn');
  const clearBtn = document.getElementById('clearBtn');
  const optionsBtn = document.getElementById('optionsBtn');
  const optionsLink = document.getElementById('optionsLink');
  const tabFilterToggle = document.getElementById('tabFilterToggle');
  
  // Monitor control elements
  const monitorToggle = document.getElementById('monitorToggle');
  const monitorStatus = document.getElementById('monitorStatus');
  const statusIndicator = document.getElementById('statusIndicator');
  const ruleSelector = document.getElementById('ruleSelector');
  
  let monitorEnabled = true;
  // Rules currently being shown. null means every rule, an array means only
  // those ids, and an empty array means none of them.
  let focusedRuleIds = null;
  let allRules = [];
  let monitorSettingsLoaded = false;
  let focusedRulesLoaded = false;
  let rulesLoaded = false;

  // Initialize popup
  function init() {
    loadMonitorSettings();
    loadFocusedRules();
    loadRules();
  }

  // Load monitor settings from storage
  function loadMonitorSettings() {
    chrome.storage.sync.get(['monitorEnabled'], (result) => {
      monitorEnabled = result.monitorEnabled !== false; // Default to true
      monitorSettingsLoaded = true;

      updateMonitorUI();
      loadUrlsWhenReady();
    });
  }

  // Load the focused rules. They live in local storage because they change as
  // often as the user switches context, and sync storage rejects frequent
  // writes.
  function loadFocusedRules() {
    chrome.storage.local.get(['focusedRuleIds'], (result) => {
      focusedRuleIds = Array.isArray(result.focusedRuleIds) ? result.focusedRuleIds : null;
      focusedRulesLoaded = true;

      updateRuleSelector();
      loadUrlsWhenReady();
    });
  }

  // Load rules from storage
  function loadRules() {
    chrome.storage.sync.get(['urlRules'], (result) => {
      allRules = result.urlRules || [];
      rulesLoaded = true;

      populateRuleSelector();
      loadUrlsWhenReady();
    });
  }

  // Load URLs once the focus and the rule list are both known, so a focus
  // pointing at a deleted rule is caught before the first query.
  function loadUrlsWhenReady() {
    if (!monitorSettingsLoaded || !focusedRulesLoaded || !rulesLoaded) {
      return;
    }

    if (dropDeletedRuleIds()) {
      // Wait for the background to take the correction, otherwise the query
      // below could still run against the old focus.
      saveFocusedRules(loadUrls);
      return;
    }

    loadUrls();
  }

  // Drop ids whose rule is gone, which happens when it was deleted, when all
  // rules were cleared, or when an import replaced them. Falling back to every
  // rule beats leaving the popup on a list that can never fill. Returns whether
  // anything changed.
  function dropDeletedRuleIds() {
    if (focusedRuleIds === null) {
      return false;
    }

    const knownIds = focusedRuleIds.filter(id => allRules.some(rule => rule.id === id));
    if (knownIds.length === focusedRuleIds.length) {
      return false;
    }

    focusedRuleIds = knownIds.length > 0 ? knownIds : null;
    updateRuleSelector();
    return true;
  }
  
  // Update monitor UI based on current state
  function updateMonitorUI() {
    monitorToggle.checked = monitorEnabled;
    
    if (monitorEnabled) {
      monitorStatus.textContent = getMessage('monitorEnabled');
      statusIndicator.classList.remove('disabled');
    } else {
      monitorStatus.textContent = getMessage('monitorDisabled');
      statusIndicator.classList.add('disabled');
    }
  }
  
  // Update rule selector based on the current focus
  function updateRuleSelector() {
    ruleSelector.value = focusedRuleIds === null ? 'all' : (focusedRuleIds[0] || 'all');
  }
  
  // Populate rule selector dropdown
  function populateRuleSelector() {
    // Clear existing options except "all"
    const allOption = ruleSelector.querySelector('option[value="all"]');
    ruleSelector.innerHTML = '';
    ruleSelector.appendChild(allOption);
    
    // Add rule options. A rule without an id cannot be filtered on, so it is
    // left out until the background migration gives it one.
    allRules.forEach((rule, index) => {
      if (!rule.id) {
        return;
      }

      const option = document.createElement('option');
      option.value = rule.id;
      option.textContent = rule.name || `${getMessage('rule')} ${index + 1}`;
      ruleSelector.appendChild(option);
    });
    
    updateRuleSelector();
  }
  
  // Save monitor settings to storage
  function saveMonitorSettings() {
    chrome.storage.sync.set({
      monitorEnabled: monitorEnabled
    });

    // Notify background script about settings change
    chrome.runtime.sendMessage({
      action: 'updateMonitorSettings',
      settings: {
        enabled: monitorEnabled
      }
    });
  }

  // Save the focused rules through the background so its in-memory copy is
  // updated before the next query runs. The background owns the write, which
  // keeps a single writer for this key.
  function saveFocusedRules(callback) {
    chrome.runtime.sendMessage({
      action: 'setFocusedRules',
      focusedRuleIds: focusedRuleIds
    }, () => {
      if (callback) {
        callback();
      }
    });
  }
  
  // Load and display URLs
  function loadUrls() {
    loading.style.display = 'block';
    urlList.style.display = 'none';
    emptyState.style.display = 'none';
    
    // Check if we should filter by current tab only (default: true)
    const currentTabOnly = tabFilterToggle ? tabFilterToggle.checked : true;
    
    chrome.runtime.sendMessage({
      action: 'getFoundUrls',
      currentTabOnly: currentTabOnly
    }, (response) => {
      loading.style.display = 'none';
      
      if (response && response.urls && response.urls.length > 0) {
        displayUrls(response.urls);
        const filterText = currentTabOnly ? getMessage('currentTab') : getMessage('allTabs');
        urlCount.textContent = getMessage('foundUrls', [response.urls.length.toString(), filterText]);
      } else {
        emptyState.style.display = 'block';
        const filterText = currentTabOnly ? getMessage('currentTab') : getMessage('allTabs');
        urlCount.textContent = getMessage('foundUrls', ['0', filterText]);
      }
    });
  }
  
  // Display URLs in the list
  function displayUrls(urls) {
    urlList.innerHTML = '';
    urlList.style.display = 'block';
    
    // Sort by timestamp (newest first)
    const sortedUrls = urls.sort((a, b) => b.timestamp - a.timestamp);
    
    sortedUrls.forEach((urlData, index) => {
      const urlItem = document.createElement('div');
      urlItem.className = 'url-item';
      
      const timeString = new Date(urlData.timestamp).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      
      // Get tab title, truncate if too long
      const tabTitle = urlData.tabTitle || getMessage('unknown');
      const displayTitle = tabTitle.length > 50 ? tabTitle.substring(0, 50) + '...' : tabTitle;
      const tabPrefix = getMessage('tab') + ': ';
      
      urlItem.innerHTML = `
        <div class="tab-title" title="${escapeHtml(tabTitle)}" data-tab-prefix="${escapeHtml(tabPrefix)}">${escapeHtml(displayTitle)}</div>
        <div class="url-meta">
          <span>${getMessage('rule')}: ${urlData.rule.name || urlData.rule.type}</span>
          <span>${timeString}</span>
        </div>
        <div class="url-text">${urlData.url}</div>
        <div class="url-actions">
          <button class="copy-btn" data-url="${encodeURIComponent(urlData.url)}">${getMessage('copyUrl')}</button>
        </div>
      `;
      
      urlList.appendChild(urlItem);
    });
    
    // Add copy event listeners
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const url = decodeURIComponent(this.getAttribute('data-url'));
        navigator.clipboard.writeText(url).then(() => {
          const originalText = this.textContent;
          this.textContent = getMessage('copied');
          this.style.background = '#61dafb';
          
          setTimeout(() => {
            this.textContent = originalText;
            this.style.background = '#98c379';
          }, 1500);
        }).catch(err => {
          console.error('Failed to copy URL:', err);
          this.textContent = getMessage('copyFailed');
          setTimeout(() => {
            this.textContent = getMessage('copyUrl');
          }, 1500);
        });
      });
    });
  }
  
  // Monitor toggle event
  monitorToggle.addEventListener('change', function() {
    monitorEnabled = this.checked;
    updateMonitorUI();
    saveMonitorSettings();
  });
  
  // Rule selector change event
  ruleSelector.addEventListener('change', function() {
    focusedRuleIds = this.value === 'all' ? null : [this.value];
    saveFocusedRules(loadUrls);
  });
  
  // Refresh button
  refreshBtn.addEventListener('click', function() {
    loadUrls();
  });
  
  // Clear button
  clearBtn.addEventListener('click', function() {
    if (confirm(getMessage('confirmClearAll'))) {
      chrome.runtime.sendMessage({ action: 'clearFoundUrls' }, (response) => {
        if (response && response.success) {
          loadUrls();
        }
      });
    }
  });
  
  // Options button and link
  function openOptions() {
    chrome.runtime.openOptionsPage();
  }
  
  optionsBtn.addEventListener('click', openOptions);
  optionsLink.addEventListener('click', function(e) {
    e.preventDefault();
    openOptions();
  });
  
  // Tab filter toggle
  if (tabFilterToggle) {
    // Set default to current tab only
    tabFilterToggle.checked = true;
    
    tabFilterToggle.addEventListener('change', function() {
      loadUrls();
    });
  }
  
  // Initialize popup
  init();
});
