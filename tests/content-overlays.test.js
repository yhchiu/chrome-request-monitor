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
  'overlayClose',
  'overlayCloseAll'
];

// Enough of an element for the overlay code to build and tear down its boxes
function createElement(tagName = 'div') {
  const classes = new Set();
  const element = {
    tagName,
    id: '',
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    parentNode: null,
    listeners: {},
    selectorStubs: new Map(),
    // Plain assignments land on the object as they would on a real style
    // declaration; setProperty is recorded the same way so a test can read back
    // the custom property the overlay code sets.
    style: {
      setProperty(name, value) {
        this[name] = value;
      }
    },
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      toggle(name) {
        if (classes.has(name)) {
          classes.delete(name);
        } else {
          classes.add(name);
        }
      },
      contains(name) {
        return classes.has(name);
      }
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
    // Fire a listener the way the browser would, with `this` set to the element
    dispatch(type) {
      assert.ok(element.listeners[type], `no ${type} listener registered`);
      element.listeners[type].call(element);
    },
    // The overlay markup is set through innerHTML, so the buttons it looks for
    // afterwards are handed back as stubs. The same selector gives back the
    // same stub, the way the real DOM would, so a test can press the button the
    // overlay code has attached its listener to.
    querySelector(selector) {
      if (!element.selectorStubs.has(selector)) {
        element.selectorStubs.set(selector, createElement('button'));
      }
      return element.selectorStubs.get(selector);
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

function createContentHarness({ storedOverlaySettings } = {}) {
  const body = createElement('body');
  const head = createElement('head');
  const runtimeMessages = [];
  const storageReads = [];
  let messageListener;
  let storageListener;
  let scheduledTimeouts = 0;

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
    // The overlays currently on the page, which is what a settings change looks
    // for when it brings them into line
    querySelectorAll(selector) {
      if (selector !== '.url-monitor-overlay') {
        return [];
      }

      const container = body.children[0];
      return container ? container.children.slice() : [];
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
      },
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        }
      }
    }
  };

  const context = vm.createContext({
    chrome,
    clearTimeout() {},
    console,
    document,
    navigator: {
      clipboard: {
        writeText: () => Promise.resolve()
      }
    },
    // Real timers would keep the overlays scheduled and hold the process open.
    // The calls are counted because an overlay only schedules one when the
    // timeouts are not paused, which is how a test can tell the two apart.
    setTimeout() {
      scheduledTimeouts += 1;
      return 0;
    }
  });

  // The manifest lists the shared escaping helper before the content script, so
  // the context needs it in the same order
  ['escape-html.js', 'content.js'].forEach(file => {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
      context,
      { filename: file }
    );
  });

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
    // Deliver a settings change the way Chrome does to every content script
    syncOverlaySettings(settings, areaName = 'sync') {
      storageListener({ overlaySettings: { newValue: settings } }, areaName);
    },
    // Where the container ended up, which is what a position change moves
    containerStyle() {
      return body.children[0].style;
    },
    showUrl(ruleId, url) {
      this.showUrlForRules([ruleId], url || `https://example.com/${ruleId}`);
    },
    // A URL can match several rules at once, and the background sends all of
    // them together in one overlay
    showUrlForRules(ruleIds, url) {
      this.send({
        action: 'showUrlOverlay',
        data: {
          url: url || `https://example.com/${ruleIds.join('-')}`,
          timestamp: 1,
          rules: ruleIds.map(ruleId => ({
            id: ruleId,
            name: ruleId,
            type: 'contains',
            value: ruleId
          }))
        }
      });
    },
    // The markup of the overlay added most recently
    lastOverlayHtml() {
      const container = body.children[0];
      return container.children[container.children.length - 1].innerHTML;
    },
    // Rule ids of the overlays currently on the page, flattened
    visibleRuleIds() {
      return this.visibleRuleIdSets().flat();
    },
    // The same ids kept one list per overlay, for overlays built from a URL
    // that matched several rules
    visibleRuleIdSets() {
      const container = body.children[0];
      return container
        ? container.children.map(overlay => JSON.parse(overlay.dataset.ruleIds))
        : [];
    },
    hasContainer() {
      return body.children.length > 0;
    },
    // Press a button on the overlay added most recently
    pressButton(selector) {
      this.lastOverlay().querySelector(selector).dispatch('click');
    },
    // Put the pointer over the overlay added most recently, which is what the
    // user does on the way to its buttons and what pauses the timeouts
    hoverLastOverlay() {
      this.lastOverlay().dispatch('mouseenter');
    },
    lastOverlay() {
      const container = body.children[0];
      return container.children[container.children.length - 1];
    },
    // How many timeouts have been scheduled. An overlay schedules one only when
    // the timeouts are not paused.
    timeoutsScheduled() {
      return scheduledTimeouts;
    },
    // The style declaration of the overlay added most recently, which is where
    // the opacity custom property lands
    lastOverlayStyle() {
      return this.lastOverlay().style;
    },
    // The same for every overlay on the page
    overlayOpacities() {
      const container = body.children[0];
      return container
        ? container.children.map(overlay => overlay.style['--url-monitor-opacity'])
        : [];
    },
    buttonHasClass(selector, name) {
      return this.lastOverlay().querySelector(selector).classList.contains(name);
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

test('an overlay remembers every rule its URL matched', () => {
  const content = createContentHarness();

  content.showUrlForRules(['rule-a', 'rule-b']);

  assert.deepEqual(content.visibleRuleIdSets(), [['rule-a', 'rule-b']]);
});

test('an overlay stays while any of its rules is still shown', () => {
  const content = createContentHarness();

  content.showUrlForRules(['rule-a', 'rule-b']);

  // Rule A has been unticked, but the user is still showing rule B and this
  // URL matched that too.
  content.send({ action: 'updateFocusedRules', focusedRuleIds: ['rule-b'] });

  assert.deepEqual(content.visibleRuleIdSets(), [['rule-a', 'rule-b']]);
});

test('an overlay goes once none of its rules are shown', () => {
  const content = createContentHarness();

  content.showUrlForRules(['rule-a', 'rule-b']);

  content.send({ action: 'updateFocusedRules', focusedRuleIds: ['rule-c'] });

  assert.deepEqual(content.visibleRuleIdSets(), []);
});

test('an overlay names every rule its URL matched', () => {
  const content = createContentHarness();

  content.showUrlForRules(['rule-a', 'rule-b']);

  const overlay = content.lastOverlayHtml();
  assert.ok(overlay.includes('rule-a - rule-a'), 'the first rule should be named');
  assert.ok(overlay.includes('rule-b - rule-b'), 'the second rule should be named');
});

// How an overlay looks is the stylesheet's job. It resets the overlay and its
// buttons with `all: initial !important` to keep the host page's styles out,
// and an important declaration beats a plain inline one, so a colour the script
// assigned to element.style never took effect. The script hands over the one
// setting behind those colours and nothing else.

test('an overlay carries the opacity setting as a custom property', () => {
  const content = createContentHarness({
    storedOverlaySettings: {
      maxOverlays: 5,
      timeoutSeconds: 30,
      position: 'top-right',
      opacity: 0.5
    }
  });

  content.showUrl('rule-a');

  assert.equal(content.lastOverlayStyle()['--url-monitor-opacity'], 0.5);
});

test('the built in opacity is handed over when storage holds none', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');

  assert.equal(content.lastOverlayStyle()['--url-monitor-opacity'], 0.95);
});

