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
  const saveOverlaySettings = document.getElementById('saveOverlaySettings');
  
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
    contains: '輸入URL中應包含的文字，例如：api.example.com',
    startswith: '輸入URL的開頭部分，例如：https://api.',
    endswith: '輸入URL的結尾部分，例如：.json 或 /api/data',
    regex: '輸入正則表達式，例如：/api/v\\d+/users （不需要包含斜線）'
  };
  
  // Update help text when rule type changes
  ruleType.addEventListener('change', function() {
    const selectedType = this.value;
    if (selectedType && helpTexts[selectedType]) {
      ruleHelp.textContent = helpTexts[selectedType];
    } else {
      ruleHelp.textContent = '請先選擇匹配類型';
    }
  });
  
  // Show alert message
  function showAlert(message, type = 'success') {
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;
    alert.textContent = message;
    
    alertContainer.innerHTML = '';
    alertContainer.appendChild(alert);
    
    setTimeout(() => {
      alert.remove();
    }, 5000);
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
  
  // Save overlay settings
  function saveOverlaySettingsFunction() {
    const maxValue = parseInt(maxOverlays.value);
    const timeoutValue = parseInt(overlayTimeout.value);
    
    // Validate input
    if (maxValue < 1 || maxValue > 20) {
      showAlert('最大覆蓋框數量必須在1-20之間', 'error');
      return;
    }
    
    if (timeoutValue < 5 || timeoutValue > 300) {
      showAlert('超時時間必須在5-300秒之間', 'error');
      return;
    }
    
    const settings = {
      maxOverlays: maxValue,
      timeoutSeconds: timeoutValue
    };
    
    chrome.storage.sync.set({ overlaySettings: settings }, function() {
      if (chrome.runtime.lastError) {
        showAlert('儲存覆蓋框設定時發生錯誤：' + chrome.runtime.lastError.message, 'error');
      } else {
        showAlert('覆蓋框設定已成功儲存！');
      }
    });
  }
  
  // Display rules in the list
  function displayRules(rules) {
    if (rules.length === 0) {
      rulesList.innerHTML = `
        <div class="empty-state">
          <div class="icon">🔍</div>
          <div>尚未設定任何規則</div>
          <div style="font-size: 12px; margin-top: 8px; color: #999;">
            新增第一個規則來開始監控網絡請求
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
          contains: '包含',
          startswith: '開頭匹配',
          endswith: '結尾匹配',
          regex: '正則表達式'
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
            <button class="btn btn-danger btn-sm delete-rule" data-index="${index}">
              🗑️ 刪除
            </button>
          </div>
        `;
        
        rulesList.appendChild(ruleItem);
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
  
  // Add new rule
  ruleForm.addEventListener('submit', function(e) {
    e.preventDefault();
    
    const name = document.getElementById('ruleName').value.trim();
    const type = document.getElementById('ruleType').value;
    const value = document.getElementById('ruleValue').value.trim();
    
    if (!name || !type || !value) {
      showAlert('請填寫所有必填欄位', 'error');
      return;
    }
    
    // Validate regex if type is regex
    if (type === 'regex') {
      try {
        new RegExp(value);
      } catch (e) {
        showAlert('正則表達式格式不正確：' + e.message, 'error');
        return;
      }
    }
    
    // Get existing rules
    chrome.storage.sync.get(['urlRules'], function(result) {
      const rules = result.urlRules || [];
      
      // Check for duplicate names
      if (rules.some(rule => rule.name.toLowerCase() === name.toLowerCase())) {
        showAlert('規則名稱已存在，請使用不同的名稱', 'error');
        return;
      }
      
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
          showAlert('儲存規則時發生錯誤：' + chrome.runtime.lastError.message, 'error');
        } else {
          showAlert('規則已成功新增！');
          ruleForm.reset();
          ruleHelp.textContent = '請先選擇匹配類型';
          loadRules();
        }
      });
    });
  });
  
  // Delete rule
  function deleteRule(index) {
    if (confirm('確定要刪除這個規則嗎？')) {
      chrome.storage.sync.get(['urlRules'], function(result) {
        const rules = result.urlRules || [];
        
        if (index >= 0 && index < rules.length) {
          const deletedRule = rules.splice(index, 1)[0];
          
          chrome.storage.sync.set({ urlRules: rules }, function() {
            if (chrome.runtime.lastError) {
              showAlert('刪除規則時發生錯誤：' + chrome.runtime.lastError.message, 'error');
            } else {
              showAlert(`規則「${deletedRule.name}」已刪除`);
              loadRules();
            }
          });
        }
      });
    }
  }
  
  // Clear all rules
  clearAllBtn.addEventListener('click', function() {
    if (confirm('確定要刪除所有規則嗎？此操作無法復原。')) {
      chrome.storage.sync.set({ urlRules: [] }, function() {
        if (chrome.runtime.lastError) {
          showAlert('清除規則時發生錯誤：' + chrome.runtime.lastError.message, 'error');
        } else {
          showAlert('所有規則已清除');
          loadRules();
        }
      });
    }
  });
  
  // Initial load
  loadRules();
  loadOverlaySettings();
  
  // Overlay settings event listener
  saveOverlaySettings.addEventListener('click', saveOverlaySettingsFunction);
}); 