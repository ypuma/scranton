const fields = ['dev', 'ino', 'size', 'nlink', 'mtimeNs', 'ctimeNs', 'birthtimeNs'];

// File indexes can be reused; access time alone may change because of our own read.
export function sameFileIdentity(a, b) {
  return a.isFile() && b.isFile() && a.nlink === 1n && b.nlink === 1n && fields.every((key) => typeof a[key] === 'bigint' && a[key] === b[key]);
}
