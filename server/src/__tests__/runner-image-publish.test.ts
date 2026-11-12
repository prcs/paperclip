import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  RUNNER_IMAGE_BUILD_INPUT_ROOTS,
  RUNNER_IMAGE_RECIPE_INPUTS,
} from "../../../scripts/runner-image-identity.mjs";
import {
  createLegRecord,
  parsePublishArguments,
  readRunnerImageManifest,
  runPublishCommand,
  runnerLockState,
  verifyLegRecords,
  verifyPublishedIndex,
} from "../../../scripts/runner-image-publish.mjs";

/**
 * Publication of the Runner image. The `inputs-<digest>` tag is create-only
 * and consumers verify its attestation, so three things must hold: only a
 * master push in the canonical repository can publish, the bytes it publishes
 * are the ones the build legs checked, and a tag is never written on a guess.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "runner-image.yml"), "utf8");
const mergeReview = readFileSync(path.join(repoRoot, ".github", "workflows", "pr-merge-review.yml"), "utf8");
const smoke = readFileSync(path.join(repoRoot, "docker", "runner-image", "Dockerfile.smoke"), "utf8");

const INPUTS = "1".repeat(64);
const REVISION = "a".repeat(40);
const sha256 = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const scratch = mkdtempSync(path.join(tmpdir(), "runner-image-publish-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;

/** What one build leg uploads: the image archive and the record of what it verified. */
async function leg(directory: string, architecture: string, { inputsDigest = INPUTS, sourceRevision = REVISION } = {}) {
  const root = path.join(directory, architecture);
  mkdirSync(path.join(root, "tree"), { recursive: true });
  writeFileSync(path.join(root, "image.oci.tar"), `image for ${architecture}`);
  writeFileSync(path.join(root, "metadata.json"), JSON.stringify({ "containerimage.digest": sha256(`manifest ${architecture}`) }));
  writeFileSync(path.join(root, "tree", "runner-image.json"), JSON.stringify({
    inputsDigest: { digest: inputsDigest }, sourceRevision, platform: { os: "linux", architecture },
  }));
  const record = await createLegRecord({
    architecture, archive: path.join(root, "image.oci.tar"), metadataFile: path.join(root, "metadata.json"), tree: path.join(root, "tree"),
  });
  writeFileSync(path.join(root, "record.json"), JSON.stringify(record));
  return record;
}

async function legs(options: Record<string, object> = {}) {
  const directory = path.join(scratch, String(sequence += 1));
  for (const architecture of ["amd64", "arm64"]) await leg(directory, architecture, options[architecture]);
  return directory;
}

describe("verified build legs", () => {
  it("accepts one verified image per architecture for this run's inputs and commit", async () => {
    const directory = await legs();
    await expect(verifyLegRecords({ directory, inputsDigest: INPUTS, sourceRevision: REVISION })).resolves.toEqual({
      amd64: sha256("manifest amd64"), arm64: sha256("manifest arm64"),
    });
  });

  it("refuses a leg that built other inputs or another commit", async () => {
    const otherInputs = await legs({ arm64: { inputsDigest: "2".repeat(64) } });
    await expect(verifyLegRecords({ directory: otherInputs, inputsDigest: INPUTS, sourceRevision: REVISION }))
      .rejects.toThrow(/arm64: the image was built from other inputs/);
    const otherCommit = await legs({ amd64: { sourceRevision: "b".repeat(40) } });
    await expect(verifyLegRecords({ directory: otherCommit, inputsDigest: INPUTS, sourceRevision: REVISION }))
      .rejects.toThrow(/amd64: the image was built at another commit/);
  });

  it("refuses an archive that changed after its leg recorded it, and a missing leg", async () => {
    const directory = await legs();
    appendFileSync(path.join(directory, "amd64", "image.oci.tar"), "tampered");
    await expect(verifyLegRecords({ directory, inputsDigest: INPUTS, sourceRevision: REVISION }))
      .rejects.toThrow(/amd64: the image archive does not match its record/);
    const missing = await legs();
    rmSync(path.join(missing, "arm64"), { recursive: true });
    await expect(verifyLegRecords({ directory: missing, inputsDigest: INPUTS, sourceRevision: REVISION })).rejects.toThrow();
  });

  it("does not record a tree that is for another architecture", async () => {
    const directory = path.join(scratch, String(sequence += 1));
    await leg(directory, "amd64");
    await expect(createLegRecord({
      architecture: "arm64", archive: path.join(directory, "amd64", "image.oci.tar"),
      metadataFile: path.join(directory, "amd64", "metadata.json"), tree: path.join(directory, "amd64", "tree"),
    })).rejects.toThrow(/another architecture/);
  });
});

