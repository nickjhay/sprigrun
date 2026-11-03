// Editorial seed intentions, not an authority registry or preallocated database.
// The future installer substitutes real returned references and operator-held keys.
export const values = [
  { label: 'moss_profile', file: 'moss_profile.md' },
  { label: 'first_morning', file: 'first_morning.md' },
  { label: 'small_sum', file: 'small_sum.moss' },
  { label: 'welcome', file: 'welcome.txt' },
];
export const identities = [
  { label: 'moss', topic: '/plot/moss', profile: 'moss_profile', key: null },
];
export const publications = [
  { label: 'morning', owner: 'moss', topic: 'notes/first_morning', value: 'first_morning' },
  { label: 'sum', owner: null, topic: '/grove/small_sum', value: 'small_sum' },
];
export const messages = [
  { author: 'moss', publication: 'sum', value: 'welcome' },
];
