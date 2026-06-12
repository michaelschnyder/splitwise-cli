import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcSkills = join(root, 'src', 'skills');
const distSkills = join(root, 'dist', 'skills');

if (!existsSync(srcSkills)) {
  throw new Error(`Missing source skills directory: ${srcSkills}`);
}

rmSync(distSkills, { recursive: true, force: true });
mkdirSync(distSkills, { recursive: true });
cpSync(srcSkills, distSkills, { recursive: true });
