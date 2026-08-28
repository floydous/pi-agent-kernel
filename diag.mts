import { EpistemicGuard } from './src/safety/epistemic_guard';
import { extractInspectedFilesFromCommand } from './src/safety/epistemic_guard';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SID = '__default__';
const g = new EpistemicGuard();
const inspected = g.getInspectedFiles(SID);
console.log('All files currently marked inspected in __default__ session:');
for (const f of inspected) {
	console.log(' -', f);
}
console.log('\nTotal:', inspected.length);
console.log('\nNow: try target.ts in temp_epistemic_test:');
const targetFile = 'C:/Users/brat/temp_epistemic_test/target.ts';
const norm = g['normalize'] ? g['normalize'](targetFile) : targetFile;
console.log('  normalized:', norm);
console.log('  isInspected:', g.isFileInspected(targetFile, SID));
console.log('  exists:', fs.existsSync(targetFile));
