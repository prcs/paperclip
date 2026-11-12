#!/usr/bin/env node
// Publication checks for the Runner image (.github/workflows/runner-image.yml).
//
// The build legs run without write access to the registry. Each one records
// the image it built and verified; the publish job pushes exactly those bytes,
// names them under one multi-platform tag and attests that tag's digest.
//
//   lock-state    whether pnpm-lock.yaml matches the manifests in an exported
//                 `runner-artifacts-context` tree: `current` or `behind`. It
//                 runs the image build's own frozen install as a lockfile-only,
//                 offline check. Any other failure is an error
//   record        a build leg, after its checks passed: binds the image archive
//                 to its digest, architecture, inputs digest and source revision
//   verify-legs   the publish job, before any push: accepts only one record per
//                 architecture, for this run's inputs digest and commit, whose
//                 archive still has the recorded bytes
//   tag-state     whether a tag exists: `present`, `absent` or `unknown`. The
//                 `inputs-<digest>` tag is create-only, so --strict fails on
//                 `unknown` instead of guessing
//   verify-index  the pushed tag names exactly the recorded images
//
// Registry credentials come from RUNNER_IMAGE_REGISTRY_USERNAME and
// RUNNER_IMAGE_REGISTRY_PASSWORD when both are set; lookups are anonymous
// otherwise. An unknown flag, a repeated flag or a flag with an empty value is
// an error.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RUNNER_IMAGE_NAME, RUNNER_IMAGE_PLATFORMS } from "./runner-image-identity.mjs";
import { RUNNER_IMAGE_PATHS } from "./runner-image-layout.mjs";
import { assertIndexUsesVerifiedImages, standardImageDigest } from "./standard-image-contract.mjs";

export const RUNNER_IMAGE_RECORD_SCHEMA = "paperclip.runner-image-leg.v1";
const ARCHITECTURES = RUNNER_IMAGE_PLATFORMS.map((platform) => platform.split("/")[1]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

/** What a build leg hands to the publish job, read from the tree it verified. */
export async function createLegRecord({ architecture, archive, metadataFile, tree }) {
  assert.ok(ARCHITECTURES.includes(architecture), `Unsupported architecture ${architecture}`);
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  const digest = metadata["containerimage.digest"];
  assert.match(digest ?? "", DIGEST, "The build reported no image digest");
  const manifest = JSON.parse(await readFile(path.join(tree, RUNNER_IMAGE_PATHS.manifest), "utf8"));
  assert.equal(manifest.platform?.architecture, architecture, "The verified tree is for another architecture");
  assert.match(manifest.inputsDigest?.digest ?? "", HEX_64);
  assert.match(manifest.sourceRevision ?? "", REVISION);
  return {
    schema: RUNNER_IMAGE_RECORD_SCHEMA,
    architecture,
    digest,
    inputsDigest: manifest.inputsDigest.digest,
    sourceRevision: manifest.sourceRevision,
    archiveSha256: await sha256File(archive),
  };
}

/**
 * The image digest of each architecture, accepted only when every leg built
 * this run's inputs at this run's commit and its archive is unchanged.
 * @param {{ directory: string, inputsDigest: string, sourceRevision: string, archiveName?: string }} input
 * @returns {Promise<Record<string, string>>}
 */
export async function verifyLegRecords({ directory, inputsDigest, sourceRevision, archiveName = "image.oci.tar" }) {
  assert.match(inputsDigest ?? "", HEX_64);
  assert.match(sourceRevision ?? "", REVISION);
  /** @type {Record<string, string>} */
  const digests = {};
  for (const architecture of ARCHITECTURES) {
    const legDirectory = path.join(directory, architecture);
    const record = JSON.parse(await readFile(path.join(legDirectory, "record.json"), "utf8"));
    assert.equal(record.schema, RUNNER_IMAGE_RECORD_SCHEMA, `${architecture}: unknown record schema`);
    assert.equal(record.architecture, architecture, `${architecture}: the record is for another architecture`);
    assert.equal(record.inputsDigest, inputsDigest, `${architecture}: the image was built from other inputs`);
    assert.equal(record.sourceRevision, sourceRevision, `${architecture}: the image was built at another commit`);
    assert.match(record.digest ?? "", DIGEST, `${architecture}: the record has no image digest`);
    assert.equal(await sha256File(path.join(legDirectory, archiveName)), record.archiveSha256,
      `${architecture}: the image archive does not match its record`);
    digests[architecture] = record.digest;
  }
  return digests;
}

function repositoryOf(image) {
  const match = /^ghcr\.io\/([a-z0-9][a-z0-9._/-]*)$/.exec(image);
  assert.ok(match, `Not a ghcr.io image name: ${image}`);
  return match[1];
}

async function request(url, headers, fetchImpl, sleep) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(attempt * 1000);
      continue;
    }
    const transient = [408, 425, 429].includes(response.status) || response.status >= 500;
    if (!transient || attempt === 5) return response;
    await response.body?.cancel();
    await sleep(attempt * 1000);
  }
}

