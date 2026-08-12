const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// These tests are about what the background does per request and per tab rather
// than about what it decides, which background-rules.test.js already covers. So
// the storage areas here count their reads and the tab stub records every
// message, which is what makes the cost visible.

// Arrays built inside the VM belong to another realm, so their prototype does
// not match this realm's Array and deepStrictEqual rejects them. Copy first.
function plain(value) {
  return Array.isArray(value) ? Array.from(value) : value;
}

function createStorageArea(initial) {
  const data = { ...initial };
  const reads = [];
  const writes = [];

  return {
    data,
    reads,
    writes,
    // How many reads asked for this key, which is the per request cost under
    // test
    readsOf(key) {
      return reads.filter(keyList => keyList.includes(key)).length;
    },
    get(keys, callback) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      reads.push(keyList);

      const read = () => {
        const result = {};
        keyList.forEach(key => {
          if (key in data) {
            result[key] = data[key];
          }
        });
        return result;
      };

      if (callback) {
        callback(read());
        return undefined;
      }
      return Promise.resolve(read());
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

function createHarness({
  sync = {},
  local = {},
  session = {},
  tabs = [{ id: 1 }],
  // Tab ids that reject, the way a tab without the content script does
  unreachableTabIds = []
} = {}) {
  const syncArea = createStorageArea(sync);
  const localArea = createStorageArea(local);
  const sessionArea = createStorageArea(session);

  const tabMessages = [];
  const tabQueries = [];
  const errors = [];

  // A broadcast used to send to every tab at once. Watching how many messages
  // are outstanding is the only way to see that it no longer does.
  let inFlight = 0;
  let peakInFlight = 0;

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
        tabQueries.push(queryInfo);
        if (callback) {
          callback(tabs);
          return undefined;
        }
        return Promise.resolve(tabs);
      },
      sendMessage: (tabId, message) => {
        tabMessages.push({ tabId, message });
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);

        // Answering on a later turn is what makes the batching observable: a
        // stub that resolved straight away would never show more than one
        // message outstanding.
        return new Promise((resolve, reject) => {
          setImmediate(() => {
            inFlight -= 1;
            if (unreachableTabIds.includes(tabId)) {
              reject(new Error('Receiving end does not exist.'));
              return;
            }
            resolve();
          });
        });
      }
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
    console: {
      log: console.log,
      warn() {},
      // Counted rather than printed: an unusable rule should be reported when
      // it is compiled, not once per request
      error(...args) {
        errors.push(args.join(' '));
      }
    },
    crypto,
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
    setTimeout
  });

  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'),
    context,
    { filename: 'background.js' }
  );

  return {
    syncArea,
    errors,
    tabMessages,
    tabQueries,
    peakInFlight() {
      return peakInFlight;
    },
    // Generous by default: a batched broadcast needs a turn per batch, so the
    // ten turns the other suites use would stop partway through one.
    async settle(turns = 60) {
      for (let i = 0; i < turns; i += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
    },
    async request(url, tabId = 1) {
      await requestListener({ url, tabId });
    },
    // Deliver a sync change the way Chrome does when another device edits
    syncRules(rules) {
      const oldValue = syncArea.data.urlRules;
      syncArea.data.urlRules = rules;
      storageListener({ urlRules: { oldValue, newValue: rules } }, 'sync');
    },
    syncOverlaySettings(settings) {
      const oldValue = syncArea.data.overlaySettings;
      syncArea.data.overlaySettings = settings;
      storageListener({ overlaySettings: { oldValue, newValue: settings } }, 'sync');
    },
    setFocusedRules(focusedRuleIds) {
      return new Promise(resolve => {
        messageListener({ action: 'setFocusedRules', focusedRuleIds }, {}, resolve);
      });
    },
    messagesOfAction(action) {
      return tabMessages.filter(entry => entry.message.action === action);
    },
    overlayUrls() {
      return tabMessages
        .filter(entry => entry.message.action === 'showUrlOverlay')
        .map(entry => entry.message.data.url);
    },
    getFoundUrls() {
      return new Promise(resolve => {
        messageListener(
          { action: 'getFoundUrls', currentTabOnly: false },
          {},
          response => resolve(response.urls)
        );
      });
    }
  };
}

