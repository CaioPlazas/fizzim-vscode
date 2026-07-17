import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFzm } from './parser';

const samplesDir = path.join(__dirname, '..', '..', 'samples');

function load(name: string) {
  return parseFzm(fs.readFileSync(path.join(samplesDir, name), 'utf8'));
}

test('parses machine attributes and version', () => {
  const doc = load('cliff_classic_juststatesandtransitions.fzm');
  assert.equal(doc.version, '11.03.02');
  assert.equal(doc.versionInt, 110302);
  assert.deepEqual(doc.tabs, ['Page 1']);
  assert.equal(doc.machine.find((a) => a.name === 'name')?.value, 'def_name');
  assert.equal(doc.machine.find((a) => a.name === 'clock')?.value, 'clk');
});

test('parses all four states with correct coordinates and reset flag', () => {
  const doc = load('cliff_classic_juststatesandtransitions.fzm');
  assert.equal(doc.states.length, 4);

  const idle = doc.states.find((s) => s.name === 'IDLE');
  assert.ok(idle);
  assert.equal(idle?.x0, 540);
  assert.equal(idle?.y0, 51);
  assert.equal(idle?.x1, 670);
  assert.equal(idle?.y1, 181);
  assert.equal(idle?.reset, false);

  assert.deepEqual(doc.states.map((s) => s.name).sort(), ['DLY', 'DONE', 'IDLE', 'READ']);
});

test('this fixture has no transitions, despite its filename', () => {
  const doc = load('cliff_classic_juststatesandtransitions.fzm');
  assert.equal(doc.transitions.length, 0);
});

test('parses normal transitions with correct start/end states', () => {
  const doc = load('cliff_classic_4state2bit_iloop.fzm');
  const normal = doc.transitions.filter((t) => t.kind === 'transition');
  assert.deepEqual(
    normal.map((t) => `${t.startState}->${t.endState}`).sort(),
    ['DLY->DONE', 'DLY->READ', 'DONE->IDLE', 'IDLE->READ', 'READ->DLY'].sort()
  );
});

test('distinguishes a loopback from a normal transition', () => {
  const doc = load('cliff_classic_4state2bit_iloop.fzm');
  const loopbacks = doc.transitions.filter((t) => t.kind === 'loopback');
  assert.equal(loopbacks.length, 1);
  assert.equal(loopbacks[0].state, 'IDLE');
});

test('reset state is derived correctly from the reset_state machine attribute', () => {
  const doc = load('cliff_classic_4state2bit_iloop.fzm');
  assert.equal(doc.machine.find((a) => a.name === 'reset_state')?.value, 'IDLE');
  assert.equal(doc.states.find((s) => s.name === 'IDLE')?.reset, true);
  assert.equal(doc.states.find((s) => s.name === 'READ')?.reset, false);
});
