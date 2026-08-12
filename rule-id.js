// Stable identifiers for URL rules, shared by the background Service Worker and
// the options page. A rule used to be referred to by its position in the array,
// which points at a different rule as soon as any earlier one is deleted.

// Generate a stable identifier for a rule
function createRuleId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
