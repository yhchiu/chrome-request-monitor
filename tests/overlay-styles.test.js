const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// The overlay's appearance lives in the stylesheet rather than in the script,
// because the stylesheet resets the overlay with `all: initial !important` to
// keep the host page's styles out, and an important declaration beats a plain
// inline one. A colour the script assigned to element.style therefore never
// took effect, and a button with no rule of its own was left transparent by
// that reset and vanished into the overlay.
//
// None of that is visible to the tests above, which run against a DOM stub with
// no cascade. What can be checked is that the declarations the arrangement
// depends on are still there.

const ROOT = path.join(__dirname, '..');
const styles = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

const BUTTONS = ['copy-btn', 'close-btn', 'close-all-btn'];

// Whitespace tolerant, so reformatting the stylesheet does not fail these
function hasRule(selector) {
  const pattern = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(,|\\{)');
  return pattern.test(styles);
}

BUTTONS.forEach(button => {
  test(`the stylesheet gives .${button} its own colour`, () => {
    assert.ok(hasRule(`.url-monitor-overlay .${button}`),
      'without a rule of its own the button is left transparent by all: initial');
  });

  test(`the stylesheet gives .${button} a hovered colour`, () => {
    assert.ok(hasRule(`.url-monitor-overlay .${button}:hover`),
      'the script cannot do this: a plain inline colour loses to the reset above');
  });
});

test('every button colour is drawn from the opacity custom property', () => {
  // Rather than a fixed alpha, so one setting drives the overlay, its buttons
  // and the copied confirmation without any of them being restated
  const declarations = styles.match(/\.url-monitor-overlay [^{]*\{[^}]*background:[^;]*;/g) || [];

  assert.ok(declarations.length >= BUTTONS.length, 'expected a background per button');
  declarations.forEach(declaration => {
    assert.match(declaration, /var\(--url-monitor-opacity\)/);
  });
});

test('the hovered opacity is important so it can beat the inline setting', () => {
  // The script writes the setting to the overlay's inline style, and a plain
  // inline declaration outranks any rule in the stylesheet however specific.
  // Without !important here the hovered state silently never applies.
  const hoverRule = styles.match(/\.url-monitor-overlay:hover\s*\{[^}]*\}/);

  assert.ok(hoverRule, 'the overlay should have a hovered rule');
  assert.match(hoverRule[0], /--url-monitor-opacity:\s*1\s*!important/);
});

test('the script assigns no button colours of its own', () => {
  // These are what used to fight the stylesheet and lose
  assert.doesNotMatch(content, /\.style\.background\s*=/);
  assert.doesNotMatch(content, /setProperty\(\s*['"]background['"]/);
});
