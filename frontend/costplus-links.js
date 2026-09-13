import catalog from './costplus-products.json' with {type: 'json'};

export const costPlusBrowseUrl = 'https://www.costplusdrugs.com/medications/';
const cleanName = value => value.toLowerCase().replace(/extended[ -]release/gi, 'er')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\ber\s+er\b/g, 'er');
const cleanStrength = value => value.toLowerCase().replace(/\s/g, '');

export function costPlusProduct(fields, entries = catalog.entries) {
  let name = cleanName(fields.medication || '');
  // Some labels keep the release marker in the form field. Never drop it when matching.
  if (/\b(er|extended[ -]release)\b/i.test(fields.form || '') && !/\ber\b/.test(name)) name += ' er';
  const strength = cleanStrength(fields.strength || '');
  if (!name || !strength) return null;
  const matches = entries.filter(entry => cleanName(entry.name) === name
    && cleanStrength(entry.strength) === strength);
  const urls = [...new Set(matches.map(entry => entry.url))];
  if (urls.length !== 1) return null;
  try {
    const url = new URL(urls[0]);
    if (url.protocol !== 'https:' || url.hostname !== 'www.costplusdrugs.com'
      || !url.pathname.startsWith('/medications/') || url.username || url.password || url.port) return null;
    return {url: url.href, name: `${matches[0].name} ${matches[0].strength} ${matches[0].form}`,
      source: matches[0].source};
  } catch { return null; }
}
