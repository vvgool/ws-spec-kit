import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const cleanEnvironmentKeys = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "HOME",
  "LC_ALL",
  "PATH",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
];

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value) {
  const input = typeof value === "string" || ArrayBuffer.isView(value) ? value : canonicalJson(value);
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

export async function sha256File(filename) {
  return sha256(await readFile(filename));
}

export async function inspectBoundFile(root, relativePath) {
  const canonicalRoot = await realpath(root);
  const normalized = relativePath.split(path.sep).join("/");
  if (path.isAbsolute(relativePath) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("bound file path 必须是 canonical repository-relative path");
  }
  const filename = path.join(canonicalRoot, relativePath);
  const before = await lstat(filename);
  const resolved = await realpath(filename);
  const info = await stat(resolved);
  const after = await lstat(filename);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : info.uid;
  const stable = resolved === filename && !before.isSymbolicLink() && !after.isSymbolicLink()
    && before.dev === info.dev && before.ino === info.ino && after.dev === info.dev && after.ino === info.ino;
  if (!stable || !info.isFile() || info.nlink !== 1 || ![0, expectedUid].includes(info.uid) || (info.mode & 0o022) !== 0) {
    throw new Error("bound file identity 无效");
  }
  const value = {
    path: normalized,
    digest: await sha256File(resolved),
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    mode: info.mode & 0o777,
    uid: info.uid,
    size: info.size,
  };
  return { ...value, identity: sha256(value) };
}

function authorityIdentityValue(info) {
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    mode: info.mode & 0o777,
    nlink: info.nlink,
    size: info.size,
    uid: info.uid,
  };
}

function authorityIdentity(info, raw) {
  return sha256({
    ...authorityIdentityValue(info),
    contentDigest: sha256(raw),
  });
}

export async function createAuthority() {
  const filename = path.join(os.tmpdir(), `wsspeckit-agent-authority-${randomUUID()}.json`);
  const authority = {
    version: 1,
    kind: "wsspeckit-agent-smoke-authority",
    createdAt: new Date().toISOString(),
    runNonce: randomBytes(32).toString("hex"),
    hmacKey: randomBytes(32).toString("hex"),
  };
  const raw = `${JSON.stringify(authority)}\n`;
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(raw, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filename, 0o600);
  return { filename, identity: authorityIdentity(await stat(filename), raw), authority };
}

export async function readAuthority(filename, expectedIdentity) {
  const before = await lstat(filename);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(filename, flags);
  let info;
  let raw;
  try {
    info = await handle.stat();
    if (info.size > 4096) throw new Error("acceptance authority 过大");
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const after = await lstat(filename);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : info.uid;
  const stablePath = before.dev === info.dev && before.ino === info.ino && after.dev === info.dev && after.ino === info.ino;
  const identity = authorityIdentity(info, raw);
  if (!stablePath || !info.isFile() || before.isSymbolicLink() || after.isSymbolicLink() || info.nlink !== 1
    || (info.mode & 0o777) !== 0o600 || info.uid !== expectedUid || identity !== expectedIdentity) {
    throw new Error("acceptance authority identity 无效");
  }
  const value = JSON.parse(raw);
  if (value?.version !== 1 || value.kind !== "wsspeckit-agent-smoke-authority"
    || typeof value.runNonce !== "string" || !/^[a-f0-9]{64}$/u.test(value.runNonce)
    || typeof value.hmacKey !== "string" || !/^[a-f0-9]{64}$/u.test(value.hmacKey)) {
    throw new Error("acceptance authority 内容无效");
  }
  return value;
}

function receiptMac(authority, kind, manifestDigest, authorityIdentity) {
  return `sha256:${createHmac("sha256", Buffer.from(authority.hmacKey, "hex"))
    .update(`${kind}\n${manifestDigest}\n${authorityIdentity}`, "utf8")
    .digest("hex")}`;
}

export async function writeSignedJson(manifestFile, receiptFile, kind, value, authority, authorityIdentity) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const manifestDigest = sha256(text);
  const receipt = {
    version: 1,
    kind,
    manifestDigest,
    authorityIdentity,
    mac: receiptMac(authority, kind, manifestDigest, authorityIdentity),
  };
  await writeFile(manifestFile, text, { encoding: "utf8", mode: 0o600 });
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { manifestDigest, receipt };
}

export async function readSignedJson(manifestFile, receiptFile, kind, authorityFile, expectedIdentity) {
  const authority = await readAuthority(authorityFile, expectedIdentity);
  const manifestText = await readFile(manifestFile, "utf8");
  const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  const manifestDigest = sha256(manifestText);
  const expectedMac = receiptMac(authority, kind, manifestDigest, expectedIdentity);
  const actual = typeof receipt?.mac === "string" ? Buffer.from(receipt.mac) : Buffer.alloc(0);
  const expected = Buffer.from(expectedMac);
  if (receipt?.version !== 1 || receipt.kind !== kind || receipt.manifestDigest !== manifestDigest
    || receipt.authorityIdentity !== expectedIdentity || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("acceptance receipt 无效");
  }
  return { authority, value: JSON.parse(manifestText), manifestDigest, receipt };
}

async function fixedGitExecutable() {
  for (const candidate of ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("找不到受信任的 git executable");
}

export async function cleanEnvironment(root, additionalPath = [], options = {}) {
  const privateHome = path.join(root, ".acceptance", "home");
  const home = options.home ?? privateHome;
  const xdgConfig = path.join(privateHome, ".config");
  const xdgCache = path.join(privateHome, ".cache");
  const temporary = path.join(privateHome, "tmp");
  await Promise.all([mkdir(xdgConfig, { recursive: true }), mkdir(xdgCache, { recursive: true }), mkdir(temporary, { recursive: true })]);
  const globalGitConfig = path.join(privateHome, ".gitconfig");
  await writeFile(globalGitConfig, "", { encoding: "utf8", mode: 0o600 });
  const gitExecutable = await fixedGitExecutable();
  const pathEntries = [...additionalPath, path.dirname(process.execPath), path.dirname(gitExecutable), "/usr/bin", "/bin"]
    .filter((entry, index, all) => path.isAbsolute(entry) && all.indexOf(entry) === index);
  const environment = {
    GIT_CONFIG_GLOBAL: globalGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    LC_ALL: "C",
    PATH: pathEntries.join(path.delimiter),
    TMPDIR: temporary,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
  };
  return { environment, gitExecutable };
}
