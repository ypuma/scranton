import fs from 'node:fs';
const [file, ...args] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
if (state.down) process.exit(1);
if (args[0] === 'rm') {
  if (!state.refuse) state.containers = state.containers.filter((c) => c.Name !== args[2]);
  fs.writeFileSync(file, JSON.stringify(state));
} else if (args[1] === 'inspect') {
  console.log(JSON.stringify(state.containers.filter((c) => c.Name === args[2])));
} else if (args.includes('--filter')) {
  const name = args[args.indexOf('--filter') + 1].slice('name=^/'.length, -1);
  console.log(state.containers.some((c) => c.Name === name) ? 'leftover' : '');
} else console.log(state.containers.map((c) => c.Name).join('\n'));
