// Content script for showing URL overlays on web pages
let overlayContainer = null;

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'showUrlOverlay') {
    showUrlOverlay(request.data);
  }
});

function showUrlOverlay(urlData) {
  // Create overlay container if it doesn't exist
  if (!overlayContainer) {
    overlayContainer = document.createElement('div');
    overlayContainer.id = 'url-monitor-overlay-container';
    overlayContainer.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      max-width: 400px;
    `;
    document.body.appendChild(overlayContainer);
  }
  
  // Create individual overlay box
  const overlay = document.createElement('div');
  overlay.className = 'url-monitor-overlay';
  overlay.style.cssText = `
    background: rgba(40, 44, 52, 0.95);
    color: #fff;
    padding: 12px;
    border-radius: 8px;
    margin-bottom: 10px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    border: 1px solid #61dafb;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    font-size: 14px;
    line-height: 1.4;
    animation: slideIn 0.3s ease-out;
  `;
  
  // Add keyframe animation
  if (!document.getElementById('url-monitor-styles')) {
    const style = document.createElement('style');
    style.id = 'url-monitor-styles';
    style.textContent = `
      @keyframes slideIn {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
    `;
    document.head.appendChild(style);
  }
  
  // Create content
  const content = `
    <div style="margin-bottom: 8px;">
      <div style="color: #61dafb; font-weight: bold; margin-bottom: 4px;">找到匹配的URL:</div>
      <div style="word-break: break-all; background: rgba(255, 255, 255, 0.1); padding: 6px; border-radius: 4px; font-family: monospace; font-size: 12px;">
        ${urlData.url}
      </div>
    </div>
    <div style="margin-bottom: 8px;">
      <div style="color: #98c379; font-size: 12px;">
        規則: ${urlData.rule.name || urlData.rule.type} - ${urlData.rule.value}
      </div>
    </div>
    <div style="display: flex; gap: 8px; justify-content: flex-end;">
      <button class="copy-btn" style="
        background: #61dafb;
        color: #282c34;
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: bold;
        transition: all 0.2s;
      ">複製</button>
      <button class="close-btn" style="
        background: #e06c75;
        color: white;
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: bold;
        transition: all 0.2s;
      ">關閉</button>
    </div>
  `;
  
  overlay.innerHTML = content;
  
  // Add event listeners
  const copyBtn = overlay.querySelector('.copy-btn');
  const closeBtn = overlay.querySelector('.close-btn');
  
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(urlData.url).then(() => {
      copyBtn.textContent = '已複製!';
      copyBtn.style.background = '#98c379';
      setTimeout(() => {
        copyBtn.textContent = '複製';
        copyBtn.style.background = '#61dafb';
      }, 1500);
    });
  });
  
  copyBtn.addEventListener('mouseenter', () => {
    copyBtn.style.background = '#4fa8c5';
  });
  
  copyBtn.addEventListener('mouseleave', () => {
    if (copyBtn.textContent === '複製') {
      copyBtn.style.background = '#61dafb';
    }
  });
  
  closeBtn.addEventListener('click', () => {
    overlay.remove();
    if (overlayContainer && overlayContainer.children.length === 0) {
      overlayContainer.remove();
      overlayContainer = null;
    }
  });
  
  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.background = '#c24d5a';
  });
  
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.background = '#e06c75';
  });
  
  // Add to container
  overlayContainer.appendChild(overlay);
  
  // Auto-remove after 30 seconds
  setTimeout(() => {
    if (overlay.parentNode) {
      overlay.remove();
      if (overlayContainer && overlayContainer.children.length === 0) {
        overlayContainer.remove();
        overlayContainer = null;
      }
    }
  }, 30000);
} 