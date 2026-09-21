import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CliAdapterError } from "../cli/output.js";
import { spawnJson } from "../process/spawn-json.js";

export interface ProjectGuidanceDependencies { randomUUID(): string }
export interface ProjectGuidanceInput { root: string; operation: "setup" | "remove"; dryRun?: boolean }
export interface ProjectGuidanceResult { root: string; target: string; operation: "setup" | "remove"; dryRun: boolean; changed: boolean; recoveryFile?: string }
const begin = "<!-- wsspeckit:begin -->";
const end = "<!-- wsspeckit:end -->";
const body = [
  "### WSSpecKit 工作流接入",
  "",
  "项目存在 .wsspec/repository.yaml 与 .wsspec/config.yaml 时，实现功能、修复错误、修改文档使用当前 Host 已加载的 wsspeckit-driver；配置有效性以 CLI 校验为准。",
  "继续已有任务时先执行 wspec continue <workItemId> --actor <执行者>，按 action / view.nextAction 恢复；仅独立新需求创建任务，关联不明时先确认。",
  "咨询、解释、只读 review 和评估直接处理，不创建交付任务。",
  "Driver 未加载时如实说明，用 wspec agent status --client <客户端> 检查磁盘；在已授权任务范围内继续，不自行修改全局安装或初始化项目。磁盘安装成功不证明当前会话已加载。",
];
function conflict(message = "项目指引区块未知、被修改或不完整，拒绝覆盖。 "): never {
  throw new CliAdapterError("WSSPEC_SKILL_INSTALL_CONFLICT", message);
}
function block(eol: string, prefix: number): string {
  return [begin, `<!-- wsspeckit:managed v1 prefix=${prefix} -->`, ...body, end, ""].join(eol);
}

/** Pure byte-preserving edit outside the registered managed block. */
export function transformProjectGuidance(source: string, operation: "setup" | "remove"): string {
  const markers = source.match(/<!--\s*wsspeckit:/gu) ?? [];
  if (markers.length === 0) {
    if (source.includes("wsspeckit:begin") || source.includes("wsspeckit:end")) conflict();
    if (operation === "remove") return source;
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const prefix = source.length > 0 && !source.endsWith("\n") ? 1 : 0;
    return source + (prefix ? eol : "") + block(eol, prefix);
  }
  if (markers.length !== 3) conflict();
  for (const eol of ["\n", "\r\n"]) for (const prefix of [0, 1]) {
    const known = block(eol, prefix);
    const index = source.indexOf(known);
    if (index < 0 || (index > 0 && source[index - 1] !== "\n")) continue;
    const start = index - (prefix ? eol.length : 0);
    if (start < 0 || (prefix && source.slice(start, index) !== eol)) continue;
    return operation === "setup" ? source : source.slice(0, start) + source.slice(index + known.length);
  }
  return conflict();
}

// A pinned directory fd and atomic exchange prevent path replacement from destroying
// an unobserved concurrent version. Displaced data always remains in the named
// recovery file, including successful replacements, to preserve late editor writes. The lock coordinates instances of this command (not arbitrary editors).
const writer = String.raw`
import base64, ctypes, json, os, stat, sys
r=json.load(sys.stdin)
d=None
lock=None
temp=None
tempCreated=False
tempIdentity=None
swapped=False
ok=False
try:
    d=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    for part in r['root'].split('/')[1:]:
        child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=d)
        os.close(d)
        d=child
    s=os.fstat(d)
    if str(s.st_dev)!=r['dev'] or str(s.st_ino)!=r['ino']: raise ValueError()
    if s.st_uid!=os.getuid() or s.st_mode & 0o022: raise ValueError()
    if not r['dryRun']:
        lock=os.open('.wsspeckit-guidance.lock',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=d)
    def unlink_owned(name, owned):
        current=os.stat(name,dir_fd=d,follow_symlinks=False)
        if (current.st_dev,current.st_ino)!=(owned.st_dev,owned.st_ino): raise ValueError()
        os.unlink(name,dir_fd=d)
    def binding():
        current=os.stat(r['root'],follow_symlinks=False)
        if (current.st_dev,current.st_ino)!=(s.st_dev,s.st_ino) or os.path.realpath(r['root'])!=r['root']: raise ValueError()
    binding()
    def read(name):
        f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
        try:
            s=os.fstat(f)
            if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=os.getuid() or s.st_mode & 0o022: raise ValueError()
            data=b''
            while len(data)<=r['maxBytes']:
                part=os.read(f,min(65536,r['maxBytes']+1-len(data)))
                if not part: break
                data+=part
            if len(data)>r['maxBytes']: raise ValueError()
            after=os.fstat(f)
            if (s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns): raise ValueError()
            return data,s
        finally: os.close(f)
    expected=None if r['before'] is None else base64.b64decode(r['before'])
    try: old,identity=read('AGENTS.md')
    except FileNotFoundError: old=None
    if old!=expected: raise ValueError()
    if not r['dryRun'] and r['changed']:
        temp=r['recoveryName']
        f=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=d)
        tempCreated=True
        try:
            tempIdentity=os.fstat(f)
            data=base64.b64decode(r['after'])
            while data:
                n=os.write(f,data)
                data=data[n:]
            if old is not None: os.fchmod(f,identity.st_mode & 0o777)
            os.fsync(f)
        finally: os.close(f)
        if old is None:
            os.link(temp,'AGENTS.md',src_dir_fd=d,dst_dir_fd=d,follow_symlinks=False)
        else:
            replacement=os.stat(temp,dir_fd=d,follow_symlinks=False)
            libc=ctypes.CDLL(None,use_errno=True)
            fn=libc.renameatx_np
            fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
            if fn(d,temp.encode(),d,b'AGENTS.md',2)!=0: raise OSError(ctypes.get_errno())
            swapped=True
            displaced,previous=read(temp)
            if displaced!=expected or (previous.st_dev,previous.st_ino)!=(identity.st_dev,identity.st_ino): raise ValueError()
            installed,current=read('AGENTS.md')
            if installed!=base64.b64decode(r['after']) or (current.st_dev,current.st_ino)!=(replacement.st_dev,replacement.st_ino): raise ValueError()
        if not swapped:
            unlink_owned(temp,tempIdentity)
            temp=None
        os.fsync(d)
    binding()
    ok=True
except Exception: pass
finally:
    if d is not None:
        if temp is not None and tempCreated and tempIdentity is not None and not swapped:
            try: unlink_owned(temp,tempIdentity)
            except (OSError,ValueError): pass
        if lock is not None:
            lockIdentity=os.fstat(lock)
            os.close(lock)
            try: unlink_owned('.wsspeckit-guidance.lock',lockIdentity)
            except (OSError,ValueError): pass
        os.close(d)
print(json.dumps({'ok':ok,'recoveryFile':temp if swapped else None}))
`;

