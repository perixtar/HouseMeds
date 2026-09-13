import test from 'node:test';
import assert from 'node:assert/strict';
import {prototypeDeals} from '../deals.js';

const members = [{id: 'dad', nickname: 'Dad'}, {id: 'demo', nickname: 'Demo member'}];
const prescription = (id, member_id, medication) => ({
  id, member_id, fields: {medication, strength: '75 mcg'}, normalization: {status: 'unverified'},
});
const demoMedicine = prescription('demo-rx', 'demo', 'Synthroid');

test('Dad has no deals when only Demo member has a medicine', () => {
  assert.deepEqual(prototypeDeals([demoMedicine], members, 'dad'), []);
});

test('switching members scopes medicines and savings to that member', () => {
  const prescriptions = [demoMedicine, prescription('dad-rx', 'dad', 'Dad medicine')];
  const dadDeals = prototypeDeals(prescriptions, members, 'dad');
  assert.deepEqual(dadDeals.map(deal => [deal.id, deal.member]), [['dad-rx', 'Dad']]);
  assert.equal(dadDeals.length, 1);
  assert.deepEqual(prototypeDeals(prescriptions, members, 'demo').map(deal => deal.id), ['demo-rx']);
});

test('ownership uses member IDs even when nicknames match', () => {
  const sameNames = members.map(member => ({...member, nickname: 'Dad'}));
  assert.deepEqual(prototypeDeals([demoMedicine], sameNames, 'dad'), []);
});

test('missing or stale member selections do not fall back to household medicines', () => {
  for (const memberId of ['', 'deleted-member']) {
    assert.deepEqual(prototypeDeals([demoMedicine], members, memberId), []);
  }
});

test('household view includes known members and never invents ownership for orphan records', () => {
  const prescriptions = [demoMedicine, prescription('dad-rx', 'dad', 'Dad medicine'), prescription('orphan-rx', 'unknown', 'Other medicine')];
  assert.deepEqual(prototypeDeals(prescriptions, members).map(deal => [deal.id, deal.member]), [
    ['demo-rx', 'Demo member'], ['dad-rx', 'Dad'],
  ]);
  assert.deepEqual(prototypeDeals(prescriptions, []), []);
});
