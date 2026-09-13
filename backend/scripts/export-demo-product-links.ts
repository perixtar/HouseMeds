// Read public catalog fields from Supabase. No household/prescription data is exported.
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {makePool} from '../src/db.js';
import {CP_API} from '../src/core.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const pool = makePool(true);
try {
  const {rows} = await pool.query(`select l.id::text as listing_id,
    l.metadata->>'catalog_name' as name, l.metadata->>'catalog_strength' as strength,
    l.metadata->>'catalog_form' as form, l.url
    from pricing.listings l join pricing.sources s on s.id=l.source_id
    where s.slug='costplus' and l.metadata->>'catalog_name' is not null order by l.id`);
  const entries = rows.map(row => ({...row, source: 'supabase_pricing_listings'}));
  // The demo photos include strengths and release forms beyond the small Supabase sample.
  // Fill those gaps from the pharmacy's documented public catalog, retaining provenance.
  const catalog = existsSync('.cache/costplus-public-catalog.json')
    ? JSON.parse(readFileSync('.cache/costplus-public-catalog.json', 'utf8'))
    : await (await fetch(CP_API, {signal: AbortSignal.timeout(45000)})).json();
  const demoNames = new Set(['levothyroxine', 'amlodipine', 'lisinopril', 'metformin',
    'metformin extended release (er)', 'atorvastatin', 'furosemide', 'apixaban', 'tamsulosin',
    'acetaminophen', 'metoprolol succinate er', 'losartan', 'pantoprazole', 'gabapentin',
    'nitroglycerin', 'cholecalciferol', 'empagliflozin', 'aspirin', 'sildenafil citrate']);
  const keys = new Set(entries.map(row => `${row.name}|${row.strength}|${row.form}`));
  for (const row of catalog.results) {
    const key = `${row.medication_name}|${row.strength}|${row.form}`;
    if (!demoNames.has(row.medication_name.toLowerCase()) || keys.has(key)) continue;
    entries.push({listing_id: null, name: row.medication_name, strength: row.strength,
      form: row.form, url: row.url, source: 'costplus_public_catalog'});
    keys.add(key);
  }
  for (const entry of entries) {
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' || url.hostname !== 'www.costplusdrugs.com'
      || !url.pathname.startsWith('/medications/') || url.username || url.password || url.port) {
      throw Error('Invalid pharmacy product URL');
    }
  }
  const snapshot = {exported_at: new Date().toISOString(), public_catalog_url: CP_API, entries};
  writeFileSync('../frontend/costplus-products.json', JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Exported ${rows.length} Supabase listings and ${entries.length - rows.length} supplemental public catalog products.`);
} finally { await pool.end(); }
