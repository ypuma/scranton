const cleanups = new WeakMap();

export function cleanup(t, dispose, { timeoutMs = 10000 } = {}) {
  if (!cleanups.has(t)) {
    const stack = [];
    cleanups.set(t, stack);
    // A throwing after hook prevents Node from running later hooks.
    t.after(async () => {
      const errors = [];
      for (const { dispose, timeoutMs } of stack.reverse()) {
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(dispose),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture cleanup timed out')), timeoutMs); })
          ]);
        } catch (err) { errors.push(err); }
        finally { clearTimeout(timer); }
      }
      if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
    });
  }
  cleanups.get(t).push({ dispose, timeoutMs });
}
