import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { desktopPlatform, validateNodeBinary, validateNodeDistribution } from '../../scripts/desktop-platform.mjs';

const config = { variables: { node_shared: false, node_shared_libuv: false, node_shared_openssl: false,
  node_shared_zlib: false, node_shared_cares: false, node_shared_nghttp2: false, icu_small: false,
  icu_gyp_path: 'tools/icu/icu-generic.gyp' } };
function macho(arch, names, extra = []) {
  const commands = [...names.map(name => {
    const b = Buffer.alloc(Math.ceil((25 + name.length) / 8) * 8);
    b.writeUInt32LE(0xc); b.writeUInt32LE(b.length, 4); b.writeUInt32LE(24, 8); b.write(name, 24); return b;
  }), ...extra.map(command => { const b = Buffer.alloc(8); b.writeUInt32LE(command); b.writeUInt32LE(8, 4); return b; })];
  const header = Buffer.alloc(32); header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4);
  header.writeUInt32LE(2, 12); header.writeUInt32LE(commands.length, 16); header.writeUInt32LE(commands.reduce((n,b) => n+b.length,0),20);
  return Buffer.concat([header,...commands]);
}
function elf(arch, names, extra = []) {
  const b = Buffer.alloc(2048), write = (offset, value) => b.writeBigUInt64LE(BigInt(value), offset);
  b.write('7f454c46',0,'hex'); b[4]=2; b[5]=1; b.writeUInt16LE(3,16); b.writeUInt16LE(arch === 'x64' ? 62 : 183,18);
  write(32,64); b.writeUInt16LE(56,54); b.writeUInt16LE(3,56);
  function segment(i,type,offset,address,size) { const p=64+i*56; b.writeUInt32LE(type,p); write(p+8,offset); write(p+16,address); write(p+32,size); }
  segment(0,1,0,0,2048); segment(1,3,256,256,64);
  b.write(arch === 'x64' ? '/lib64/ld-linux-x86-64.so.2' : '/lib/ld-linux-aarch64.so.1',256);
  let stringOffset=1; const tags=[[5,1024],[10,512]];
  for (const name of names) { b.write(name,1024+stringOffset); tags.push([1,stringOffset]); stringOffset+=name.length+1; }
  tags.push(...extra,[0,0]); segment(2,2,512,512,tags.length*16);
  tags.forEach(([tag,value],i)=>{write(512+i*16,tag);write(520+i*16,value);}); return b;
}

test('running native Node satisfies distribution gate; shared library config fails closed', async () => {
  const bytes = await fs.readFile(process.execPath);
  assert.equal(validateNodeDistribution(bytes).policy, 'node24-bundled-libraries-v1');
  for (const key of ['node_shared_libuv','node_shared_openssl','node_shared_icu','node_shared_unknown']) {
    assert.throws(() => validateNodeDistribution(bytes, desktopPlatform(), { variables: { ...config.variables, [key]: true } }), /self-contained/);
  }
  assert.throws(() => validateNodeDistribution(bytes, desktopPlatform(), { variables: {} }), /self-contained/);
  assert.throws(() => validateNodeDistribution(bytes, desktopPlatform(), { variables: { ...config.variables, icu_gyp_path: 'system' } }), /ICU/);
  assert.throws(() => validateNodeDistribution(bytes, desktopPlatform(), config, 'v22.19.0'), /Node 24/);
});

test('Mach-O direct libraries catch Homebrew dependencies even with a static-looking config', () => {
  for (const arch of ['x64','arm64']) {
    const host=desktopPlatform('darwin',arch), valid=macho(arch,['/usr/lib/libSystem.B.dylib','/usr/lib/libc++.1.dylib']);
    assert.equal(validateNodeDistribution(valid,host,config,'v24.1.0').dependencies.length,2);
    for (const name of ['/opt/homebrew/opt/icu4c/lib/libicui18n.dylib','/usr/local/opt/openssl/lib/libssl.dylib','@rpath/libuv.dylib','/usr/lib/libssl.dylib']) {
      const bytes=macho(arch,['/usr/lib/libSystem.B.dylib',name]);
      validateNodeBinary(bytes,host); // The old header-only gate accepts the negative control.
      assert.throws(()=>validateNodeDistribution(bytes,host,config,'v24.1.0'),/non-system dylib/);
    }
    for (const command of [0x8000001c,0x27,0x80000023]) assert.throws(()=>validateNodeDistribution(macho(arch,['/usr/lib/libSystem.B.dylib'],[command]),host,config,'v24.1.0'),/loading refused/);
    assert.throws(()=>validateNodeDistribution(valid.subarray(0,valid.length-1),host,config,'v24.1.0'),/loader bounds/);
  }
});

test('ELF direct libraries catch distro dependencies and loader search paths', () => {
  for (const arch of ['x64','arm64']) {
    const host=desktopPlatform('linux',arch), names=['libc.so.6','libstdc++.so.6','libm.so.6'];
    assert.deepEqual(validateNodeDistribution(elf(arch,names),host,config,'v24.1.0').dependencies,names);
    for (const name of ['libnode.so.137','libuv.so.1','libssl.so.3','libicui18n.so.78','/custom/libc.so.6']) {
      const bytes=elf(arch,[...names,name]); validateNodeBinary(bytes,host);
      assert.throws(()=>validateNodeDistribution(bytes,host,config,'v24.1.0'),/non-system ELF dependency/);
    }
    for (const tag of [15,29,0x6ffffefb,0x7fffffff]) assert.throws(()=>validateNodeDistribution(elf(arch,names,[[tag,1]]),host,config,'v24.1.0'),/loading refused/);
    const bad=elf(arch,names); bad.writeBigUInt64LE(999999n,32);
    assert.throws(()=>validateNodeDistribution(bad,host,config,'v24.1.0'),/loader bounds/);
    assert.throws(()=>validateNodeDistribution(elf(arch,[]),host,config,'v24.1.0'),/missing ELF dependencies/);
  }
});

test('Windows import inventory rejects a non-system DLL despite matching PE CPU/config', { skip: process.platform !== 'win32' }, async () => {
  const bytes=await fs.readFile(process.execPath);
  const offset=bytes.toString('latin1').toLowerCase().indexOf('crypt32.dll\0'); assert.ok(offset > 0);
  bytes.write('libuvxx.dll',offset,'ascii');
  validateNodeBinary(bytes);
  assert.throws(()=>validateNodeDistribution(bytes),/non-system PE dependency libuvxx.dll/);
});