describe("registry lookups", () => {
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] }));
  const respond = (status: number, body: Buffer | string = "", headers: Record<string, string> = {}) =>
    new Response(typeof body === "string" ? body : new Uint8Array(body), { status, headers });
  function registry(manifest: () => Response, token: () => Response = () => respond(200, JSON.stringify({ token: "t" }))) {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      requests.push({ url, headers: init.headers });
      return url.includes("/token?") ? token() : manifest();
    };
    return { requests, options: { fetchImpl, sleep: async () => {} } };
  }

  it("reports a tag that exists, with the digest of the registry bytes", async () => {
    const { requests, options } = registry(() => respond(200, index, { "docker-content-digest": sha256(index) }));
    const result = await readRunnerImageManifest(`inputs-${INPUTS}`, options);
    expect(result).toMatchObject({ state: "present", digest: sha256(index) });
    expect(requests.map((request) => request.url)).toEqual([
      "https://ghcr.io/token?service=ghcr.io&scope=repository:paperclipai/paperclip-runner:pull",
      `https://ghcr.io/v2/paperclipai/paperclip-runner/manifests/inputs-${INPUTS}`,
    ]);
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(requests[1].headers.authorization).toBe("Bearer t");
  });

  it("reports a missing tag only when the registry says it is missing", async () => {
    await expect(readRunnerImageManifest("inputs-x", registry(() => respond(404)).options)).resolves.toEqual({ state: "absent" });
  });

  it.each<[string, () => Response, (() => Response) | undefined]>([
    ["the token request is refused", () => respond(200, index), () => respond(403)],
    ["the token response has no token", () => respond(200, index), () => respond(200, "{}")],
    ["the manifest request is unauthorized", () => respond(401), undefined],
    ["the manifest request is denied", () => respond(403), undefined],
    ["the registry keeps failing", () => respond(503), undefined],
  ])("does not guess when %s", async (_label, manifest, token) => {
    const result = await readRunnerImageManifest("inputs-x", registry(manifest, token).options);
    expect(result.state).toBe("unknown");
  });

  it("retries a transient registry error", async () => {
    let calls = 0;
    const { options } = registry(() => ((calls += 1) < 3 ? respond(502) : respond(404)));
    await expect(readRunnerImageManifest("inputs-x", options)).resolves.toEqual({ state: "absent" });
    expect(calls).toBe(3);
  });

  it.each<[string, () => Promise<Response>]>([
    ["the registry cannot be reached", async () => { throw new TypeError("fetch failed"); }],
    ["the token response is not JSON", async () => respond(200, "<html>gateway</html>")],
  ])("does not guess, and does not crash, when %s", async (_label, token) => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return token(); };
    const result = await readRunnerImageManifest("inputs-x", { fetchImpl, sleep: async () => {} });
    expect(result.state).toBe("unknown");
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("does not guess when the manifest request cannot be completed", async () => {
    let manifests = 0;
    const fetchImpl = async (url: string) => {
      if (url.includes("/token?")) return respond(200, JSON.stringify({ token: "t" }));
      manifests += 1;
      throw new TypeError("fetch failed");
    };
    await expect(readRunnerImageManifest("inputs-x", { fetchImpl, sleep: async () => {} })).resolves.toMatchObject({ state: "unknown" });
    expect(manifests).toBe(5);
  });

  it("authenticates with the credentials it is given and rejects bytes that do not match their digest", async () => {
    const { requests, options } = registry(() => respond(200, index, { "docker-content-digest": sha256("other") }));
    await expect(readRunnerImageManifest("inputs-x", { ...options, credentials: { username: "u", password: "p" } }))
      .rejects.toThrow(/does not match the manifest bytes/);
    expect(requests[0].headers.authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });
});

