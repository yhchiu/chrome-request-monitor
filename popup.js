// Popup script for Chrome extension
document.addEventListener('DOMContentLoaded', function() {
  const urlList = document.getElementById('urlList');
  const emptyState = document.getElementById('emptyState');
  const loading = document.getElementById('loading');
  const urlCount = document.getElementById('urlCount');
  const refreshBtn = document.getElementById('refreshBtn');
  const clearBtn = document.getElementById('clearBtn');
  const optionsBtn = document.getElementById('optionsBtn');
  const optionsLink = document.getElementById('optionsLink');
  
  // Load and display URLs
  function loadUrls() {
    loading.style.display = 'block';
    urlList.style.display = 'none';
    emptyState.style.display = 'none';
    
    chrome.runtime.sendMessage({ action: 'getFoundUrls' }, (response) => {
      loading.style.display = 'none';
      
      if (response && response.urls && response.urls.length > 0) {
        displayUrls(response.urls);
        urlCount.textContent = `找到 ${response.urls.length} 個URL`;
      } else {
        emptyState.style.display = 'block';
        urlCount.textContent = '找到 0 個URL';
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
      
      const timeString = new Date(urlData.timestamp).toLocaleTimeString('zh-TW', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      
      urlItem.innerHTML = `
        <div class="url-meta">
          <span>規則: ${urlData.rule.name || urlData.rule.type}</span>
          <span>${timeString}</span>
        </div>
        <div class="url-text">${urlData.url}</div>
        <div class="url-actions">
          <button class="copy-btn" data-url="${encodeURIComponent(urlData.url)}">複製URL</button>
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
          this.textContent = '已複製!';
          this.style.background = '#61dafb';
          
          setTimeout(() => {
            this.textContent = originalText;
            this.style.background = '#98c379';
          }, 1500);
        }).catch(err => {
          console.error('Failed to copy URL:', err);
          this.textContent = '複製失敗';
          setTimeout(() => {
            this.textContent = '複製URL';
          }, 1500);
        });
      });
    });
  }
  
  // Refresh button
  refreshBtn.addEventListener('click', function() {
    loadUrls();
  });
  
  // Clear button
  clearBtn.addEventListener('click', function() {
    if (confirm('確定要清除所有找到的URL嗎？')) {
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
  
  // Initial load
  loadUrls();
}); 