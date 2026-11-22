import './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { startAgent } from '../../src/core/agent/index.js';
import { createSandbox } from '../../src/core/sandbox-docker/index.js';
import { fakeCli } from './sandbox-docker/fake-cli.js';

test('orchestrator scripted Docker run uses container bash without host Git Bash', async t => {
  const f = fakeCli(t, {exitCode: 0});
  const config = loadConfig({cwd: f.root, env: {}, platform: 'win32', hasBash: false,
    fileConfig: {execution: {maxParallel: 1, sandbox: {mode: 'docker'}}}});
  config.scripted = 'happy';
  const outputs = [], sandboxes = [];
  const o = new Orchestrator({config, noPlan: true, onBreaker: 'abort',
    extraEnv: {PATH: '', Path: '', ProgramFiles: path.join(f.root, 'no-git'), 'ProgramFiles(x86)': path.join(f.root, 'no-git')},
    sandboxFactory() { assert.fail('Docker must not use the native sandbox'); },
    dockerSandboxFactory(settings) {
      const sandbox = createSandbox(settings, f.deps);
      sandboxes.push(sandbox);
      return sandbox;
    },
    startRunner(options) {
      assert.ok(sandboxes.includes(options.sandbox));
      return startAgent({...options, onLive(record) {
        options.onLive?.(record);
        if (record.type === 'tool_execution_end' && record.toolName === 'bash') outputs.push(record.result);
      }});
    }});
  const result = await o.run('Verify Docker shell routing');
  assert.equal(result.status, 'success', result.summary);
  assert.equal(outputs.length, 2, 'developer and QA both executed bash');
  for (const output of outputs) {
    assert.equal(output.isError, false, output.content);
    assert.equal(output.details.exitCode, 0);
    assert.match(output.content, /stdout/);
  }
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  const execs = calls.filter(args => args[0] === 'exec' && args[1] === '--interactive');
  assert.equal(execs.length, 2, 'tool calls reached the fake Docker CLI');
  for (const args of execs) {
    assert.deepEqual(args.slice(0, 4), ['exec', '--interactive', '--workdir', '/workspace']);
    assert.equal(args[5], '/usr/local/bin/node');
    assert.equal(args[6], '-e');
    assert.match(args[8], /^\/tmp\/scranton-exec-/);
    assert.deepEqual(args.slice(9), ['/bin/bash', '-c', 'node --test']);
  }
  assert.equal(calls.filter(args => args[0] === 'run').length, 2);
  assert.equal(calls.filter(args => args[0] === 'rm').length, 2);
});