test('a changed opacity reaches the overlays already on screen', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');
  content.showUrl('rule-b');

  content.syncOverlaySettings({
    maxOverlays: 5,
    timeoutSeconds: 30,
    position: 'top-right',
    opacity: 0.4
  });

  assert.deepEqual(content.overlayOpacities(), [0.4, 0.4]);
});

test('no colour is written onto the overlay by the script', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');

  // Writing one would be overridden by the stylesheet anyway, and having two
  // places declare it is what let the buttons drift apart.
  assert.equal(content.lastOverlayStyle().background, undefined);
});

test('copying marks the button instead of recolouring it', async () => {
  const content = createContentHarness();

  content.showUrl('rule-a');
  content.pressButton('.copy-btn');
  // The clipboard write resolves on a microtask
  await new Promise(resolve => setImmediate(resolve));

  // A class, so the confirmation follows the opacity setting and the hovered
  // state without restating either
  assert.equal(content.buttonHasClass('.copy-btn', 'copied'), true);
  assert.equal(content.lastOverlay().querySelector('.copy-btn').style.background, undefined);
});

test('close all takes every overlay away', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');
  content.showUrl('rule-b');
  content.showUrl('rule-c');

  content.pressButton('.close-all-btn');

  assert.deepEqual(content.visibleRuleIds(), []);
});

