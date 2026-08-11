const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
    addEventListener(type, listener) {
      element.listeners[type] = listener;
    },
    // The overlay markup is set through innerHTML, so the buttons it looks for
    // afterwards are handed back as fresh stubs.
    querySelector() {
      return createElement('button');
    },
    querySelectorAll() {
      return [];
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

function createContentHarness() {
  const body = createElement('body');
  const head = createElement('head');
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
      getMessage: key => key
    },
    runtime: {
      sendMessage(message, callback) {
        // Settings are requested on startup; the defaults are fine here.
        if (callback) {
          callback({});
        }
      },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
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
