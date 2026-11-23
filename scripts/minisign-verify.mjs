import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

const untrustedPrefix = 'untrusted comment: ';
const trustedPrefix = 'trusted comment: ';
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function base64(text, label, length) {
  if (typeof text !== 'string' || !text.length) throw new Error(`Missing ${label}.`);
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text || (length !== undefined && bytes.length !== length)) {
    throw new Error(`Invalid ${label} encoding.`);
  }
  return bytes;
}

function unwrap(text, label, lineCount) {
  const decoded = utf8.decode(base64(text, label));
  const lines = decoded.replace(/\r?\n$/, '').split(/\r?\n/);
  if (lines.length !== lineCount || !lines[0].startsWith(untrustedPrefix) || lines.some(line => line.includes('\r'))) {
    throw new Error(`Invalid minisign ${label} format.`);
  }
  return lines;
}

function parsePublicKey(text) {
  const [, packet] = unwrap(text, 'public key', 2);
  const bytes = base64(packet, 'public key packet', 42);
  if (bytes.toString('latin1', 0, 2) !== 'Ed') {
    throw new Error('Unsupported minisign public key algorithm.');
  }
  return bytes;
}

export function validateMinisignPublicKey(text) {
  parsePublicKey(text);
}

/** Return the authenticated trusted comment after verifying both signatures. */
export async function verifyMinisignFile(file, signatureText, publicKeyText) {
  const publicKey = parsePublicKey(publicKeyText);
  const [, packet, commentLine, globalLine] = unwrap(signatureText, 'signature', 4);
  const signature = base64(packet, 'signature packet', 74);
  const globalSignature = base64(globalLine, 'global signature', 64);
  const algorithm = signature.toString('latin1', 0, 2);
  if (algorithm !== 'Ed' && algorithm !== 'ED') throw new Error('Unsupported minisign signature algorithm.');
  if (!signature.subarray(2, 10).equals(publicKey.subarray(2, 10))) throw new Error('Minisign key ID mismatch.');
  if (!commentLine.startsWith(trustedPrefix)) throw new Error('Missing minisign trusted comment.');

  const key = createPublicKey({ key: Buffer.concat([ed25519SpkiPrefix, publicKey.subarray(10)]), type: 'spki', format: 'der' });
  const rawSignature = signature.subarray(10);
  const comment = commentLine.slice(trustedPrefix.length);
  // Authenticate the exact comment, and reject whitespace that minisign itself trims before verification.
  if (comment !== comment.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') ||
      !verify(null, Buffer.concat([rawSignature, Buffer.from(comment)]), key, globalSignature)) {
    throw new Error('Minisign trusted comment verification failed.');
  }

  let message;
  if (algorithm === 'ED') {
    const hash = createHash('blake2b512');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    message = hash.digest();
  } else {
    message = await readFile(file);
  }
  if (!verify(null, message, key, rawSignature)) throw new Error('Minisign file signature verification failed.');
  return comment;
}
