import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { partnerOf, clientId, clientLabel, noteHints, planStatus } from '../src/commercial/partners.js';
import { customerPrefs } from '../src/schedule/rules.js';

describe('commercial partners', () => {
  test('partners and programs from the service name', () => {
    assert.equal(partnerOf(['Homemaking(B@H) (1 Cleaner x 2.00 Hours)']).program, 'B@H');
    assert.equal(partnerOf(['Homemaking(QCH @ Home) (1 Cleaner x 2.00 Hours)']).name, 'Queensway Carleton at Home');
    assert.equal(partnerOf(['Homemaking (MFT @ Home) (1 Cleaner x 2.00 Hours)']).key, 'mft-home');
    assert.deepEqual([partnerOf(['Carefor Homemaking (1 Cleaner x 2.00 Hours)']).kind, partnerOf(['Carefor Homemaking (1 Cleaner x 2.00 Hours)']).name], ['homemaking', 'Carefor Homemaking']);
    assert.equal(partnerOf(['OWCS Homemaking (1 Cleaner x 2.00 Hours)']).key, 'owcs');
    assert.equal(partnerOf(['Past Temporary Homemaking (1 Cleaner x 2.00 Hours)']).kind, 'after');
    assert.equal(partnerOf(['Commercial'], 'EOPMG').kind, 'company');
    assert.equal(partnerOf(['Two Bedroom Home, 1 x Full Bathrooms']), null);
  });
  test('one client per address inside a partner account', () => {
    assert.equal(clientId(2418, '12 Main St, Ottawa'), clientId(2418, '12 MAIN ST'));
    assert.notEqual(clientId(2418, '12 Main St'), clientId(2418, '14 Main St'));
    assert.ok(clientId(2418, '12 Main St') < 0);
    assert.equal(clientLabel('JANE DOE\n613-555-0101\nPrefers Karen', '12 Main St'), 'Jane Doe');
    assert.equal(clientLabel('613-555-0101', '12 Main St, Ottawa'), '12 Main St');
  });
  test('cleaner wishes from staff notes feed the planner', () => {
    const notes = 'Jane Doe\n613-555-0101\n1/13/26 Prefers Karen\n8/27/25: Prefers Anne\n10/07/2025: Do not assign Fatu (cleaner\'s request)\nFemale cleaner only';
    const hints = noteHints(notes);
    assert.deepEqual(hints, ['prefers karen', 'do not assign fatu', 'female cleaner only']);
    const p = customerPrefs(hints);
    assert.deepEqual([p.prefers, p.avoid, p.femaleOnly], [['karen'], ['fatu'], true]);
    assert.deepEqual(noteHints('07/14/2026: Client prefers Magalie'), ['prefers magalie']);
  });
  test('progress against the 4/2/1 plan', () => {
    const on = planStatus(['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-11-05'], '2026-11-06');
    assert.deepEqual([on.done, on.stage, on.state, on.flags.length, on.next_planned, on.next_label], [5, 'biweekly', 'active', 0, '2026-11-19', 'Every 2 weeks']);
    // What the data shows: visit 5 a week after visit 4, then a 6th weekly.
    const drift = planStatus(['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29', '2026-09-05'], '2026-11-06');
    assert.deepEqual([drift.state, drift.flags.map((f) => [f.visit, f.gap, f.planned])], ['ended_early', [[5, 7, 14], [6, 7, 14]]]);
    const done = planStatus(['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22', '2026-02-05', '2026-02-19', '2026-03-19'], '2026-06-01');
    assert.equal(done.state, 'finished');
    const due = planStatus(['2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30'], '2026-11-06');
    assert.deepEqual([due.unbooked, due.next_planned], [true, '2026-11-13']);
  });
});
