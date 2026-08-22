import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

export interface AtomicFileHandle {
  writeFile(content: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicFileDependencies {
  mkdir(directory: string): Promise<unknown>;
  open(filename: string, flags: string, mode?: number): Promise<AtomicFileHandle>;
  beforeRename(source: string, target: string): Promise<void>;
  rename(source: string, target: string): Promise<void>;
  unlink(filename: string): Promise<void>;
}

const defaultDependencies: AtomicFileDependencies = {
  mkdir: async (directory) => mkdir(directory, { recursive: true }),
  open: async (filename, flags, mode) => open(filename, flags as Parameters<typeof open>[1], mode) as Promise<FileHandle>,
  beforeRename: async () => undefined,
  rename,
  unlink,
};

export function createWriteFileAtomic(overrides: Partial<AtomicFileDependencies> = {}): (target: string, content: string) => Promise<void> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async (target, content) => {
    const directory = path.dirname(target);
    const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle: AtomicFileHandle | undefined;
    let temporaryCreated = false;
    let renamed = false;
    try {
      await dependencies.mkdir(directory);
      handle = await dependencies.open(temporary, "wx", 0o600);
      temporaryCreated = true;
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await dependencies.beforeRename(temporary, target);
      await dependencies.rename(temporary, target);
      renamed = true;
      const directoryHandle = await dependencies.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (temporaryCreated && !renamed) await dependencies.unlink(temporary).catch(() => undefined);
      throw error;
    }
  };
}

export const writeFileAtomic = createWriteFileAtomic();
