#!/usr/bin/env node
// Identity of the Runner image (ghcr.io/paperclipai/paperclip-runner).
//
// The Runner image is built once for each distinct set of inputs and published
// under the tag `inputs-<digest>`. This script computes that digest from the
// build context it is run in. Two contexts with the same digest build the same
// Runner, so the publish workflow skips the build when the tag already exists.
//
// The digest covers:
//   - the context tree: every file the recipe stages can copy from the build
//     context, by path, executable bit and content, and every symbolic link by
//     its target. Nothing under those paths is skipped;
//   - the recipe: the text of every Dockerfile stage the `runner-artifacts`
//     target is built from, and the syntax directive;
//   - every base image those stages start from or copy from, which must be
//     pinned by digest;
//   - computeBuildInputsDigest (packages/paperclip-runner/scripts/build-inputs.mjs),
//     the digest the Runner's build stamp records. The context tree already
//     covers those files; the digest is kept so the image can name it.
//
// It does not cover the source revision: a commit that changes none of the
// above reuses the image an earlier commit built. It does not cover the text
// of .dockerignore either: those rules only decide which files the build
// receives, and the context tree is hashed from the files it received.
//
// The script refuses a recipe it cannot account for: a base image that is not
// pinned by digest, a COPY from the build context of a path outside the
// covered inputs, ADD, a heredoc, a build-context mount, a cache or secret
// mount, a flag on FROM, and a continued global ARG.
//
// The published digest is the one the image build computes for itself. The
// `runner-artifacts-identity-compute` stage runs this script on the files the
// build context supplies after .dockerignore. Run in a checkout, this script
// also reads the files .dockerignore drops and anything a local build left
// behind, so it prints another digest. For the published one:
//
//   docker buildx build --target runner-artifacts-identity --output type=local,dest=DIR .
//
// Usage: node scripts/runner-image-identity.mjs [--json]
//   default  prints the digest
//   --json   prints the digest and every component it was computed from
// See doc/runner-image-contract.md.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeBuildInputsDigest } from "../packages/paperclip-runner/scripts/build-inputs.mjs";
import { RUNNER_IMAGE_INPUTS_SCHEMA } from "./runner-image-layout.mjs";

export { RUNNER_IMAGE_INPUTS_SCHEMA };
export const RUNNER_IMAGE_NAME = "ghcr.io/paperclipai/paperclip-runner";
export const RUNNER_IMAGE_DOCKERFILE = "Dockerfile";
export const RUNNER_IMAGE_TARGET = "runner-artifacts";
export const RUNNER_IMAGE_PLATFORMS = Object.freeze(["linux/amd64", "linux/arm64"]);

/**
 * Files and directories the recipe reads from the build context that
 * computeBuildInputsDigest does not read. The script refuses a COPY of any
 * context path outside this list and RUNNER_IMAGE_BUILD_INPUT_ROOTS.
 *
 * @paperclipai/shared owns the last one. build:typescript only checks the
 * Runner's generated copy against it (check:protocol-types), but it fails
 * without it.
 */
export const RUNNER_IMAGE_RECIPE_INPUTS = Object.freeze([
  ".npmrc",
  "scripts/create-provider-pack-archive.mjs",
  "scripts/link-plugin-dev-sdk.mjs",
  "scripts/runner-image-identity.mjs",
  "scripts/runner-image-layout.mjs",
  "packages/shared/src/provider-failure.generated.ts",
]);

/** Context paths the Runner's own build reads. computeBuildInputsDigest reads a subset of the files under them. */
export const RUNNER_IMAGE_BUILD_INPUT_ROOTS = Object.freeze([
  "packages/paperclip-runner",
  "packages/paperclip-eval-kernel",
  "patches",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
]);

/** Every context path the recipe may copy. The context tree digest covers all of it. */
export const RUNNER_IMAGE_CONTEXT_INPUTS = Object.freeze([...RUNNER_IMAGE_BUILD_INPUT_ROOTS, ...RUNNER_IMAGE_RECIPE_INPUTS].sort());

const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(`Runner image identity: ${message}`);
}

/**
 * Splits a Dockerfile into the lines before the first FROM and one entry per stage.
 * @param {string} dockerfile
 * @returns {{ preamble: string[], stages: { name: string | null, from: string, fromFlags: string, lines: string[], text: string }[] }}
 */
