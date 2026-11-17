import { modelId } from '../../src/core/model-windows.js';

export const modelWindows = {
  warm() {},
  async resolve(ref) { return { id: modelId(ref), window: 128000, known: false }; }
};
