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

function createPopupHarness({ rules = [], deferRules = false } = {}) {
  const domReadyListeners = [];
  const elements = new Map();
  const messages = [];
  const writes = [];
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
          callback({ urls: [] });
        }
      }
    },
    storage: {
      sync: {
        get(keys, callback) {
          if (keys.includes('selectedRule')) {
            monitorSettingsCallback = callback;
            return;
          }

          if (deferRules) {
            rulesCallback = callback;
            return;
          }

          callback({ urlRules: rules });
        },
        set(items) {
          writes.push(items);
        }
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
    getWrites() {
      return writes;
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

test('loads URLs once with the saved rule after monitor settings are restored', () => {
  const popup = createPopupHarness({
    rules: [
      { id: 'rule-a', name: 'A', type: 'contains', value: 'a' },
      { id: 'rule-b', name: 'B', type: 'contains', value: 'b' }
    ]
  });

  popup.openPopup();
  assert.equal(popup.getFoundUrlsRequests().length, 0);

  popup.resolveMonitorSettings({
    monitorEnabled: true,
    selectedRule: 'rule-b'
  });

  const requests = popup.getFoundUrlsRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].ruleFilter, 'rule-b');
});

test('waits for the rule list before the first query when rules load last', () => {
  const popup = createPopupHarness({ deferRules: true });

  popup.openPopup();
  popup.resolveMonitorSettings({
    monitorEnabled: true,
    selectedRule: 'rule-a'
  });

  // The saved filter cannot be checked until the rules are known.
  assert.equal(popup.getFoundUrlsRequests().length, 0);

  popup.resolveRules([{ id: 'rule-a', name: 'A', type: 'contains', value: 'a' }]);

  const requests = popup.getFoundUrlsRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].ruleFilter, 'rule-a');
});

test('falls back to all rules when the saved rule was deleted', () => {
  const popup = createPopupHarness({
    rules: [{ id: 'rule-b', name: 'B', type: 'contains', value: 'b' }]
  });

  popup.openPopup();
  popup.resolveMonitorSettings({
    monitorEnabled: true,
    selectedRule: 'rule-a'
  });

  const requests = popup.getFoundUrlsRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].ruleFilter, 'all');

  // The correction is persisted so the next open starts clean.
  assert.ok(popup.getWrites().some(write => write.selectedRule === 'all'));
});