test('close all clears the container away with the last overlay', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');
  content.showUrl('rule-b');

  content.pressButton('.close-all-btn');

  assert.equal(content.hasContainer(), false);
});

test('close is still only the one overlay', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');
  content.showUrl('rule-b');

  content.pressButton('.close-btn');

  assert.deepEqual(content.visibleRuleIds(), ['rule-a']);
});

test('an overlay after close all is not left paused', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');

  // Reaching the button means hovering the overlay, which pauses the timeouts
  content.hoverLastOverlay();
  content.pressButton('.close-all-btn');

  // A removed element does not report the pointer leaving it, so without the
  // pause being released by hand the next overlay would arrive already paused
  // and would never time out.
  const before = content.timeoutsScheduled();
  content.showUrl('rule-b');

  assert.equal(content.timeoutsScheduled(), before + 1);
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
    'translated:overlayClose',
    'translated:overlayCloseAll'
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

// A settings change used to arrive as a message the background sent to every
// tab. The same change event reaches every content script on its own.

test('a settings change from storage applies without a message', () => {
  const content = createContentHarness();

  content.syncOverlaySettings({
    maxOverlays: 2,
    timeoutSeconds: 10,
    position: 'bottom-left',
    opacity: 0.5
  });

  content.showUrl('rule-a');
  content.showUrl('rule-b');
  content.showUrl('rule-c');

  // The new limit is in force, so the change really was taken up
  assert.deepEqual(content.visibleRuleIds(), ['rule-b', 'rule-c']);
});

test('a settings change moves the overlays already on screen', () => {
  const content = createContentHarness();

  content.showUrl('rule-a');
  content.syncOverlaySettings({
    maxOverlays: 5,
    timeoutSeconds: 30,
    position: 'bottom-left',
    opacity: 0.5
  });

  // Switching what is shown is a statement about now, so the container moves
  // rather than waiting for the next overlay
  assert.equal(content.containerStyle().bottom, '20px');
  assert.equal(content.containerStyle().left, '20px');
  assert.equal(content.containerStyle().top, '');
});

test('a change in another storage area is left alone', () => {
  const content = createContentHarness();

  content.syncOverlaySettings({ maxOverlays: 1 }, 'local');

  for (let i = 0; i < 6; i += 1) {
    content.showUrl(`rule-${i}`);
  }

  // The settings live in sync storage, so the default limit still stands
  assert.equal(content.visibleRuleIds().length, 5);
});

// The overlay markup is built as a string and assigned through innerHTML. A
// rule name and value can come from an imported settings file, and the URL is
// whatever the page asked the network for.

test('a URL that looks like markup is escaped into the overlay', () => {
  const content = createContentHarness();

  content.showUrl('rule-a', 'https://example.com/?q=<img src=x onerror=alert(1)>');

  const overlay = content.lastOverlayHtml();
  assert.ok(!overlay.includes('<img'), 'the tag should not survive into the markup');
  assert.ok(overlay.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('a rule name and value that look like markup are escaped into the overlay', () => {
  const content = createContentHarness();

  content.send({
    action: 'showUrlOverlay',
    data: {
      url: 'https://example.com/one',
      timestamp: 1,
      rules: [{
        id: 'rule-a',
        name: '<script>alert(1)</script>',
        type: 'contains',
        value: '"><img src=x onerror=alert(2)>'
      }]
    }
  });

  const overlay = content.lastOverlayHtml();
  assert.ok(!overlay.includes('<script>'), 'the script tag should not survive');
  assert.ok(!overlay.includes('<img'), 'the image tag should not survive');
  assert.ok(overlay.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});
