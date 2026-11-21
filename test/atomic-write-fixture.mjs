// In an isolated fixture process, associate write faults with the actual path
// even when the writer opens the file before writing to its descriptor.
export function interceptFileWrites(fs, write) {
  const { openSync, closeSync, writeFileSync } = fs;
  const paths = new Map();
  fs.openSync = (path, ...options) => {
    const fd = openSync(path, ...options);
    paths.set(fd, path);
    return fd;
  };
  fs.closeSync = fd => {
    try { return closeSync(fd); }
    finally { paths.delete(fd); }
  };
  fs.writeFileSync = (file, data, ...options) =>
    write(paths.get(file) ?? file, data, bytes => writeFileSync(file, bytes, ...options));
}
