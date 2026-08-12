const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Enough of an element to render and click the rule focus list
function createElement(tagName = 'div') {
  const element = {
    tagName,
    type: '',
    className: '',
    checked: false,
    disabled: false,
    value: '',
    textContent: '',
    style: {},
    children: [],
    listeners: {},
    classList: {
      add() {},
      remove() {},
      toggle() {}
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    addEventListener(type, listener) {
      element.listeners[type] = listener;
    },
    // Fire a listener the way the browser would, with `this` set to the element
    dispatch(type) {
      assert.ok(element.listeners[type], `no ${type} listener registered`);
      element.listeners[type].call(element);
    },
    querySelector(selector) {
      return selector === 'option[value="all"]' ? createElement('option') : null;
    },
    // Only ever used to find the checkboxes inside the focus list
    querySelectorAll() {
      return element.children
        .reduce((found, child) => found.concat(child.children || []), [])
        .filter(child => child.type === 'checkbox');
    }
  };

  // Kept rather than discarded, so a test can read back the markup that was
  // built and check what was escaped
  let html = '';
  Object.defineProperty(element, 'innerHTML', {
    get() {
      return html;
    },
    set(value) {
      html = value;
      element.children.length = 0;
    }
  });

  return element;
}

function createPopupHarness({
  rules = [],
  focusedRuleIds = null,
  deferRules = false,
  foundUrls = []
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
          callback(message.action === 'getFoundUrls' ? { urls: foundUrls } : { success: true });
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

  const context = vm.createContext({
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
  });

  // The popup page loads the shared escaping helper first, so the context needs
  // it too
  ['escape-html.js', 'popup.js'].forEach(file => {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
      context,
      { filename: file }
    );
  });

  return {
    element(id) {
      return document.getElementById(id);
    },
    // The markup the URL list was rendered with
    urlListHtml() {
      return document.getElementById('urlList').children
        .map(item => item.innerHTML)
        .join('');
    },
    getFoundUrlsRequests() {
      return messages.filter(message => message.action === 'getFoundUrls');
    },
    getFocusUpdates() {
      return messages.filter(message => message.action === 'setFocusedRules');
    },
    latestFocus() {
      const updates = messages.filter(message => message.action === 'setFocusedRules');
      const latest = updates[updates.length - 1];
      assert.ok(latest, 'no focus update was sent');
      return Array.isArray(latest.focusedRuleIds)
        ? Array.from(latest.focusedRuleIds)
        : latest.focusedRuleIds;
    },
    checkboxes() {
      return document.getElementById('ruleFocusList').querySelectorAll();
    },
    toggle(value, checked) {
      const checkbox = this.checkboxes().find(entry => entry.value === value);
      assert.ok(checkbox, `no checkbox for ${value}`);
      checkbox.checked = checked;
      checkbox.dispatch('change');
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
    },
    // Flip the monitor switch the way a click would
    setMonitoring(isEnabled) {
      const toggle = document.getElementById('monitorToggle');
      toggle.checked = isEnabled;
      toggle.dispatch('change');
    }
  };
}

const THREE_RULES = [
  { id: 'rule-a', name: 'A', type: 'contains', value: 'a' },
  { id: 'rule-b', name: 'B', type: 'contains', value: 'b' },
  { id: 'rule-c', name: 'C', type: 'contains', value: 'c' }
];

function openPopup(options) {
  const popup = createPopupHarness(options);
  popup.openPopup();
  popup.resolveMonitorSettings({ monitorEnabled: true });
  return popup;
}

test('loads URLs once, after every stored setting is restored', () => {
  const popup = createPopupHarness({
    rules: THREE_RULES,
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
  const popup = openPopup({
    rules: [{ id: 'rule-b', name: 'B', type: 'contains', value: 'b' }],
    focusedRuleIds: ['rule-a']
  });

  assert.equal(popup.getFocusUpdates().length, 1);
  assert.equal(popup.latestFocus(), null);
  assert.equal(popup.getFoundUrlsRequests().length, 1);
});

test('keeps the rules that still exist when only some were deleted', () => {
  const popup = openPopup({
    rules: [THREE_RULES[0], THREE_RULES[2]],
    focusedRuleIds: ['rule-a', 'rule-b', 'rule-c']
  });

  assert.deepEqual(popup.latestFocus(), ['rule-a', 'rule-c']);
});

test('renders one checkbox per rule plus the "all" row', () => {
  const popup = openPopup({ rules: THREE_RULES });

  assert.deepEqual(
    popup.checkboxes().map(checkbox => checkbox.value),
    ['all', 'rule-a', 'rule-b', 'rule-c']
  );
  // A null focus shows everything, so every box is ticked.
  assert.deepEqual(
    popup.checkboxes().map(checkbox => checkbox.checked),
    [true, true, true, true]
  );
});

test('unticking a rule keeps the rest', () => {
  const popup = openPopup({ rules: THREE_RULES });

  popup.toggle('rule-b', false);

  assert.deepEqual(popup.latestFocus(), ['rule-a', 'rule-c']);
  // The "all" row follows the rules rather than acting on its own.
  assert.equal(popup.checkboxes()[0].checked, false);
});

test('ticking the last missing rule collapses back to showing everything', () => {
  const popup = openPopup({
    rules: THREE_RULES,
    focusedRuleIds: ['rule-a', 'rule-c']
  });

  popup.toggle('rule-b', true);

  // Stored as "everything" rather than as a list of every id.
  assert.equal(popup.latestFocus(), null);
  assert.equal(popup.checkboxes()[0].checked, true);
});

test('unticking "all" shows nothing', () => {
  const popup = openPopup({ rules: THREE_RULES });

  popup.toggle('all', false);

  assert.deepEqual(popup.latestFocus(), []);
  assert.deepEqual(
    popup.checkboxes().map(checkbox => checkbox.checked),
    [false, false, false, false]
  );
});

test('ticking "all" from an empty focus shows everything again', () => {
  const popup = openPopup({ rules: THREE_RULES, focusedRuleIds: [] });

  popup.toggle('all', true);

  assert.equal(popup.latestFocus(), null);
});

test('the empty state offers a way back when nothing is being shown', () => {
  const popup = openPopup({ rules: THREE_RULES, focusedRuleIds: [] });

  assert.equal(popup.element('emptyStateTitle').textContent, 'noFocusedRules');
  assert.equal(popup.element('showAllRulesBtn').style.display, 'inline-flex');

  popup.element('showAllRulesBtn').dispatch('click');

  assert.equal(popup.latestFocus(), null);
});

test('the ordinary empty state keeps its hint and hides the button', () => {
  const popup = openPopup({ rules: THREE_RULES });

  assert.equal(popup.element('emptyStateTitle').textContent, 'noMatchingUrls');
  assert.equal(popup.element('showAllRulesBtn').style.display, 'none');
});

test('the focus list is disabled while monitoring is off', () => {
  const popup = createPopupHarness({ rules: THREE_RULES });

  popup.openPopup();
  popup.resolveMonitorSettings({ monitorEnabled: false });

  assert.deepEqual(
    popup.checkboxes().map(checkbox => checkbox.disabled),
    [true, true, true, true]
  );
  // The choice itself is kept, so turning monitoring back on restores it.
  assert.deepEqual(popup.getFocusUpdates(), []);
});

test('turning monitoring back on restores the selection', () => {
  const popup = createPopupHarness({
    rules: THREE_RULES,
    focusedRuleIds: ['rule-b']
  });

  popup.openPopup();
  popup.resolveMonitorSettings({ monitorEnabled: false });
  popup.setMonitoring(true);

  assert.deepEqual(
    popup.checkboxes().map(checkbox => checkbox.disabled),
    [false, false, false, false]
  );

  // The same rule is still the one being shown
  assert.deepEqual(
    popup.checkboxes().filter(checkbox => checkbox.checked).map(checkbox => checkbox.value),
    ['rule-b']
  );

  // Turning the monitor off and on again says nothing about the selection
  assert.deepEqual(popup.getFocusUpdates(), []);
});

test('a row names every rule the URL matched', () => {
  const popup = openPopup({
    rules: THREE_RULES,
    foundUrls: [{
      url: 'https://api.example.com/v1/users',
      timestamp: 1,
      tabId: 1,
      tabTitle: 'A tab',
      rules: [
        { id: 'rule-a', name: 'One', type: 'contains' },
        { id: 'rule-b', name: 'Two', type: 'contains' }
      ]
    }]
  });

  // Naming only the first left the row claiming a rule the user may not even
  // be showing, which read as the wrong rule having fired.
  assert.ok(popup.urlListHtml().includes('One, Two'));
});

// The URL list is built as a string and assigned through innerHTML. The URL is
// whatever a page asked the network for, and the rule name can come from an
// imported settings file.

test('a URL that looks like markup is escaped into the list', () => {
  const popup = openPopup({
    rules: THREE_RULES,
    foundUrls: [{
      url: 'https://example.com/?q=<img src=x onerror=alert(1)>',
      timestamp: 1,
      tabId: 1,
      tabTitle: 'A tab',
      rules: [{ id: 'rule-a', name: 'A', type: 'contains' }]
    }]
  });

  const html = popup.urlListHtml();
  assert.ok(!html.includes('<img'), 'the tag should not survive into the markup');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('a rule name that looks like markup is escaped into the list', () => {
  const popup = openPopup({
    rules: THREE_RULES,
    foundUrls: [{
      url: 'https://example.com/one',
      timestamp: 1,
      tabId: 1,
      tabTitle: 'A tab',
      rules: [{ id: 'rule-a', name: '<script>alert(1)</script>', type: 'contains' }]
    }]
  });

  const html = popup.urlListHtml();
  assert.ok(!html.includes('<script>'), 'the script tag should not survive');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});
