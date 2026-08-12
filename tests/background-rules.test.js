const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Arrays built inside the VM belong to another realm, so their prototype does
// not match this realm's Array and deepStrictEqual rejects them. Copy first.
function plain(value) {
  return Array.isArray(value) ? Array.from(value) : value;
}

// Minimal chrome.storage area that supports both the promise and the callback
// calling styles used by background.js.
//
// A held area keeps its reads open until release() is called. That is how a
// test reproduces a request arriving before initialization has finished: the
// plain stub resolves within a microtask, which is far too quick for the race
// to ever show up.
function createStorageArea(initial, { held = false } = {}) {
  const data = { ...initial };
  const writes = [];

  let openReads;
  const opened = held
    ? new Promise(resolve => { openReads = resolve; })
    : null;

  return {
    data,
    writes,
    release() {
      if (openReads) {
        openReads();
      }
    },
    get(keys, callback) {
      const read = () => {
        const result = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        keyList.forEach(key => {
          if (key in data) {
            result[key] = data[key];
          }
        });
        return result;
      };

      if (callback) {
        // Kept synchronous unless the area is held, so the existing tests see
        // exactly the timing they were written against.
        if (opened) {
          opened.then(() => callback(read()));
        } else {
          callback(read());
        }
        return undefined;
      }
      return opened ? opened.then(read) : Promise.resolve(read());
    },
    set(items, callback) {
      Object.assign(data, items);
      writes.push(items);

      if (callback) {
        callback();
        return undefined;
      }
      return Promise.resolve();
    },
    remove(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      keyList.forEach(key => {
        delete data[key];
      });
      return Promise.resolve();
    }
  };
}

function createBackgroundHarness({
  sync = {},
  local = {},
  session = {},
  holdLocalReads = false
} = {}) {
  const syncArea = createStorageArea(sync);
  const localArea = createStorageArea(local, { held: holdLocalReads });
  const sessionArea = createStorageArea(session);
  const tabMessages = [];
  let messageListener;
  let requestListener;
  let storageListener;

  const chrome = {
    i18n: {
      getMessage: key => key
    },
    runtime: {
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    },
    storage: {
      sync: syncArea,
      local: localArea,
      session: sessionArea,
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        }
      }
    },
    tabs: {
      get: () => Promise.resolve({ title: 'tab', url: 'https://example.com' }),
      query: (queryInfo, callback) => {
        const tabs = [{ id: 1 }];
        if (callback) {
          callback(tabs);
          return undefined;
        }
        return Promise.resolve(tabs);
      },
      sendMessage: (tabId, message) => {
        tabMessages.push({ tabId, message });
        return Promise.resolve();
      },
      // The tab title cache keeps itself current from these
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} }
    },
    webRequest: {
      onBeforeRequest: {
        addListener(listener) {
          requestListener = listener;
        }
      }
    }
  };

  const context = vm.createContext({
    chrome,
    console,
    crypto,
    // Load the shared script into the same context, the way the Service Worker
    // does. A no-op stub would leave createRuleId undefined.
    importScripts(file) {
      vm.runInContext(
        fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
        context,
        { filename: file }
      );
    },
    setInterval() {
      return 0;
    },
    setTimeout,
    // The backup to session storage is scheduled on a timer and cancelled when
    // the captured URLs are cleared
    clearTimeout
  });

  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'),
    context,
    { filename: 'background.js' }
  );

  return {
    syncData: syncArea.data,
    syncWrites: syncArea.writes,
    localData: localArea.data,
    localWrites: localArea.writes,
    // Let the top level async initialization settle.
    async settle() {
      for (let i = 0; i < 10; i += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
    },
    // Let a held local storage area answer its reads
    releaseLocalReads() {
      localArea.release();
    },
    // Deliver a sync storage change the way Chrome does when another device
    // edits the rules
    syncRules(rules) {
      const oldValue = syncArea.data.urlRules;
      syncArea.data.urlRules = rules;
      storageListener({ urlRules: { oldValue, newValue: rules } }, 'sync');
    },
    sendMessage(message) {
      return new Promise(resolve => {
        messageListener(message, {}, resolve);
      });
    },
    // Drive the webRequest listener the way Chrome would
    async request(url, tabId = 1) {
      await requestListener({ url, tabId });
    },
    // Start a request without waiting for it, so a test can look at what the
    // background did while the request is still being handled
    startRequest(url, tabId = 1) {
      return requestListener({ url, tabId });
    },
    overlayMessages() {
      return tabMessages
        .filter(entry => entry.message.action === 'showUrlOverlay')
        .map(entry => entry.message.data.rule.id);
    },
    focusBroadcasts() {
      return tabMessages
        .filter(entry => entry.message.action === 'updateFocusedRules')
        .map(entry => plain(entry.message.focusedRuleIds));
    },
    getFoundUrls(request) {
      return new Promise(resolve => {
        messageListener(
          { action: 'getFoundUrls', currentTabOnly: false, ...request },
          {},
          response => resolve(response.urls)
        );
      });
    }
  };
}

