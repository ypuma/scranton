const targets = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu'
};

export function desktopPlatform(platform = process.platform, arch = process.arch) {
  const target = targets[`${platform}-${arch}`];
  if (!target) throw new Error(`Unsupported desktop platform/architecture: ${platform}/${arch}; native Windows x64, macOS x64/arm64 or Linux glibc x64/arm64 required (no universal or musl).`);
  return { platform, arch, target, nodeFile: `scranton-node-${target}${platform === 'win32' ? '.exe' : ''}` };
}

export function assertNativeBuild(host = desktopPlatform(), env = process.env, report = process.report.getReport()) {
  for (const key of ['CARGO_BUILD_TARGET', 'TAURI_ENV_TARGET_TRIPLE']) {
    if (env[key] && env[key] !== host.target) throw new Error(`Cross-target desktop staging refused: ${key}=${env[key]}; native ${host.target} required.`);
  }
  for (const key of ['npm_config_arch', 'npm_config_target_arch', 'npm_config_platform']) {
    const expected = key.endsWith('platform') ? host.platform : host.arch;
    if (env[key] && env[key] !== expected) throw new Error(`Cross-target desktop staging refused: ${key}=${env[key]}.`);
  }
  if (host.platform === 'linux') {
    const version = report.header?.glibcVersionRuntime;
    if (!version) throw new Error('Linux desktop staging requires glibc; musl is unsupported.');
    const [major, minor] = version.split('.').map(Number);
    if (major < 2 || (major === 2 && minor < 28)) throw new Error('Bundled wheels require glibc >= 2.28.');
  }
  return host;
}

export function launchManifest(host = desktopPlatform()) {
  return { schema: 1, platform: host.platform, arch: host.arch,
    executable: host.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3',
    args: ['-I', '-B', 'bootstrap.py'] };
}

export function validateNodeBinary(bytes, host = desktopPlatform()) {
  let arch;
  if (host.platform === 'darwin') {
    if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Expected thin native Mach-O Node; universal/fat binaries are unsupported.');
    arch = { 0x01000007: 'x64', 0x0100000c: 'arm64' }[bytes.readUInt32LE(4)];
  } else if (host.platform === 'linux') {
    if (bytes.length < 20 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1) throw new Error('Expected native ELF64 little-endian Node.');
    arch = { 62: 'x64', 183: 'arm64' }[bytes.readUInt16LE(18)];
  } else {
    if (bytes.length < 64 || bytes.subarray(0, 2).toString() !== 'MZ') throw new Error('Expected native PE Node.');
    const offset = bytes.readUInt32LE(60);
    if (offset + 6 > bytes.length || bytes.subarray(offset, offset + 4).toString('hex') !== '50450000') throw new Error('Invalid PE Node header.');
    arch = { 0x8664: 'x64' }[bytes.readUInt16LE(offset + 4)];
  }
  if (arch !== host.arch) throw new Error(`Node binary architecture ${arch ?? 'unknown'} does not match native ${host.arch}.`);
}