const RULES = [
  { id: 'rule-a', name: 'A', type: 'contains', value: 'a.example.com' },
  { id: 'rule-b', name: 'B', type: 'regex', value: 'b\\.example\\.com/\\d+' }
];

// A request is the hot path: at ten thousand tabs the browser makes thousands
// of them a second, and each storage read is a round trip to the browser
// process.

test('the rules are read from storage once, not once per request', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  const readsAfterStartup = harness.syncArea.readsOf('urlRules');

  for (let i = 0; i < 25; i += 1) {
    await harness.request(`https://a.example.com/${i}`);
  }
  await harness.settle();

  assert.equal(harness.syncArea.readsOf('urlRules'), readsAfterStartup);
});

test('a request that matches nothing still reads no storage', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  const readsAfterStartup = harness.syncArea.readsOf('urlRules');

  await harness.request('https://unrelated.example.org/one');
  await harness.settle();

  assert.equal(harness.syncArea.readsOf('urlRules'), readsAfterStartup);
});

test('an unusable regex is reported once rather than on every request', async () => {
  const harness = createHarness({
    sync: {
      urlRules: [{ id: 'rule-bad', name: 'Bad', type: 'regex', value: '([' }]
    }
  });
  await harness.settle();

  for (let i = 0; i < 5; i += 1) {
    await harness.request(`https://example.com/${i}`);
  }
  await harness.settle();

  const reported = harness.errors.filter(message => message.includes('Invalid regex pattern'));
  assert.equal(reported.length, 1);
});

test('a rule with an unusable regex matches nothing but leaves the others working', async () => {
  const harness = createHarness({
    sync: {
      urlRules: [
        { id: 'rule-bad', name: 'Bad', type: 'regex', value: '([' },
        { id: 'rule-a', name: 'A', type: 'contains', value: 'a.example.com' }
      ]
    }
  });
  await harness.settle();

  await harness.request('https://a.example.com/one');
  await harness.settle();

  assert.deepEqual(harness.overlayUrls(), ['https://a.example.com/one']);
});

test('every match type still matches from the cached rules', async () => {
  const harness = createHarness({
    sync: {
      urlRules: [
        { id: 'c', name: 'C', type: 'contains', value: 'contains-me' },
        { id: 's', name: 'S', type: 'startswith', value: 'https://start.example.com' },
        { id: 'e', name: 'E', type: 'endswith', value: '.json' },
        { id: 'r', name: 'R', type: 'regex', value: 'RE\\d+' }
      ]
    }
  });
  await harness.settle();

  await harness.request('https://x.example.com/contains-me/path');
  await harness.request('https://start.example.com/anything');
  await harness.request('https://x.example.com/data.json');
  await harness.request('https://x.example.com/re42');
  await harness.settle();

  assert.equal(harness.overlayUrls().length, 4);
});

// The rules are cached, so a change made anywhere has to reach the cache or the
// extension would keep matching against a stale set until the next restart.

test('a rule edited on another device is matched without reading storage again', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  harness.syncRules([{ id: 'rule-a', name: 'A', type: 'contains', value: 'moved.example.com' }]);
  await harness.settle();

  const readsAfterChange = harness.syncArea.readsOf('urlRules');

  await harness.request('https://moved.example.com/one');
  await harness.request('https://a.example.com/one');
  await harness.settle();

  assert.deepEqual(harness.overlayUrls(), ['https://moved.example.com/one']);
  assert.equal(harness.syncArea.readsOf('urlRules'), readsAfterChange);
});

test('clearing the rules on another device stops every match', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  harness.syncRules([]);
  await harness.settle();

  await harness.request('https://a.example.com/one');
  await harness.settle();

  assert.deepEqual(harness.overlayUrls(), []);
  assert.deepEqual(plain(await harness.getFoundUrls()), []);
});

