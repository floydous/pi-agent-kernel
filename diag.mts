import { EpistemicGuard } from './src/safety/epistemic_guard';
import * as fs from 'node:fs';

const testFile = 'C:/Users/brat/temp_epistemic_test/target.ts';
console.log('File exists:', fs.existsSync(testFile));

const g = new EpistemicGuard();
const SID = '__test_direct__';
const chk = g.checkReadPrecondition(testFile, 'edit', SID);
console.log('Direct guard check (no record):');
console.log('  allowed:', chk.allowed);
console.log('  reason:', chk.reason);

g.recordFileRead(testFile, SID);
const chk2 = g.checkReadPrecondition(testFile, 'edit', SID);
console.log('After recordFileRead:');
console.log('  allowed:', chk2.allowed);
