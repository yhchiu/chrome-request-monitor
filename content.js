// Content script for showing URL overlays on web pages
// escapeHtml comes from escape-html.js, listed before this file in the manifest.
let overlayContainer = null;
let activeOverlays = [];
let overlaySettings = {
  maxOverlays: 5,
  timeoutSeconds: 30,
  position: 'top-right'
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

// i18n helper for content script
function localizeOverlay(overlay) {
  const elements = overlay.querySelectorAll('[data-i18n]');
  elements.forEach(element => {
    const key = element.getAttribute('data-i18n');
    // chrome.i18n works in a content script, so the background is not needed
    // for this. Asking it cost one message per element, five per overlay, and
    // every one of those had to reach the Service Worker and come back.
    const message = chrome.i18n.getMessage(key);
    if (message) {
      element.textContent = message;
    }
  });
}

// Load overlay settings from storage.
//
// Read straight from storage rather than through the background. A content
// script runs in every tab, so going through the background woke the Service
// Worker once per tab just to be handed a value storage can give us directly.
function loadOverlaySettings() {
  chrome.storage.sync.get(['overlaySettings'], function(result) {
    applyOverlaySettings(result && result.overlaySettings);
  });
}

// Take a new set of settings and bring what is already on screen into line
function applyOverlaySettings(settings) {
  if (!settings) {
    return;
  }

  overlaySettings = settings;

  // Apply container position if already created
  if (overlayContainer) {
    applyOverlayContainerPosition();
  }

  updateExistingOverlayStyles();
}

// Settings changes arrive straight from storage.
//
// The background used to watch for the change and send a message to every tab,
// which cost one message per tab open however few of them cared. A content
// script is given the same change event, so each tab can pick its own up for
// nothing, the way it already reads the settings for itself at load.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.overlaySettings) {
    applyOverlaySettings(changes.overlaySettings.newValue);
  }
});

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

// Take every overlay off the page at once. A page that keeps matching a rule
// puts up a stack of them, and dismissing that one box at a time is tedious.
function removeAllOverlays() {
  // Copy first: removeOverlay mutates activeOverlays as it goes
  activeOverlays.slice().forEach(overlay => removeOverlay(overlay));

  // The pause those overlays were holding has to be released by hand. The
  // pointer was over one of them to reach the button, and an element that is
  // removed does not report the pointer leaving it, so the mouseleave that
  // normally resumes the timeouts never arrives. Without this the next overlay
  // would turn up already paused and would never go away on its own.
  globalHoverState = false;
}

// Initialize settings
loadOverlaySettings();

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'showUrlOverlay') {
    showUrlOverlay(request.data);
  } else if (request.action === 'updateFocusedRules') {
    removeUnfocusedOverlays(request.focusedRuleIds);
  }
});

// The rules a captured URL matched. A URL can match more than one, and the
// background sends all of them.
function matchedRules(urlData) {
  return Array.isArray(urlData.rules) ? urlData.rules : [];
}

// How those rules read on screen. Naming only one of several left the user
// guessing which of their rules had actually fired.
function describeRules(rules) {
  return rules
    .map(rule => `${rule.name || rule.type} - ${rule.value}`)
    .join(', ');
}

// The rules an overlay was built from. Stored as JSON rather than a joined
// string because a rule id comes from settings the user can import, so nothing
// here can assume it is free of whatever separator we picked.
function overlayRuleIds(overlay) {
  try {
    const ruleIds = JSON.parse(overlay.dataset.ruleIds || '[]');
    return Array.isArray(ruleIds) ? ruleIds : [];
  } catch (error) {
    return [];
  }
}

// Drop overlays whose rules are no longer being shown. New overlays are already
// filtered in the background, so this only clears what is still on screen when
// the user changes what they are looking at.
function removeUnfocusedOverlays(focusedRuleIds) {
  // null means every rule is shown, so there is nothing to take away
  if (!Array.isArray(focusedRuleIds)) {
    return;
  }

  // Copy first: removeOverlay mutates activeOverlays as it goes
  activeOverlays.slice().forEach(overlay => {
    // A URL can match several rules, so the overlay stays for as long as the
    // user is still showing any one of them. Removing it as soon as a single
    // rule was unticked would take away an overlay they asked to see.
    const stillShown = overlayRuleIds(overlay).some(id => focusedRuleIds.includes(id));

    if (!stillShown) {
      removeOverlay(overlay);
    }
  });
}

// Apply overlay container position based on settings
function applyOverlayContainerPosition() {
  if (!overlayContainer) return;
  const pos = overlaySettings.position || 'top-right';
  const isTop = pos.startsWith('top');
  const isRight = pos.endsWith('right');
  // Base styles
  overlayContainer.style.position = 'fixed';
  overlayContainer.style.zIndex = '10000';
  overlayContainer.style.maxWidth = '400px';
  overlayContainer.style.display = 'flex';
  overlayContainer.style.flexDirection = 'column';
  overlayContainer.style.gap = '10px';
  // Reset sides
  overlayContainer.style.top = '';
  overlayContainer.style.right = '';
  overlayContainer.style.bottom = '';
  overlayContainer.style.left = '';
  // Set sides
  if (isTop) {
    overlayContainer.style.top = '20px';
    overlayContainer.style.justifyContent = 'flex-start';
  } else {
    overlayContainer.style.bottom = '20px';
    overlayContainer.style.justifyContent = 'flex-end';
  }
  if (isRight) {
    overlayContainer.style.right = '20px';
  } else {
    overlayContainer.style.left = '20px';
  }
}

