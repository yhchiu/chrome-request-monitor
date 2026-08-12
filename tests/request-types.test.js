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

// The shared list and its normalization, used by the background Service Worker
// to build a webRequest filter and by the options page to draw the checkboxes.
function loadRequestTypes() {
  const context = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'request-types.js'), 'utf8'),
    context,
    { filename: 'request-types.js' }
  );

  // A top level const is a lexical binding rather than a property of the global
  // object, so it has to be read by evaluating its name. The extension sees it
  // the same way: the options page and the Service Worker both load this file
  // as a plain script alongside the ones that use it, which share one scope.
  return vm.runInContext('({ KNOWN_REQUEST_TYPES, normalizeRequestTypes })', context);
}

const { KNOWN_REQUEST_TYPES, normalizeRequestTypes } = loadRequestTypes();

test('nothing stored means every type', () => {
  assert.equal(normalizeRequestTypes(undefined), null);
  assert.equal(normalizeRequestTypes(null), null);
});

test('a value that is not a list means every type', () => {
  // A hand edited settings file can hold anything
  assert.equal(normalizeRequestTypes('main_frame'), null);
  assert.equal(normalizeRequestTypes({ main_frame: true }), null);
  assert.equal(normalizeRequestTypes(42), null);
});

test('a narrowed list is kept', () => {
  assert.deepEqual(
    plain(normalizeRequestTypes(['main_frame', 'xmlhttprequest'])),
    ['main_frame', 'xmlhttprequest']
  );
});

test('every type listed is stored as every type', () => {
  // "Watch everything" gets a single representation, the same way the rule
  // focus does
  assert.equal(normalizeRequestTypes(Array.from(KNOWN_REQUEST_TYPES)), null);
});

test('an empty list means every type rather than nothing', () => {
  // A filter matching nothing would stop the monitor finding anything, with
  // nothing on screen to explain why
  assert.equal(normalizeRequestTypes([]), null);
});

test('types Chrome would not recognize are dropped', () => {
  // Passing one of these to a webRequest filter makes addListener throw
  assert.deepEqual(
    plain(normalizeRequestTypes(['main_frame', 'not_a_type', 'xmlhttprequest'])),
    ['main_frame', 'xmlhttprequest']
  );
});

test('a list of nothing but unknown types widens back to every type', () => {
  assert.equal(normalizeRequestTypes(['not_a_type', 'also_not_a_type']), null);
});

test('repeats are removed and the order is stable', () => {
  // The stored value should not depend on the order the boxes were ticked
  assert.deepEqual(
    plain(normalizeRequestTypes(['xmlhttprequest', 'main_frame', 'xmlhttprequest'])),
    ['main_frame', 'xmlhttprequest']
  );
});

test('the known types are the ones the webRequest filter accepts', () => {
  // Guards against a typo in the list, which would silently drop a type the
  // user ticked
  assert.deepEqual(plain(KNOWN_REQUEST_TYPES), [
    'main_frame',
    'sub_frame',
    'stylesheet',
    'script',
    'image',
    'font',
    'object',
    'xmlhttprequest',
    'ping',
    'csp_report',
    'media',
    'websocket',
    'other'
  ]);
});
