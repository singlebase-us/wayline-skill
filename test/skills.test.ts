import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const skillsRoot = new URL("../skills/", import.meta.url);
const expectedSkills = ["wayline-estimate", "wayline-review", "wayline-workspace"];

test("the User package exposes the intent-scoped skill set", async () => {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  assert.deepEqual(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), expectedSkills);

  for (const name of expectedSkills) {
    const contents = await readFile(new URL(`${name}/SKILL.md`, skillsRoot), "utf8");
    assert.match(contents, new RegExp(`^---\\nname: ${name}\\n`));
  }
});
test("estimate and review ship the same byte-identical authoritative Graph protocol", async () => {
  for (const file of ["graph-document.v3.schema.json", "task-graph-version.v1.schema.json", "protocol-manifest.json", "task-graph-protocol.md"]) {
    const estimate = await readFile(new URL(`wayline-estimate/references/${file}`, skillsRoot));
    const review = await readFile(new URL(`wayline-review/references/${file}`, skillsRoot));
    assert.deepEqual(review, estimate, file);
  }

  const references = new URL("wayline-estimate/references/", skillsRoot);
  const manifest = JSON.parse(await readFile(new URL("protocol-manifest.json", references), "utf8")) as {
    files: Record<string, { sha256: string }>;
  };
  for (const [file, entry] of Object.entries(manifest.files)) {
    const contents = await readFile(new URL(file, references));
    assert.equal(createHash("sha256").update(contents).digest("hex"), entry.sha256, file);
    assert.doesNotMatch(contents.toString("utf8"), /[^\x00-\x7F]/u, file);
  }
});