/**
 * Reads a manifest. `state` is `present` with the registry bytes, `absent`
 * when the registry says the manifest does not exist, and `unknown` for every
 * other answer: a refused token, a package that is private to this caller, or
 * a registry error that outlasted the retries.
 * @param {string} reference
 * @param {{
 *   image?: string,
 *   credentials?: { username: string, password: string } | null,
 *   fetchImpl?: (url: string, init: { headers: Record<string, string>, redirect: "error", signal: AbortSignal }) => Promise<Response>,
 *   sleep?: (ms: number) => Promise<unknown>,
 * }} [options]
 * @returns {Promise<{ state: "present", bytes: Buffer, digest: string } | { state: "absent" } | { state: "unknown", detail: string }>}
 */
export async function readRunnerImageManifest(reference, {
  image = RUNNER_IMAGE_NAME,
  credentials = null,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const repository = repositoryOf(image);
  /** @type {Record<string, string>} */
  const basic = credentials ? { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}` } : {};
  // A registry that cannot be reached, or that answers with something other
  // than a token, leaves the question open. It is not an answer.
  let token;
  try {
    const tokenResponse = await request(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`, basic, fetchImpl, sleep);
    if (!tokenResponse.ok) {
      await tokenResponse.body?.cancel();
      return { state: "unknown", detail: `token request: HTTP ${tokenResponse.status}` };
    }
    ({ token } = await tokenResponse.json());
  } catch (error) {
    return { state: "unknown", detail: `token request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof token !== "string" || !token) return { state: "unknown", detail: "token request returned no token" };
  let response;
  let bytes;
  try {
    response = await request(`https://ghcr.io/v2/${repository}/manifests/${reference}`,
      { authorization: `Bearer ${token}`, accept: MANIFEST_TYPES }, fetchImpl, sleep);
    if (response.status === 404) {
      await response.body?.cancel();
      return { state: "absent" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { state: "unknown", detail: `manifest request: HTTP ${response.status}` };
    }
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { state: "unknown", detail: `manifest request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  assert.ok(bytes.length <= 1024 * 1024, "Registry manifest exceeds its size limit");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const reported = response.headers.get("docker-content-digest");
  assert.ok(!reported || reported === digest, "Registry digest does not match the manifest bytes");
  return { state: "present", bytes, digest };
}

/**
 * The digest of the pushed index, accepted only when it names exactly the recorded images.
 * @param {Buffer} bytes
 * @param {Record<string, string>} legDigests
 */
export function verifyPublishedIndex(bytes, legDigests) {
  assert.deepEqual(Object.keys(legDigests).sort(), [...ARCHITECTURES].sort(), "Expected one recorded image for each architecture");
  const digest = standardImageDigest(bytes);
  assertIndexUsesVerifiedImages(bytes, new Set(Object.values(legDigests)));
  const index = JSON.parse(bytes.toString("utf8"));
  // Exactly the two images, and nothing beside them: no attestation manifest,
  // no entry without a platform, no other operating system.
  assert.equal(index.manifests.length, ARCHITECTURES.length, `Expected exactly ${ARCHITECTURES.length} manifests in the index, found ${index.manifests.length}`);
  for (const entry of index.manifests) {
    const architecture = entry.platform?.architecture;
    assert.ok(entry.platform?.os === "linux" && ARCHITECTURES.includes(architecture) && !entry.platform.variant,
      `The index names an unexpected platform: ${JSON.stringify(entry.platform ?? null)}`);
    assert.equal(entry.digest, legDigests[architecture], `linux/${architecture} is not the image its build leg recorded`);
  }
  return digest;
}

/** pnpm reports a lockfile that the manifests have moved past with one of these codes. */
const LOCK_BEHIND_CODES = ["ERR_PNPM_OUTDATED_LOCKFILE", "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH"];

/**
 * Whether pnpm-lock.yaml in an exported `runner-artifacts-context` tree
 * matches the manifests in that tree. This is the image build's frozen,
 * filtered install with --lockfile-only and --offline: it compares and
 * neither downloads nor writes. `behind` means the manifests the Runner build
 * reads were changed after the lockfile was. Every other failure throws.
 * @param {string} context
 * @param {{ run?: (command: string, args: string[], options: object) => { status: number | null, stdout: string, stderr: string, error?: Error } }} [options]
 * @returns {{ state: "current" | "behind", detail: string }}
 */
export function runnerLockState(context, { run = (command, args, options) => spawnSync(command, args, options) } = {}) {
  assert.ok(existsSync(path.join(context, "pnpm-lock.yaml")), `${context} has no pnpm-lock.yaml`);
  assert.ok(existsSync(path.join(context, "packages", "paperclip-runner", "package.json")), `${context} is not a Runner build context`);
  const result = run("pnpm", ["install", "--frozen-lockfile", "--lockfile-only", "--offline", "--ignore-scripts",
    "--filter", "@paperclipai/paperclip-runner..."], { cwd: context, encoding: "utf8" });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0) return { state: "current", detail: "pnpm-lock.yaml matches the Runner's manifests" };
  const code = LOCK_BEHIND_CODES.find((candidate) => output.includes(candidate));
  if (code) {
    const line = output.split("\n").find((candidate) => candidate.includes(code)) ?? code;
    return { state: "behind", detail: line.trim().slice(0, 500) };
  }
  throw new Error(`The lockfile check failed for another reason (exit ${result.status}):\n${output.trim().slice(-2000)}`);
}

const COMMAND_FLAGS = Object.freeze({
  "lock-state": { context: "value" },
  record: { arch: "value", archive: "value", metadata: "value", tree: "value", out: "value" },
  "verify-legs": { dir: "value", "inputs-digest": "value", "source-revision": "value" },
  "tag-state": { strict: "boolean" },
  "verify-index": { dir: "value", expect: "value" },
});
const REQUIRED_FLAGS = Object.freeze({
  "lock-state": ["context"],
  record: ["arch", "archive", "metadata", "tree", "out"],
  "verify-legs": ["dir", "inputs-digest", "source-revision"],
  "tag-state": [],
  "verify-index": ["dir"],
});

/**
 * Splits a command line into positional arguments and the flags the command
 * knows. Throws on an unknown command, an unknown or repeated flag, a missing
 * or empty value, and a missing required flag.
 * @param {string | undefined} command
 * @param {string[]} argv
 */
export function parsePublishArguments(command, argv) {
  if (!command || !Object.hasOwn(COMMAND_FLAGS, command)) {
    throw new Error("Usage: runner-image-publish.mjs lock-state|record|verify-legs|tag-state|verify-index ...");
  }
  const known = COMMAND_FLAGS[command];
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string | true>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (!Object.hasOwn(known, name)) throw new Error(`${command} does not take ${argument}`);
    if (Object.hasOwn(flags, name)) throw new Error(`${argument} is given twice`);
    if (known[name] === "boolean") {
      flags[name] = true;
      continue;
    }
    const value = argv[index += 1];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${argument} needs a value`);
    flags[name] = value;
  }
  for (const name of REQUIRED_FLAGS[command]) {
    if (!Object.hasOwn(flags, name)) throw new Error(`${command} needs --${name}`);
  }
  const takesReference = command === "tag-state" || command === "verify-index";
  if (positional.length !== (takesReference ? 1 : 0)) {
    throw new Error(takesReference ? `${command} takes exactly one tag or digest` : `${command} takes no positional argument`);
  }
  if (takesReference && !/^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|sha256:[0-9a-f]{64})$/.test(positional[0])) {
    throw new Error(`${command}: not a tag or digest: ${positional[0]}`);
  }
  return { positional, flags };
}

