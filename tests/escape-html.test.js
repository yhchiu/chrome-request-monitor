const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// The shared helper the popup, the options page and the content script all use
// before putting a stored value into innerHTML.
function loadEscapeHtml() {
  const context = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'escape-html.js'), 'utf8'),
    context,
    { filename: 'escape-html.js' }
  );
  return context.escapeHtml;
}

const escapeHtml = loadEscapeHtml();

test('the characters that start a tag are escaped', () => {
  assert.equal(
    escapeHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;'
  );
});

test('quotes are escaped so a value cannot break out of an attribute', () => {
  assert.equal(
    escapeHtml('" onmouseover="alert(1)'),
    '&quot; onmouseover=&quot;alert(1)'
  );
  assert.equal(escapeHtml("it's"), 'it&#039;s');
});

test('ampersands are escaped first so an escape cannot be re-read', () => {
  // Without this, &lt; in the input would come back out as <
  assert.equal(escapeHtml('&lt;script&gt;'), '&amp;lt;script&amp;gt;');
});

test('ordinary text is left alone', () => {
  assert.equal(
    escapeHtml('https://api.example.com/v1/users?page=2'),
    'https://api.example.com/v1/users?page=2'
  );
  assert.equal(escapeHtml('規則 A'), '規則 A');
});

test('a value that is not a string does not throw', () => {
  // Building the markup must not stop partway because a field was missing
  assert.equal(escapeHtml(undefined), 'undefined');
  assert.equal(escapeHtml(null), 'null');
  assert.equal(escapeHtml(42), '42');
});