test('migration gives every stored rule a stable id', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: [
        { name: 'A', type: 'contains', value: 'a.example.com', created: 1 },
        { name: 'B', type: 'regex', value: '\\d+', created: 2 }
      ]
    }
  });

  await harness.settle();

  const rules = harness.syncData.urlRules;
  assert.equal(rules.length, 2);
  assert.equal(typeof rules[0].id, 'string');
  assert.equal(typeof rules[1].id, 'string');
  assert.notEqual(rules[0].id, rules[1].id);
  // Existing fields survive the migration.
  assert.equal(rules[0].name, 'A');
  assert.equal(rules[0].value, 'a.example.com');
  assert.equal(rules[1].created, 2);
});

test('a legacy index filter that no longer resolves ends up showing every rule', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: [{ name: 'A', type: 'contains', value: 'a' }],
      selectedRule: '5'
    }
  });

  await harness.settle();

  assert.equal(harness.localData.focusedRuleIds, null);
  assert.equal('selectedRule' in harness.syncData, false);
});

const CAPTURED_URLS = [
  { url: 'https://a.example.com/1', timestamp: 1, tabId: 1, rule: { id: 'rule-a' } },
  { url: 'https://b.example.com/1', timestamp: 2, tabId: 1, rule: { id: 'rule-b' } },
  { url: 'https://c.example.com/1', timestamp: 3, tabId: 1, rule: { id: 'rule-c' } }
];

test('a null focus shows every rule', async () => {
  const harness = createBackgroundHarness({
    local: { focusedRuleIds: null },
    session: { foundUrls: CAPTURED_URLS }
  });

  await harness.settle();

  const urls = await harness.getFoundUrls();
  assert.equal(urls.length, 3);
});

test('found URLs are filtered by the focused rule ids', async () => {
  const harness = createBackgroundHarness({
    local: { focusedRuleIds: ['rule-a'] },
    session: { foundUrls: CAPTURED_URLS }
  });

  await harness.settle();

  const urls = await harness.getFoundUrls();
  assert.deepEqual(urls.map(entry => entry.url), ['https://a.example.com/1']);
});

test('several rules can be focused at once', async () => {
  const harness = createBackgroundHarness({
    local: { focusedRuleIds: ['rule-a', 'rule-c'] },
    session: { foundUrls: CAPTURED_URLS }
  });

  await harness.settle();

  const urls = await harness.getFoundUrls();
  assert.deepEqual(urls.map(entry => entry.url), [
    'https://a.example.com/1',
    'https://c.example.com/1'
  ]);
});

test('an empty focus shows nothing', async () => {
  const harness = createBackgroundHarness({
    local: { focusedRuleIds: [] },
    session: { foundUrls: CAPTURED_URLS }
  });

  await harness.settle();

  assert.deepEqual(await harness.getFoundUrls(), []);
});

