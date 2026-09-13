import test from 'node:test';
import assert from 'node:assert/strict';
import {costPlusProduct, costPlusBrowseUrl} from '../costplus-links.js';
import {prototypeDeals} from '../deals.js';

test('Dad’s Metformin ER 500 mg links to the exact extended-release product', () => {
  const product = costPlusProduct({medication: 'Metformin ER', strength: '500 mg'});
  assert.equal(product.url, 'https://www.costplusdrugs.com/medications/metforminextendedreleaseer-500mg-tablet/');
  assert.match(product.name, /Extended Release/);
});

test('regular Metformin and ER in the form field retain their different product links', () => {
  const regular = costPlusProduct({medication: 'metformin', strength: '500mg'});
  const extended = costPlusProduct({medication: 'metformin', strength: '500mg', form: 'extended release tablet'});
  assert.equal(regular.url, 'https://www.costplusdrugs.com/medications/metformin-500mg-tablet/');
  assert.notEqual(regular.url, extended.url);
});

test('no wrong-strength, partial-name, brand or combination substitution', () => {
  for (const medication of ['Metformin ER combination', 'Metformin HCl ER (Osm)', 'Synthroid']) {
    assert.equal(costPlusProduct({medication, strength: '75 mcg'}), null);
  }
  assert.equal(costPlusProduct({medication: 'Metformin ER', strength: '123 mg'}), null);
  assert.equal(costPlusProduct({medication: 'Metformin ER', strength: ''}), null);
});

test('unexpected URLs and ambiguous catalog matches cannot become pharmacy links', () => {
  const fields = {medication: 'Example', strength: '5mg'};
  for (const url of ['javascript:alert(1)', 'https://www.costplusdrugs.com.evil.example/medications/example/', 'https://user:pass@www.costplusdrugs.com/medications/example/']) {
    assert.equal(costPlusProduct(fields, [{name: 'Example', strength: '5mg', form: 'Tablet', url}]), null);
  }
  const entries = ['a', 'b'].map(path => ({name: 'Example', strength: '5mg', form: 'Tablet', url: `https://www.costplusdrugs.com/medications/${path}/`}));
  assert.equal(costPlusProduct(fields, entries), null);
});

test('the first demo offer exposes a real product URL and an honest fallback', () => {
  const members = [{id: 'dad', nickname: 'Dad'}];
  const prescriptions = ['Metformin ER', 'Unknown medicine'].map((medication, id) => ({
    id, member_id: 'dad', fields: {medication, strength: '500 mg'}, normalization: {status: 'unverified'},
  }));
  const deals = prototypeDeals(prescriptions, members, 'dad');
  assert.equal(deals[0].best.pharmacy, 'Cost Plus Drugs');
  assert.match(deals[0].best.productUrl, /metforminextendedreleaseer-500mg/);
  assert.equal(deals[1].best.productUrl, costPlusBrowseUrl);
  assert.equal(deals[1].best.product, null);
});
