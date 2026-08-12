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

// options.js hangs everything else off DOMContentLoaded, which never fires
// here, so only the top level functions are loaded.
function loadOptions() {
  const messages = [];
  let storedFocus;

  const context = {
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(message);
        }
      },
      storage: {
        local: {
          get(keys, callback) {
            callback({ focusedRuleIds: storedFocus });
          }
        }
      }
    },
    console,
    crypto,
    document: {
      addEventListener() {}
    }
  };

  // The options page loads the shared script first, so the context needs it too
  vm.createContext(context);
  ['rule-id.js', 'options.js'].forEach(file => {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
      context,
      { filename: file }
    );
  });

  return {
    focusAfterRuleAdded: context.focusAfterRuleAdded,
    focusAfterRuleDeleted: context.focusAfterRuleDeleted,
    applyFocusChange(current, update) {
      storedFocus = current;
      messages.length = 0;
      context.applyFocusChange(update);
      return messages.map(message => plain(message.focusedRuleIds));
    }
  };
}

test('a new rule joins a narrowed selection', () => {
  const { focusAfterRuleAdded } = loadOptions();

  assert.deepEqual(
    plain(focusAfterRuleAdded(['rule-a'], 'rule-b')),
    ['rule-a', 'rule-b']
  );
});

test('a new rule changes nothing when every rule is already shown', () => {
  const { focusAfterRuleAdded } = loadOptions();

  assert.equal(focusAfterRuleAdded(null, 'rule-b'), null);
});

test('a new rule is not added twice', () => {
  const { focusAfterRuleAdded } = loadOptions();

  assert.deepEqual(
    plain(focusAfterRuleAdded(['rule-a', 'rule-b'], 'rule-b')),
    ['rule-a', 'rule-b']
  );
});

test('deleting a shown rule leaves the others selected', () => {
  const { focusAfterRuleDeleted } = loadOptions();

  assert.deepEqual(
    plain(focusAfterRuleDeleted(['rule-a', 'rule-b'], 'rule-a')),
    ['rule-b']
  );
});

test('deleting the only shown rule widens back to every rule', () => {
  const { focusAfterRuleDeleted } = loadOptions();

  // Leaving an empty selection here would silence everything, which is not
  // what deleting one rule asks for.
  assert.equal(focusAfterRuleDeleted(['rule-a'], 'rule-a'), null);
});

test('deleting a rule that was not shown keeps the selection as it was', () => {
  const { focusAfterRuleDeleted } = loadOptions();
  const focus = ['rule-a'];

  // Returned unchanged, so applyFocusChange can skip the write.
  assert.equal(focusAfterRuleDeleted(focus, 'rule-b'), focus);
});

test('deleting a rule changes nothing when every rule is shown', () => {
  const { focusAfterRuleDeleted } = loadOptions();

  assert.equal(focusAfterRuleDeleted(null, 'rule-a'), null);
});

test('a changed selection is pushed to the background', () => {
  const options = loadOptions();

  const sent = options.applyFocusChange(['rule-a'], current =>
    current.concat(['rule-b'])
  );

  assert.deepEqual(sent, [['rule-a', 'rule-b']]);
});

test('an unchanged selection is not pushed anywhere', () => {
  const options = loadOptions();

  const sent = options.applyFocusChange(['rule-a'], current => current);

  assert.deepEqual(sent, []);
});

test('clearing every rule resets the selection', () => {
  const options = loadOptions();

  const sent = options.applyFocusChange(['rule-a'], () => null);

  assert.deepEqual(sent, [null]);
});
