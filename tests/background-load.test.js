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

// A held area keeps its reads open until release() is called. That is how a
// test reproduces a request arriving before initialization has finished: the
// plain stub resolves within a microtask, which is far too quick for the race
// to ever show up.
function createStorageArea(initial, { held = false } = {}) {
  const data = { ...initial };
  const reads = [];
  const writes = [];

  let openReads;
  const opened = held
    ? new Promise(resolve => { openReads = resolve; })
    : null;

  return {
    data,
    reads,
    writes,
    release() {
      if (openReads) {
        openReads();
      }
    },
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

function createHarness({
  sync = {},
  local = {},
  session = {},
  tabs = [{ id: 1 }],
  // Tab ids that reject, the way a tab without the content script does
  unreachableTabIds = [],
  // Tab ids that no longer exist, so asking about them throws
  missingTabIds = [],
  // Keep the restore of the captured URLs open, so a request can arrive first
  holdSessionReads = false,
  // Make a narrowed filter throw, the way Chrome does for a type it does not
  // know
  rejectNarrowFilter = false
} = {}) {
  const syncArea = createStorageArea(sync);
  const localArea = createStorageArea(local);
  const sessionArea = createStorageArea(session, { held: holdSessionReads });

  const tabMessages = [];
  const tabQueries = [];
  const tabGets = [];
  const errors = [];
  const timers = [];

  let tabUpdatedListener;
  let tabRemovedListener;
  let activeTabId = 1;

  // A broadcast used to send to every tab at once. Watching how many messages
  // are outstanding is the only way to see that it no longer does.
  let inFlight = 0;
  let peakInFlight = 0;

  let messageListener;
  let requestListener;
  const requestFilters = [];
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
      get: (tabId) => {
        tabGets.push(tabId);
        if (missingTabIds.includes(tabId)) {
          return Promise.reject(new Error('No tab with id.'));
        }
        return Promise.resolve({
          id: tabId,
          title: `tab ${tabId}`,
          url: `https://example.com/tab/${tabId}`
        });
      },
      query: (queryInfo, callback) => {
        tabQueries.push(queryInfo);
        // The popup asks for the active tab; everything else is a broadcast
        const answer = queryInfo && queryInfo.active ? [{ id: activeTabId }] : tabs;
        if (callback) {
          callback(answer);
          return undefined;
        }
        return Promise.resolve(answer);
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
      },
      onUpdated: {
        addListener(listener) {
          tabUpdatedListener = listener;
        }
      },
      onRemoved: {
        addListener(listener) {
          tabRemovedListener = listener;
        }
      }
    },
    webRequest: {
      onBeforeRequest: {
        addListener(listener, filter) {
          if (rejectNarrowFilter && filter && filter.types) {
            throw new Error('Invalid value for argument 2. Unknown request type.');
          }
          requestListener = listener;
          requestFilters.push(filter);
        },
        // The filter is fixed when the listener is registered, so narrowing it
        // means taking the listener off and putting it back
        removeListener() {
          requestListener = null;
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
    // Stubbed so a test does not have to wait out the backup delay in real
    // time. runTimers() is what advances the clock.
    setTimeout(fn, delay) {
      const id = timers.length + 1;
      timers.push({ id, fn, delay, done: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.find(entry => entry.id === id);
      if (timer) {
        timer.done = true;
      }
    }
  });

  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'),
    context,
    { filename: 'background.js' }
  );

  return {
    syncArea,
    sessionArea,
    errors,
    tabMessages,
    tabQueries,
    tabGets,
    // Which tab the popup is looking at
    setActiveTab(tabId) {
      activeTabId = tabId;
    },
    // Report a tab the way Chrome does as it loads and its title settles
    updateTab(tab) {
      tabUpdatedListener(tab.id, { title: tab.title }, tab);
    },
    removeTab(tabId) {
      tabRemovedListener(tabId, { windowId: 1, isWindowClosing: false });
    },
    // Fire every timer that is still waiting, the way the clock reaching the
    // delay would
    runTimers() {
      timers
        .filter(timer => !timer.done)
        .forEach(timer => {
          timer.done = true;
          timer.fn();
        });
    },
    pendingTimers() {
      return timers.filter(timer => !timer.done).length;
    },
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
    requestFilters,
    // Whether anything is registered to receive requests at all
    hasRequestListener() {
      return Boolean(requestListener);
    },
    async request(url, tabId = 1, type = 'xmlhttprequest') {
      await requestListener({ url, tabId, type });
    },
    // Start a request without waiting for it, so a test can look at what the
    // background did while the request is still being handled
    startRequest(url, tabId = 1, type = 'xmlhttprequest') {
      return requestListener({ url, tabId, type });
    },
    // Let a held session storage area answer its reads
    releaseSessionReads() {
      sessionArea.release();
    },
    // Deliver a sync change the way Chrome does when another device edits
    syncRules(rules) {
      const oldValue = syncArea.data.urlRules;
      syncArea.data.urlRules = rules;
      storageListener({ urlRules: { oldValue, newValue: rules } }, 'sync');
    },
    syncRequestTypes(types) {
      const oldValue = syncArea.data.requestTypes;
      syncArea.data.requestTypes = types;
      storageListener({ requestTypes: { oldValue, newValue: types } }, 'sync');
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
    clearFoundUrls() {
      return new Promise(resolve => {
        messageListener({ action: 'clearFoundUrls' }, {}, resolve);
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
    getFoundUrls(request) {
      return new Promise(resolve => {
        messageListener(
          { action: 'getFoundUrls', currentTabOnly: false, ...request },
          {},
          response => resolve(response.urls)
        );
      });
    },
    syncDataSettings(settings) {
      const oldValue = syncArea.data.dataSettings;
      syncArea.data.dataSettings = settings;
      storageListener({ dataSettings: { oldValue, newValue: settings } }, 'sync');
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

// The backup to session storage serializes the whole captured list, which can
// hold a thousand entries. Doing that per match was the second largest cost
// behind reading the rules.

test('many matches in a row are backed up in a single write', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  for (let i = 0; i < 40; i += 1) {
    await harness.request(`https://a.example.com/${i}`);
  }
  await harness.settle();

  // Still waiting, so the writes have not gone out one at a time
  assert.deepEqual(harness.sessionArea.writes, []);

  harness.runTimers();
  await harness.settle();

  assert.equal(harness.sessionArea.writes.length, 1);
  assert.equal(harness.sessionArea.writes[0].foundUrls.length, 40);
});

test('a backup that has already gone out does not block the next one', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  await harness.request('https://a.example.com/one');
  await harness.settle();
  harness.runTimers();
  await harness.settle();

  await harness.request('https://a.example.com/two');
  await harness.settle();
  harness.runTimers();
  await harness.settle();

  assert.equal(harness.sessionArea.writes.length, 2);
  assert.equal(harness.sessionArea.writes[1].foundUrls.length, 2);
});

test('everything captured before the backup goes out is still in it', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  await harness.request('https://a.example.com/one');
  await harness.request('https://b.example.com/2');
  await harness.request('https://a.example.com/three');
  await harness.settle();
  harness.runTimers();
  await harness.settle();

  const written = harness.sessionArea.writes[0].foundUrls.map(entry => entry.url);
  assert.deepEqual(plain(written), [
    'https://a.example.com/one',
    'https://b.example.com/2',
    'https://a.example.com/three'
  ]);
});

test('clearing drops a backup that was still waiting to go out', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  await harness.request('https://a.example.com/one');
  await harness.settle();

  await harness.clearFoundUrls();
  await harness.settle();

  // A waiting backup would write the emptied cache straight back over the
  // removal
  assert.equal(harness.pendingTimers(), 0);

  harness.runTimers();
  await harness.settle();

  assert.deepEqual(harness.sessionArea.writes, []);
  assert.equal('foundUrls' in harness.sessionArea.data, false);
});

test('capturing again after a clear schedules a fresh backup', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  await harness.request('https://a.example.com/one');
  await harness.settle();
  await harness.clearFoundUrls();
  await harness.settle();

  await harness.request('https://a.example.com/two');
  await harness.settle();
  harness.runTimers();
  await harness.settle();

  assert.equal(harness.sessionArea.writes.length, 1);
  assert.deepEqual(
    plain(harness.sessionArea.writes[0].foundUrls.map(entry => entry.url)),
    ['https://a.example.com/two']
  );
});

// A match also needs the tab's title and url. Asking the browser for them per
// match was a second round trip on top of the rules, and requests that belong
// to no tab always threw.

test('the tab is asked about once, not once per match', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  for (let i = 0; i < 25; i += 1) {
    await harness.request(`https://a.example.com/${i}`, 7);
  }
  await harness.settle();

  assert.deepEqual(plain(harness.tabGets), [7]);
});

test('each tab is asked about separately', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  await harness.request('https://a.example.com/one', 7);
  await harness.request('https://a.example.com/two', 8);
  await harness.request('https://a.example.com/three', 7);
  await harness.settle();

  assert.deepEqual(plain(harness.tabGets), [7, 8]);
});

test('the captured URL still carries the tab title', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  await harness.request('https://a.example.com/one', 7);
  await harness.settle();

  const urls = await harness.getFoundUrls();
  assert.equal(urls[0].tabTitle, 'tab 7');
});

test('a request that belongs to no tab never asks the browser', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  // Requests from a Service Worker carry -1, and asking about that always threw
  await harness.request('https://a.example.com/one', -1);
  await harness.settle();

  assert.deepEqual(plain(harness.tabGets), []);
  const urls = await harness.getFoundUrls();
  assert.equal(urls.length, 1);
  assert.equal(urls[0].tabTitle, 'unknown');
});

test('a tab that reports itself is never asked about', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  harness.updateTab({ id: 7, title: 'Reported', url: 'https://reported.example.com/' });
  await harness.request('https://a.example.com/one', 7);
  await harness.settle();

  assert.deepEqual(plain(harness.tabGets), []);
  const urls = await harness.getFoundUrls();
  assert.equal(urls[0].tabTitle, 'Reported');
});