/** Caller enforces Git/init policy. This function touches only root/AGENTS.md. */
export async function manageProjectGuidance(input: ProjectGuidanceInput, dependencies: ProjectGuidanceDependencies = { randomUUID }): Promise<ProjectGuidanceResult> {
  if (process.platform !== "darwin") conflict("项目指引安全写入当前仅支持 macOS。");
  const root = path.resolve(input.root);
  if (await realpath(root) !== root) conflict("项目根目录必须是 canonical 普通目录，禁止 symlink。");
  const rootInfo = await lstat(root, { bigint: true });
  if (!rootInfo.isDirectory()) conflict();
  const target = path.join(root, "AGENTS.md");
  let bytes: Buffer | undefined;
  try {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > 1_048_576n) conflict("AGENTS.md 必须是有界单链接普通文件。");
      bytes = Buffer.alloc(Number(before.size) + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      bytes = bytes.subarray(0, bytesRead);
      const after = await handle.stat({ bigint: true });
      if (before.size !== BigInt(bytes.length) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) conflict();
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof CliAdapterError) throw error;
      conflict("AGENTS.md 不可安全读取，禁止 symlink 或特殊文件。");
    }
  }
  const source = bytes?.toString("utf8") ?? "";
  if (bytes !== undefined && !Buffer.from(source).equals(bytes)) conflict("AGENTS.md 必须是有效 UTF-8。");
  const content = transformProjectGuidance(source, input.operation);
  if (Buffer.byteLength(content, "utf8") > 1_048_576) conflict("AGENTS.md 添加指引后的内容超过安全读取上限，未修改文件。");
  const changed = content !== source;
  let recoveryFile: string | undefined;
  const recoveryId = dependencies.randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(recoveryId)) conflict("项目指引恢复文件 ID 无效。");
  try {
    const helper = await realpath("/usr/bin/python3");
    const info = await lstat(helper);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) conflict();
    const result = await spawnJson({ executable: helper, argv: ["-I", "-S", "-c", writer],
      input: { root, recoveryName: `.wsspeckit-guidance-recovery-${recoveryId}.md`, dev: String(rootInfo.dev), ino: String(rootInfo.ino), before: bytes?.toString("base64") ?? null,
        after: Buffer.from(content).toString("base64"), changed, dryRun: input.dryRun === true, maxBytes: 1_048_576 },
      timeoutMs: 5_000, maxStdoutBytes: 256 });
    const response = result.value as { ok?: boolean; recoveryFile?: string | null };
    if (typeof response.recoveryFile === "string" && /^\.wsspeckit-guidance-recovery-[a-f0-9-]+\.md$/u.test(response.recoveryFile)) recoveryFile = path.join(root, response.recoveryFile);
    if (response.ok !== true) conflict("项目指引写入冲突；请检查 AGENTS.md、锁文件及 .wsspeckit-guidance-recovery-* 后重试。");
  } catch (error) {
    if (error instanceof CliAdapterError) throw error;
    conflict("项目指引安全写入 helper 不可用。");
  }
  return { root, target, operation: input.operation, dryRun: input.dryRun === true, changed, ...(recoveryFile === undefined ? {} : { recoveryFile }) };
}
