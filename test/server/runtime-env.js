import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.scratch/server-switch/credentials', String(process.pid));
fs.mkdirSync(root, { recursive: true });
process.env.SCRANTON_CREDENTIALS_DIR = root;
process.env.PI_CODING_AGENT_DIR = path.join(root, 'legacy');
process.env.SCRANTON_FAKE_MODE = '1';
