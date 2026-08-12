// The webRequest resource types the monitor can watch, shared by the background
// Service Worker and the options page so the two cannot drift apart.
//
// Chrome throws from addListener when a filter names a type it does not know,
// and a throw there would leave nothing listening at all, so anything read back
// from storage is checked against this list before it reaches a filter.
//
// The list is deliberately the long established set. Narrowing means "watch
// only these", so a type that is not here is not watched once the user narrows,
// which is the same answer as for any type they did not tick.
const KNOWN_REQUEST_TYPES = [
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
];

// null means every type.
//
// Two other values are read the same way. Every type ticked is the same request
// as no narrowing at all, so it is stored the one way, which gives "watch
// everything" a single representation. A value naming none of the known types
// also widens back: a filter that matches nothing would stop the monitor
// finding anything, with nothing on screen to explain why, and watching
// everything is the safer answer for a tool whose whole job is to notice
// requests.
function normalizeRequestTypes(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  // Filtering the known list rather than the stored one drops anything
  // unrecognized, removes repeats, and keeps a stable order
  const known = KNOWN_REQUEST_TYPES.filter(type => value.includes(type));

  if (known.length === 0 || known.length === KNOWN_REQUEST_TYPES.length) {
    return null;
  }

  return known;
}