test('a title that changes as the page loads is the one captured', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  harness.updateTab({ id: 7, title: 'Loading', url: 'https://reported.example.com/' });
  harness.updateTab({ id: 7, title: 'Settled', url: 'https://reported.example.com/' });
  await harness.request('https://a.example.com/one', 7);
  await harness.settle();

  const urls = await harness.getFoundUrls();
  assert.equal(urls[0].tabTitle, 'Settled');
});

test('a closed tab is forgotten rather than kept for the life of the worker', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  harness.updateTab({ id: 7, title: 'Reported', url: 'https://reported.example.com/' });
  await harness.request('https://a.example.com/one', 7);
  await harness.settle();
  assert.deepEqual(plain(harness.tabGets), []);

  harness.removeTab(7);
  await harness.request('https://a.example.com/two', 7);
  await harness.settle();

  // Asking again is the proof the entry was dropped
  assert.deepEqual(plain(harness.tabGets), [7]);
});

test('an overlay still goes only to a tab showing an http page', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  harness.updateTab({ id: 7, title: 'Settings', url: 'chrome://settings' });
  await harness.request('https://a.example.com/one', 7);
  await harness.settle();

  assert.deepEqual(harness.overlayUrls(), []);
  // It is captured all the same, it just does not interrupt the page
  const urls = await harness.getFoundUrls();
  assert.equal(urls.length, 1);
});

