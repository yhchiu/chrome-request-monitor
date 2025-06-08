// Options page script for Chrome extension
document.addEventListener('DOMContentLoaded', function() {
  const ruleForm = document.getElementById('ruleForm');
  const rulesList = document.getElementById('rulesList');
  const clearAllBtn = document.getElementById('clearAllBtn');
  const alertContainer = document.getElementById('alertContainer');
  const ruleType = document.getElementById('ruleType');
  const ruleHelp = document.getElementById('ruleHelp');
  
  // Tab elements
  const tabButtons = document.querySelectorAll('.tab-button');
  const tabContents = document.querySelectorAll('.tab-content');
  const tabsContainer = document.getElementById('tabsContainer');
  const leftIndicator = document.querySelector('.scroll-indicator.left');
  const rightIndicator = document.querySelector('.scroll-indicator.right');
  
  // Overflow menu elements
  const overflowButton = document.getElementById('overflowButton');
  const overflowCount = document.getElementById('overflowCount');
  const overflowDropdown = document.getElementById('overflowDropdown');
  let overflowTabs = [];
  
  // Overlay settings elements
  const maxOverlays = document.getElementById('maxOverlays');
  const overlayTimeout = document.getElementById('overlayTimeout');
  const saveButton = document.getElementById('saveButton');
  
  // Data management elements
  const maxStorageLimit = document.getElementById('maxStorageLimit');
  const saveDataButton = document.getElementById('saveDataButton');
  
  // Import/Export elements
  const exportButton = document.getElementById('exportButton');
  const importButton = document.getElementById('importButton');
  const importFile = document.getElementById('importFile');
  
  // Edit form elements
  const editingIndex = document.getElementById('editingIndex');
  const addButton = document.getElementById('addButton');
  const updateButton = document.getElementById('updateButton');
  const cancelButton = document.getElementById('cancelButton');
  
  // Tab switching functionality
  function switchTab(tabName) {
    // Remove active class from all buttons and contents
    tabButtons.forEach(btn => btn.classList.remove('active'));
    tabContents.forEach(content => content.classList.remove('active'));
    
    // Add active class to selected button and content
    const selectedButton = document.querySelector(`[data-tab="${tabName}"]`);
    const selectedContent = document.getElementById(`${tabName}-tab`);
    
    if (selectedButton && selectedContent) {
      selectedButton.classList.add('active');
      selectedContent.classList.add('active');
    }
  }
  
  // Add click listeners to tab buttons
  tabButtons.forEach(button => {
    button.addEventListener('click', function() {
      const tabName = this.getAttribute('data-tab');
      switchTab(tabName);
      
      // Ensure the active tab is visible
      scrollTabIntoView(this);
    });
  });
  
  // Scroll indicators functionality
  function updateScrollIndicators() {
    if (!tabsContainer) return;
    
    const scrollLeft = tabsContainer.scrollLeft;
    const scrollWidth = tabsContainer.scrollWidth;
    const clientWidth = tabsContainer.clientWidth;
    
    // Show/hide left indicator
    if (leftIndicator) {
      leftIndicator.classList.toggle('visible', scrollLeft > 0);
    }
    
    // Show/hide right indicator
    if (rightIndicator) {
      rightIndicator.classList.toggle('visible', scrollLeft < scrollWidth - clientWidth - 1);
    }
  }
  
  // Scroll active tab into view
  function scrollTabIntoView(tabButton) {
    if (!tabsContainer || !tabButton) return;
    
    const containerRect = tabsContainer.getBoundingClientRect();
    const buttonRect = tabButton.getBoundingClientRect();
    
    if (buttonRect.left < containerRect.left) {
      // Scroll left
      tabsContainer.scrollLeft -= containerRect.left - buttonRect.left + 20;
    } else if (buttonRect.right > containerRect.right) {
      // Scroll right
      tabsContainer.scrollLeft += buttonRect.right - containerRect.right + 20;
    }
  }
  
  // Add scroll listener to tabs container
  if (tabsContainer) {
    tabsContainer.addEventListener('scroll', updateScrollIndicators);
    
    // Initial check for scroll indicators and overflow
    setTimeout(() => {
      calculateOverflow();
      updateScrollIndicators();
    }, 100);
    
    // Update on window resize
    window.addEventListener('resize', () => {
      setTimeout(() => {
        calculateOverflow();
        updateScrollIndicators();
      }, 100);
    });
  }
  
  // Utility function to add new tab (for future use)
  function addTab(id, label, content) {
    // Create tab button
    const tabButton = document.createElement('button');
    tabButton.className = 'tab-button';
    tabButton.setAttribute('data-tab', id);
    tabButton.textContent = label;
    
    // Add click listener
    tabButton.addEventListener('click', function() {
      const tabName = this.getAttribute('data-tab');
      switchTab(tabName);
      scrollTabIntoView(this);
    });
    
    // Add to tabs container
    if (tabsContainer) {
      tabsContainer.appendChild(tabButton);
    }
    
    // Create tab content
    const tabContent = document.createElement('div');
    tabContent.id = `${id}-tab`;
    tabContent.className = 'tab-content';
    tabContent.innerHTML = content;
    
    // Add to content area
    const contentArea = document.querySelector('.content');
    if (contentArea) {
      contentArea.appendChild(tabContent);
    }
    
    // Update scroll indicators and overflow
    setTimeout(() => {
      calculateOverflow();
      updateScrollIndicators();
    }, 100);
    
    return { button: tabButton, content: tabContent };
  }
  
  // Make addTab available globally for future extensions
  window.addTab = addTab;
  
  // Overflow menu functionality
  function calculateOverflow() {
    if (!tabsContainer || !overflowButton) return;
    
    // Get the tabs-container (parent) width instead of tabs width
    const tabsContainerElement = tabsContainer.parentElement;
    const containerRect = tabsContainerElement.getBoundingClientRect();
    const containerWidth = containerRect.width;
    const overflowButtonWidth = 100; // Reserve space for overflow button
    const availableWidth = containerWidth - overflowButtonWidth;
    
    let currentWidth = 0;
    const visibleTabs = [];
    const hiddenTabs = [];
    
    // Get all tab buttons (excluding overflow button)
    const allTabs = Array.from(tabsContainer.querySelectorAll('.tab-button'));
    
    allTabs.forEach((tab, index) => {
      const tabRect = tab.getBoundingClientRect();
      const tabWidth = tabRect.width || 120; // Fallback width
      
      if (currentWidth + tabWidth <= availableWidth || index === 0) {
        // Always show at least the first tab
        visibleTabs.push(tab);
        currentWidth += tabWidth;
        tab.style.display = 'block';
      } else {
        hiddenTabs.push(tab);
        tab.style.display = 'none';
      }
    });
    
    // Update overflow menu
    overflowTabs = hiddenTabs;
    updateOverflowMenu();
  }
  
  function updateOverflowMenu() {
    if (!overflowButton || !overflowCount || !overflowDropdown) return;
    
    if (overflowTabs.length > 0) {
      // Show overflow button
      overflowButton.classList.add('visible');
      overflowCount.textContent = overflowTabs.length;
      
      // Populate dropdown
      overflowDropdown.innerHTML = '';
      overflowTabs.forEach(tab => {
        const dropdownItem = document.createElement('button');
        dropdownItem.className = 'overflow-dropdown-item';
        dropdownItem.textContent = tab.textContent;
        dropdownItem.setAttribute('data-tab', tab.getAttribute('data-tab'));
        
        // Check if this tab is currently active
        if (tab.classList.contains('active')) {
          dropdownItem.classList.add('active');
        }
        
        // Add click listener
        dropdownItem.addEventListener('click', function(e) {
          e.stopPropagation();
          const tabName = this.getAttribute('data-tab');
          switchTab(tabName);
          hideOverflowDropdown();
        });
        
        overflowDropdown.appendChild(dropdownItem);
      });
    } else {
      // Hide overflow button
      overflowButton.classList.remove('visible');
      overflowDropdown.innerHTML = '';
    }
  }
  
  function showOverflowDropdown() {
    if (overflowDropdown) {
      overflowDropdown.classList.add('visible');
    }
  }
  
  function hideOverflowDropdown() {
    if (overflowDropdown) {
      overflowDropdown.classList.remove('visible');
    }
  }
  
  function toggleOverflowDropdown() {
    if (overflowDropdown && overflowDropdown.classList.contains('visible')) {
      hideOverflowDropdown();
    } else {
      showOverflowDropdown();
    }
  }
  
  // Overflow button click handler
  if (overflowButton) {
    overflowButton.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleOverflowDropdown();
    });
  }
  
  // Close dropdown when clicking outside
  document.addEventListener('click', function(e) {
    if (overflowDropdown && !overflowButton.contains(e.target) && !overflowDropdown.contains(e.target)) {
      hideOverflowDropdown();
    }
  });
  
  // Enhanced switchTab function to handle overflow
  const originalSwitchTab = switchTab;
  switchTab = function(tabName) {
    originalSwitchTab(tabName);
    
    // Update overflow dropdown active states
    if (overflowDropdown) {
      const dropdownItems = overflowDropdown.querySelectorAll('.overflow-dropdown-item');
      dropdownItems.forEach(item => {
        if (item.getAttribute('data-tab') === tabName) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });
    }
  };
  
  // Help text for different rule types
  const helpTexts = {
    contains: () => getMessage('helpContains'),
    startswith: () => getMessage('helpStartswith'),
    endswith: () => getMessage('helpEndswith'),
    regex: () => getMessage('helpRegex')
  };
  
  // Update help text when rule type changes
  ruleType.addEventListener('change', function() {
    const selectedType = this.value;
    if (selectedType && helpTexts[selectedType]) {
      ruleHelp.textContent = helpTexts[selectedType]();
    } else {
      ruleHelp.textContent = getMessage('selectMatchTypeFirst');
    }
  });
  
  // Show overlay notice message
  function showAlert(message, type = 'success', duration = 5000) {
    // Validate duration
    if (duration < 5000 || duration > 30000) {
      duration = 5000;
    }
    
    // Create overlay notice container if it doesn't exist
    let noticeContainer = document.getElementById('overlayNoticeContainer');
    if (!noticeContainer) {
      noticeContainer = document.createElement('div');
      noticeContainer.id = 'overlayNoticeContainer';
      noticeContainer.style.cssText = `
        position: fixed;
        top: 0;
        right: 0;
        z-index: 10000;
        pointer-events: none;
      `;
      document.body.appendChild(noticeContainer);
    }

    // Create notice element
    const notice = document.createElement('div');
    notice.className = `overlay-notice overlay-notice-${type}`;
    notice.style.pointerEvents = 'auto';
    
    // Get icon based on type
    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };
    
    notice.innerHTML = `
      <div class="overlay-notice-icon">${icons[type] || icons.success}</div>
      <div class="overlay-notice-content">${message}</div>
      <button class="overlay-notice-close" aria-label="關閉">×</button>
      <div class="overlay-notice-progress"></div>
    `;
    
    // Add to container
    noticeContainer.appendChild(notice);
    
    // Position multiple notices
    const existingNotices = noticeContainer.children.length;
    const noticeIndex = existingNotices - 1;
    
    // Set initial position for all notices
    notice.style.top = `${20 + noticeIndex * 80}px`;
    notice.style.transform = `translateX(100%) scale(${1 - noticeIndex * 0.05})`;
    
        // Show animation
    requestAnimationFrame(() => {
      notice.style.transform = `translateX(0) scale(${1 - noticeIndex * 0.05})`;
      notice.classList.add('show');
      
      // Progress bar animation - start after the notice is visible
      const progressBar = notice.querySelector('.overlay-notice-progress');
      
      // Force initial state without transition
      progressBar.style.transition = 'none';
      progressBar.style.width = '100%';
      
      // Force reflow to ensure the width is applied
      progressBar.offsetWidth;
      
      // Enable transition and start countdown
      requestAnimationFrame(() => {
        progressBar.style.transition = `width ${duration}ms linear`;
        requestAnimationFrame(() => {
          progressBar.style.width = '0%';
        });
      });
    });
    
    // Close button functionality
    const closeBtn = notice.querySelector('.overlay-notice-close');
    closeBtn.addEventListener('click', () => {
      removeNotice(notice);
    });
    
    // Auto remove after duration
    const timeoutId = setTimeout(() => {
      removeNotice(notice);
    }, duration);
    
    // Remove notice function
    function removeNotice(noticeElement) {
      clearTimeout(timeoutId);
      
      // Start hide animation
      noticeElement.style.transform = `translateX(100%) ${noticeElement.style.transform.includes('scale') ? noticeElement.style.transform.split('scale')[1] : 'scale(1)'}`;
      noticeElement.classList.remove('show');
      noticeElement.classList.add('hide');
      
      setTimeout(() => {
        if (noticeElement.parentNode) {
          noticeElement.parentNode.removeChild(noticeElement);
          
          // Reposition remaining notices
          const remainingNotices = Array.from(noticeContainer.children);
          remainingNotices.forEach((notice, index) => {
            notice.style.top = `${20 + index * 80}px`;
            notice.style.transform = `translateX(0) scale(${1 - index * 0.05})`;
          });
        }
      }, 400);
    }
    
    // Clean up old alertContainer content (for backward compatibility)
    if (alertContainer) {
      alertContainer.innerHTML = '';
    }
  }
  
  // Load and display rules
  function loadRules() {
    chrome.storage.sync.get(['urlRules'], function(result) {
      const rules = result.urlRules || [];
      displayRules(rules);
    });
  }
  
  // Load overlay settings
  function loadOverlaySettings() {
    chrome.storage.sync.get(['overlaySettings'], function(result) {
      const settings = result.overlaySettings || {
        maxOverlays: 5,
        timeoutSeconds: 30
      };
      
      maxOverlays.value = settings.maxOverlays;
      overlayTimeout.value = settings.timeoutSeconds;
    });
  }
  
  // Load data management settings
  function loadDataSettings() {
    chrome.storage.sync.get(['dataSettings'], function(result) {
      const settings = result.dataSettings || {
        maxStorageLimit: 100
      };
      
      maxStorageLimit.value = settings.maxStorageLimit;
    });
  }
  
  // Save settings
  function saveSettingsFunction() {
    const maxValue = parseInt(maxOverlays.value);
    const timeoutValue = parseInt(overlayTimeout.value);
    
    // Validate input
    if (maxValue < 1 || maxValue > 20) {
      showAlert(getMessage('errorMaxOverlaysRange'), 'error');
      return;
    }
    
    if (timeoutValue < 5 || timeoutValue > 300) {
      showAlert(getMessage('errorTimeoutRange'), 'error');
      return;
    }
    
    const settings = {
      maxOverlays: maxValue,
      timeoutSeconds: timeoutValue
    };
    
    chrome.storage.sync.set({ overlaySettings: settings }, function() {
      if (chrome.runtime.lastError) {
        showAlert(getMessage('errorSavingSettings', [chrome.runtime.lastError.message]), 'error');
      } else {
        showAlert(getMessage('settingsSaved'));
      }
    });
  }
  
  // Save data settings
  function saveDataSettingsFunction() {
    const limitValue = parseInt(maxStorageLimit.value);
    
    // Validate input
    if (limitValue < 10 || limitValue > 1000) {
      showAlert(getMessage('errorStorageLimitRange'), 'error');
      return;
    }
    
    const settings = {
      maxStorageLimit: limitValue
    };
    
    chrome.storage.sync.set({ dataSettings: settings }, function() {
      if (chrome.runtime.lastError) {
        showAlert(getMessage('errorSavingDataSettings', [chrome.runtime.lastError.message]), 'error');
      } else {
        showAlert(getMessage('settingsSaved'));
      }
    });
  }
  
  // Export settings function
  function exportSettings() {
    chrome.storage.sync.get(['urlRules', 'overlaySettings', 'dataSettings'], function(result) {
      const settings = {
        exportDate: new Date().toISOString(),
        extensionVersion: chrome.runtime.getManifest().version,
        urlRules: result.urlRules || [],
        overlaySettings: result.overlaySettings || {
          maxOverlays: 5,
          timeoutSeconds: 30
        },
        dataSettings: result.dataSettings || {
          maxStorageLimit: 100
        }
      };
      
      const dataStr = JSON.stringify(settings, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `network-monitor-settings-${new Date().toISOString().split('T')[0]}.json`;
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      showAlert(getMessage('exportSuccess'));
    });
  }
  
  // Import settings function
  function importSettings(file) {
    if (!file) {
      showAlert(getMessage('errorNoFileSelected'), 'error');
      return;
    }
    
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const settings = JSON.parse(e.target.result);
        
        // Validate the imported settings structure
        if (!settings || typeof settings !== 'object') {
          throw new Error('Invalid settings file format');
        }
        
        // Prepare settings to save
        const settingsToSave = {};
        
        // Validate and prepare URL rules
        if (settings.urlRules && Array.isArray(settings.urlRules)) {
          settingsToSave.urlRules = settings.urlRules.filter(rule => 
            rule && rule.name && rule.type && rule.value
          );
        }
        
        // Validate and prepare overlay settings
        if (settings.overlaySettings && typeof settings.overlaySettings === 'object') {
          const overlay = settings.overlaySettings;
          if (overlay.maxOverlays >= 1 && overlay.maxOverlays <= 20 &&
              overlay.timeoutSeconds >= 5 && overlay.timeoutSeconds <= 300) {
            settingsToSave.overlaySettings = overlay;
          }
        }
        
        // Validate and prepare data settings
        if (settings.dataSettings && typeof settings.dataSettings === 'object') {
          const data = settings.dataSettings;
          if (data.maxStorageLimit >= 10 && data.maxStorageLimit <= 1000) {
            settingsToSave.dataSettings = data;
          }
        }
        
        // Save settings
        chrome.storage.sync.set(settingsToSave, function() {
          if (chrome.runtime.lastError) {
            showAlert(getMessage('errorImportingSettings', [chrome.runtime.lastError.message]), 'error');
          } else {
            showAlert(getMessage('importSuccess'));
            // Reload the page to reflect imported settings
            setTimeout(() => {
              location.reload();
            }, 1500);
          }
        });
        
      } catch (error) {
        showAlert(getMessage('errorInvalidSettingsFile', [error.message]), 'error');
      }
    };
    
    reader.onerror = function() {
      showAlert(getMessage('errorReadingFile'), 'error');
    };
    
    reader.readAsText(file);
  }
  
  // Display rules in the list
  function displayRules(rules) {
    if (rules.length === 0) {
      rulesList.innerHTML = `
        <div class="empty-state">
          <div class="icon">🔍</div>
          <div>${getMessage('noRulesYet')}</div>
          <div style="font-size: 12px; margin-top: 8px; color: #999;">
            ${getMessage('addFirstRule')}
          </div>
        </div>
      `;
      clearAllBtn.style.display = 'none';
    } else {
      rulesList.innerHTML = '';
      clearAllBtn.style.display = 'inline-block';
      
      rules.forEach((rule, index) => {
        const ruleItem = document.createElement('div');
        ruleItem.className = 'rule-item';
        
        // Format rule type display
        const typeLabels = {
          contains: getMessage('matchTypeContains'),
          startswith: getMessage('matchTypeStartswith'),
          endswith: getMessage('matchTypeEndswith'),
          regex: getMessage('matchTypeRegex')
        };
        
        ruleItem.innerHTML = `
          <div class="rule-info">
            <div class="rule-name">
              ${rule.name}
              <span class="rule-type">${typeLabels[rule.type] || rule.type}</span>
            </div>
            <div class="rule-details">${rule.value}</div>
          </div>
          <div class="rule-actions">
            <button class="btn btn-primary btn-sm edit-rule" data-index="${index}">
              ${getMessage('editRule')}
            </button>
            <button class="btn btn-danger btn-sm delete-rule" data-index="${index}">
              ${getMessage('deleteRule')}
            </button>
          </div>
        `;
        
        rulesList.appendChild(ruleItem);
      });
      
      // Add edit event listeners
      document.querySelectorAll('.edit-rule').forEach(btn => {
        btn.addEventListener('click', function() {
          const index = parseInt(this.getAttribute('data-index'));
          editRule(index);
        });
      });
      
      // Add delete event listeners
      document.querySelectorAll('.delete-rule').forEach(btn => {
        btn.addEventListener('click', function() {
          const index = parseInt(this.getAttribute('data-index'));
          deleteRule(index);
        });
      });
    }
  }
  
  // Add new rule or update existing rule
  ruleForm.addEventListener('submit', function(e) {
    e.preventDefault();
    
    const name = document.getElementById('ruleName').value.trim();
    const type = document.getElementById('ruleType').value;
    const value = document.getElementById('ruleValue').value.trim();
    const isEditing = editingIndex.value !== '';
    const editIndex = parseInt(editingIndex.value);
    
    if (!name || !type || !value) {
      showAlert(getMessage('errorAllFieldsRequired'), 'error');
      return;
    }
    
    // Validate regex if type is regex
    if (type === 'regex') {
      try {
        new RegExp(value);
      } catch (e) {
        showAlert(getMessage('errorInvalidRegex', [e.message]), 'error');
        return;
      }
    }
    
    // Get existing rules
    chrome.storage.sync.get(['urlRules'], function(result) {
      const rules = result.urlRules || [];
      
      // Check for duplicate names (excluding current rule when editing)
      const duplicateRule = rules.find((rule, index) => 
        rule.name.toLowerCase() === name.toLowerCase() && 
        (!isEditing || index !== editIndex)
      );
      
      if (duplicateRule) {
        showAlert(getMessage('errorDuplicateRuleName'), 'error');
        return;
      }
      
      if (isEditing) {
        // Update existing rule
        if (editIndex >= 0 && editIndex < rules.length) {
          rules[editIndex] = {
            ...rules[editIndex],
            name: name,
            type: type,
            value: value,
            updated: Date.now()
          };
          
          // Save to storage
          chrome.storage.sync.set({ urlRules: rules }, function() {
            if (chrome.runtime.lastError) {
              showAlert(getMessage('errorUpdatingRule', [chrome.runtime.lastError.message]), 'error');
            } else {
              showAlert(getMessage('ruleUpdatedSuccess'));
              resetForm();
              loadRules();
            }
          });
        }
      } else {
        // Add new rule
        const newRule = {
          name: name,
          type: type,
          value: value,
          created: Date.now()
        };
        
        rules.push(newRule);
        
        // Save to storage
        chrome.storage.sync.set({ urlRules: rules }, function() {
          if (chrome.runtime.lastError) {
            showAlert(getMessage('errorSavingRule', [chrome.runtime.lastError.message]), 'error');
          } else {
            showAlert(getMessage('ruleAddedSuccess'));
            resetForm();
            loadRules();
          }
        });
      }
    });
  });
  
  // Edit rule
  function editRule(index) {
    chrome.storage.sync.get(['urlRules'], function(result) {
      const rules = result.urlRules || [];
      
      if (index >= 0 && index < rules.length) {
        const rule = rules[index];
        
        // Fill form with rule data
        document.getElementById('ruleName').value = rule.name;
        document.getElementById('ruleType').value = rule.type;
        document.getElementById('ruleValue').value = rule.value;
        editingIndex.value = index.toString();
        
        // Update help text
        if (rule.type && helpTexts[rule.type]) {
          ruleHelp.textContent = helpTexts[rule.type]();
        }
        
        // Switch to edit mode
        const sectionTitle = document.querySelector('.section h2');
        sectionTitle.textContent = getMessage('editRuleTitle');
        addButton.style.display = 'none';
        updateButton.style.display = 'inline-block';
        cancelButton.style.display = 'inline-block';
        
        // Scroll to form
        document.querySelector('.section').scrollIntoView({ behavior: 'smooth' });
      }
    });
  }
  
  // Reset form to add mode
  function resetForm() {
    ruleForm.reset();
    editingIndex.value = '';
    ruleHelp.textContent = getMessage('selectMatchTypeFirst');
    
    // Switch back to add mode
    const sectionTitle = document.querySelector('.section h2');
    sectionTitle.setAttribute('data-i18n', 'addUrlRuleSection');
    sectionTitle.textContent = getMessage('addUrlRuleSection');
    addButton.style.display = 'inline-block';
    updateButton.style.display = 'none';
    cancelButton.style.display = 'none';
  }
  
  // Delete rule
  function deleteRule(index) {
    if (confirm(getMessage('confirmDeleteRule'))) {
      chrome.storage.sync.get(['urlRules'], function(result) {
        const rules = result.urlRules || [];
        
        if (index >= 0 && index < rules.length) {
          const deletedRule = rules.splice(index, 1)[0];
          
          chrome.storage.sync.set({ urlRules: rules }, function() {
            if (chrome.runtime.lastError) {
              showAlert(getMessage('errorDeletingRule', [chrome.runtime.lastError.message]), 'error');
            } else {
              showAlert(getMessage('ruleDeletedSuccess', [deletedRule.name]));
              // Reset form if we're editing the deleted rule
              if (editingIndex.value === index.toString()) {
                resetForm();
              }
              loadRules();
            }
          });
        }
      });
    }
  }
  
  // Clear all rules
  clearAllBtn.addEventListener('click', function() {
    if (confirm(getMessage('confirmClearAllRules'))) {
      chrome.storage.sync.set({ urlRules: [] }, function() {
        if (chrome.runtime.lastError) {
          showAlert(getMessage('errorClearingRules', [chrome.runtime.lastError.message]), 'error');
        } else {
          showAlert(getMessage('allRulesCleared'));
          loadRules();
        }
      });
    }
  });
  
  // Cancel edit button
  cancelButton.addEventListener('click', function() {
    resetForm();
  });
  
  // Initial load
  loadRules();
  loadOverlaySettings();
  loadDataSettings();
  
  // Settings event listeners
  saveButton.addEventListener('click', saveSettingsFunction);
  saveDataButton.addEventListener('click', saveDataSettingsFunction);
  
  // Import/Export event listeners
  exportButton.addEventListener('click', exportSettings);
  importButton.addEventListener('click', function() {
    importFile.click();
  });
  importFile.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
      importSettings(file);
      // Reset the file input
      e.target.value = '';
    }
  });
}); 