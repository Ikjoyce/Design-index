import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function defaultLibraryDir(): string {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'DesignIndex', 'library');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'DesignIndex', 'library');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'design-index', 'library');
}

export function readConfig() {
  const port = Number(process.env.DESIGN_INDEX_PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DESIGN_INDEX_PORT must be between 1 and 65535.');
  const customDir = process.env.DESIGN_INDEX_LIBRARY_DIR;
  if (customDir && !isAbsolute(customDir)) throw new Error('DESIGN_INDEX_LIBRARY_DIR must be an absolute path.');
  const inbox = process.env.DESIGN_INDEX_INBOX_DIR?.trim();
  if (inbox && inbox !== 'off' && !isAbsolute(inbox)) throw new Error('DESIGN_INDEX_INBOX_DIR must be an absolute path, or off.');
  // Both src/config.ts and the bundled dist/index.js are three directories below the project root.
  const inboxDir = inbox === 'off' ? null : inbox || resolve(dirname(fileURLToPath(import.meta.url)), '../../../inbox');
  return { port, libraryDir: resolve(customDir || defaultLibraryDir()), inboxDir };
}