test('a tab that has gone away does not stop the URL being captured', async () => {
  const harness = createHarness({ sync: { urlRules: RULES }, missingTabIds: [7] });
  await harness.settle();

  await harness.request('https://a.example.com/one', 7);
  await harness.settle();

  const urls = await harness.getFoundUrls();
  assert.equal(urls.length, 1);
  assert.equal(urls[0].tabTitle, 'unknown');
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

// The captured URLs used to share one list trimmed to the storage limit, so a
// noisy tab evicted what every other tab had captured. The popup shows the
// current tab by default, which made that view almost always empty on a busy
// profile.

test('a noisy tab does not evict what a quiet tab captured', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, dataSettings: { maxStorageLimit: 10 } }
  });
  await harness.settle();

  await harness.request('https://a.example.com/quiet', 2);

  // Far more than the limit, all from one other tab
  for (let i = 0; i < 50; i += 1) {
    await harness.request(`https://a.example.com/noisy-${i}`, 3);
  }
  await harness.settle();

  harness.setActiveTab(2);
  const urls = await harness.getFoundUrls({ currentTabOnly: true });
  assert.deepEqual(plain(urls.map(entry => entry.url)), ['https://a.example.com/quiet']);
});

test('the limit applies to each tab rather than to everything at once', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, dataSettings: { maxStorageLimit: 5 } }
  });
  await harness.settle();

  for (let i = 0; i < 8; i += 1) {
    await harness.request(`https://a.example.com/two-${i}`, 2);
    await harness.request(`https://a.example.com/three-${i}`, 3);
  }
  await harness.settle();

  harness.setActiveTab(2);
  const tabTwo = await harness.getFoundUrls({ currentTabOnly: true });
  harness.setActiveTab(3);
  const tabThree = await harness.getFoundUrls({ currentTabOnly: true });

  // Each tab keeps its own five, so ten are held where one list kept five
  assert.equal(tabTwo.length, 5);
  assert.equal(tabThree.length, 5);
  assert.deepEqual(plain(tabTwo.map(entry => entry.url)), [
    'https://a.example.com/two-3',
    'https://a.example.com/two-4',
    'https://a.example.com/two-5',
    'https://a.example.com/two-6',
    'https://a.example.com/two-7'
  ]);
});

