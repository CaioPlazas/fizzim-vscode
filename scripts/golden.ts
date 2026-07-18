// Golden test: our serializer must produce .fzm that generates byte-identical
// HDL to what the original file generates. For each real fixture:
//   original.fzm --fizzim.pl--> HDL_a
//   parseFzm -> serializeFzm -> our.fzm --fizzim.pl--> HDL_b
//   HDL_a === HDL_b  (ignoring the timestamp header line)
//
//   node --require ts-node/register scripts/golden.ts
//
// fizzim.pl's key order is nondeterministic unless the Perl hash seed is pinned
// (see CONTEXT.md §7), so both runs share PERL_HASH_SEED=0 / PERL_PERTURB_KEYS=0.
// Fed on stdin, never a path (a path can silently yield empty output).

import { execFileSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { parseFzm } from '../src/fzm/parser';
import { serializeFzm } from '../src/fzm/serializer';

const root = resolve(__dirname, '..');
const corpus = resolve(root, 'samples'); // bundled samples (full 93-file corpus lives in the private working repo)
const script = resolve(root, 'resources/fizzim.pl');
const env = { ...process.env, PERL_HASH_SEED: '0', PERL_PERTURB_KEYS: '0' };

// Drop the generator's timestamp/header lines so only real output is compared.
const strip = (hdl: string): string =>
  hdl
    .split('\n')
    .filter((l) => !/created|generated on|\d{1,2}:\d{2}:\d{2}|\d{4}[/-]\d{2}[/-]\d{2}/i.test(l))
    .join('\n');

function gen(fzm: string, language: string): string {
  try {
    return execFileSync('perl', [script, '-language', language], { input: fzm, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch {
    return '';
  }
}

const files = readdirSync(corpus).filter((f) => f.endsWith('.fzm')).sort();
let pass = 0;
const fails: string[] = [];

for (const f of files) {
  const orig = readFileSync(resolve(corpus, f), 'utf8');
  const ours = serializeFzm(parseFzm(orig));

  // Pick the language the file actually generates in: verilog, else vhdl.
  let lang = 'verilog';
  let a = gen(orig, lang);
  if (!a.trim()) { lang = 'vhdl'; a = gen(orig, lang); }
  const b = gen(ours, lang);

  if (a.trim() && strip(a) === strip(b)) {
    pass++;
  } else {
    fails.push(`${f} (${lang})${!a.trim() ? ' — original produced no output' : ''}`);
  }
}

console.log(`\nGolden: ${pass}/${files.length} byte-identical (timestamp ignored)`);
if (fails.length) {
  console.log('FAILURES:');
  for (const f of fails) console.log('  ✖ ' + f);
  process.exit(1);
}
console.log('✓ serializer parity intact');
