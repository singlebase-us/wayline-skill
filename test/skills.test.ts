import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const skillsRoot = new URL("../skills/", import.meta.url);
const protocolRoot = new URL("../protocol/", import.meta.url);
const expectedSkills = [
  "wayline-estimate",
  "wayline-execution",
  "wayline-review",
  "wayline-workspace",
];
const protocolConsumers: Record<string, string[]> = {
  "wayline-estimate": ["estimation-method.md"],
  "wayline-review": [],
};

test("the User package exposes the intent-scoped skill set", async () => {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  assert.deepEqual(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), expectedSkills);

  for (const name of expectedSkills) {
    const contents = await readFile(new URL(`${name}/SKILL.md`, skillsRoot), "utf8");
    assert.match(contents, new RegExp(`^---\\nname: ${name}\\n`));
  }
});
test("execution remains read-only and projects state onto the current graph version", async () => {
  const contents = await readFile(new URL("wayline-execution/SKILL.md", skillsRoot), "utf8");
  assert.match(contents, /projects only the node refs of the current Task Graph version/);
  assert.match(contents, /--version-id/);
  assert.match(contents, /This skill is read-only/);
  assert.doesNotMatch(contents, /task-execution update|node-comment create/);
});
test("protocol files ship from the repository root into every consumer skill", async () => {
  const protocolFiles = (await readdir(protocolRoot)).sort();
  assert.deepEqual(protocolFiles, [
    "graph-document.v3.schema.json",
    "protocol-manifest.json",
    "task-graph-protocol.md",
    "task-graph-version.v1.schema.json",
  ]);

  for (const [consumer, localReferences] of Object.entries(protocolConsumers)) {
    const references = new URL(`${consumer}/references/`, skillsRoot);
    let entries: string[];
    try {
      entries = (await readdir(references)).sort();
    } catch {
      return assert.fail(`${consumer}: run "npm run build" to distribute protocol/ into the skill`);
    }
    assert.deepEqual(entries, [...localReferences, ...protocolFiles].sort(), consumer);
    for (const file of protocolFiles) {
      assert.deepEqual(
        await readFile(new URL(file, references)),
        await readFile(new URL(file, protocolRoot)),
        `${consumer}/references/${file}`,
      );
    }
  }
});
test("the protocol manifest records its schema digests and stays ASCII-only", async () => {
  const manifest = JSON.parse(await readFile(new URL("protocol-manifest.json", protocolRoot), "utf8")) as {
    files: Record<string, { sha256: string }>;
  };
  for (const [file, entry] of Object.entries(manifest.files)) {
    const contents = await readFile(new URL(file, protocolRoot));
    assert.equal(createHash("sha256").update(contents).digest("hex"), entry.sha256, file);
    assert.doesNotMatch(contents.toString("utf8"), /[^\x00-\x7F]/u, file);
  }
});
