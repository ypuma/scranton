// Node is present in the tool image; detached spawn creates a command-local process group.
const common = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const token = process.argv[1];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pgid => fs.readdirSync('/proc').some(pid => {
  if (!/^\\d+$/.test(pid)) return false;
  try {
    const fields = fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').pop().split(' ');
    return fields[0] !== 'Z' && Number(fields[2]) === pgid;
  } catch { return false; }
});
const killGroup = async pid => {
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 5000;
  while (alive(pid)) {
    if (Date.now() >= deadline) throw Error('Docker command cleanup could not be verified');
    await sleep(10);
  }
};
`;

export const commandSource = common + `
(async () => {
  if (fs.existsSync(token + '.cancel')) { fs.writeFileSync(token + '.done', ''); return; }
  const child = spawn(process.argv[2], process.argv.slice(3), { detached: true, stdio: 'inherit' });
  child.once('error', error => { console.error(error.message); fs.writeFileSync(token + '.done', ''); process.exitCode = 127; });
  if (child.pid) fs.writeFileSync(token + '.pid', String(child.pid), { mode: 0o600 });
  child.once('exit', async code => {
    try { await killGroup(child.pid); fs.writeFileSync(token + '.done', ''); process.exitCode = code ?? 137; }
    catch (error) { console.error(error.message); process.exitCode = 125; }
  });
})().catch(error => { console.error(error.message); process.exitCode = 125; });
`;

export const stopSource = common + `
(async () => {
  fs.writeFileSync(token + '.cancel', '', { mode: 0o600 });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(token + '.done')) {
    if (fs.existsSync(token + '.pid')) { await killGroup(Number(fs.readFileSync(token + '.pid', 'utf8'))); return; }
    if (Date.now() >= deadline) throw Error('Docker command startup/cleanup could not be verified');
    await sleep(10);
  }
})().catch(error => { console.error(error.message); process.exitCode = 125; });
`;
