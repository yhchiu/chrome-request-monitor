const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createElement() {
  return {
    style: {},
    classList: {
      add() {},
      remove() {}
    },
    checked: false,
    value: '',
    textContent: '',
    innerHTML: '',
    appendChild() {},
    addEventListener() {},
    querySelector(selector) {
      return selector === 'option[value="all"]' ? createElement() : null;
    }
  };
}

function createPopupHarness({
  rules = [],
  focusedRuleIds = null,
  deferRules = false
} = {}) {
  const domReadyListeners = [];
  const elements = new Map();
  const messages = [];
  let monitorSettingsCallback;
  let rulesCallback;

  const document = {
    addEventListener(type, listener) {
      if (type === 'DOMContentLoaded') {
        domReadyListeners.push(listener);
      }
    },
    createElement,
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createElement());
      }
      return elements.get(id);
    },
    querySelectorAll() {
      return [];
    }
  };

  const chrome = {
    runtime: {
      openOptionsPage() {},
      sendMessage(message, callback) {
        messages.push(message);
        if (callback) {
          callback(message.action === 'getFoundUrls' ? { urls: [] } : { success: true });
        }
      }
    },
    storage: {
      sync: {
        get(keys, callback) {
          if (keys.includes('monitorEnabled')) {
            monitorSettingsCallback = callback;
            return;
          }

          if (deferRules) {
            rulesCallback = callback;
            return;
          }

          callback({ urlRules: rules });
        },
        set() {}
      },
      local: {
        get(keys, callback) {
          callback({ focusedRuleIds: focusedRuleIds });
        },
        set() {}
      }
    }
  };

  const popupSource = fs.readFileSync(
    path.join(__dirname, '..', 'popup.js'),
    'utf8'
  );

  vm.runInNewContext(popupSource, {
    chrome,
    clearTimeout,
    confirm: () => true,
    console,
    decodeURIComponent,
    document,
    encodeURIComponent,
    getMessage: key => key,
    navigator: {
      clipboard: {
        writeText: () => Promise.resolve()
      }
    },
    setTimeout
  }, { filename: 'popup.js' });

  return {
    getFoundUrlsRequests() {
      return messages.filter(message => message.action === 'getFoundUrls');
    },
    getFocusUpdates() {
      return messages.filter(message => message.action === 'setFocusedRules');
    },
    openPopup() {
      assert.equal(domReadyListeners.length, 1);
      domReadyListeners[0]();
    },
    resolveMonitorSettings(settings) {
      assert.ok(monitorSettingsCallback);
      monitorSettingsCallback(settings);
    },
    resolveRules(loadedRules) {
      assert.ok(rulesCallback);
      rulesCallback({ urlRules: loadedRules });
    }
  };
}

test('loads URLs once, after every stored setting is restored', () => {
  const popup = createPopupHarness({
    rules: [
      { id: 'rule-a', name: 'A', type: 'contains', value: 'a' },
      { id: 'rule-b', name: 'B', type: 'contains', value: 'b' }
    ],
    focusedRuleIds: ['rule-b']
  });

  popup.openPopup();
  assert.equal(popup.getFoundUrlsRequests().length, 0);

  popup.resolveMonitorSettings({ monitorEnabled: true });

  assert.equal(popup.getFoundUrlsRequests().length, 1);
  // The focus is already stored, so there is nothing to correct.
  assert.deepEqual(popup.getFocusUpdates(), []);
});

test('waits for the rule list before the first query when rules load last', () => {
  const popup = createPopupHarness({
    deferRules: true,
    focusedRuleIds: ['rule-a']
  });

  popup.openPopup();
  popup.resolveMonitorSettings({ monitorEnabled: true });

  // The focus cannot be checked until the rules are known.
  assert.equal(popup.getFoundUrlsRequests().length, 0);

  popup.resolveRules([{ id: 'rule-a', name: 'A', type: 'contains', value: 'a' }]);

  assert.equal(popup.getFoundUrlsRequests().length, 1);
});

test('falls back to every rule when the focused rule was deleted', () => {
  const popup = createPopupHarness({
    rules: [{ id: 'rule-b', name: 'B', type: 'contains', value: 'b' }],
    focusedRuleIds: ['rule-a']
  });

  popup.openPopup();
  popup.resolveMonitorSettings({ monitorEnabled: true });

  // The correction is pushed to the background before anything is queried.
  const updates = popup.getFocusUpdates();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].focusedRuleIds, null);
  assert.equal(popup.getFoundUrlsRequests().length, 1);
});

test('keeps the rules that still exist when only some were deleted', () => {
  const popup = createPopupHarness({
    rules: [
      { id: 'rule-a', name: 'A', type: 'contains', value: 'a' },
      { id: 'rule-c', name: 'C', type: 'contains', value: 'c' }
    ],
    focusedRuleIds: ['rule-a', 'rule-b', 'rule-c']
  });

  popup.openPopup();
  popup.resolveMonitorSettings({ monitorEnabled: true });

  const updates = popup.getFocusUpdates();
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].focusedRuleIds, ['rule-a', 'rule-c']);
});