test('deleting an earlier rule does not change what the remaining focus returns', async () => {
  const harness = createBackgroundHarness({
    // Rule A has been deleted, so under the old index scheme the filter for
    // rule B pointed at a missing index and returned nothing.
    sync: {
      urlRules: [{ id: 'rule-b', name: 'B', type: 'contains', value: 'b' }]
    },
    local: { focusedRuleIds: ['rule-b'] },
    session: { foundUrls: CAPTURED_URLS }
  });

  await harness.settle();

  const urls = await harness.getFoundUrls();
  assert.deepEqual(urls.map(entry => entry.url), ['https://b.example.com/1']);
});

test('editing a rule value keeps the URLs it already matched', async () => {
  const harness = createBackgroundHarness({
    // The rule now looks for a different host than when the URL was captured.
    sync: {
      urlRules: [{ id: 'rule-a', name: 'A', type: 'contains', value: 'api.other.com' }]
    },
    local: { focusedRuleIds: ['rule-a'] },
    session: {
      foundUrls: [
        {
          url: 'https://api.example.com/v1',
          timestamp: 1,
          tabId: 1,
          rule: { id: 'rule-a', type: 'contains', value: 'api.example.com' }
        }
      ]
    }
  });

  await harness.settle();

  const urls = await harness.getFoundUrls();
  assert.equal(urls.length, 1);
  assert.equal(urls[0].url, 'https://api.example.com/v1');
});

test('setFocusedRules updates the focus before it responds', async () => {
  const harness = createBackgroundHarness({
    local: { focusedRuleIds: null },
    session: { foundUrls: CAPTURED_URLS }
  });

  await harness.settle();

  await harness.sendMessage({ action: 'setFocusedRules', focusedRuleIds: ['rule-b'] });

  // No settle in between: the next query must already see the new focus.
  const urls = await harness.getFoundUrls();
  assert.deepEqual(urls.map(entry => entry.url), ['https://b.example.com/1']);
  assert.deepEqual(plain(harness.localData.focusedRuleIds), ['rule-b']);
});

const TWO_RULES = [
  { id: 'rule-a', name: 'A', type: 'contains', value: 'a.example.com' },
  { id: 'rule-b', name: 'B', type: 'contains', value: 'b.example.com' }
];

test('an overlay is sent for a focused rule', async () => {
  const harness = createBackgroundHarness({
    sync: { urlRules: TWO_RULES },
    local: { focusedRuleIds: ['rule-a'] }
  });

  await harness.settle();
  await harness.request('https://a.example.com/one');
  await harness.settle();

  assert.deepEqual(harness.overlayMessages(), ['rule-a']);
});

test('no overlay is sent for a rule outside the focus', async () => {
  const harness = createBackgroundHarness({
    sync: { urlRules: TWO_RULES },
    local: { focusedRuleIds: ['rule-a'] }
  });

  await harness.settle();
  await harness.request('https://b.example.com/one');
  await harness.settle();

  assert.deepEqual(harness.overlayMessages(), []);
});

test('a rule outside the focus is still captured', async () => {
  const harness = createBackgroundHarness({
    sync: { urlRules: TWO_RULES },
    local: { focusedRuleIds: ['rule-a'] }
  });

  await harness.settle();
  await harness.request('https://b.example.com/one');
  await harness.settle();

  // Showing every rule again reveals what was captured quietly.
  await harness.sendMessage({ action: 'setFocusedRules', focusedRuleIds: null });
  const urls = await harness.getFoundUrls();
  assert.deepEqual(plain(urls.map(entry => entry.rule.id)), ['rule-b']);
});

// A request is what wakes the Service Worker, so it can arrive before the
// stored focus has been read. Until it has, the in memory focus is still the
// "every rule" default, which would show overlays the user has hidden.

