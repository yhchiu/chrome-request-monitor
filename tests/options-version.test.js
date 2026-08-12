const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadDisplayExtensionVersion(manifestVersion) {
  const versionElement = { textContent: '' };
  const messageCalls = [];
  const context = {
    chrome: {
      runtime: {
        getManifest() {
          return { version: manifestVersion };
        }
      }
    },
    console,
    crypto,
    document: {
      addEventListener() {},
      querySelector(selector) {
        return selector === '[data-i18n="extensionVersion"]'
          ? versionElement
          : null;
      }
    },
    getMessage(key, substitution) {
      messageCalls.push({ key, substitution });
      return `Version ${substitution}`;
    }
  };

  vm.createContext(context);
  ['rule-id.js', 'options.js'].forEach(file => {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
      context,
      { filename: file }
    );
  });

  return {
    display: context.displayExtensionVersion,
    messageCalls,
    versionElement
  };
}

test('the options page displays the version from the extension manifest', () => {
  const options = loadDisplayExtensionVersion('9.8.7');

  options.display();

  assert.equal(options.versionElement.textContent, 'Version 9.8.7');
  assert.deepEqual(options.messageCalls, [
    { key: 'extensionVersion', substitution: '9.8.7' }
  ]);
});