test('the view across every tab is still in time order', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  await harness.request('https://a.example.com/first', 2);
  await harness.request('https://a.example.com/second', 3);
  await harness.request('https://a.example.com/third', 2);
  await harness.request('https://a.example.com/fourth', 3);
  await harness.settle();

  const urls = await harness.getFoundUrls({ currentTabOnly: false });
  const timestamps = urls.map(entry => entry.timestamp);
  assert.deepEqual(plain(timestamps), plain(timestamps).slice().sort((a, b) => a - b));
  assert.equal(urls.length, 4);
});

test('tabs beyond the tracked limit are dropped oldest first', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, dataSettings: { maxStorageLimit: 10 } }
  });
  await harness.settle();

  // One capture each from more tabs than are tracked
  for (let tabId = 1; tabId <= 60; tabId += 1) {
    await harness.request(`https://a.example.com/tab-${tabId}`, tabId);
  }
  await harness.settle();

  // The tab that captured first has been quiet the longest
  harness.setActiveTab(1);
  assert.deepEqual(plain(await harness.getFoundUrls({ currentTabOnly: true })), []);

  // The most recent ones are still there
  harness.setActiveTab(60);
  assert.equal((await harness.getFoundUrls({ currentTabOnly: true })).length, 1);

  // Fifty tabs are still held; the view across every tab is capped separately
  harness.setActiveTab(11);
  assert.equal((await harness.getFoundUrls({ currentTabOnly: true })).length, 1);
  harness.setActiveTab(10);
  assert.deepEqual(plain(await harness.getFoundUrls({ currentTabOnly: true })), []);
});

test('a tab that keeps capturing is not dropped for being old', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, dataSettings: { maxStorageLimit: 10 } }
  });
  await harness.settle();

  await harness.request('https://a.example.com/early', 1);

  for (let tabId = 2; tabId <= 60; tabId += 1) {
    await harness.request(`https://a.example.com/tab-${tabId}`, tabId);
    // Tab 1 keeps going, so it is never the least recently active
    await harness.request(`https://a.example.com/still-here-${tabId}`, 1);
  }
  await harness.settle();

  harness.setActiveTab(1);
  const urls = await harness.getFoundUrls({ currentTabOnly: true });
  assert.ok(urls.length > 0, 'a tab that keeps capturing should survive');
});

