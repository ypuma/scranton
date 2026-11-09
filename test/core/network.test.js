import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLoopbackAddress } from '../../src/core/network.js';

test('TCP loopback addresses include all 127/8 and IPv4-mapped loopback peers', () => {
  for (const address of ['127.0.0.1', '127.42.1.2', '127.255.255.255', '::1', '::ffff:127.0.0.1', '::FFFF:127.10.20.30']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of [undefined, 'localhost', '0.0.0.0', '192.168.1.2', '::', '::ffff:192.168.1.2', '127.999.1.2', '127.0.0.1.evil']) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});
