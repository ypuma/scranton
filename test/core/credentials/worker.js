import fs from 'node:fs';
import { createCredentials, createOAuthProviders, createCredentialStore } from '../../../src/core/credentials/index.js';
const [mode, file] = process.argv.slice(2), config = JSON.parse(fs.readFileSync(file, 'utf8'));
try {
  if (mode === 'write') {
    const store = createCredentialStore({ dir: config.dir });
    for (let i = 0; i < 15; i++) await store.transaction(async (data) => {
      const count = data.count ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 2)); data.count = count + 1;
    });
  } else {
    const auth = await createCredentials({ env: config.env, oauth: createOAuthProviders({ endpoints: { anthropic: { tokenUrl: config.url } } }) });
    const result = await auth.resolveAuth('anthropic');
    if (result.access !== 'FAKE_NEW_ACCESS') throw Error('Unexpected access');
    await auth.close();
  }
  console.log('ok');
} catch { console.error('Credential worker failed'); process.exitCode = 1; }