test('the popup is never handed more entries than the limit', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, dataSettings: { maxStorageLimit: 10 } }
  });
  await harness.settle();

  for (let tabId = 2; tabId <= 6; tabId += 1) {
    for (let i = 0; i < 10; i += 1) {
      await harness.request(`https://a.example.com/${tabId}-${i}`, tabId);
    }
  }
  await harness.settle();

  // Fifty are held across the tabs, but the popup builds a row per entry
  const urls = await harness.getFoundUrls({ currentTabOnly: false });
  assert.equal(urls.length, 10);
});

test('lowering the limit trims every tab straight away', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, dataSettings: { maxStorageLimit: 10 } }
  });
  await harness.settle();

  for (let i = 0; i < 10; i += 1) {
    await harness.request(`https://a.example.com/two-${i}`, 2);
    await harness.request(`https://a.example.com/three-${i}`, 3);
  }
  await harness.settle();

  harness.syncDataSettings({ maxStorageLimit: 2 });
  await harness.settle();

  harness.setActiveTab(2);
  assert.equal((await harness.getFoundUrls({ currentTabOnly: true })).length, 2);
  harness.setActiveTab(3);
  assert.equal((await harness.getFoundUrls({ currentTabOnly: true })).length, 2);
});

test('a backup written before the lists were split per tab still restores', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES },
    // The flat shape an older version wrote
    session: {
      foundUrls: [
        { url: 'https://a.example.com/1', timestamp: 1, tabId: 2, rule: { id: 'rule-a' } },
        { url: 'https://a.example.com/2', timestamp: 2, tabId: 3, rule: { id: 'rule-a' } },
        { url: 'https://a.example.com/3', timestamp: 3, tabId: 2, rule: { id: 'rule-a' } }
      ]
    }
  });
  await harness.settle();

  harness.setActiveTab(2);
  const tabTwo = await harness.getFoundUrls({ currentTabOnly: true });
  assert.deepEqual(plain(tabTwo.map(entry => entry.url)), [
    'https://a.example.com/1',
    'https://a.example.com/3'
  ]);

  assert.equal((await harness.getFoundUrls({ currentTabOnly: false })).length, 3);
});

test('the backup is written flat so it can be read back', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  await harness.request('https://a.example.com/one', 2);
  await harness.request('https://a.example.com/two', 3);
  await harness.settle();
  harness.runTimers();
  await harness.settle();

  const written = harness.sessionArea.writes[0].foundUrls;
  assert.equal(written.length, 2);
  assert.deepEqual(plain(written.map(entry => entry.tabId)), [2, 3]);
});

// A request is what wakes the Service Worker, so it can arrive before the
// captured URLs have been restored from session storage. The restore replaces
// what is held rather than adding to it, so anything captured first would be
// wiped by it.

test('a URL captured before the restore finishes is not wiped by it', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES },
    session: {
      foundUrls: [
        { url: 'https://a.example.com/restored', timestamp: 1, tabId: 2, rule: { id: 'rule-a' } }
      ]
    },
    holdSessionReads: true
  });

  const pending = harness.startRequest('https://a.example.com/captured', 2);
  await harness.settle();

  harness.releaseSessionReads();
  await pending;
  await harness.settle();

  harness.setActiveTab(2);
  const urls = await harness.getFoundUrls({ currentTabOnly: true });
  assert.deepEqual(plain(urls.map(entry => entry.url)), [
    'https://a.example.com/restored',
    'https://a.example.com/captured'
  ]);
});

test('nothing is decided about a request until the restore has finished', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES },
    holdSessionReads: true
  });

  const pending = harness.startRequest('https://a.example.com/one', 2);
  await harness.settle();

  // The overlay is what shows the request was handled
  assert.deepEqual(harness.overlayUrls(), []);

  harness.releaseSessionReads();
  await pending;
  await harness.settle();

  assert.deepEqual(harness.overlayUrls(), ['https://a.example.com/one']);
});

// Rules are only checked against the request types the user asked to watch.
// The handler decides, but the listener's filter is narrowed to match so Chrome
// stops delivering the rest at all.

test('every type is watched when nothing is stored', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  await harness.request('https://a.example.com/one', 1, 'image');
  await harness.request('https://a.example.com/two', 1, 'ping');
  await harness.settle();

  assert.equal((await harness.getFoundUrls()).length, 2);
});

