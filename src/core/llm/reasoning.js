const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function reasoningLevel(model, requested = 'off') {
  if (!levels.includes(requested)) throw new Error('Invalid reasoning level');
  if (!model.reasoning) return 'off';
  const map = model.thinkingLevelMap ?? {};
  const supported = levels.filter(level => map[level] !== null && (map[level] !== undefined || ['off', 'low', 'medium', 'high'].includes(level)));
  const at = levels.indexOf(requested);
  return levels.slice(at).find(level => supported.includes(level)) ?? levels.slice(0, at).reverse().find(level => supported.includes(level)) ?? 'off';
}
