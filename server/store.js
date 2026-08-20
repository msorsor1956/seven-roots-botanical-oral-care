import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const emptyData = () => ({ version: 1, waitlist: [], inquiries: [] });

export class JsonStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "seven-roots-data.json");
    this.data = emptyData();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.filePath, "utf8"));
      this.data = {
        version: 1,
        waitlist: Array.isArray(saved.waitlist) ? saved.waitlist : [],
        inquiries: Array.isArray(saved.inquiries) ? saved.inquiries : []
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
    return this;
  }

  async persist() {
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }

  async addWaitlist(entry) {
    const now = new Date().toISOString();
    const existing = this.data.waitlist.find((item) => item.email === entry.email);
    if (existing) {
      existing.name = entry.name;
      existing.preferredFormat = entry.preferredFormat;
      existing.country = entry.country;
      existing.source = entry.source;
      existing.updatedAt = now;
      await this.persist();
      return { record: existing, created: false };
    }
    const record = {
      id: randomUUID(),
      name: entry.name,
      email: entry.email,
      preferredFormat: entry.preferredFormat,
      country: entry.country,
      source: entry.source,
      status: "new",
      createdAt: now,
      updatedAt: now
    };
    this.data.waitlist.unshift(record);
    await this.persist();
    return { record, created: true };
  }

  async addInquiry(entry) {
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      name: entry.name,
      email: entry.email,
      phone: entry.phone,
      organization: entry.organization,
      inquiryType: entry.inquiryType,
      message: entry.message,
      status: "new",
      createdAt: now
    };
    this.data.inquiries.unshift(record);
    await this.persist();
    return record;
  }

  summary() {
    const formatInterest = this.data.waitlist.reduce((summary, entry) => {
      summary[entry.preferredFormat] = (summary[entry.preferredFormat] || 0) + 1;
      return summary;
    }, {});
    return {
      waitlistTotal: this.data.waitlist.length,
      inquiryTotal: this.data.inquiries.length,
      formatInterest
    };
  }

  list(collection, limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return this.data[collection].slice(0, safeLimit);
  }
}
