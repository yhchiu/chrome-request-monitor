const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// The data-i18n keys the overlay markup carries
const OVERLAY_I18N_KEYS = [
  'overlayTitle',
  'overlayPaused',
  'rule',
  'overlayCopy',
  'overlayClose'
];

// Enough of an element for the overlay code to build and tear down its boxes
function createElement(tagName = 'div') {
  const element = {
    tagName,
    id: '',
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    parentNode: null,
    listeners: {},
    style: {
      setProperty() {}
    },
    classList: {
      add() {},
      remove() {},
      toggle() {}
    },
    appendChild(child) {
      child.parentNode = element;
      element.children.push(child);
      return child;
    },
    remove() {
      if (!element.parentNode) {
        return;
      }
      const siblings = element.parentNode.children;
      const index = siblings.indexOf(element);
      if (index > -1) {
        siblings.splice(index, 1);
      }
      element.parentNode = null;
    },
    attributes: {},
    getAttribute(name) {
      return name in element.attributes ? element.attributes[name] : null;
    },
    setAttribute(name, value) {
      element.attributes[name] = value;
    },
    addEventListener(type, listener) {
      element.listeners[type] = listener;
    },
    // The overlay markup is set through innerHTML, so the buttons it looks for
    // afterwards are handed back as fresh stubs.
    querySelector() {
      return createElement('button');
    },
    // innerHTML does not really parse here, so the localizable parts of the
    // overlay markup stand in as a fixed set. They are remembered so a test can
    // read back what was written into them.
    querySelectorAll(selector) {
      if (selector !== '[data-i18n]') {
        return [];
      }

      if (!element.i18nStubs) {
        element.i18nStubs = OVERLAY_I18N_KEYS.map(key => {
          const stub = createElement('span');
          stub.setAttribute('data-i18n', key);
          return stub;
        });
      }

      return element.i18nStubs;
    }
  };

  Object.defineProperty(element, 'innerHTML', {
    get() {
      return '';
    },
    set() {
      element.children.length = 0;
    }
  });

  return element;
}

function createContentHarness({ storedOverlaySettings } = {}) {
  const body = createElement('body');
  const head = createElement('head');
  const runtimeMessages = [];
  const storageReads = [];
  let messageListener;

  const document = {
    body,
    head,
    createElement,
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  const chrome = {
    i18n: {
      // Distinct from the key so a test can tell a localized element from an
      // untouched one
      getMessage: key => `translated:${key}`
    },
    runtime: {
      sendMessage(message, callback) {
        runtimeMessages.push(message);
        if (callback) {
          callback({});
        }
      },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    },
    storage: {
      sync: {
        get(keys, callback) {
          // Copied out of the content script's realm so deepEqual accepts it
          storageReads.push(Array.isArray(keys) ? Array.from(keys) : [keys]);
          callback(storedOverlaySettings ? { overlaySettings: storedOverlaySettings } : {});
        }
      }
    }
  };

  const contentSource = fs.readFileSync(
    path.join(__dirname, '..', 'content.js'),
    'utf8'
  );

  vm.runInNewContext(contentSource, {
    chrome,
    clearTimeout() {},
    console,
    document,
    navigator: {
      clipboard: {
        writeText: () => Promise.resolve()
      }
    },
    // Real timers would keep the overlays scheduled and hold the process open
    setTimeout() {
      return 0;
    }
  }, { filename: 'content.js' });

  return {
    runtimeMessages,
    storageReads,
    // What the last overlay's localizable parts ended up saying
    localizedTexts() {
      const container = body.children[0];
      const overlay = container.children[container.children.length - 1];
      return overlay.querySelectorAll('[data-i18n]').map(stub => stub.textContent);
    },
    send(message) {
      messageListener(message, {}, () => {});
    },
    showUrl(ruleId, url) {
      this.send({
        action: 'showUrlOverlay',
        data: {
          url: url || `https://example.com/${ruleId}`,
          timestamp: 1,
          rule: { id: ruleId, name: ruleId, type: 'contains', value: ruleId }
        }
      });
    },
    // Rule ids of the overlays currently on the page
    visibleRuleIds() {
      const container = body.children[0];
      return container ? container.children.map(overlay => overlay.dataset.ruleId) : [];
    },
    hasContainer() {
      return body.children.length > 0;
    }
  };
}

test('an overlay remembers the rule that produced it', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');

  assert.deepEqual(content.visibleRuleIds(), ['rule-a']);
});

test('changing the focus takes away the overlays that are no longer shown', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');
  content.showUrl('rule-b');
  content.showUrl('rule-c');

  content.send({ action: 'updateFocusedRules', focusedRuleIds: ['rule-b'] });

  assert.deepEqual(content.visibleRuleIds(), ['rule-b']);
});

test('several focused rules keep their overlays', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');
  content.showUrl('rule-b');
  content.showUrl('rule-c');

  content.send({ action: 'updateFocusedRules', focusedRuleIds: ['rule-a', 'rule-c'] });

  assert.deepEqual(content.visibleRuleIds(), ['rule-a', 'rule-c']);
});

test('showing every rule again takes nothing away', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');
  content.showUrl('rule-b');

  content.send({ action: 'updateFocusedRules', focusedRuleIds: null });

  assert.deepEqual(content.visibleRuleIds(), ['rule-a', 'rule-b']);
});

test('an empty focus clears the page', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');
  content.showUrl('rule-b');

  content.send({ action: 'updateFocusedRules', focusedRuleIds: [] });

  assert.deepEqual(content.visibleRuleIds(), []);
  // The container goes with the last overlay rather than sitting there empty.
  assert.equal(content.hasContainer(), false);
});

// A content script runs in every open tab, so anything it asks the background
// for is paid once per tab and wakes the Service Worker to do it.

test('an overlay is localized without asking the background', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');

  assert.deepEqual(content.localizedTexts(), [
    'translated:overlayTitle',
    'translated:overlayPaused',
    'translated:rule',
    'translated:overlayCopy',
    'translated:overlayClose'
  ]);
  assert.deepEqual(
    content.runtimeMessages.filter(message => message.action === 'getI18nMessage'),
    []
  );
});

test('showing many overlays sends no messages at all', () => {
  const content = createContentHarness();

  for (let i = 0; i < 5; i += 1) {
    content.showUrl(`rule-${i}`);
  }

  assert.deepEqual(content.runtimeMessages, []);
});

test('the overlay settings are read from storage rather than from the background', () => {
  const content = createContentHarness({
    storedOverlaySettings: {
      maxOverlays: 2,
      timeoutSeconds: 10,
      position: 'bottom-left',
      opacity: 0.5
    }
  });

  assert.deepEqual(content.storageReads, [['overlaySettings']]);
  assert.deepEqual(
    content.runtimeMessages.filter(message => message.action === 'getOverlaySettings'),
    []
  );

  // The stored limit is the one in force, so it was really applied
  content.showUrl('rule-a');
  content.showUrl('rule-b');
  content.showUrl('rule-c');
  assert.deepEqual(content.visibleRuleIds(), ['rule-b', 'rule-c']);
});

test('the built in settings still apply when storage holds none', () => {
  const content = createContentHarness();

  for (let i = 0; i < 6; i += 1) {
    content.showUrl(`rule-${i}`);
  }

  // The default limit of five
  assert.equal(content.visibleRuleIds().length, 5);
});
