import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const dockerfile = fs.readFileSync(path.join(root, 'sandbox/Dockerfile'), 'utf8');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'tools-lock.json'), 'utf8'));

for (const [arch, target] of [['amd64', 'x86_64-unknown-linux-gnu'], ['arm64', 'aarch64-unknown-linux-gnu']]) {
  test(`Docker ${arch} search tools match tools-lock.json`, () => {
    const block = dockerfile.match(new RegExp(`\\b${arch}\\)([\\s\\S]*?);;`))?.[1];
    assert.ok(block, `Missing ${arch} archive selection`);
    for (const tool of ['rg', 'fd']) {
      const prefix = tool.toUpperCase();
      const pinned = lock.tools[tool];
      assert.equal(dockerfile.match(new RegExp(`${prefix}_VERSION='([^']+)'`))?.[1], pinned.version);
      for (const field of ['url', 'sha256', 'binary']) {
        assert.equal(block.match(new RegExp(`${prefix}_${field.toUpperCase()}='([^']+)'`))?.[1],
          pinned.targets[target][field], `${arch} ${tool} ${field}`);
      }
    }
  });
}

test('Docker verifies archives before extraction and preserves the tool-only non-root image', () => {
  assert.match(dockerfile, /^ARG TARGETARCH$/m);
  assert.match(dockerfile, /\$\{TARGETARCH:-\$\(dpkg --print-architecture\)\}/);
  assert.match(dockerfile, /\*\) echo .*unsupported architecture.*exit 1/);
  assert.doesNotMatch(dockerfile, /apt-get install[^\n]*(?:ripgrep|fd-find)/);
  assert.match(dockerfile, /RUN set -eu;/);
  assert.match(dockerfile, /if \(!response\.ok\) throw new Error/);
  for (const tool of ['rg', 'fd']) {
    const prefix = tool.toUpperCase();
    const check = `printf '%s  %s\\n' "$${prefix}_SHA256" '/tmp/${tool}.tar.gz' | sha256sum -c -`;
    const extract = `tar -xzf /tmp/${tool}.tar.gz -C /tmp/search-tools "$${prefix}_BINARY"`;
    const install = `install -m 0755 "/tmp/search-tools/$${prefix}_BINARY" /usr/local/bin/${tool}`;
    assert.ok(dockerfile.includes(check), `${tool} checksum verification missing`);
    assert.ok(dockerfile.indexOf(extract) > dockerfile.indexOf(check), `${tool} must be checked before extraction`);
    assert.ok(dockerfile.indexOf(install) > dockerfile.indexOf(extract), `${tool} must be installed after extraction`);
  }
  assert.match(dockerfile, /^USER 10001:10001$/m);
  assert.match(dockerfile, /^FROM node:24-bookworm-slim$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["\/bin\/sleep", "infinity"\]$/m);
});
