import { spawn } from 'child_process';

export interface CodegenResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

// Runs the user-provided HDL code generator (fizzim.pl) by feeding the .fzm
// text on stdin and capturing stdout. Stdin is deliberate: fizzim.pl reads
// `<>` (stdin or file args), and stdin is path-independent - passing a file
// path can misbehave depending on where the file lives, whereas stdin always
// works. The generator is fully user-configurable (perl path, script path,
// language) so users can swap in their own generator.
// Splits a user-typed args string into argv tokens, honoring simple
// double-quoted segments (e.g. `-warnout "my file.txt"`). Good enough for
// fizzim.pl's flag-style options; not a full shell parser.
export function splitArgs(argsString: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(argsString)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

export function runCodegen(
  perlPath: string,
  scriptPath: string,
  language: string,
  fzmText: string,
  extraArgs = ''
): Promise<CodegenResult> {
  return new Promise((resolve) => {
    let child;
    try {
      const args = [scriptPath, '-language', language, ...splitArgs(extraArgs)];
      // fizzim.pl iterates Perl hashes without sorting, so its output order
      // depends on the per-process hash seed - the same .fzm can generate
      // different (but equivalent) HDL on different runs. Pin the seed so
      // Generate HDL is reproducible: same input -> byte-identical output.
      child = spawn(perlPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PERL_HASH_SEED: '0', PERL_PERTURB_KEYS: '0' },
      });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: '', error: String(e) });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.on('error', (err) => {
      resolve({ ok: false, stdout: '', stderr: '', error: err.message });
    });
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      // fizzim.pl can exit 0 while still failing to produce output; treat empty
      // stdout as a failure so the user gets the stderr rather than an empty file.
      const ok = code === 0 && stdout.trim().length > 0;
      resolve({ ok, stdout, stderr });
    });

    child.stdin.write(fzmText);
    child.stdin.end();
  });
}
