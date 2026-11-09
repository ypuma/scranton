import { isIP } from 'node:net';

export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  if (address === '::1') return true;
  const ipv4 = address.replace(/^::ffff:/i, '');
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}