test('a request that arrives before the focus is loaded shows no overlay for a hidden rule', async () => {
  const harness = createBackgroundHarness({
    sync: { urlRules: TWO_RULES },
    local: { focusedRuleIds: ['rule-b'] },
    holdLocalReads: true
  });

  const pending = harness.startRequest('https://a.example.com/one');
  await harness.settle();

  // Nothing is decided while the stored focus is still unknown
  assert.deepEqual(harness.overlayMessages(), []);

  harness.releaseLocalReads();
  await pending;
  await harness.settle();

  // Rule A is outside the stored focus, so it stays quiet
  assert.deepEqual(harness.overlayMessages(), []);
});

test('a request that arrives before the focus is loaded still shows a focused rule', async () => {
  const harness = createBackgroundHarness({
    sync: { urlRules: TWO_RULES },
    local: { focusedRuleIds: ['rule-b'] },
    holdLocalReads: true
  });

  const pending = harness.startRequest('https://b.example.com/one');
  await harness.settle();
  assert.deepEqual(harness.overlayMessages(), []);

  harness.releaseLocalReads();
  await pending;
  await harness.settle();

  assert.deepEqual(harness.overlayMessages(), ['rule-b']);
});

test('a query that arrives before the focus is loaded waits for it', async () => {
  const harness = createBackgroundHarness({
    sync: { urlRules: TWO_RULES },
    local: { focusedRuleIds: ['rule-b'] },
    session: { foundUrls: CAPTURED_URLS },
    holdLocalReads: true
  });

  const pending = harness.getFoundUrls();
  await harness.settle();

  harness.releaseLocalReads();
  const urls = await pending;

  assert.deepEqual(plain(urls.map(entry => entry.rule.id)), ['rule-b']);
});

test('a URL captured before the migration finishes still carries a rule id', async () => {
  const harness = createBackgroundHarness({
    // Stored before rule ids existed, so the id is backfilled by the migration
    sync: { urlRules: [{ name: 'A', type: 'contains', value: 'a.example.com' }] },
    holdLocalReads: true
  });

  const pending = harness.startRequest('https://a.example.com/one');
  await harness.settle();

  harness.releaseLocalReads();
  await pending;
  await harness.settle();

  // Without an id the captured URL could never be matched against a focus
  const urls = await harness.getFoundUrls();
  assert.equal(urls.length, 1);
  assert.ok(urls[0].rule.id, 'the captured rule should carry an id');
});

// Rules can also be deleted on another device, which arrives here as a sync
// change rather than through the options page. Ids left pointing at rules that
// are gone match nothing, which silences every overlay.

test('a rule deleted on another device drops out of the focus', async () => {
  const harness = createBackgroundHarness({
    sync: { urlRules: TWO_RULES },
    local: { focusedRuleIds: ['rule-a', 'rule-b'] }
  });

  await harness.settle();
  harness.syncRules([TWO_RULES[1]]);
  await harness.settle();

  assert.deepEqual(plain(harness.localData.focusedRuleIds), ['rule-b']);
  assert.deepEqual(harness.focusBroadcasts(), [['rule-b']]);
});

test('deleting the last focused rule on another device widens back to every rule', async () => {
  const harness = createBackgroundHarness({
    sync: { urlRules: TWO_RULES },
    local: { focusedRuleIds: ['rule-a'] }
  });

  await harness.settle();
  harness.syncRules([TWO_RULES[1]]);
  await harness.settle();

  // Deleting a rule is not a request to silence the rest
  assert.equal(harness.localData.focusedRuleIds, null);
  assert.deepEqual(harness.focusBroadcasts(), [null]);

  await harness.request('https://b.example.com/one');
  await harness.settle();
  assert.deepEqual(harness.overlayMessages(), ['rule-b']);
});

test('a sync change that removes no focused rule writes nothing', async () => {
  const harness = createBackgroundHarness({
    sync: { urlRules: TWO_RULES },
    local: { focusedRuleIds: ['rule-b'] }
  });

  await harness.settle();
  const writesBefore = harness.localWrites.length;

  // Rule A was never focused, so the focus does not change
  harness.syncRules([TWO_RULES[1]]);
  await harness.settle();

  assert.equal(harness.localWrites.length, writesBefore);
  assert.deepEqual(harness.focusBroadcasts(), []);
});

