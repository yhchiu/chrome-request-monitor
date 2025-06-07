// Options page script for Chrome extension
document.addEventListener('DOMContentLoaded', function() {
  const ruleForm = document.getElementById('ruleForm');
  const rulesList = document.getElementById('rulesList');
  const clearAllBtn = document.getElementById('clearAllBtn');
  const alertContainer = document.getElementById('alertContainer');
  const ruleType = document.getElementById('ruleType');
  const ruleHelp = document.getElementById('ruleHelp');
  
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
}); 