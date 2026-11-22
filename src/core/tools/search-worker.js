import { parentPort, workerData } from 'node:worker_threads';
import { grep } from './search.js';

try {
  parentPort.postMessage({ result: await grep(workerData.args, workerData.ctx) });
} catch (error) {
  parentPort.postMessage({ error: error?.message ?? String(error) });
}
