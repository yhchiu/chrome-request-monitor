// Popup script for Chrome extension
// escapeHtml comes from escape-html.js, loaded before this file.

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
  const emptyStateTitle = document.getElementById('emptyStateTitle');
  const emptyStateHint = document.getElementById('emptyStateHint');
  const showAllRulesBtn = document.getElementById('showAllRulesBtn');

  // Monitor control elements
  const monitorToggle = document.getElementById('monitorToggle');
  const monitorStatus = document.getElementById('monitorStatus');
  const statusIndicator = document.getElementById('statusIndicator');
  const ruleFocusList = document.getElementById('ruleFocusList');
  
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

      updateFocusCheckboxes();
      loadUrlsWhenReady();
    });
  }

  // Load rules from storage
  function loadRules() {
    chrome.storage.sync.get(['urlRules'], (result) => {
      allRules = result.urlRules || [];
      rulesLoaded = true;

      renderRuleFocusList();
      loadUrlsWhenReady();
    });
  }

  // Whether every stored setting is back, so a query runs against the focus the
  // user actually chose rather than the defaults this page starts with
  function isReady() {
    return monitorSettingsLoaded && focusedRulesLoaded && rulesLoaded;
  }

  // Load URLs once the focus and the rule list are both known, so a focus
  // pointing at a deleted rule is caught before the first query.
  function loadUrlsWhenReady() {
    if (!isReady()) {
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
    updateFocusCheckboxes();
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

    setFocusListEnabled(monitorEnabled);
  }

  // The list is empty for two different reasons, and they need different words
  function showEmptyState() {
    const noRulesShown = Array.isArray(focusedRuleIds) && focusedRuleIds.length === 0;

    emptyState.style.display = 'block';
    emptyStateTitle.textContent = getMessage(noRulesShown ? 'noFocusedRules' : 'noMatchingUrls');
    emptyStateHint.style.display = noRulesShown ? 'none' : 'block';
    showAllRulesBtn.style.display = noRulesShown ? 'inline-flex' : 'none';
  }
  
  // Tick the boxes that match the current focus
  function updateFocusCheckboxes() {
    ruleFocusList.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
      checkbox.checked = checkbox.value === 'all'
        ? focusedRuleIds === null
        : (focusedRuleIds === null || focusedRuleIds.includes(checkbox.value));
    });
  }

  // Build the list of rules that can be shown
  function renderRuleFocusList() {
    ruleFocusList.innerHTML = '';
    ruleFocusList.appendChild(createFocusOption('all', getMessage('allRules')));

    // A rule without an id cannot be focused, so it is left out until the
    // background migration gives it one.
    allRules.forEach((rule, index) => {
      if (!rule.id) {
        return;
      }

      ruleFocusList.appendChild(
        createFocusOption(rule.id, rule.name || `${getMessage('rule')} ${index + 1}`)
      );
    });

    updateFocusCheckboxes();
    setFocusListEnabled(monitorEnabled);
  }

  function createFocusOption(value, label) {
    const option = document.createElement('label');
    option.className = 'rule-focus-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = value;
    checkbox.addEventListener('change', function() {
      if (this.value === 'all') {
        focusedRuleIds = this.checked ? null : [];
      } else {
        toggleRuleFocus(this.value, this.checked);
      }

      updateFocusCheckboxes();
      saveFocusedRules(loadUrls);
    });

    const text = document.createElement('span');
    text.textContent = label;

    option.appendChild(checkbox);
    option.appendChild(text);
    return option;
  }

  // Add or remove one rule from the focus
  function toggleRuleFocus(ruleId, isFocused) {
    const ruleIds = allRules.filter(rule => rule.id).map(rule => rule.id);
    const selected = new Set(focusedRuleIds === null ? ruleIds : focusedRuleIds);

    if (isFocused) {
      selected.add(ruleId);
    } else {
      selected.delete(ruleId);
    }

    // Keep the rule order so the stored value is stable
    const next = ruleIds.filter(id => selected.has(id));

    // Every rule selected means the same as no focus at all. Store it that way
    // so "show everything" has a single representation.
    focusedRuleIds = next.length === ruleIds.length ? null : next;
  }

  // The monitor being off makes the focus meaningless, but the choice is kept
  // so turning it back on restores what the user was looking at.
  function setFocusListEnabled(isEnabled) {
    ruleFocusList.classList.toggle('disabled', !isEnabled);
    ruleFocusList.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
      checkbox.disabled = !isEnabled;
    });
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
  
  // Load and display URLs.
  //
  // A quiet load is one the user did not ask for, so it leaves what is on
  // screen alone until the answer is back. Blanking the list out behind the
  // loading indicator is right for a button press, but doing it every time
  // something new is captured would make the list flicker as the user reads it.
  function loadUrls({ quiet = false } = {}) {
    if (!quiet) {
      loading.style.display = 'block';
      urlList.style.display = 'none';
      emptyState.style.display = 'none';
    }

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
        showEmptyState();
        const filterText = currentTabOnly ? getMessage('currentTab') : getMessage('allTabs');
        urlCount.textContent = getMessage('foundUrls', ['0', filterText]);
      }
    });
  }
  
  // Name every rule a captured URL matched. A URL can match more than one, and
  // naming only the first left the row claiming a rule the user may not even
  // be showing.
  function describeMatchedRules(urlData) {
    const rules = Array.isArray(urlData.rules) ? urlData.rules : [];
    return rules.map(rule => rule.name || rule.type).join(', ');
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
          <span>${getMessage('rule')}: ${escapeHtml(describeMatchedRules(urlData))}</span>
          <span>${timeString}</span>
        </div>
        <div class="url-text">${escapeHtml(urlData.url)}</div>
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
  
  // Escape hatch from the empty state when nothing is being shown
  showAllRulesBtn.addEventListener('click', function() {
    focusedRuleIds = null;
    updateFocusCheckboxes();
    saveFocusedRules(loadUrls);
  });
  
  // Show what has just been captured without waiting for the refresh button.
  //
  // The background already backs the captured URLs up to session storage on a
  // short timer, so that write is a signal this page can listen for. Nothing
  // new is sent for it: no message per capture that would be wasted whenever
  // the popup is closed, and no polling that would wake the Service Worker just
  // to be told nothing has happened. The write is coalesced, so a busy page
  // reloads the list about once a second rather than once per request.
  chrome.storage.onChanged.addListener(function(changes, areaName) {
    if (areaName !== 'session' || !changes.foundUrls) {
      return;
    }

    // Before the stored settings are back there is nothing to update: the load
    // that init is already waiting to run will pick these up.
    if (!isReady()) {
      return;
    }

    loadUrls({ quiet: true });
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
