import { runOracle } from './src/safety/test_oracle';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-test-'));

const passing = await runOracle('node -e "process.exit(0)"', { cwd: tmp });
console.log('Passing case:', passing.summary, '| exitCode:', passing.exitCode);

const failing = await runOracle('node -e "process.exit(42)"', { cwd: tmp });
console.log('Failing case:', failing.summary, '| exitCode:', failing.exitCode);

const noisy = await runOracle('node -e "console.log(\'a\'.repeat(2000))"', { cwd: tmp });
console.log('Noisy case (single 2000-char line):', noisy.summary);
console.log('  rawLength:', noisy.rawLength, '| output preview:', noisy.output.slice(0, 100));

fs.rmSync(tmp, { recursive: true, force: true });
