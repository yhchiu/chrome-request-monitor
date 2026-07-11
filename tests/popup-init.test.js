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

function createPopupHarness() {
  const domReadyListeners = [];
  const elements = new Map();
  const messages = [];
  let monitorSettingsCallback;

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

          callback({ urlRules: [] });
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
    openPopup() {
      assert.equal(domReadyListeners.length, 1);
      domReadyListeners[0]();
    },
    resolveMonitorSettings(settings) {
      assert.ok(monitorSettingsCallback);
      monitorSettingsCallback(settings);
    }
  };
}

test('loads URLs once with the saved rule after monitor settings are restored', () => {
  const popup = createPopupHarness();

  popup.openPopup();
  assert.equal(popup.getFoundUrlsRequests().length, 0);

  popup.resolveMonitorSettings({
    monitorEnabled: true,
    selectedRule: '1'
  });

  const requests = popup.getFoundUrlsRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].ruleFilter, '1');
});
