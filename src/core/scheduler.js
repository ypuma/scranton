/** Slots cover the entire developer -> QA -> integration pipeline. */
export async function runDag(milestones, { maxParallel, run, blocked, signal }) {
  const pending = new Map(milestones.map((m, index) => [m.id, { m, index }]));
  const active = new Map();
  const outcomes = new Map();
  let failure;
  while (pending.size || active.size) {
    const pendingBefore = pending.size;
    if (!failure && !signal?.aborted) {
      for (const [id, { m, index }] of pending) {
        const deps = m.dependsOn ?? (index ? [milestones[index - 1].id] : []);
        if (deps.some((d) => outcomes.has(d) && outcomes.get(d) !== 'passed')) {
          pending.delete(id);
          outcomes.set(id, 'blocked');
          await blocked(m, deps.filter((d) => outcomes.has(d) && outcomes.get(d) !== 'passed'));
        } else if (active.size < maxParallel && deps.every((d) => outcomes.get(d) === 'passed')) {
          pending.delete(id);
          const task = Promise.resolve().then(() => run(m, index, [...outcomes].filter(([, s]) => s === 'passed').map(([id]) => id)))
            .then((status) => outcomes.set(id, status), (err) => { failure ??= err; })
            .finally(() => active.delete(id));
          active.set(id, task);
        }
      }
    }
    if (!active.size) {
      if (failure) throw failure;
      if (signal?.aborted) throw new Error('Run aborted');
      if (pending.size && pending.size < pendingBefore) continue;
      if (pending.size) throw new Error('No ready milestones: invalid dependency graph');
      break;
    }
    await Promise.race(active.values());
  }
  if (failure) throw failure;
  return [...outcomes.values()];
}
