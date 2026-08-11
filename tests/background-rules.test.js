const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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

function createBackgroundHarness({ sync = {}, session = {} } = {}) {
  const syncArea = createStorageArea(sync);
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
    // Let the top level async initialization settle.
    async settle() {
      for (let i = 0; i < 5; i += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
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

test('migration converts a legacy index filter to the matching rule id', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: [
        { name: 'A', type: 'contains', value: 'a' },
        { name: 'B', type: 'contains', value: 'b' },
        { name: 'C', type: 'contains', value: 'c' }
      ],
      selectedRule: '1'
    }
  });

  await harness.settle();

  const rules = harness.syncData.urlRules;
  assert.equal(harness.syncData.selectedRule, rules[1].id);
  assert.equal(rules[1].name, 'B');
});

test('migration drops a legacy index filter that no longer resolves', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: [{ name: 'A', type: 'contains', value: 'a' }],
      selectedRule: '5'
    }
  });

  await harness.settle();

  assert.equal(harness.syncData.selectedRule, 'all');
});

test('migration does not write when rules already have ids', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: [{ id: 'rule-a', name: 'A', type: 'contains', value: 'a' }],
      selectedRule: 'rule-a'
    }
  });

  await harness.settle();

  assert.deepEqual(harness.syncWrites, []);
  assert.equal(harness.syncData.selectedRule, 'rule-a');
});

test('found URLs are filtered by rule id', async () => {
  const harness = createBackgroundHarness({
    sync: {
      urlRules: [
        { id: 'rule-a', name: 'A', type: 'contains', value: 'a' },
        { id: 'rule-b', name: 'B', type: 'contains', value: 'b' }
      ]
    },
    session: {
      foundUrls: [
        { url: 'https://a.example.com/1', timestamp: 1, tabId: 1, rule: { id: 'rule-a' } },
        { url: 'https://b.example.com/1', timestamp: 2, tabId: 1, rule: { id: 'rule-b' } },
        { url: 'https://a.example.com/2', timestamp: 3, tabId: 1, rule: { id: 'rule-a' } }
      ]
    }
  });

  await harness.settle();

  const urls = await harness.getFoundUrls({ ruleFilter: 'rule-a' });
  assert.deepEqual(urls.map(entry => entry.url), [
    'https://a.example.com/1',
    'https://a.example.com/2'
  ]);
});

test('deleting an earlier rule does not change what the remaining filter returns', async () => {
  const harness = createBackgroundHarness({
    // Rule A has been deleted, so under the old index scheme the filter for
    // rule B pointed at a missing index and returned nothing.
    sync: {
      urlRules: [{ id: 'rule-b', name: 'B', type: 'contains', value: 'b' }]
    },
    session: {
      foundUrls: [
        { url: 'https://a.example.com/1', timestamp: 1, tabId: 1, rule: { id: 'rule-a' } },
        { url: 'https://b.example.com/1', timestamp: 2, tabId: 1, rule: { id: 'rule-b' } }
      ]
    }
  });

  await harness.settle();

  const urls = await harness.getFoundUrls({ ruleFilter: 'rule-b' });
  assert.deepEqual(urls.map(entry => entry.url), ['https://b.example.com/1']);
});

test('editing a rule value keeps the URLs it already matched', async () => {
  const harness = createBackgroundHarness({
    // The rule now looks for a different host than when the URL was captured.
    sync: {
      urlRules: [{ id: 'rule-a', name: 'A', type: 'contains', value: 'api.other.com' }]
    },
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

  const urls = await harness.getFoundUrls({ ruleFilter: 'rule-a' });
  assert.equal(urls.length, 1);
  assert.equal(urls[0].url, 'https://api.example.com/v1');
});

test('an unknown rule filter returns no URLs', async () => {
  const harness = createBackgroundHarness({
    session: {
      foundUrls: [
        { url: 'https://a.example.com/1', timestamp: 1, tabId: 1, rule: { id: 'rule-a' } }
      ]
    }
  });

  await harness.settle();

  const urls = await harness.getFoundUrls({ ruleFilter: 'rule-gone' });
  assert.deepEqual(urls, []);
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