describe("published index", () => {
  const legDigests = { amd64: sha256("manifest amd64"), arm64: sha256("manifest arm64") };
  const entry = (architecture: string, digest: string) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json", digest, size: 500, platform: { os: "linux", architecture },
  });
  const bytes = (manifests: object[]) => Buffer.from(JSON.stringify({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests,
  }));

  it("accepts an index of exactly the two verified images and returns its digest", () => {
    const index = bytes([entry("amd64", legDigests.amd64), entry("arm64", legDigests.arm64)]);
    expect(verifyPublishedIndex(index, legDigests)).toBe(sha256(index));
  });

  const both = [entry("amd64", legDigests.amd64), entry("arm64", legDigests.arm64)];
  const extra = (platform: object | undefined) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json", digest: sha256("extra"), size: 500, ...(platform ? { platform } : {}),
  });

  it.each<[string, object[]]>([
    ["an image no leg verified", [entry("amd64", legDigests.amd64), entry("arm64", sha256("unverified"))]],
    ["the images under the wrong architectures", [entry("amd64", legDigests.arm64), entry("arm64", legDigests.amd64)]],
    ["one architecture only", [entry("amd64", legDigests.amd64)]],
    ["one architecture twice", [entry("amd64", legDigests.amd64), entry("amd64", legDigests.amd64), entry("arm64", legDigests.arm64)]],
    ["an attestation manifest beside the images", [...both, extra({ os: "unknown", architecture: "unknown" })]],
    ["an entry without a platform", [...both, extra(undefined)]],
    ["an image for another operating system", [...both, extra({ os: "windows", architecture: "amd64" })]],
    ["an image for another architecture", [...both, extra({ os: "linux", architecture: "riscv64" })]],
    ["a platform variant in place of an image", [entry("amd64", legDigests.amd64),
      { ...entry("arm64", legDigests.arm64), platform: { os: "linux", architecture: "arm64", variant: "v8" } }]],
  ])("refuses an index with %s", (_label, manifests) => {
    expect(() => verifyPublishedIndex(bytes(manifests), legDigests)).toThrow();
  });

  it("needs a recorded image for each architecture, and no other", () => {
    expect(() => verifyPublishedIndex(bytes(both), { amd64: legDigests.amd64 })).toThrow(/one recorded image for each architecture/);
    expect(() => verifyPublishedIndex(bytes(both), { ...legDigests, riscv64: sha256("extra") })).toThrow(/one recorded image for each architecture/);
  });
});

