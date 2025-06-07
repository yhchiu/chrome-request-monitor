// Content script for showing URL overlays on web pages
let overlayContainer = null;
let activeOverlays = [];
let overlaySettings = {
  maxOverlays: 5,
  timeoutSeconds: 30
};

// Global hover state management
// Alternative solution: Use fixed position slots to prevent position jumping
// This current implementation uses global pause strategy which is more user-friendly

/* 
 * ALTERNATIVE APPROACH - Fixed Position Slots (if needed):
 * Instead of stacking overlays relatively, assign each a fixed position slot.
 * This completely eliminates position jumping but may leave gaps.
 * 
 * Implementation would modify overlay positioning like this:
 * const slotHeight = 80;
 * const slotIndex = activeOverlays.length % overlaySettings.maxOverlays;
 * overlay.style.top = `${20 + (slotIndex * slotHeight)}px`;
 */

let globalHoverState = false;
let allOverlayTimeouts = new Map(); // Store timeoutId for each overlay

// Load overlay settings from storage
function loadOverlaySettings() {
  chrome.runtime.sendMessage({ action: 'getOverlaySettings' }, function(response) {
    if (response && response.settings) {
      overlaySettings = response.settings;
    }
  });
}

// Pause all overlay timeouts
function pauseAllTimeouts() {
  globalHoverState = true;
  allOverlayTimeouts.forEach((timeoutId, overlay) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      allOverlayTimeouts.set(overlay, null);
    }
  });
}

// Resume all overlay timeouts
function resumeAllTimeouts() {
  globalHoverState = false;
  allOverlayTimeouts.forEach((timeoutId, overlay) => {
    if (!timeoutId && overlay.parentNode) {
      const newTimeoutId = setTimeout(() => {
        removeOverlay(overlay);
      }, overlaySettings.timeoutSeconds * 1000);
      allOverlayTimeouts.set(overlay, newTimeoutId);
    }
  });
}

// Remove overlay helper function
function removeOverlay(overlay) {
  if (overlay.parentNode) {
    overlay.remove();
    // Remove from active overlays array
    const index = activeOverlays.indexOf(overlay);
    if (index > -1) {
      activeOverlays.splice(index, 1);
    }
    // Remove from timeouts map
    allOverlayTimeouts.delete(overlay);
    // Clean up container if empty
    if (overlayContainer && overlayContainer.children.length === 0) {
      overlayContainer.remove();
      overlayContainer = null;
    }
  }
}

// Initialize settings
loadOverlaySettings();

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'showUrlOverlay') {
    showUrlOverlay(request.data);
  } else if (request.action === 'updateOverlaySettings') {
    overlaySettings = request.settings;
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
  
  // Check if we've reached the maximum number of overlays
  if (activeOverlays.length >= overlaySettings.maxOverlays) {
    // Remove the oldest overlay
    const oldestOverlay = activeOverlays[0];
    if (oldestOverlay && oldestOverlay.parentNode) {
      removeOverlay(oldestOverlay);
    }
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
    transition: transform 0.2s ease-out, box-shadow 0.2s ease-out;
    cursor: default;
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
      <div style="color: #61dafb; font-weight: bold; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
        <span>找到匹配的URL:</span>
        <span id="timeout-indicator" style="font-size: 10px; color: rgba(255, 255, 255, 0.6); display: none;">⏸️ 已暫停</span>
      </div>
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
  
  // Get timeout indicator element
  const timeoutIndicator = overlay.querySelector('#timeout-indicator');
  
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
    removeOverlay(overlay); // Use helper function for consistent cleanup
  });
  
  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.background = '#c24d5a';
  });
  
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.background = '#e06c75';
  });
  
  // Add to container
  overlayContainer.appendChild(overlay);
  
  // Add to active overlays array
  activeOverlays.push(overlay);
  
  // Mouse hover events with global timeout management
  overlay.addEventListener('mouseenter', () => {
    pauseAllTimeouts();
    timeoutIndicator.style.display = 'inline';
    overlay.style.transform = 'scale(1.02)';
    overlay.style.boxShadow = '0 6px 25px rgba(0, 0, 0, 0.4)';
  });
  
  overlay.addEventListener('mouseleave', () => {
    // Add a small delay to prevent accidental resume when moving between overlays
    setTimeout(() => {
      // Only resume if mouse is not over any overlay
      const hoveredOverlay = document.querySelector('.url-monitor-overlay:hover');
      if (!hoveredOverlay) {
        resumeAllTimeouts();
        // Update all timeout indicators
        document.querySelectorAll('#timeout-indicator').forEach(indicator => {
          indicator.style.display = 'none';
        });
        // Reset all overlay styles
        document.querySelectorAll('.url-monitor-overlay').forEach(ol => {
          ol.style.transform = 'scale(1)';
          ol.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3)';
        });
      }
    }, 100); // 100ms delay
  });
  
  // Set initial timeout if not globally paused
  if (!globalHoverState) {
    const timeoutId = setTimeout(() => {
      removeOverlay(overlay);
    }, overlaySettings.timeoutSeconds * 1000);
    allOverlayTimeouts.set(overlay, timeoutId);
  } else {
    allOverlayTimeouts.set(overlay, null);
  }
} 