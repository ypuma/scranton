const escape = (c) => /[\\^$+.()|]/.test(c) ? `\\${c}` : c;

export function globMatcher(pattern, { nocase = false, basename = true } = {}) {
  pattern = pattern.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  let i = 0;
  function compile(stop = '') {
    let out = '';
    while (i < pattern.length && !stop.includes(pattern[i])) {
      const c = pattern[i++];
      if (c === '*') {
        if (pattern[i] === '*') {
          while (pattern[i] === '*') i++;
          if (pattern[i] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
        } else out += '[^/]*';
      } else if (c === '?') out += '[^/]';
      else if (c === '[') {
        const end = pattern.indexOf(']', i);
        if (end < 0) out += '\\[';
        else {
          let body = pattern.slice(i, end);
          if (body.startsWith('!')) body = '^' + body.slice(1);
          out += `(?!/)[${body}]`; i = end + 1;
        }
      } else if (c === '{') {
        const alternatives = [compile(',}')];
        while (pattern[i] === ',') { i++; alternatives.push(compile(',}')); }
        if (pattern[i] !== '}') throw new Error('Invalid glob: unclosed brace');
        i++; out += `(?:${alternatives.join('|')})`;
      } else out += escape(c);
    }
    return out;
  }
  const expression = compile();
  const regex = new RegExp(`^(?:${basename && !pattern.includes('/') ? '(?:.*/)?' : ''})${expression}$`, nocase ? 'i' : '');
  return (name) => regex.test(name.replaceAll('\\', '/'));
}
