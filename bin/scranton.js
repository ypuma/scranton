#!/usr/bin/env node
import { runCli } from '../src/core/cli.js';

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (err) {
  console.error(`scranton: unexpected error: ${err?.stack ?? err}`);
  process.exitCode = 1;
}
