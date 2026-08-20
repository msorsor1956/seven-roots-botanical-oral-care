import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ignored = new Set([".git", ".data", "node_modules", "assets"]);
const secretPatterns = [
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/u,
  /whsec_[A-Za-z0-9]{16,}/u,
  /ZOHO_(?:CLIENT_SECRET|REFRESH_TOKEN)=[^\s<][^\r\n]{12,}/u,
  /1000\.[A-Za-z0-9]{20,}\.[A-Za-z0-9]{20,}/u
];

const files = [];
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else files.push(target);
  }
};

await walk(root);
const findings = [];
for (const file of files) {
  const contents = await readFile(file, "utf8").catch(() => "");
  if (secretPatterns.some((pattern) => pattern.test(contents))) findings.push(path.relative(root, file));
}

if (findings.length) {
  console.error(`Potential commerce secret found in: ${findings.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("No Stripe or Zoho secret patterns found in tracked project files.");
}