export function parseDockerfileStages(dockerfile) {
  const lines = dockerfile.replace(/\r\n/g, "\n").split("\n");
  /** @type {string[]} */
  const preamble = [];
  /** @type {{ name: string | null, from: string, fromFlags: string, lines: string[], text: string }[]} */
  const stages = [];
  /** @type {{ name: string | null, from: string, fromFlags: string, lines: string[], text: string } | null} */
  let current = null;
  for (const line of lines) {
    if (/^\s*FROM\s/i.test(line)) {
      const match = /^\s*FROM((?:\s+--\S+)*)\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
      if (!match) fail(`cannot parse stage declaration: ${line.trim()}`);
      current = { name: match[3] ?? null, from: match[2], fromFlags: match[1].trim(), lines: [line], text: "" };
      stages.push(current);
      continue;
    }
    (current ? current.lines : preamble).push(line);
  }
  for (const stage of stages) {
    // Blank lines and comments after a stage's last instruction introduce the
    // next stage. They are not part of this one.
    while (stage.lines.length > 1 && /^\s*(?:#.*)?$/.test(stage.lines[stage.lines.length - 1])) stage.lines.pop();
    stage.text = `${stage.lines.join("\n")}\n`;
  }
  return { preamble, stages };
}

/**
 * The instructions of a stage after its FROM line, each as one logical line:
 * comment lines dropped and continuation lines joined, as the Dockerfile
 * parser reads them.
 * @param {{ lines: string[] }} stage
 */
function stageInstructions(stage) {
  /** @type {{ keyword: string, text: string }[]} */
  const instructions = [];
  let pending = "";
  for (const line of stage.lines.slice(1)) {
    if (/^\s*#/.test(line) || (pending === "" && line.trim() === "")) continue;
    if (/\\\s*$/.test(line)) {
      pending += `${line.replace(/\\\s*$/, "")} `;
      continue;
    }
    const text = (pending + line).trim();
    pending = "";
    if (text) instructions.push({ keyword: text.split(/\s+/, 1)[0].toUpperCase(), text });
  }
  if (pending.trim()) instructions.push({ keyword: pending.trim().split(/\s+/, 1)[0].toUpperCase(), text: pending.trim() });
  return instructions;
}

const COPY_FLAGS = new Set(["--from", "--chown", "--chmod", "--link"]);

/**
 * What one stage reads from outside itself: the stages or images it copies or
 * mounts from, and the build-context paths it copies. Throws on anything whose
 * inputs this script cannot name.
 * @param {{ name: string | null, lines: string[], fromFlags: string }} stage
 */
function stageReads(stage) {
  const where = `stage ${stage.name}`;
  if (stage.fromFlags) fail(`${where} sets a flag on FROM (${stage.fromFlags}); the image is built for a fixed set of platforms`);
  /** @type {string[]} */
  const sources = [];
  /** @type {string[]} */
  const contextPaths = [];
  for (const { keyword, text } of stageInstructions(stage)) {
    // A heredoc body is not parsed here: a line in it that starts with FROM
    // would end the stage early and drop the rest of the instruction.
    if (text.includes("<<")) fail(`${where} uses a heredoc or "<<" in ${keyword}; write the instruction on continued lines`);
    if (keyword === "ADD") fail(`${where} uses ADD, which can read URLs and unpack archives; use COPY`);
    if (keyword === "COPY") {
      const operands = text.split(/\s+/).slice(1);
      const flags = operands.filter((operand) => operand.startsWith("--"));
      for (const flag of flags) {
        if (!COPY_FLAGS.has(flag.split("=", 1)[0])) fail(`${where} uses the COPY flag ${flag}, which this script does not account for`);
      }
      const from = flags.find((flag) => flag.startsWith("--from="));
      if (from) {
        sources.push(from.slice("--from=".length));
        continue;
      }
      const paths = operands.filter((operand) => !operand.startsWith("--")).slice(0, -1);
      if (paths.length === 0) fail(`${where} has a COPY without a source: ${text}`);
      contextPaths.push(...paths);
    }
    if (keyword === "RUN") {
      for (const mount of text.matchAll(/--mount=(\S+)/g)) {
        const options = Object.fromEntries(mount[1].split(",").map((option) => {
          const separator = option.indexOf("=");
          return separator < 0 ? [option, ""] : [option.slice(0, separator), option.slice(separator + 1)];
        }));
        const type = options.type ?? "bind";
        if (type === "tmpfs") continue;
        if (type !== "bind") fail(`${where} uses a ${type} mount, whose content is outside the image identity`);
        if (!options.from) fail(`${where} mounts the build context into a RUN; copy the files through runner-artifacts-context instead`);
        sources.push(options.from);
      }
    }
  }
  return { sources, contextPaths };
}

/** Whether a COPY source from the build context is one of the covered inputs. */
function coveredContextPath(source) {
  if (/[*?[\]$]/.test(source)) return false;
  const trimmed = source.replace(/\/+$/, "");
  const normalized = path.posix.normalize(trimmed);
  if (normalized !== trimmed || normalized.startsWith("..") || path.posix.isAbsolute(normalized)) return false;
  return normalized === RUNNER_IMAGE_DOCKERFILE
    || RUNNER_IMAGE_CONTEXT_INPUTS.some((input) => normalized === input || normalized.startsWith(`${input}/`));
}

/**
 * The recipe of `target`: every stage it is built from, in file order, with
 * the base images those stages use. Throws when the recipe reads anything this
 * script cannot account for, because that input would change the build under
 * one identity.
 * @param {string} dockerfile
 * @param {string} [target]
 */
export function extractRunnerImageRecipe(dockerfile, target = RUNNER_IMAGE_TARGET) {
  const { preamble, stages } = parseDockerfileStages(dockerfile);
  const byName = new Map();
  for (const stage of stages) {
    if (stage.name === null) continue;
    if (byName.has(stage.name)) fail(`stage ${stage.name} is declared twice`);
    byName.set(stage.name, stage);
  }
  if (!byName.has(target)) fail(`the Dockerfile declares no ${target} stage`);

  const selected = new Set();
  /** @type {Set<string>} */
  const baseImages = new Set();
  /** @type {Set<string>} */
  const contextPaths = new Set();
  const reference = (name, context) => {
    if (byName.has(name)) {
      visit(byName.get(name));
      return;
    }
    if (name === "scratch") return;
    if (/^\d+$/.test(name)) fail(`${context} refers to a stage by index; name the stage`);
    if (name.includes("$")) fail(`${context} uses a build argument in an image reference: ${name}`);
    if (!PINNED_IMAGE.test(name)) fail(`${context} uses a base image that is not pinned by digest: ${name}`);
    baseImages.add(name);
  };
  function visit(stage) {
    if (selected.has(stage)) return;
    selected.add(stage);
    const where = `stage ${stage.name}`;
    reference(stage.from, where);
    const reads = stageReads(stage);
    for (const source of reads.sources) reference(source, where);
    for (const source of reads.contextPaths) {
      if (!coveredContextPath(source)) {
        fail(`${where} copies ${source} from the build context, which the image identity does not cover; add it to RUNNER_IMAGE_RECIPE_INPUTS`);
      }
      contextPaths.add(path.posix.normalize(source));
    }
  }
  visit(byName.get(target));

  // The syntax directive selects the Dockerfile frontend, and a global ARG can
  // change any stage, so both belong to the recipe.
  const frontend = /^#\s*syntax\s*=\s*(\S+)\s*$/.exec(preamble[0] ?? "")?.[1] ?? null;
  if (preamble.some((line) => /^#\s*escape\s*=/i.test(line))) fail("the Dockerfile changes the escape character; continued lines would be read wrongly");
  const globalArguments = [];
  for (const line of preamble) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (!/^\s*ARG\s/i.test(line)) fail(`cannot account for the instruction before the first stage: ${line.trim()}`);
    if (/\\\s*$/.test(line)) fail(`a global ARG is continued over several lines; write it on one line: ${line.trim()}`);
    globalArguments.push(line.trim());
  }
  return {
    target,
    frontend,
    globalArguments,
    stages: stages.filter((stage) => selected.has(stage)).map((stage) => ({ name: /** @type {string} */ (stage.name), text: stage.text })),
    baseImages: [...baseImages].sort(),
    contextPaths: [...contextPaths].sort(),
  };
}

const compareNames = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Digest of everything under the covered context inputs, as the tree at
 * `repoRoot` holds it. Each file is recorded by path, executable bit and
 * content digest, each symbolic link by its target, each directory by path.
 * Entries are ordered by code unit, so the result does not depend on locale.
 * @param {string} repoRoot
 */
export function computeContextTreeDigest(repoRoot) {
  const hash = createHash("sha256");
  let fileCount = 0;
  let byteCount = 0;
  const visit = (relative, top) => {
    const absolute = path.join(repoRoot, ...relative.split("/"));
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      fail(`the recipe reads ${relative}, which is missing from the build context`);
    }
    if (stat.isSymbolicLink()) {
      record(hash, "link", relative, readlinkSync(absolute));
    } else if (stat.isFile()) {
      const content = readFileSync(absolute);
      fileCount += 1;
      byteCount += content.length;
      record(hash, "file", relative, (stat.mode & 0o111) === 0 ? "-" : "x", sha256(content));
    } else if (stat.isDirectory()) {
      const entries = readdirSync(absolute).sort(compareNames);
      if (top && entries.length === 0) fail(`the recipe reads ${relative}, which is empty in the build context`);
      record(hash, "directory", relative);
      for (const name of entries) visit(`${relative}/${name}`, false);
    } else {
      fail(`the recipe reads ${relative}, which is not a file, a directory or a symbolic link`);
    }
  };
  for (const input of RUNNER_IMAGE_CONTEXT_INPUTS) visit(input, true);
  return { digest: hash.digest("hex"), fileCount, byteCount };
}

function record(hash, kind, ...fields) {
  hash.update(kind);
  for (const field of fields) {
    hash.update("\0");
    hash.update(field);
  }
  hash.update("\n");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The identity of the Runner image built from the tree at `repoRoot`.
 * `buildInputs` replaces the Runner build-input digest; tests use it.
 * @param {string} repoRoot
 * @param {{ buildInputs?: { schema: string, digest: string } }} [options]
 */
export function computeRunnerImageIdentity(repoRoot, { buildInputs = computeBuildInputsDigest(repoRoot) } = {}) {
  const dockerfile = readFileSync(path.join(repoRoot, RUNNER_IMAGE_DOCKERFILE), "utf8");
  const recipe = extractRunnerImageRecipe(dockerfile);
  const context = computeContextTreeDigest(repoRoot);

  const recipeHash = createHash("sha256");
  record(recipeHash, "frontend", recipe.frontend ?? "");
  for (const argument of recipe.globalArguments) record(recipeHash, "global-argument", argument);
  for (const stage of recipe.stages) record(recipeHash, "stage", stage.name, stage.text);
  const recipeDigest = recipeHash.digest("hex");

  const hash = createHash("sha256");
  record(hash, "schema", RUNNER_IMAGE_INPUTS_SCHEMA);
  record(hash, "context", context.digest);
  record(hash, "build-inputs", buildInputs.schema, buildInputs.digest);
  record(hash, "recipe", recipe.target, recipeDigest);
  for (const image of recipe.baseImages) record(hash, "base-image", image);
  for (const platform of RUNNER_IMAGE_PLATFORMS) record(hash, "platform", platform);
  const digest = hash.digest("hex");

  return {
    schema: RUNNER_IMAGE_INPUTS_SCHEMA,
    digest,
    image: RUNNER_IMAGE_NAME,
    tag: `inputs-${digest}`,
    platforms: [...RUNNER_IMAGE_PLATFORMS],
    buildInputs: { schema: buildInputs.schema, digest: buildInputs.digest },
    context: { inputs: [...RUNNER_IMAGE_CONTEXT_INPUTS], ...context },
    recipe: {
      dockerfile: RUNNER_IMAGE_DOCKERFILE,
      target: recipe.target,
      frontend: recipe.frontend,
      stages: recipe.stages.map((stage) => stage.name),
      copies: recipe.contextPaths,
      digest: recipeDigest,
    },
    baseImages: recipe.baseImages,
  };
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== "--json")) {
    process.stderr.write("Usage: node scripts/runner-image-identity.mjs [--json]\n");
    process.exit(2);
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const identity = computeRunnerImageIdentity(repoRoot);
    process.stdout.write(flags.includes("--json") ? `${JSON.stringify(identity, null, 2)}\n` : `${identity.digest}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