function showUrlOverlay(urlData) {
  // Create overlay container if it doesn't exist
  if (!overlayContainer) {
    overlayContainer = document.createElement('div');
    overlayContainer.id = 'url-monitor-overlay-container';
    applyOverlayContainerPosition();
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
  // Remembered so the overlay can be taken away once none of its rules are
  // being shown any more
  overlay.dataset.ruleIds = JSON.stringify(
    matchedRules(urlData).map(rule => rule.id).filter(id => id)
  );
  // How the overlay looks is the stylesheet's job. Everything it declares
  // carries !important, to keep the host page's styles out, so anything written
  // here as a plain inline style was being overridden anyway. The one thing
  // left to pass in is the setting behind those colours.
  applyOverlayOpacity(overlay);
  
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
        <span data-i18n="overlayTitle">Found matching URL:</span>
        <span id="timeout-indicator" style="font-size: 10px; color: rgba(255, 255, 255, 0.6); display: none;" data-i18n="overlayPaused">⏸️ Paused</span>
      </div>
      <div style="word-break: break-all; background: rgba(255, 255, 255, 0.1); padding: 6px; border-radius: 4px; font-family: monospace; font-size: 12px;">
        ${escapeHtml(urlData.url)}
      </div>
    </div>
    <div style="margin-bottom: 8px;">
      <div style="color: #98c379; font-size: 12px;">
        <span data-i18n="rule">Rule</span>: ${escapeHtml(describeRules(matchedRules(urlData)))}
      </div>
    </div>
    <div style="display: flex; gap: 8px; justify-content: flex-end;">
      <button class="copy-btn" data-i18n="overlayCopy">Copy</button>
      <button class="close-btn" data-i18n="overlayClose">Close</button>
      <button class="close-all-btn" data-i18n="overlayCloseAll">Close All</button>
    </div>
  `;
  
  overlay.innerHTML = content;
  
  // Localize the overlay content
  localizeOverlay(overlay);
  
  // Get timeout indicator element
  const timeoutIndicator = overlay.querySelector('#timeout-indicator');
  
  // Add event listeners
  const copyBtn = overlay.querySelector('.copy-btn');
  const closeBtn = overlay.querySelector('.close-btn');
  const closeAllBtn = overlay.querySelector('.close-all-btn');

  // No hover handlers here. Every button colour, hovered included, is declared
  // in the stylesheet: it resets the buttons with `all: initial !important` to
  // keep the host page out, and an important declaration beats a plain inline
  // one, so a colour assigned to element.style never took effect.
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(urlData.url).then(() => {
      copyBtn.textContent = chrome.i18n.getMessage('copied') || 'Copied!';
      // A class rather than a colour, so the confirmation follows the opacity
      // setting and the hovered state without restating either
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = chrome.i18n.getMessage('overlayCopy') || 'Copy';
        copyBtn.classList.remove('copied');
      }, 1500);
    });
  });

  closeBtn.addEventListener('click', () => {
    removeOverlay(overlay); // Use helper function for consistent cleanup
  });

  closeAllBtn.addEventListener('click', () => {
    removeAllOverlays();
  });
  
  // Add to container
  overlayContainer.appendChild(overlay);
  
  // Add to active overlays array
  activeOverlays.push(overlay);
  
  // Hovering pauses the timeouts, which is behaviour rather than appearance and
  // so stays here. How a hovered overlay is drawn is the stylesheet's :hover
  // rule: it cannot fall out of step with where the pointer actually is, and it
  // covers the buttons through the opacity custom property.
  overlay.addEventListener('mouseenter', () => {
    pauseAllTimeouts();
    timeoutIndicator.style.display = 'inline';
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

// Bring the overlays already on screen into line with a changed setting
function updateExistingOverlayStyles() {
  document.querySelectorAll('.url-monitor-overlay').forEach(applyOverlayOpacity);
}

// Hand the opacity setting to the stylesheet.
//
// This is the whole of what the script has to say about how an overlay looks.
// The colours are declared once in the stylesheet against this custom property,
// so the overlay, its three buttons, the copied confirmation and every hovered
// state follow the setting without any of them being restated here. Custom
// properties are also what survives the `all: initial` the stylesheet uses to
// keep the host page out, so it reaches the buttons.
function applyOverlayOpacity(overlay) {
  overlay.style.setProperty(
    '--url-monitor-opacity',
    overlaySettings.opacity != null ? overlaySettings.opacity : 0.95
  );
}