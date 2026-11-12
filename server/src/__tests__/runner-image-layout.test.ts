import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BUILD_INPUTS_SCHEMA,
  buildInputsStampPath,
  collectBuildOutputFiles,
} from "../../../packages/paperclip-runner/scripts/build-inputs.mjs";
import { sha256Tree } from "../../../packages/paperclip-runner/scripts/provider-pack-runtime-tree.mjs";
import {
  PROVIDER_PACK_ARCHIVE_SCHEMA,
  PROVIDER_PACK_SCHEMA,
  RUNNER_IMAGE_INPUTS_SCHEMA,
  RUNNER_IMAGE_PATHS,
  RUNNER_IMAGE_SCHEMA,
  canonicalJson,
  checkRunnerImageLayout,
  parseLayoutArguments,
  writeRunnerImageManifest,
} from "../../../scripts/runner-image-layout.mjs";

/**
 * The layout contract of the Runner image. Consumers copy the documented
 * paths out of a published image and trust runner-image.json, so a tree that
 * lacks a path, or whose manifest does not describe it, must never pass.
 */

const REVISION = "a".repeat(40);
const INPUTS = "1".repeat(64);
const BUILD_INPUTS = "2".repeat(64);
const identity = { schema: RUNNER_IMAGE_INPUTS_SCHEMA, digest: INPUTS, buildInputs: { schema: BUILD_INPUTS_SCHEMA, digest: BUILD_INPUTS } };
const platform = { os: "linux", architecture: "amd64" };
const libc = { baseline: "debian-bookworm", buildVersion: "2.36", runnerdRequires: "2.34" };
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const layoutScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "runner-image-layout.mjs");
const scratch = mkdtempSync(path.join(tmpdir(), "runner-image-layout-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;

function write(root: string, relative: string, content: Buffer | string) {
  const file = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** The first bytes of a little-endian ELF executable for the given machine. */
function elf(machine: number) {
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(machine, 18);
  return header;
}

/** A Runner package as its build leaves it: build output and the stamp that describes it. */
function workspace(root: string, { machine = 62, arch = "x64", digest = BUILD_INPUTS } = {}) {
  const runner = "packages/paperclip-runner";
  write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(root, `${runner}/package.json`, '{"name":"@paperclipai/paperclip-runner","type":"module"}\n');
  write(root, `${runner}/scripts/provision-grok.mjs`, "// provisions Grok\n");
  write(root, `${runner}/src/providers/grok/platforms.json`, '{"version":"1.0.13"}\n');
  write(root, `${runner}/src/live/runnerd-codex-transport.ts`, 'const RUNNER_CLIENT_VERSION = "0.3.0";\n');
  for (const file of ["index.js", "live/index.js", "testing.js"]) write(root, `${runner}/dist/${file}`, `// ${file}\n`);
  chmodSync(write(root, `${runner}/dist/bin/paperclip-runnerd`, elf(machine)), 0o755);
  const packageRoot = path.join(root, ...runner.split("/"));
  const outputs = collectBuildOutputFiles(packageRoot);
  write(packageRoot, path.relative(packageRoot, buildInputsStampPath(packageRoot)).split(path.sep).join("/"), JSON.stringify({
    schema: BUILD_INPUTS_SCHEMA, digest, platform: "linux", arch, outputCount: outputs.length, outputs,
  }));
}

/** The files the image build produces before it writes runner-image.json. */
function providerPack(out: string, { revision = REVISION, inputsDigest = INPUTS, arch = "x64", lock = "lockfileVersion: '9.0'\n" } = {}) {
  const pack = path.join(out, "provider-pack");
  const files: Record<string, string> = {
    nodeCommand: "node_modules/node/bin/node",
    productionLock: "pnpm-lock.yaml",
    opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs",
  };
  const artifacts: Record<string, { path: string; sha256: string }> = {};
  for (const [name, relative] of Object.entries(files)) {
    const content = name === "productionLock" ? lock : `${name}\n`;
    write(pack, relative, content);
    artifacts[name] = { path: relative, sha256: `sha256:${sha256(content)}` };
  }
  write(pack, "dist/index.js", "// pack dist\n");
  write(pack, "provider-assets/pi/linux-x64/pi.js", "// pi\n");
  const payload = {
    target: { platform: "linux", architecture: arch },
    runnerSourceRevision: revision,
    runnerInputsDigest: inputsDigest,
    distDigest: sha256Tree(path.join(pack, "dist")),
    providers: { pi: { path: "provider-assets/pi/linux-x64", sha256: sha256Tree(path.join(pack, "provider-assets/pi/linux-x64")) } },
    artifacts,
  };
  const manifest = { schema: PROVIDER_PACK_SCHEMA, digest: `sha256:${sha256(canonicalJson(payload))}`, payload };
  write(pack, "provider-pack.json", `${JSON.stringify(manifest, null, 2)}\n`);

  const archived = { path: "node_modules/node/bin/node", content: "nodeCommand\n" };
  const overlay = Buffer.from("overlay archive");
  const layer = Buffer.from("node archive");
  write(out, "provider-pack.archives/overlay.tar.zst", overlay);
  write(out, "provider-pack.archives/0.tar.zst", layer);
  write(out, "provider-pack.archive.json", JSON.stringify({
    schema: PROVIDER_PACK_ARCHIVE_SCHEMA,
    encoding: "tar+zstd",
    providerPackDigest: manifest.digest,
    overlay: { sha256: sha256(overlay), bytes: overlay.length },
    files: [{ path: archived.path, bytes: archived.content.length, mode: 0o755, sha256: sha256(archived.content),
      archive: { sha256: sha256(layer), bytes: layer.length } }],
  }));
  write(out, "bundles/runnerd-codex-transport.mjs", "export function createCapabilityRunnerdCodexTransport() {}\n");
}

function image({ stamped = true, pack = {}, source = {} }: { stamped?: boolean; pack?: object; source?: object } = {}) {
  const root = path.join(scratch, String(sequence += 1));
  const out = path.join(root, "out");
  workspace(path.join(root, "workspace"), source);
  if (stamped) providerPack(out, pack);
  writeRunnerImageManifest({
    outRoot: out, workspaceRoot: path.join(root, "workspace"), identity, platform, libc, sourceRevision: stamped ? REVISION : null,
  });
  return out;
}

const manifestOf = (out: string) => JSON.parse(readFileSync(path.join(out, "runner-image.json"), "utf8"));
function rewriteManifest(out: string, change: (manifest: Record<string, any>) => void) {
  const manifest = manifestOf(out);
  change(manifest);
  writeFileSync(path.join(out, "runner-image.json"), JSON.stringify(manifest));
}

describe("Runner image layout contract", () => {
  let out: string;
  beforeEach(() => {
    out = image();
  });

  it("accepts the tree the image build writes", () => {
    expect(checkRunnerImageLayout(out)).toEqual([]);
    expect(checkRunnerImageLayout(out, { expectInputsDigest: INPUTS, expectSourceRevision: REVISION, expectArchitecture: "amd64" })).toEqual([]);
    const manifest = manifestOf(out);
    expect(manifest).toMatchObject({
      schema: RUNNER_IMAGE_SCHEMA,
      inputsDigest: { schema: "paperclip.runner-image-inputs.v1", digest: INPUTS },
      buildInputsDigest: { schema: "paperclip.runner-build-inputs.v2", digest: BUILD_INPUTS },
      sourceRevision: REVISION,
      platform: { os: "linux", architecture: "amd64" },
      libc: { family: "glibc", baseline: "debian-bookworm", buildVersion: "2.36", runnerdRequires: "2.34" },
      paths: RUNNER_IMAGE_PATHS,
    });
    // One daemon, at the root for sandbox images and inside the build output
    // for a build that vendors the Runner.
    expect(manifest.sha256.runnerd).toBe(manifest.sha256.runnerDistRunnerd);
  });

  it.each(Object.entries(RUNNER_IMAGE_PATHS))("fails when the documented path %s is missing", (name, relative) => {
    rmSync(path.join(out, ...(relative as string).split("/")), { recursive: true, force: true });
    const problems = checkRunnerImageLayout(out);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain(name === "manifest" ? "runner-image.json is missing" : (relative as string));
  });

  it.each([
    ["is not JSON", (file: string) => writeFileSync(file, "{")],
    ["is not an object", (file: string) => writeFileSync(file, "[]")],
  ])("fails when runner-image.json %s", (_label, corrupt) => {
    corrupt(path.join(out, "runner-image.json"));
    expect(checkRunnerImageLayout(out)).toHaveLength(1);
  });

  it.each<[string, (manifest: Record<string, any>) => void, RegExp]>([
    ["another schema", (m) => { m.schema = "paperclip.runner-image.v0"; }, /schema/],
    ["no inputs digest", (m) => { delete m.inputsDigest; }, /inputsDigest must be/],
    ["a short inputs digest", (m) => { m.inputsDigest.digest = "abc"; }, /inputsDigest must be/],
    ["another build-inputs schema", (m) => { m.buildInputsDigest.schema = "paperclip.runner-build-inputs.v1"; }, /buildInputsDigest must be/],
    ["an abbreviated source revision", (m) => { m.sourceRevision = "abc1234"; }, /sourceRevision/],
    ["an unsupported platform", (m) => { m.platform = { os: "linux", architecture: "riscv64" }; }, /platform must be/],
    ["no libc baseline", (m) => { delete m.libc.baseline; }, /libc must record/],
    ["a daemon newer than its baseline", (m) => { m.libc.runnerdRequires = "2.38"; }, /requires glibc 2\.38/],
    ["an undocumented path", (m) => { m.paths.extra = "extra"; }, /paths does not match/],
    ["a moved path", (m) => { m.paths.runnerd = "bin/paperclip-runnerd"; }, /paths does not match/],
    ["no digests", (m) => { delete m.sha256; }, /sha256 must map/],
  ])("fails when runner-image.json has %s", (_label, change, expected) => {
    rewriteManifest(out, change);
    expect(checkRunnerImageLayout(out).join("\n")).toMatch(expected);
  });

  it("fails when a file differs from the digest runner-image.json records", () => {
    appendFileSync(path.join(out, "runner-package/scripts/provision-grok.mjs"), "// changed\n");
    expect(checkRunnerImageLayout(out).join("\n")).toMatch(/provision-grok\.mjs \(grokProvisioner\) does not match the digest/);
  });

  it("fails when the image is for other inputs, another commit or another architecture than expected", () => {
    const problems = checkRunnerImageLayout(out, {
      expectInputsDigest: "f".repeat(64), expectSourceRevision: "b".repeat(40), expectArchitecture: "arm64",
    }).join("\n");
    expect(problems).toMatch(/inputs digest is 1{64}, expected f{64}/);
    expect(problems).toMatch(/source revision is a{40}, expected b{40}/);
    expect(problems).toMatch(/architecture is amd64, expected arm64/);
  });

  it("fails when the daemon is built for another architecture", () => {
    const arm = image({ source: { machine: 183 } });
    expect(checkRunnerImageLayout(arm).join("\n")).toMatch(/paperclip-runnerd is not a linux\/amd64 executable/);
  });

  it("fails when the daemon is not executable or a file is not readable by every user", () => {
    chmodSync(path.join(out, "paperclip-runnerd"), 0o644);
    chmodSync(path.join(out, "provider-pack/provider-pack.json"), 0o600);
    const problems = checkRunnerImageLayout(out).join("\n");
    expect(problems).toMatch(/paperclip-runnerd is not executable by every user/);
    expect(problems).toMatch(/not readable by every user: provider-pack\/provider-pack\.json/);
  });

  describe("Runner build stamp", () => {
    it("fails when a build output changed size after the stamp was recorded", () => {
      appendFileSync(path.join(out, "runner-package/dist/index.js"), "// later edit\n");
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/build output dist\/index\.js is changed size/);
    });

    it("fails when a recorded build output is gone", () => {
      rmSync(path.join(out, "runner-package/dist/testing.js"));
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/dist\/testing\.js is missing/);
    });

    it("fails when the stamp was recorded on another architecture", () => {
      const other = image({ source: { arch: "arm64" } });
      expect(checkRunnerImageLayout(other).join("\n")).toMatch(/stamp was recorded on linux\/arm64, not linux\/x64/);
    });

    it("refuses to describe a build whose stamp names other inputs, and never writes a stamp itself", () => {
      const root = path.join(scratch, String(sequence += 1));
      workspace(path.join(root, "workspace"), { digest: "9".repeat(64) });
      const write = () => writeRunnerImageManifest({
        outRoot: path.join(root, "out"), workspaceRoot: path.join(root, "workspace"), identity, platform, libc, sourceRevision: null,
      });
      expect(write).toThrow(/built from inputs 9{64}, but the image identity was computed from 2{64}/);
      rmSync(buildInputsStampPath(path.join(root, "workspace/packages/paperclip-runner")));
      expect(write).toThrow(/recorded no build stamp/);
    });
  });

  describe("provider pack integrity", () => {
    it("fails when an artifact differs from its digest in provider-pack.json", () => {
      appendFileSync(path.join(out, "provider-pack/dist/cli/opencode-app-server-proxy.cjs"), "// changed\n");
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/artifact opencodeProxy does not match its digest/);
    });

    it("fails when an artifact is missing", () => {
      rmSync(path.join(out, "provider-pack/dist/cli/opencode-app-server-proxy.cjs"));
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/artifact opencodeProxy is missing/);
    });

    it("fails when provider assets the manifest names are missing", () => {
      rmSync(path.join(out, "provider-pack/provider-assets"), { recursive: true });
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/the provider pack asset tree of pi is missing/);
    });

    it("recomputes the tree digests the manifest records", () => {
      // A file that is not a listed artifact is bound only by its tree digest.
      appendFileSync(path.join(out, "provider-pack/provider-assets/pi/linux-x64/pi.js"), "// changed\n");
      expect(checkRunnerImageLayout(out)).toEqual(["the provider pack asset tree of pi does not match its tree digest"]);
      const other = image();
      write(path.join(other, "provider-pack"), "dist/extra.js", "// not built\n");
      expect(checkRunnerImageLayout(other)).toEqual(["the provider pack dist tree does not match its tree digest"]);
      const third = image();
      rmSync(path.join(third, "provider-pack/dist/index.js"));
      expect(checkRunnerImageLayout(third).join("\n")).toMatch(/the provider pack dist tree does not match its tree digest/);
    });

    it("fails when the manifest was edited after it was sealed", () => {
      const file = path.join(out, "provider-pack/provider-pack.json");
      const pack = JSON.parse(readFileSync(file, "utf8"));
      pack.payload.runnerSourceRevision = "c".repeat(40);
      writeFileSync(file, JSON.stringify(pack));
      rewriteManifest(out, (m) => { m.sha256.providerPackManifest = `sha256:${sha256(readFileSync(file))}`; });
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/provider-pack\.json digest does not match its payload/);
    });

    it.each<[string, object, RegExp]>([
      ["another commit", { revision: "c".repeat(40) }, /provider pack was built from c{40}, but the image source revision is a{40}/],
      ["other inputs", { inputsDigest: "d".repeat(64) }, /runnerInputsDigest does not match/],
      ["another architecture", { arch: "arm64" }, /provider pack targets/],
      ["another lockfile", { lock: "lockfileVersion: '6.0'\n" }, /lockfile at the image root is not the one the provider pack was installed from/],
    ])("fails when the pack was built for %s", (_label, pack, expected) => {
      expect(checkRunnerImageLayout(image({ pack })).join("\n")).toMatch(expected);
    });

    it("fails when a transport archive or an archived file differs from the receipt", () => {
      appendFileSync(path.join(out, "provider-pack.archives/0.tar.zst"), "x");
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/transport archive 0\.tar\.zst does not match its receipt/);
      const other = image();
      const receipt = path.join(other, "provider-pack.archive.json");
      const parsed = JSON.parse(readFileSync(receipt, "utf8"));
      parsed.providerPackDigest = `sha256:${"e".repeat(64)}`;
      parsed.files[0].sha256 = "e".repeat(64);
      writeFileSync(receipt, JSON.stringify(parsed));
      rewriteManifest(other, (m) => { m.sha256.providerPackArchiveReceipt = `sha256:${sha256(readFileSync(receipt))}`; });
      const problems = checkRunnerImageLayout(other).join("\n");
      expect(problems).toMatch(/transport archives belong to another provider pack/);
      expect(problems).toMatch(/archived file node_modules\/node\/bin\/node does not match the provider pack/);
    });
  });

  describe("paths that resolve outside the tree", () => {
    // A link to a file with the right bytes somewhere else on the machine
    // must not vouch for a file the image does not contain.
    const outside = () => {
      const directory = path.join(scratch, String(sequence += 1));
      mkdirSync(directory, { recursive: true });
      return directory;
    };

    it("refuses a pack artifact that is a link out of the pack", () => {
      const artifact = path.join(out, "provider-pack/dist/cli/opencode-app-server-proxy.cjs");
      const elsewhere = path.join(outside(), "proxy.cjs");
      renameSync(artifact, elsewhere);
      symlinkSync(elsewhere, artifact);
      expect(readFileSync(artifact, "utf8")).toBe("opencodeProxy\n");
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/artifact opencodeProxy resolves outside the pack/);
    });

    it("refuses an artifact path that climbs out of the pack", () => {
      const file = path.join(out, "provider-pack/provider-pack.json");
      const pack = JSON.parse(readFileSync(file, "utf8"));
      pack.payload.artifacts.nodeCommand.path = "../paperclip-runnerd";
      pack.digest = `sha256:${sha256(canonicalJson(pack.payload))}`;
      writeFileSync(file, JSON.stringify(pack));
      expect(checkRunnerImageLayout(out).join("\n")).toMatch(/artifact nodeCommand resolves outside the pack/);
    });

    it("refuses an archived file and a transport archive that are links out of the tree", () => {
      const archived = path.join(out, "provider-pack/node_modules/node/bin/node");
      const elsewhere = outside();
      renameSync(archived, path.join(elsewhere, "node"));
      symlinkSync(path.join(elsewhere, "node"), archived);
      const archive = path.join(out, "provider-pack.archives/overlay.tar.zst");
      renameSync(archive, path.join(elsewhere, "overlay.tar.zst"));
      symlinkSync(path.join(elsewhere, "overlay.tar.zst"), archive);
      const problems = checkRunnerImageLayout(out).join("\n");
      expect(problems).toMatch(/archived file node_modules\/node\/bin\/node resolves outside the pack/);
      expect(problems).toMatch(/transport archive overlay\.tar\.zst resolves outside the image/);
    });

    it("refuses a documented path reached through a linked directory", () => {
      const source = path.join(out, "runner-package/src");
      const elsewhere = path.join(outside(), "src");
      cpSync(source, elsewhere, { recursive: true });
      rmSync(source, { recursive: true });
      symlinkSync(elsewhere, source);
      const problems = checkRunnerImageLayout(out).join("\n");
      expect(problems).toMatch(/documented path runner-package\/src\/providers\/grok\/platforms\.json \(grokPlatforms\) resolves outside the image/);
    });

    it("accepts a link that stays inside the pack, as pnpm's layout has them", () => {
      const pack = path.join(out, "provider-pack");
      const real = path.join(pack, "node_modules/.pnpm/node@24/node_modules/node");
      mkdirSync(path.dirname(real), { recursive: true });
      renameSync(path.join(pack, "node_modules/node"), real);
      symlinkSync(path.relative(path.join(pack, "node_modules"), real), path.join(pack, "node_modules/node"));
      expect(checkRunnerImageLayout(out)).toEqual([]);
    });
  });

  describe("command line", () => {
    const check = (...args: string[]) => spawnSync(process.execPath, [layoutScript, "check", ...args], { encoding: "utf8" });

    it("passes for a valid tree and fails for a wrong expectation", () => {
      expect(check(out, "--expect-inputs-digest", INPUTS, "--expect-source-revision", REVISION, "--expect-architecture", "amd64").status).toBe(0);
      const wrong = check(out, "--expect-architecture", "arm64");
      expect(wrong.status).toBe(1);
      expect(wrong.stderr).toMatch(/architecture is amd64, expected arm64/);
    });

    it.each<[string, string[], RegExp]>([
      ["an empty inputs digest", ["--expect-inputs-digest", ""], /--expect-inputs-digest needs a value/],
      ["an empty source revision", ["--expect-source-revision", ""], /--expect-source-revision needs a value/],
      ["an empty architecture", ["--expect-architecture", ""], /--expect-architecture needs a value/],
      ["a flag with no value", ["--expect-inputs-digest"], /--expect-inputs-digest needs a value/],
      ["a flag whose value is another flag", ["--expect-inputs-digest", "--allow-unstamped"], /--expect-inputs-digest needs a value/],
      ["a misspelt flag", ["--expect-input-digest", INPUTS], /check does not take --expect-input-digest/],
      ["a flag of the other command", ["--identity", "x"], /check does not take --identity/],
      ["a repeated flag", ["--expect-architecture", "amd64", "--expect-architecture", "amd64"], /given twice/],
      ["a malformed inputs digest", ["--expect-inputs-digest", "abc"], /must be 64 hexadecimal characters/],
      ["an abbreviated source revision", ["--expect-source-revision", "abc1234"], /must be a full Git SHA/],
      ["an unknown architecture", ["--expect-architecture", "x64"], /must be amd64 or arm64/],
    ])("rejects %s instead of treating the expectation as not given", (_label, args, expected) => {
      const result = check(out, ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(expected);
      expect(result.stdout).not.toMatch(/passed/);
    });

    it("needs exactly one directory, and a known command", () => {
      expect(check().status).toBe(1);
      expect(check(out, out).status).toBe(1);
      expect(spawnSync(process.execPath, [layoutScript, "verify", out], { encoding: "utf8" }).status).toBe(1);
    });

    it("parses the flags each command knows", () => {
      expect(parseLayoutArguments("check", ["tree", "--allow-unstamped", "--expect-architecture", "arm64"])).toEqual({
        positional: ["tree"], flags: { "allow-unstamped": true, "expect-architecture": "arm64" },
      });
      expect(() => parseLayoutArguments("write", ["--out", "o", "--source-revision", ""])).toThrow(/--source-revision needs a value/);
      expect(() => parseLayoutArguments("write", ["--expect-architecture", "arm64"])).toThrow(/write does not take/);
    });
  });

  describe("a build without a source revision", () => {
    it("has the daemon and the Runner build but no pack, and is not a publishable image", () => {
      const unstamped = image({ stamped: false });
      const manifest = manifestOf(unstamped);
      expect(manifest.sourceRevision).toBeNull();
      expect(manifest.providerPack).toBeNull();
      expect(manifest.inputsDigest.digest).toBe(INPUTS);
      expect(checkRunnerImageLayout(unstamped).join("\n")).toMatch(/has no source revision/);
      expect(checkRunnerImageLayout(unstamped, { allowUnstamped: true })).toEqual([]);
      // It is still checked: the daemon and the stamp must hold.
      appendFileSync(path.join(unstamped, "runner-package/dist/index.js"), "// later edit\n");
      expect(checkRunnerImageLayout(unstamped, { allowUnstamped: true }).join("\n")).toMatch(/changed size/);
    });
  });

  it("writes nothing at the image root that the documented layout does not list", () => {
    const documented = new Set(Object.values(RUNNER_IMAGE_PATHS).map((relative) => (relative as string).split("/")[0]));
    expect(new Set(readdirSync(out))).toEqual(documented);
    expect([...documented].sort()).toEqual(["bundles", "paperclip-runnerd", "pnpm-lock.yaml", "provider-pack",
      "provider-pack.archive.json", "provider-pack.archives", "runner-image.json", "runner-package"]);
  });
});