test('a regex rule added on another device is compiled once for the whole set of requests', async () => {
  const harness = createHarness({ sync: { urlRules: [] } });
  await harness.settle();

  harness.syncRules([{ id: 'rule-bad', name: 'Bad', type: 'regex', value: '([' }]);
  await harness.settle();

  for (let i = 0; i < 5; i += 1) {
    await harness.request(`https://example.com/${i}`);
  }
  await harness.settle();

  const reported = harness.errors.filter(message => message.includes('Invalid regex pattern'));
  assert.equal(reported.length, 1);
});

// Broadcasts go out whenever the user changes what they are looking at, which
// is as often as a checkbox in the popup. Sending to every tab at once made
// that a browser wide stall on a profile with many tabs open.

function manyTabs(count) {
  return Array.from({ length: count }, (unused, index) => ({ id: index + 1 }));
}

test('a focus broadcast reaches every tab', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES },
    local: { focusedRuleIds: null },
    tabs: manyTabs(500)
  });
  await harness.settle();

  await harness.setFocusedRules(['rule-a']);
  await harness.settle();

  const sent = harness.messagesOfAction('updateFocusedRules');
  assert.equal(sent.length, 500);
  assert.deepEqual(plain(sent[0].message.focusedRuleIds), ['rule-a']);
});

test('a focus broadcast keeps a bounded number of messages in flight', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES },
    local: { focusedRuleIds: null },
    tabs: manyTabs(500)
  });
  await harness.settle();

  await harness.setFocusedRules(['rule-a']);
  await harness.settle();

  assert.equal(harness.messagesOfAction('updateFocusedRules').length, 500);
  assert.ok(
    harness.peakInFlight() <= 50,
    `expected at most 50 messages in flight, saw ${harness.peakInFlight()}`
  );
});

test('the broadcast asks only for tabs that can receive it', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES },
    local: { focusedRuleIds: null }
  });
  await harness.settle();

  await harness.setFocusedRules(['rule-a']);
  await harness.settle();

  // A discarded tab has no renderer and a non http page never ran the content
  // script, so asking for them only buys rejections to throw away
  const query = harness.tabQueries[harness.tabQueries.length - 1];
  assert.equal(query.discarded, false);
  assert.deepEqual(plain(query.url), ['http://*/*', 'https://*/*']);
});

test('a tab that cannot receive the broadcast does not stop the rest', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES },
    local: { focusedRuleIds: null },
    tabs: manyTabs(120),
    // Spread across batches so a whole batch is never lost at once
    unreachableTabIds: [3, 60, 61, 119]
  });
  await harness.settle();

  await harness.setFocusedRules(['rule-a']);
  await harness.settle();

  assert.equal(harness.messagesOfAction('updateFocusedRules').length, 120);
});

test('an overlay settings change is broadcast the same bounded way', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES },
    tabs: manyTabs(500)
  });
  await harness.settle();

  harness.syncOverlaySettings({ maxOverlays: 3, timeoutSeconds: 10, position: 'top-left', opacity: 0.5 });
  await harness.settle();

  const sent = harness.messagesOfAction('updateOverlaySettings');
  assert.equal(sent.length, 500);
  assert.equal(sent[0].message.settings.maxOverlays, 3);
  assert.ok(
    harness.peakInFlight() <= 50,
    `expected at most 50 messages in flight, saw ${harness.peakInFlight()}`
  );
});

test('rules backfilled with ids by the migration are the ones matched against', async () => {
  const harness = createHarness({
    // Stored before rule ids existed
    sync: { urlRules: [{ name: 'A', type: 'contains', value: 'a.example.com' }] }
  });
  await harness.settle();

  await harness.request('https://a.example.com/one');
  await harness.settle();

  const urls = await harness.getFoundUrls();
  assert.equal(urls.length, 1);
  assert.ok(urls[0].rule.id, 'the captured rule should carry an id');
});
