// Validate the complete inventory before writing; never delegate archive paths to extractall/tar.
export const extractionScript = String.raw`
import os, sys, stat, tarfile, zipfile, shutil
from pathlib import Path, PurePosixPath
archive, destination, kind = sys.argv[1:]
root = Path(destination)
if root.exists():
    raise ValueError('Extraction destination must not exist')

def relative(name):
    if not name or '\\' in name or ':' in name or '\0' in name or name.startswith('/'):
        raise ValueError('Unsafe archive path: ' + repr(name))
    parts = name.rstrip('/').split('/')
    if any(p in ('', '.', '..') or p.endswith((' ', '.')) for p in parts):
        raise ValueError('Unsafe archive path: ' + name)
    if any(p.split('.')[0].upper() in {'CON','PRN','AUX','NUL',*(f'COM{i}' for i in range(1,10)),*(f'LPT{i}' for i in range(1,10))} for p in parts):
        raise ValueError('Reserved archive path: ' + name)
    return '/'.join(parts)

handle = zipfile.ZipFile(archive) if kind == 'zip' else tarfile.open(archive, 'r:gz')
entries = []
seen = {}
identity = str.casefold if kind == 'zip' else (lambda name: name)
for item in (handle.infolist() if kind == 'zip' else handle.getmembers()):
    original = item.orig_filename if kind == 'zip' else item.name
    name = relative(original)
    if kind != 'zip':
        if name == 'python' and item.isdir():
            continue
        if not name.startswith('python/'):
            raise ValueError('Expected standalone python/ archive root')
        name = name[len('python/'):]
    mode = (item.external_attr >> 16) if kind == 'zip' else item.mode
    if kind == 'zip':
        filetype = stat.S_IFMT(mode)
        if filetype not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ValueError('Unsupported ZIP entry: ' + name)
        entrykind = 'dir' if item.is_dir() else 'file'
    else:
        entrykind = 'dir' if item.isdir() else 'file' if item.isfile() else 'symlink' if item.issym() else 'hardlink' if item.islnk() else 'invalid'
    if entrykind == 'invalid':
        raise ValueError('Device/special archive entry: ' + name)
    folded = identity(name)
    if folded in seen:
        raise ValueError('Duplicate archive path: ' + name)
    seen[folded] = entrykind
    entries.append((name, entrykind, mode, item))
for name, entrykind, mode, item in entries:
    parts = PurePosixPath(name).parts
    for i in range(1,len(parts)):
        if seen.get(identity('/'.join(parts[:i])), 'dir') != 'dir':
            raise ValueError('Non-directory archive ancestor: ' + name)
    if entrykind in ('symlink','hardlink'):
        link = item.linkname
        if not link or '\\' in link or ':' in link or '\0' in link or link.startswith('/'):
            raise ValueError('Unsafe archive link: ' + name)
        if entrykind == 'hardlink':
            link = relative(link)
            if not link.startswith('python/'):
                raise ValueError('Hardlink outside standalone root')
            target = link[len('python/'):]
        else:
            target = os.path.normpath(str(PurePosixPath(name).parent / link)).replace(os.sep, '/')
        if target == '..' or target.startswith('../') or seen.get(identity(target)) not in ('file','dir','symlink'):
            raise ValueError('Escaping or missing archive link: ' + name)
        if entrykind == 'symlink' and seen.get(identity(target)) == 'dir':
            raise ValueError('Directory symlink cannot be packaged safely: ' + name)
        if entrykind == 'hardlink' and seen.get(identity(target)) != 'file':
            raise ValueError('Hardlink target must be a regular file')
# Engine CLI does not use ncurses' case-colliding terminal database; omit it on all hosts.
entries = [e for e in entries if e[0] != 'share/terminfo' and not e[0].startswith('share/terminfo/')]
root.mkdir(parents=True)
try:
    for name, entrykind, mode, item in entries:
        out = root / name
        if entrykind == 'dir':
            out.mkdir(parents=True,exist_ok=True)
        elif entrykind == 'file':
            out.parent.mkdir(parents=True,exist_ok=True)
            with (handle.open(item) if kind == 'zip' else handle.extractfile(item)) as source, out.open('xb') as dest:
                shutil.copyfileobj(source, dest)
            out.chmod(mode & 0o777 if mode & 0o777 else 0o644)
    for name, entrykind, mode, item in entries:
        out = root / name
        if entrykind in ('symlink','hardlink'):
            out.parent.mkdir(parents=True,exist_ok=True)
            if entrykind == 'symlink':
                out.symlink_to(item.linkname)
            else:
                os.link(root / item.linkname[len('python/'):], out)
    for name, entrykind, mode, item in entries:
        if entrykind == 'symlink':
            target = (root / name).resolve(strict=True)
            target.relative_to(root.resolve())
            if target.is_dir():
                raise ValueError('Directory symlink cannot be packaged safely: ' + name)
except BaseException:
    shutil.rmtree(root)
    raise
finally:
    handle.close()
`;
