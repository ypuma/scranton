import { beforeEach } from 'node:test';

// Lifecycle fixtures exercise Docker launch plumbing without contacting a model.
beforeEach((t) => {
  const values = Object.fromEntries(['MICHAEL', 'DWIGHT', 'ANGELA'].flatMap((role) => [
    [`SCRANTON_${role}_PROVIDER`, 'openai'], [`SCRANTON_${role}_MODEL`, 'test-model']
  ]));
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
});