describe("lockfile state", () => {
  function context() {
    const directory = path.join(scratch, String(sequence += 1));
    mkdirSync(path.join(directory, "packages", "paperclip-runner"), { recursive: true });
    writeFileSync(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(path.join(directory, "packages", "paperclip-runner", "package.json"), "{}\n");
    return directory;
  }
  const answer = (status: number | null, stderr = "", extra: object = {}) => {
    const calls: { command: string; args: string[]; options: { cwd?: string } }[] = [];
    const run = (command: string, args: string[], options: object) => {
      calls.push({ command, args, options });
      return { status, stdout: "", stderr, ...extra };
    };
    return { calls, run };
  };

  it("asks pnpm the image build's own question, offline and without installing", () => {
    const directory = context();
    const { calls, run } = answer(0);
    expect(runnerLockState(directory, { run }).state).toBe("current");
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("pnpm");
    expect(calls[0].options.cwd).toBe(directory);
    expect(calls[0].args).toEqual(["install", "--frozen-lockfile", "--lockfile-only", "--offline", "--ignore-scripts",
      "--filter", "@paperclipai/paperclip-runner..."]);
  });

  it.each([
    [" ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date with <ROOT>/packages/paperclip-runner/package.json"],
    [" ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation. The current \"patchedDependencies\" configuration doesn't match the value found in the lockfile"],
  ])("reports a lockfile the manifests have moved past as behind: %s", (stderr) => {
    const result = runnerLockState(context(), { run: answer(1, stderr).run });
    expect(result.state).toBe("behind");
    expect(result.detail).toContain("ERR_PNPM_");
  });

  it.each<[string, number | null, string, object]>([
    ["a broken lockfile", 1, " ERR_PNPM_BROKEN_LOCKFILE  The lockfile is broken", {}],
    ["a failure pnpm does not name", 1, "Killed", {}],
    ["a pnpm that was killed", null, "", {}],
    ["a pnpm that cannot be started", null, "", { error: new Error("spawn pnpm ENOENT") }],
  ])("fails for %s instead of calling it behind", (_label, status, stderr, extra) => {
    expect(() => runnerLockState(context(), { run: answer(status, stderr, extra).run })).toThrow();
  });

  it("fails for a directory that is not a Runner build context", () => {
    const directory = context();
    rmSync(path.join(directory, "pnpm-lock.yaml"));
    expect(() => runnerLockState(directory, { run: answer(0).run })).toThrow(/no pnpm-lock\.yaml/);
  });
});

describe("command line", () => {
  const unknown = async () => ({ state: "unknown" as const, detail: "token request: HTTP 403" });
  const absent = async () => ({ state: "absent" as const });
  const quiet = { env: {}, log: () => {} };

  it("builds on an inconclusive lookup and fails on one when it is strict", async () => {
    const lines: string[] = [];
    await expect(runPublishCommand(["tag-state", `inputs-${INPUTS}`], { env: {}, read: unknown, log: (line) => lines.push(line) }))
      .resolves.toEqual({ state: "unknown", exists: false });
    expect(lines.join("\n")).toMatch(/::notice title=Runner image lookup inconclusive::/);
    await expect(runPublishCommand(["tag-state", `inputs-${INPUTS}`, "--strict"], { ...quiet, read: unknown }))
      .rejects.toThrow(/Could not determine whether .*paperclip-runner:inputs-1{64} exists \(token request: HTTP 403\)/);
    await expect(runPublishCommand(["tag-state", `inputs-${INPUTS}`, "--strict"], { ...quiet, read: absent }))
      .resolves.toEqual({ state: "absent", exists: false });
  });

  it("stays inconclusive, not failed, when the registry cannot be reached", async () => {
    const offline = (reference: string) => readRunnerImageManifest(reference, {
      fetchImpl: async () => { throw new TypeError("fetch failed"); }, sleep: async () => {},
    });
    await expect(runPublishCommand(["tag-state", `inputs-${INPUTS}`], { ...quiet, read: offline }))
      .resolves.toEqual({ state: "unknown", exists: false });
    await expect(runPublishCommand(["tag-state", `inputs-${INPUTS}`, "--strict"], { ...quiet, read: offline })).rejects.toThrow(/Could not determine/);
  });

  it("passes the registry credentials from the environment, and none when one is missing", async () => {
    const seen: unknown[] = [];
    const read = async (_reference: string, options?: { credentials?: unknown }) => { seen.push(options?.credentials); return { state: "absent" as const }; };
    await runPublishCommand(["tag-state", "inputs-x"], { env: { RUNNER_IMAGE_REGISTRY_USERNAME: "u", RUNNER_IMAGE_REGISTRY_PASSWORD: "p" }, read, log: () => {} });
    await runPublishCommand(["tag-state", "inputs-x"], { env: { RUNNER_IMAGE_REGISTRY_USERNAME: "u" }, read, log: () => {} });
    expect(seen).toEqual([{ username: "u", password: "p" }, null]);
  });

  it("verifies the index against the recorded legs and against the expected digest", async () => {
    const directory = await legs();
    const index = Buffer.from(JSON.stringify({
      schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: ["amd64", "arm64"].map((architecture) => ({
        mediaType: "application/vnd.oci.image.manifest.v1+json", digest: sha256(`manifest ${architecture}`), size: 500,
        platform: { os: "linux", architecture },
      })),
    }));
    const read = async () => ({ state: "present" as const, bytes: index, digest: sha256(index) });
    await expect(runPublishCommand(["verify-index", "candidate-x", "--dir", directory], { ...quiet, read })).resolves.toEqual({ digest: sha256(index) });
    await expect(runPublishCommand(["verify-index", "inputs-x", "--dir", directory, "--expect", sha256(index)], { ...quiet, read }))
      .resolves.toEqual({ digest: sha256(index) });
    await expect(runPublishCommand(["verify-index", "inputs-x", "--dir", directory, "--expect", sha256("another index")], { ...quiet, read }))
      .rejects.toThrow(/inputs-x resolves to sha256:[0-9a-f]{64}, expected sha256:[0-9a-f]{64}/);
    await expect(runPublishCommand(["verify-index", "inputs-x", "--dir", directory, "--expect", "latest"], { ...quiet, read }))
      .rejects.toThrow(/--expect must be a sha256 digest/);
    await expect(runPublishCommand(["verify-index", "inputs-x", "--dir", directory], { ...quiet, read: absent })).rejects.toThrow(/is absent/);
  });

  it("reports the lockfile state and fails when the check itself fails", async () => {
    await expect(runPublishCommand(["lock-state", "--context", "/context"], { ...quiet, lockState: () => ({ state: "behind", detail: "ERR_PNPM_OUTDATED_LOCKFILE" }) }))
      .resolves.toEqual({ state: "behind" });
    await expect(runPublishCommand(["lock-state", "--context", "/context"], { ...quiet, lockState: () => { throw new Error("broken"); } }))
      .rejects.toThrow("broken");
  });

  it.each<[string, string[], RegExp]>([
    ["an empty --expect", ["verify-index", "inputs-x", "--dir", "d", "--expect", ""], /--expect needs a value/],
    ["an --expect with no value", ["verify-index", "inputs-x", "--dir", "d", "--expect"], /--expect needs a value/],
    ["a misspelt flag", ["tag-state", "inputs-x", "--strikt"], /tag-state does not take --strikt/],
    ["a flag of another command", ["tag-state", "inputs-x", "--expect", "sha256:x"], /tag-state does not take --expect/],
    ["a repeated flag", ["verify-index", "inputs-x", "--dir", "a", "--dir", "b"], /--dir is given twice/],
    ["a missing required flag", ["verify-legs", "--dir", "d", "--inputs-digest", INPUTS], /verify-legs needs --source-revision/],
    ["an empty required value", ["verify-legs", "--dir", "d", "--inputs-digest", "", "--source-revision", REVISION], /--inputs-digest needs a value/],
    ["a missing tag", ["tag-state", "--strict"], /takes exactly one tag or digest/],
    ["an empty tag", ["tag-state", ""], /not a tag or digest/],
    ["two tags", ["tag-state", "a", "b"], /takes exactly one tag or digest/],
    ["an unknown command", ["publish"], /Usage/],
    ["no command", [], /Usage/],
  ])("rejects %s", (_label, argv, expected) => {
    expect(() => parsePublishArguments(argv[0], argv.slice(1))).toThrow(expected);
  });
});

describe("Runner image workflow", () => {
  const repository = "github.repository == 'paperclipai/paperclip' && github.repository_id == '1170821064'";
  const canonical = `${repository} && github.event_name == 'push' && github.ref == 'refs/heads/master'`;
  const registryToken = "RUNNER_IMAGE_REGISTRY_PASSWORD: ${{ github.token }}";
  /** One job's text, from its two-space-indented key to the next job. */
  function job(name: string): string {
    const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
    const start = jobs.indexOf(`\n  ${name}:\n`);
    expect(start, `workflow must have a ${name} job`).toBeGreaterThanOrEqual(0);
    const rest = jobs.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z_-]+:\n/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  }
  /** The steps of a job, in order, by name. */
  function steps(name: string): { name: string; text: string }[] {
    const text = job(name);
    const list = text.slice(text.indexOf("\n    steps:\n"));
    return list.split(/\n(?= {6}- name: )/).slice(1).map((chunk) => {
      // The comment that introduces the next step trails this one.
      const lines = chunk.split("\n");
      while (lines.length > 1 && /^\s*(?:#.*)?$/.test(lines[lines.length - 1])) lines.pop();
      const text = `${lines.join("\n")}\n`;
      return { name: /- name: (.+)/.exec(text)![1], text };
    });
  }
  const step = (jobName: string, stepName: string) => {
    const found = steps(jobName).find((entry) => entry.name === stepName);
    expect(found, `${jobName} must have the step ${stepName}`).toBeDefined();
    return found!.text;
  };
  const condition = (text: string) => /^ {8}if: (.+)$/m.exec(text)?.[1] ?? null;
  const jobCondition = (name: string) => /^ {4}if: (.+)$/m.exec(job(name))?.[1] ?? null;
  const permissions = (text: string) =>
    [.../\n {4}permissions:\n((?: {6}.+\n)+)/.exec(text)![1].matchAll(/^ {6}([a-z-]+): (\w+)/gm)].map((match) => `${match[1]}: ${match[2]}`);

  it("grants nothing at the workflow level and pins every action by commit", () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    const uses = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(10);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    expect(workflow).not.toMatch(/pull_request_target|workflow_run/);
  });

  it("lets only the publish job, on a canonical master push, write to the registry or sign", () => {
    expect([...workflow.matchAll(/^ {2}([a-z_-]+):\n {4}(?:name|needs|runs-on|if):/gm)].map((match) => match[1]))
      .toEqual(["identity", "build", "publish"]);
    expect(permissions(job("identity"))).toEqual(["contents: read", "packages: read"]);
    expect(permissions(job("build"))).toEqual(["contents: read", "packages: read"]);
    expect(permissions(job("publish"))).toEqual(["contents: read", "packages: write", "id-token: write", "attestations: write"]);
    expect(jobCondition("publish")).toBe(`${canonical} && needs.identity.outputs.lock == 'current' && needs.identity.outputs.exists != 'true'`);
    for (const name of ["identity", "build"]) {
      expect(job(name)).not.toMatch(/docker\/login-action|skopeo|imagetools create|actions\/attest|secrets\./);
    }
    // Only a canonical master push keeps an image for the publish job.
    expect(job("build")).toContain(`KEEP_IMAGE: \${{ ${canonical} }}`);
    expect(condition(step("build", "Record the verified image"))).toBe("env.KEEP_IMAGE == 'true' && steps.published.outputs.exists != 'true'");
    expect(condition(step("build", "Upload the verified image"))).toBe("env.KEEP_IMAGE == 'true' && steps.published.outputs.exists != 'true'");
  });

  it("does not run for a fork's own pushes", () => {
    expect(jobCondition("identity")).toBe(`github.event_name != 'push' || (${repository})`);
    expect(jobCondition("build")).toBe(
      `needs.identity.outputs.lock == 'current' && (github.event_name != 'push' || (${repository} && needs.identity.outputs.exists != 'true'))`,
    );
  });

  it("gives the registry token only to the steps that ask the registry, never to a whole job", () => {
    const holders: Record<string, string[]> = {
      identity: ["Look for the published image"],
      build: ["Look again for the published image"],
      publish: ["Look for an image another run published", "Look again immediately before pushing", "Confirm the tag does not exist",
        "Verify the candidate names exactly the verified images", "Publish the tag"],
    };
    for (const [name, expected] of Object.entries(holders)) {
      const text = job(name);
      // Job-level env is the block before the steps.
      expect(text.slice(0, text.indexOf("\n    steps:\n")), name).not.toMatch(/github\.token|secrets\.|REGISTRY_PASSWORD/);
      expect(steps(name).filter((entry) => entry.text.includes(registryToken)).map((entry) => entry.name), name).toEqual(expected);
      expect(text.match(/github\.token/g), name).toHaveLength(expected.length);
    }
    // The build leg's token can only read, and the steps that run the build never see it.
    for (const name of ["Build the Runner image", "Check the layout contract and pack integrity", "Run the daemon on every consumer base image"]) {
      expect(step("build", name)).not.toMatch(/github\.token|REGISTRY/);
    }
  });

  it("uses no registry build cache, so a pull request has none to write and a publication reads none", () => {
    expect(workflow).not.toMatch(/cache-to|cache-from|type=registry|type=gha/);
  });

  describe("lockfile", () => {
    const resolve = "pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile";

    it("is never resolved on a master push: the identity and both legs use the committed file", () => {
      const resolving = steps("identity").filter((entry) => entry.text.includes(resolve));
      expect(resolving.map((entry) => entry.name)).toEqual(["Resolve the lockfile for a pull request or manual build"]);
      expect(condition(resolving[0].text)).toBe("github.event_name != 'push'");
      // Nothing else in the workflow resolves or installs.
      expect(workflow.match(/pnpm install/g)).toHaveLength(1);
      expect(job("build")).not.toContain("pnpm ");
      expect(job("publish")).not.toContain("pnpm ");
      // No resolved lockfile is handed to the legs on a push; they check out the committed one.
      expect(condition(step("identity", "Keep the resolved lockfile for the build legs"))).toBe("steps.lock.outputs.state == 'current' && github.event_name != 'push'");
      expect(condition(step("build", "Download the resolved lockfile"))).toBe("github.event_name != 'push'");
      expect(condition(step("build", "Use the resolved lockfile"))).toBe("github.event_name != 'push'");
    });

    it("is still resolved for a pull request and a manual run, before the identity is computed", () => {
      const names = steps("identity").map((entry) => entry.name);
      const order = ["Resolve the lockfile for a pull request or manual build", "Export the Runner build context",
        "Check the lockfile against the Runner's manifests", "Compute the identity in the build context",
        "Keep the resolved lockfile for the build legs"].map((name) => names.indexOf(name));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(step("identity", "Resolve the lockfile for a pull request or manual build")).toContain("A master push publishes only from the committed lockfile.");
      // The legs build from that same file, not from a second resolution.
      const build = steps("build").map((entry) => entry.name);
      expect(build.indexOf("Use the resolved lockfile")).toBeLessThan(build.indexOf("Build the Runner image"));
      expect(step("build", "Use the resolved lockfile")).toContain('cp "$RUNNER_TEMP/runner-image-lockfile/pnpm-lock.yaml" pnpm-lock.yaml');
    });

    it("that is behind the Runner's manifests skips the build and the publication without failing a master run", () => {
      expect(step("identity", "Export the Runner build context")).toContain("--target runner-artifacts-context");
      expect(step("identity", "Check the lockfile against the Runner's manifests"))
        .toContain('run: node scripts/runner-image-publish.mjs lock-state --context "$RUNNER_TEMP/runner-image-context"');
      const report = step("identity", "Report a lockfile that is behind the Runner's manifests");
      expect(condition(report)).toBe("steps.lock.outputs.state == 'behind'");
      expect(report).toContain("no Runner image for this commit; the next lockfile refresh will publish one.");
      expect(report).toContain('>> "$GITHUB_STEP_SUMMARY"');
      // Green on a push. A run that resolved its own lockfile cannot be behind it, so there it is a fault.
      expect(report.trimEnd().endsWith('test "$GITHUB_EVENT_NAME" = "push"')).toBe(true);
      // Nothing after it runs: no identity, no lookup, no build, no publication.
      expect(condition(step("identity", "Compute the identity in the build context"))).toBe("steps.lock.outputs.state == 'current'");
      expect(condition(step("identity", "Look for the published image"))).toBe("steps.lock.outputs.state == 'current' && github.event_name == 'push'");
      expect(job("identity")).toContain("      lock: ${{ steps.lock.outputs.state }}\n");
      expect(jobCondition("build")!.startsWith("needs.identity.outputs.lock == 'current' && ")).toBe(true);
      expect(jobCondition("publish")).toContain("&& needs.identity.outputs.lock == 'current' &&");
      expect(job("publish")).toContain("    needs: [identity, build]\n");
      // No job overrides the default that a skipped or failed dependency skips it.
      expect(workflow).not.toMatch(/always\(\)|!cancelled\(\)|failure\(\)|continue-on-error/);
    });
  });

  it("builds each architecture on its own runner", () => {
    const build = job("build");
    expect(build).toContain("runner: ubuntu-latest");
    expect(build).toContain("runner: ubuntu-24.04-arm");
    expect(build).not.toMatch(/qemu|runs-on\/fleet/i);
    expect(step("identity", "Compute the identity in the build context")).toContain("--target runner-artifacts-identity");
  });

  it("builds on every pull request and manual run, also when the image already exists", () => {
    // Only on a push does an existing image skip the build. A change to the
    // smoke matrix or to this pipeline leaves the identity alone and must
    // still be exercised.
    expect(jobCondition("build")).toContain("github.event_name != 'push' || (");
    expect(jobCondition("build")).toMatch(/\|\| \(.*needs\.identity\.outputs\.exists != 'true'\)\)$/);
    // The lookups that can skip work run on a push only, so their output is empty elsewhere.
    expect(condition(step("identity", "Look for the published image"))).toContain("github.event_name == 'push'");
    expect(condition(step("build", "Look again for the published image"))).toBe("github.event_name == 'push'");
  });

  it("stops a build leg early when another run has published the image", () => {
    const names = steps("build").map((entry) => entry.name);
    expect(names.slice(0, 3)).toEqual(["Checkout", "Setup Node.js", "Look again for the published image"]);
    const lookup = step("build", "Look again for the published image");
    expect(lookup).toContain('run: node scripts/runner-image-publish.mjs tag-state "inputs-$DIGEST"\n');
    expect(lookup).not.toContain("--strict");
    // Every step that does work is skipped once the image is known to exist.
    for (const name of ["Free runner disk", "Set up Docker Buildx", "Build the Runner image", "Check the layout contract and pack integrity",
      "Run the daemon on every consumer base image"]) {
      expect(condition(step("build", name)), name).toBe("steps.published.outputs.exists != 'true'");
    }
    expect(condition(step("build", "Report an image another run published first"))).toBe("steps.published.outputs.exists == 'true'");
    expect(names.at(-1)).toBe("Report an image another run published first");
  });

  it("checks the layout and runs the smoke matrix before it records an image for publication", () => {
    const names = steps("build").map((entry) => entry.name);
    const order = ["Build the Runner image", "Check the layout contract and pack integrity", "Run the daemon on every consumer base image",
      "Record the verified image", "Upload the verified image"].map((name) => names.indexOf(name));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const check = step("build", "Check the layout contract and pack integrity");
    for (const expectation of ['--expect-inputs-digest "$DIGEST"', '--expect-source-revision "$GITHUB_SHA"', '--expect-architecture "$ARCH"']) {
      expect(check).toContain(expectation);
    }
    expect(step("build", "Run the daemon on every consumer base image")).toContain("--file docker/runner-image/Dockerfile.smoke");
  });

  it("ends as 'another run published first' when the legs found the image published", () => {
    const names = steps("publish").map((entry) => entry.name);
    // The first thing after setup: a leg that skipped uploaded no artifact.
    expect(names.slice(0, 3)).toEqual(["Checkout", "Setup Node.js", "Look for an image another run published"]);
    expect(step("publish", "Look for an image another run published")).not.toContain("--strict");
    for (const name of ["Download the verified amd64 image", "Download the verified arm64 image", "Accept only this run's verified images",
      "Login to GitHub Container Registry", "Set up Docker Buildx", "Look again immediately before pushing"]) {
      expect(condition(step("publish", name)), name).toBe("steps.early.outputs.exists != 'true'");
    }
    expect(condition(step("publish", "Report an image another run published first")))
      .toBe("steps.early.outputs.exists == 'true' || steps.prepush.outputs.exists == 'true' || steps.gate.outputs.state == 'present'");
    expect(names.at(-1)).toBe("Report an image another run published first");
  });

  it("looks once more immediately before it pushes, and pushes nothing when the image exists", () => {
    const names = steps("publish").map((entry) => entry.name);
    expect(names.indexOf("Push the verified images by digest") - names.indexOf("Look again immediately before pushing")).toBe(1);
    expect(step("publish", "Look again immediately before pushing")).not.toContain("--strict");
    // `false` is the lookup's own answer; a skipped lookup leaves it empty.
    expect(condition(step("publish", "Push the verified images by digest"))).toBe("steps.prepush.outputs.exists == 'false'");
    expect(condition(step("publish", "Confirm the tag does not exist"))).toBe("steps.prepush.outputs.exists == 'false'");
  });

  it("writes the tag once: after a strict lookup, and only after its digest is attested", () => {
    const publish = job("publish");
    const order = [
      "node scripts/runner-image-publish.mjs verify-legs",
      "skopeo copy --preserve-digests",
      'tag-state "inputs-$DIGEST" --strict',
      '-t "$IMAGE:candidate-$DIGEST"',
      'verify-index "candidate-$DIGEST"',
      "uses: actions/attest@",
      'imagetools create -t "$IMAGE:inputs-$DIGEST" "$IMAGE@$INDEX"',
    ].map((text) => publish.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The strict gate follows the pushes directly, and is the only strict lookup.
    const names = steps("publish").map((entry) => entry.name);
    expect(names.indexOf("Confirm the tag does not exist") - names.indexOf("Push the verified images by digest")).toBe(1);
    expect(workflow.match(/--strict/g)).toHaveLength(1);
    // Every step that writes a tag or signs runs only when the tag is absent.
    for (const name of ["Create the multi-platform candidate", "Verify the candidate names exactly the verified images",
      "Attest the Runner image", "Publish the tag"]) {
      expect(condition(step("publish", name)), name).toBe("steps.gate.outputs.state == 'absent'");
    }
    expect(step("publish", "Publish the tag")).toContain('verify-index "inputs-$DIGEST" --dir "$RUNNER_TEMP/runner-image" --expect "$INDEX"');
    expect(publish).toContain("subject-name: ghcr.io/paperclipai/paperclip-runner");
    expect(publish).toContain("group: runner-image-publish-${{ needs.identity.outputs.digest }}");
    expect(publish).toContain("cancel-in-progress: false");
  });

  it("runs on every master push, and on pull requests that touch an input of the image", () => {
    const triggers = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(triggers).toMatch(/\n {2}push:\n {4}branches:\n {6}- master\n {2}pull_request:\n/);
    // No path filter on push: every commit's identity is looked up.
    expect(triggers.slice(0, triggers.indexOf("  pull_request:"))).not.toContain("paths:");
    const paths = [...triggers.matchAll(/^ {6}- (\S+)$/gm)].map((match) => match[1]);
    const covered = (file: string) => paths.some((pattern) => pattern === file
      || (pattern.endsWith("/**") && (file === pattern.slice(0, -3) || file.startsWith(pattern.slice(0, -2)))));
    // .dockerignore is not in the identity, but it decides which files the build receives.
    for (const input of ["Dockerfile", ".dockerignore", ".github/workflows/runner-image.yml", "docker/runner-image/Dockerfile.smoke",
      "scripts/runner-image-publish.mjs", ...RUNNER_IMAGE_RECIPE_INPUTS, ...RUNNER_IMAGE_BUILD_INPUT_ROOTS]) {
      expect(covered(input), input).toBe(true);
    }
  });

  it("is registered with the merge-review notifier under its own name", () => {
    const name = /^name: (.+)$/m.exec(workflow)![1];
    expect(name).toBe("Runner image");
    const listed = /workflow_run:\n {4}workflows:\n((?: {6}- .+\n)+)/.exec(mergeReview)![1].split("\n").filter(Boolean).map((line) => line.trim().slice(2));
    expect(listed).toContain(name);
  });
});

describe("Runner image smoke matrix", () => {
  it("runs the daemon on every consumer base, each pinned by digest", () => {
    const bases = [...smoke.matchAll(/^FROM (\S+) AS (\S+)$/gm)].map((match) => match[1]).filter((base) => base !== "scratch");
    expect(bases.map((base) => base.slice(0, base.indexOf("@")))).toEqual([
      "debian:bookworm-slim",
      "debian:trixie-slim",
      "node:24-trixie-slim",
      "python:3.13-slim-trixie",
      "daytonaio/sandbox:0.8.0",
    ]);
    for (const base of bases) expect(base).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(smoke.match(/^RUN paperclip-runnerd --build-metadata /gm)).toHaveLength(bases.length);
    // The final stage reads a result from every base, so none can be skipped.
    const final = smoke.slice(smoke.indexOf("FROM scratch AS smoke"));
    expect(final.match(/^COPY --from=smoke-/gm)).toHaveLength(bases.length);
  });

  it("reads the Runner image only the way a consumer may", () => {
    const copies = [...smoke.matchAll(/^COPY --from=runner-artifacts (.+)$/gm)].map((match) => match[1]);
    expect(copies.length).toBeGreaterThan(0);
    expect(new Set(copies)).toEqual(new Set(["/paperclip-runnerd /usr/local/bin/paperclip-runnerd"]));
    expect(smoke).not.toMatch(/^FROM runner-artifacts/m);
  });
});
