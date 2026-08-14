import fs from "node:fs/promises";

const sourceUrl = new URL("../src/_data/neighborhoods.json", import.meta.url);
const data = JSON.parse(await fs.readFile(sourceUrl, "utf8"));
const failures = [];

for (const neighborhood of data.neighborhoods || []) {
  const serialized = JSON.stringify(neighborhood);
  const description = String(neighborhood.description || "").trim().toLowerCase();

  if (["testing.", "test description."].includes(description)) {
    failures.push(`${neighborhood.slug}: test description is not production content`);
  }
  if (/\b555[-.) ]?555[-. ]?5555\b/.test(serialized)) {
    failures.push(`${neighborhood.slug}: placeholder 555 phone number`);
  }
  if (/@example\.com\b/i.test(serialized)) {
    failures.push(`${neighborhood.slug}: placeholder example.com email`);
  }
  if (neighborhood.association?.url && /\.\s*$/.test(neighborhood.association.url)) {
    failures.push(`${neighborhood.slug}: association URL ends with a period`);
  }
}

if (failures.length) {
  console.error("Production-content validation failed:\n- " + failures.join("\n- "));
  process.exitCode = 1;
} else {
  console.log("Production-content validation passed.");
}
