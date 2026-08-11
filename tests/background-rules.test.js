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
function createStorageArea(initial) {
  const data = { ...initial };
  const writes = [];

  return {
    data,
    writes,
    get(keys, callback) {
      const result = {};
      const keyList = Array.isArray(keys) ? keys : [keys];
      keyList.forEach(key => {
        if (key in data) {
          result[key] = data[key];
        }
      });

      if (callback) {
        callback(result);
        return undefined;
      }
      return Promise.resolve(result);
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

function createBackgroundHarness({ sync = {}, local = {}, session = {} } = {}) {
  const syncArea = createStorageArea(sync);
  const localArea = createStorageArea(local);
  const sessionArea = createStorageArea(session);
  let messageListener;

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
        addListener() {}
      }
    },
    tabs: {
      get: () => Promise.resolve({ title: 'tab', url: 'https://example.com' }),
      query: () => Promise.resolve([{ id: 1 }]),
      sendMessage: () => Promise.resolve()
    },
    webRequest: {
      onBeforeRequest: {
        addListener() {}
      }
    }
  };

  const backgroundSource = fs.readFileSync(
    path.join(__dirname, '..', 'background.js'),
    'utf8'
  );

  vm.runInNewContext(backgroundSource, {
    chrome,
    console,
    crypto,
    setInterval() {
      return 0;
    },
    setTimeout
  }, { filename: 'background.js' });

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
    sendMessage(message) {
      return new Promise(resolve => {
        messageListener(message, {}, resolve);
      });
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