/**
 * Runs one command. Returns the values it reports; throws when the command's
 * check does not hold.
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, read?: typeof readRunnerImageManifest, lockState?: typeof runnerLockState, log?: (line: string) => void }} [options]
 * @returns {Promise<Record<string, string | boolean>>}
 */
export async function runPublishCommand(argv, {
  env = process.env,
  read = readRunnerImageManifest,
  lockState = runnerLockState,
  log = console.log,
} = {}) {
  const [command, ...rest] = argv;
  const { positional, flags } = parsePublishArguments(command, rest);
  const value = (name) => /** @type {string} */ (flags[name]);
  if (command === "lock-state") {
    const result = lockState(path.resolve(value("context")));
    log(result.detail);
    return { state: result.state };
  }
  if (command === "record") {
    const record = await createLegRecord({
      architecture: value("arch"), archive: value("archive"), metadataFile: value("metadata"), tree: value("tree"),
    });
    await writeFile(value("out"), `${JSON.stringify(record, null, 2)}\n`);
    return { digest: record.digest };
  }
  if (command === "verify-legs") {
    return verifyLegRecords({
      directory: value("dir"), inputsDigest: value("inputs-digest"), sourceRevision: value("source-revision"),
    });
  }
  const reference = positional[0];
  const result = await read(reference, { credentials: environmentCredentials(env) });
  if (command === "tag-state") {
    if (result.state === "unknown") {
      const message = `Could not determine whether ${RUNNER_IMAGE_NAME}:${reference} exists (${result.detail}).`;
      // A create-only tag is never written on a guess.
      assert.ok(flags.strict !== true, message);
      log(`::notice title=Runner image lookup inconclusive::${message}`);
    }
    return { state: result.state, exists: result.state === "present", ...(result.state === "present" ? { digest: result.digest } : {}) };
  }
  assert.equal(result.state, "present", `${RUNNER_IMAGE_NAME}:${reference} is ${result.state}`);
  assert.ok(result.state === "present");
  const digest = verifyPublishedIndex(result.bytes, await legDigests(value("dir")));
  if (Object.hasOwn(flags, "expect")) {
    assert.match(value("expect"), DIGEST, "--expect must be a sha256 digest");
    assert.equal(digest, value("expect"), `${reference} resolves to ${digest}, expected ${value("expect")}`);
  }
  return { digest };
}

async function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

function environmentCredentials(env = process.env) {
  const username = env.RUNNER_IMAGE_REGISTRY_USERNAME;
  const password = env.RUNNER_IMAGE_REGISTRY_PASSWORD;
  return username && password ? { username, password } : null;
}

async function legDigests(directory) {
  /** @type {Record<string, string>} */
  const digests = {};
  for (const architecture of ARCHITECTURES) {
    digests[architecture] = JSON.parse(await readFile(path.join(directory, architecture, "record.json"), "utf8")).digest;
  }
  return digests;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await output(await runPublishCommand(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