// Inspect loader declarations, not ldd output (which depends on the build host).
export function validateNodeDistribution(bytes, host = desktopPlatform(), config = process.config, version = process.version) {
  validateNodeBinary(bytes, host);
  const fail = (reason) => { throw new Error(`Node is not a self-contained desktop runtime: ${reason}`); };
  if (!/^v24\./.test(version)) fail('native Node 24 required');
  const variables = config?.variables;
  for (const key of ['node_shared', 'node_shared_libuv', 'node_shared_openssl', 'node_shared_zlib', 'node_shared_cares', 'node_shared_nghttp2', 'icu_small']) {
    if (variables?.[key] !== false) fail(`expected ${key}=false`);
  }
  if (variables.icu_gyp_path !== 'tools/icu/icu-generic.gyp') fail('bundled ICU required');
  for (const [key, value] of Object.entries(variables)) {
    if ((key === 'node_shared' || key.startsWith('node_shared_')) && value !== false) fail(`external build option ${key}`);
  }
  const range = (offset, size) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > bytes.length) fail('invalid loader bounds');
    return offset;
  };
  const u32 = (offset) => bytes.readUInt32LE(range(offset, 4));
  const u64 = (offset) => {
    const value = Number(bytes.readBigUInt64LE(range(offset, 8)));
    if (!Number.isSafeInteger(value)) fail('invalid loader integer');
    return value;
  };
  const text = (offset, end) => {
    range(offset, end - offset);
    const nul = bytes.indexOf(0, offset);
    if (nul < offset || nul >= end) fail('unterminated loader name');
    const value = bytes.toString('utf8', offset, nul);
    if (!value || !/^[\x20-\x7e]+$/.test(value)) fail('invalid loader name');
    return value;
  };
  const dependencies = [];
  if (host.platform === 'darwin') {
    range(0, 32);
    if (u32(12) !== 2) fail('Mach-O executable required');
    const count = u32(16), end = 32 + u32(20);
    range(32, end - 32);
    let offset = 32;
    for (let i = 0; i < count; i++) {
      const command = u32(offset), size = u32(offset + 4);
      if (size < 8 || size % 8 || offset + size > end) fail('invalid Mach-O load command');
      if ([0x6, 0xd, 0x10, 0x8000001c, 0x27, 0x20, 0x80000023].includes(command)) fail('Mach-O rpath/environment/upward loading refused');
      if ([0xc, 0x80000018, 0x8000001f, 0x20].includes(command)) {
        if (size < 24) fail('invalid dylib command');
        const name = u32(offset + 8);
        if (name < 24 || name >= size) fail('invalid dylib name offset');
        dependencies.push(text(offset + name, offset + size));
      }
      offset += size;
    }
    if (offset !== end || !dependencies.length) fail('incomplete Mach-O loader inventory');
    const allowed = new Set(['/usr/lib/libSystem.B.dylib', '/usr/lib/libc++.1.dylib',
      '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
      '/System/Library/Frameworks/Security.framework/Versions/A/Security']);
    for (const name of dependencies) if (!allowed.has(name)) fail(`non-system dylib ${name}`);
  } else if (host.platform === 'linux') {
    range(0, 64);
    if (![2, 3].includes(bytes.readUInt16LE(16))) fail('ELF executable required');
    const start = u64(32), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
    if (size !== 56 || !count || count === 65535) fail('unsupported ELF program headers');
    range(start, size * count);
    const segments = [];
    for (let i = 0; i < count; i++) {
      const p = start + i * size;
      const segment = { type: u32(p), offset: u64(p + 8), address: u64(p + 16), size: u64(p + 32) };
      range(segment.offset, segment.size); segments.push(segment);
    }
    const interpreters = segments.filter(s => s.type === 3), dynamic = segments.filter(s => s.type === 2);
    const interpreter = host.arch === 'x64' ? '/lib64/ld-linux-x86-64.so.2' : '/lib/ld-linux-aarch64.so.1';
    if (interpreters.length !== 1 || text(interpreters[0].offset, interpreters[0].offset + interpreters[0].size) !== interpreter || dynamic.length !== 1) fail('unsupported ELF interpreter/dynamic table');
    const table = dynamic[0], tags = [];
    let terminated = false;
    for (let p = table.offset; p + 16 <= table.offset + table.size; p += 16) {
      const tag = u64(p), value = u64(p + 8);
      if (!tag) { terminated = true; break; }
      if ([15, 29, 0x6ffffefa, 0x6ffffefb, 0x6ffffefc, 0x7ffffffd, 0x7fffffff].includes(tag)) fail('ELF search paths/audit/filter loading refused');
      tags.push([tag, value]);
    }
    if (!terminated) fail('unterminated ELF dynamic table');
    const stringTags = tags.filter(([tag]) => tag === 5), sizeTags = tags.filter(([tag]) => tag === 10);
    if (stringTags.length !== 1 || sizeTags.length !== 1) fail('missing ELF string table');
    const address = stringTags[0][1], length = sizeTags[0][1];
    const mappings = segments.filter(s => s.type === 1 && address >= s.address && address + length <= s.address + s.size);
    if (mappings.length !== 1 || !length) fail('ambiguous ELF string table');
    const strings = mappings[0].offset + address - mappings[0].address;
    range(strings, length);
    for (const [tag, value] of tags) if (tag === 1) {
      if (value >= length) fail('invalid ELF dependency index');
      dependencies.push(text(strings + value, strings + length));
    }
    if (!dependencies.length) fail('missing ELF dependencies');
    const allowed = new Set(['libdl.so.2', 'librt.so.1', 'libstdc++.so.6', 'libm.so.6', 'libgcc_s.so.1', 'libpthread.so.0', 'libc.so.6']);
    for (const name of dependencies) if (!allowed.has(name)) fail(`non-system ELF dependency ${name}`);
  } else {
    const pe = u32(60), optional = pe + 24;
    if (bytes.readUInt16LE(range(optional, 2)) !== 0x20b || u32(optional + 108) < 14) fail('PE32+ import directories required');
    const sectionCount = bytes.readUInt16LE(pe + 6), sectionStart = optional + bytes.readUInt16LE(pe + 20);
    range(sectionStart, sectionCount * 40);
    const rva = (address, length) => {
      const matches = [];
      for (let i = 0; i < sectionCount; i++) {
        const p = sectionStart + i * 40, base = u32(p + 12), size = u32(p + 16);
        if (address >= base && address + length <= base + size) matches.push(u32(p + 20) + address - base);
      }
      if (matches.length !== 1) fail('unmapped PE import');
      return range(matches[0], length);
    };
    // Delay-loaded libraries are not needed by the supported distributable.
    if (u32(optional + 112 + 13 * 8) || u32(optional + 116 + 13 * 8)) fail('PE delay imports refused');
    const address = u32(optional + 120), length = u32(optional + 124);
    if (!address || length < 20) fail('missing PE imports');
    const start = rva(address, length);
    let terminated = false;
    for (let p = start; p + 20 <= start + length; p += 20) {
      if ([0, 4, 8, 12, 16].every(n => u32(p + n) === 0)) { terminated = true; break; }
      const name = rva(u32(p + 12), 1);
      dependencies.push(text(name, Math.min(bytes.length, name + 256)).toLowerCase());
    }
    if (!terminated || !dependencies.length) fail('incomplete PE imports');
    const allowed = new Set(['kernel32.dll', 'user32.dll', 'advapi32.dll', 'ws2_32.dll', 'dbghelp.dll', 'ole32.dll', 'shell32.dll', 'crypt32.dll', 'psapi.dll', 'iphlpapi.dll', 'userenv.dll', 'bcrypt.dll', 'ntdll.dll', 'winmm.dll', 'version.dll', 'shlwapi.dll', 'secur32.dll']);
    for (const name of dependencies) if (!allowed.has(name)) fail(`non-system PE dependency ${name}`);
  }
  return { policy: 'node24-bundled-libraries-v1', dependencies };
}
