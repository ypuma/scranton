export const PIPELINE_TERMINAL = Object.freeze(['succeeded', 'failed', 'rejected', 'cancelled']);
export const isRelativeFile = (value) => typeof value === 'string' && Boolean(value) && !/^(?:[A-Za-z]:|\/|\\)|\.\.|[\x00-\x1f\x7f]/.test(value);

export function maskHistoricalText(value, pipeline = false) {
  return value.replace(pipeline ? /\b[A-Za-z]:[\\/][^\s"<>]+|\\\\[^\s"<>]+|\/(?:Users|home|tmp|private|var|mnt)\/[^\s"<>]+/g : /\b[A-Za-z]:[\\/][^\s"<>]+|\\\\[^\s"<>]+/g, '[private path]')
    .replace(/(^|[\s"'(=])\/[^\s"<>]+/g, '$1[private path]')
    .replace(/\b[a-f0-9]{64}\b|\b[EKH]-[a-f0-9]{10}\b/gi, '[historical reference]');
}