test('the filter is left wide when every type is watched', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  // Re-registering for a filter that is already right would only churn
  assert.equal(harness.requestFilters.length, 1);
  assert.equal(harness.requestFilters[0].types, undefined);
});

test('a request of a type that is not watched is ignored', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, requestTypes: ['main_frame', 'xmlhttprequest'] }
  });
  await harness.settle();

  await harness.request('https://a.example.com/image', 1, 'image');
  await harness.settle();

  assert.deepEqual(plain(await harness.getFoundUrls()), []);
  assert.deepEqual(harness.overlayUrls(), []);
});

test('a request of a watched type is still captured', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, requestTypes: ['main_frame', 'xmlhttprequest'] }
  });
  await harness.settle();

  await harness.request('https://a.example.com/api', 1, 'xmlhttprequest');
  await harness.settle();

  assert.equal((await harness.getFoundUrls()).length, 1);
});

test('the listener is re-registered with the narrowed filter', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, requestTypes: ['main_frame', 'xmlhttprequest'] }
  });
  await harness.settle();

  // Wide first, because the listener has to be registered before the stored
  // types can be read, then narrowed
  assert.equal(harness.requestFilters.length, 2);
  assert.equal(harness.requestFilters[0].types, undefined);
  assert.deepEqual(plain(harness.requestFilters[1].types), ['main_frame', 'xmlhttprequest']);
});

test('a request arriving before the types are read is still judged by them', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, requestTypes: ['main_frame'] }
  });

  // The wide filter is in force this early, so the handler is what has to catch
  // this one
  const pending = harness.startRequest('https://a.example.com/image', 1, 'image');
  await pending;
  await harness.settle();

  assert.deepEqual(plain(await harness.getFoundUrls()), []);
});

test('changing the watched types narrows the filter again', async () => {
  const harness = createHarness({ sync: { urlRules: RULES } });
  await harness.settle();

  harness.syncRequestTypes(['main_frame']);
  await harness.settle();

  assert.deepEqual(plain(harness.requestFilters[harness.requestFilters.length - 1].types), ['main_frame']);

  await harness.request('https://a.example.com/image', 1, 'image');
  await harness.request('https://a.example.com/page', 1, 'main_frame');
  await harness.settle();

  assert.deepEqual(
    plain((await harness.getFoundUrls()).map(entry => entry.url)),
    ['https://a.example.com/page']
  );
});

test('going back to every type widens the filter again', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, requestTypes: ['main_frame'] }
  });
  await harness.settle();

  harness.syncRequestTypes(null);
  await harness.settle();

  assert.equal(harness.requestFilters[harness.requestFilters.length - 1].types, undefined);

  await harness.request('https://a.example.com/image', 1, 'image');
  await harness.settle();

  assert.equal((await harness.getFoundUrls()).length, 1);
});

test('an unchanged setting does not tear the listener down for nothing', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, requestTypes: ['main_frame'] }
  });
  await harness.settle();

  const before = harness.requestFilters.length;
  // The same list arriving again, as a sync from another device would
  harness.syncRequestTypes(['main_frame']);
  await harness.settle();

  assert.equal(harness.requestFilters.length, before);
});

test('a stored type Chrome would reject never reaches the filter', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, requestTypes: ['main_frame', 'not_a_type'] }
  });
  await harness.settle();

  assert.deepEqual(plain(harness.requestFilters[1].types), ['main_frame']);
});

test('a filter Chrome rejects leaves the listener watching everything', async () => {
  const harness = createHarness({
    sync: { urlRules: RULES, requestTypes: ['main_frame'] },
    rejectNarrowFilter: true
  });
  await harness.settle();

  // The recovery matters: the listener is taken off before it is put back, so
  // a throw in between would leave nothing listening at all
  assert.ok(harness.hasRequestListener(), 'something should still be listening');

  await harness.request('https://a.example.com/page', 1, 'main_frame');
  await harness.settle();

  assert.equal((await harness.getFoundUrls()).length, 1);
});