test('showing nothing survives a rule being deleted elsewhere', async () => {
  const harness = createBackgroundHarness({
    sync: { urlRules: TWO_RULES },
    local: { focusedRuleIds: [] }
  });

  await harness.settle();
  harness.syncRules([TWO_RULES[1]]);
  await harness.settle();

  // An empty focus is a deliberate "show nothing", not a stale value
  assert.deepEqual(plain(harness.localData.focusedRuleIds), []);
  assert.deepEqual(harness.focusBroadcasts(), []);
});

test('a legacy filter naming a rule that is gone migrates to showing every rule', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: TWO_RULES,
      // Points at a rule that was deleted on another device before this one
      // had a chance to migrate
      selectedRule: 'rule-gone'
    }
  });

  await harness.settle();

  assert.equal(harness.localData.focusedRuleIds, null);
});

test('changing the focus is broadcast to the tabs', async () => {
  const harness = createBackgroundHarness({
    sync: { urlRules: TWO_RULES },
    local: { focusedRuleIds: null }
  });

  await harness.settle();
  await harness.sendMessage({ action: 'setFocusedRules', focusedRuleIds: ['rule-b'] });
  // The broadcast has to list the tabs first, so it lands after the response
  await harness.settle();

  assert.deepEqual(harness.focusBroadcasts(), [['rule-b']]);
});

test('the old single rule filter moves to local storage', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: [{ id: 'rule-a', name: 'A', type: 'contains', value: 'a' }],
      selectedRule: 'rule-a'
    }
  });

  await harness.settle();

  assert.deepEqual(plain(harness.localData.focusedRuleIds), ['rule-a']);
  assert.equal('selectedRule' in harness.syncData, false);
});

test('the old "all" filter becomes a null focus', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: [{ id: 'rule-a', name: 'A', type: 'contains', value: 'a' }],
      selectedRule: 'all'
    }
  });

  await harness.settle();

  assert.equal(harness.localData.focusedRuleIds, null);
  assert.equal('selectedRule' in harness.syncData, false);
});

test('a legacy index filter survives both migrations in order', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: [
        { name: 'A', type: 'contains', value: 'a' },
        { name: 'B', type: 'contains', value: 'b' }
      ],
      selectedRule: '1'
    }
  });

  await harness.settle();

  // The index became an id, and then moved to local storage as a set.
  const rules = harness.syncData.urlRules;
  assert.deepEqual(plain(harness.localData.focusedRuleIds), [rules[1].id]);
  assert.equal(rules[1].name, 'B');
  assert.equal('selectedRule' in harness.syncData, false);
});

test('an existing local focus wins over a synced legacy filter', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: [
        { id: 'rule-a', name: 'A', type: 'contains', value: 'a' },
        { id: 'rule-b', name: 'B', type: 'contains', value: 'b' }
      ],
      selectedRule: 'rule-a'
    },
    local: { focusedRuleIds: ['rule-b'] }
  });

  await harness.settle();

  assert.deepEqual(plain(harness.localData.focusedRuleIds), ['rule-b']);
  assert.equal('selectedRule' in harness.syncData, false);
});

test('nothing is written when there is no legacy filter to move', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: [{ id: 'rule-a', name: 'A', type: 'contains', value: 'a' }]
    }
  });

  await harness.settle();

  assert.deepEqual(harness.localWrites, []);
  assert.deepEqual(harness.syncWrites, []);
});

test('migration keeps ids that are already present and fills in only the gaps', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: [
        { id: 'rule-a', name: 'A', type: 'contains', value: 'a' },
        { name: 'B', type: 'contains', value: 'b' }
      ]
    }
  });

  await harness.settle();

  const rules = harness.syncData.urlRules;
  assert.equal(rules[0].id, 'rule-a');
  assert.equal(typeof rules[1].id, 'string');
  assert.notEqual(rules[1].id, 'rule-a');
});
