const string = (extra = {}) => ({ type: 'string', ...extra });
const integer = (minimum = 1) => ({ type: 'integer', minimum });
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const file = string({ minLength: 1 });
const range = { path: file, limit: integer() };
const shell = object({ command: string({ minLength: 1 }), timeout: { type: 'number', exclusiveMinimum: 0, maximum: 1800 }, cwd: file }, ['command']);
const replacement = object({ oldText: string(), newText: string() }, ['oldText', 'newText']);
const definitions = [
  ['read', 'Read a text file. Offset is 1-based. Images and binary files are not supported.', object({ ...range, offset: integer() }, ['path'])],
  ['write', 'Create or overwrite a file atomically. Parent directories are created.', object({ path: file, content: string() }, ['path', 'content'])],
  ['edit', 'Replace exact, unique, non-overlapping text in the original file. Batch disjoint changes in edits.', object({ path: file, edits: { type: 'array', items: replacement } }, ['path', 'edits'])],
  ['grep', 'Search file contents, respecting .gitignore. Native fallback uses JavaScript regex, not Rust regex (no POSIX classes or inline flags; JS lookaround/backreferences are supported).', object({ ...range, pattern: string(), glob: string(), ignoreCase: { type: 'boolean' }, literal: { type: 'boolean' }, context: integer(0) }, ['pattern'])],
  ['find', 'Find paths by glob, respecting .gitignore. Supports **, *, ?, character classes and brace alternatives.', object({ ...range, pattern: string() }, ['pattern'])],
  ['ls', 'List directory entries, sorted case-insensitively; directories end in /.', object(range)],
  ['bash', 'Execute a bash command. Output keeps the tail; timeout defaults to 120 seconds.', shell],
  ['powershell', 'Execute a PowerShell command. Output keeps the tail; timeout defaults to 120 seconds.', shell],
  ['agent_chat', 'Send text to an exact agent instance ID. ACK means queue acceptance, not model consumption. Sender and run are assigned by the host. If delivery is unknown, do not resend automatically: the message may already be queued.', object({ to: string({ minLength: 1, maxLength: 200 }), text: string({ minLength: 1, maxLength: 16000 }) }, ['to', 'text'])],
].map(([name, description, parameters]) => ({ name, description, parameters }));

export function toolDefinitions(allow = []) {
  return structuredClone(definitions.filter(({ name }) => allow.includes(name)));
}

export function validate(schema, value, at = 'arguments') {
  const fail = (message) => { throw new Error(`${at} ${message}`); };
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('must be an object');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`is missing required property "${key}"`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) {
        if (schema.additionalProperties === false) fail(`has unknown property "${key}"`);
      } else validate(schema.properties[key], value[key], `${at}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('must be an array');
    value.forEach((item, i) => validate(schema.items, item, `${at}[${i}]`));
  } else if (schema.type === 'integer' ? !Number.isSafeInteger(value) : schema.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== schema.type) fail(`must be ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);
  for (const [key, bad, message] of [
    ['minimum', value < schema.minimum, 'must be at least'], ['maximum', value > schema.maximum, 'must be at most'],
    ['exclusiveMinimum', value <= schema.exclusiveMinimum, 'must be greater than'],
    ['minLength', value?.length < schema.minLength, 'length must be at least'], ['maxLength', value?.length > schema.maxLength, 'length must be at most'],
  ]) if (schema[key] !== undefined && bad) fail(`${message} ${schema[key]}`);
}
