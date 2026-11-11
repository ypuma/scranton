import { antigravityProvider } from './provider.js';

export default function (pi) {
  pi.registerProvider(antigravityProvider());
}
