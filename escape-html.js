// HTML escaping, shared by the popup, the options page and the content script.
//
// All three build their markup as strings and assign it through innerHTML, and
// the values they interpolate are not ours to trust. A rule name and a rule
// value are typed by the user but also arrive from an imported settings file,
// and a captured URL is whatever a page asked the network for.
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };

  // String() rather than toString(), so a missing value escapes to something
  // harmless instead of throwing partway through building the markup
  return String(text).replace(/[&<>"']/g, character => map[character]);
}
