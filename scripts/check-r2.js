import { randomBytes } from "node:crypto";
import { createPrivateDocumentStorage } from "../server/r2.js";

const storage = createPrivateDocumentStorage();
await storage.check();
const key = `healthchecks/${Date.now()}-${randomBytes(8).toString("hex")}.txt`;
await storage.put({ key, body: Buffer.from("seven-roots-r2-ok"), contentType: "text/plain" });
await storage.delete(key);
console.log("R2 private bucket read/write/delete check passed.");
