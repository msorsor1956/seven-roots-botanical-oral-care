import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const clean = (value) => String(value || "").trim();

export class PrivateDocumentStorage {
  constructor(environment = process.env) {
    this.bucket = clean(environment.R2_BUCKET);
    this.endpoint = clean(environment.R2_ENDPOINT);
    this.active = Boolean(this.bucket && this.endpoint && environment.R2_ACCESS_KEY_ID && environment.R2_SECRET_ACCESS_KEY);
    this.client = this.active ? new S3Client({
      region: clean(environment.R2_REGION) || "auto",
      endpoint: this.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: clean(environment.R2_ACCESS_KEY_ID),
        secretAccessKey: clean(environment.R2_SECRET_ACCESS_KEY)
      }
    }) : null;
  }

  status() {
    return { provider: "cloudflare-r2", configured: this.active, bucket: this.bucket || null };
  }

  async check() {
    if (!this.active) throw Object.assign(new Error("Private document storage is not configured."), { code: "r2_not_configured" });
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return this.status();
  }

  async put({ key, body, contentType, metadata = {} }) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, Metadata: metadata }));
    return { key };
  }

  async signedReadUrl(key, expiresIn = 300) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: Math.min(300, Math.max(30, expiresIn)) });
  }

  async delete(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export const createPrivateDocumentStorage = (environment) => new PrivateDocumentStorage(environment);
