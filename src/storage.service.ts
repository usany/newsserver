import { Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { audioDuration } from './audio-duration.js';

/**
 * A single item discovered in the object storage bucket.
 * `name` is the object key; `url` is a directly-fetchable signed URL.
 */
export interface StorageItem {
  name: string;
  url: string;
  size: number;
  lastModified: string;
}

/**
 * Lists and maps objects in the Oracle Cloud Object Storage bucket referenced
 * by `S3_REGION`, `S3_NAMESPACE`, and `S3_BUCKET` in `.env`.
 *
 * Oracle's S3-compatible API is exposed on the "compat" hostname:
 *   https://<namespace>.compat.objectstorage.<region>.oraclecloud.com
 *
 * All requests are signed with AWS Signature Version 4 using the S3 service
 * name (`s3`). Object keys live under `/<bucket>/<key>`.
 */
@Injectable()
export class StorageService {
  private readonly host: string;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKey: string;
  private readonly secretKey: string;

  constructor() {
    const region = process.env.S3_REGION ?? '';
    const namespace = process.env.S3_NAMESPACE ?? '';
    const bucket = process.env.S3_BUCKET ?? '';
    this.region = region;
    this.bucket = bucket;
    this.accessKey = process.env.S3_ACCESS_KEY ?? '';
    this.secretKey = process.env.S3_SECRET_KEY ?? '';

    // S3-compatible endpoint: namespace-prefixed compat hostname.
    this.host =
      namespace && region
        ? `${namespace}.compat.objectstorage.${region}.oraclecloud.com`
        : '';
  }

  /** The configured storage base URL (empty string if unset). */
  getStorageBaseUrl(): string {
    return this.isConfigured()
      ? `https://${this.host}/${this.bucket}/`
      : '';
  }

  /** True when the storage endpoint is configured. */
  isConfigured(): boolean {
    return this.host.length > 0 && this.bucket.length > 0;
  }

  /**
   * Resolve a request path name (e.g. `2026_08_w2_full_news.wav`) to an
   * object key. Returns the key (possibly with a `/`-separated prefix) or an
   * empty string when the name is missing.
   */
  resolveKey(name: string): string {
    return name.replace(/^\/+/, '');
  }

  /** Build the directly-fetchable URL for an object key. */
  getItemUrl(key: string): string {
    if (!this.isConfigured()) return '';
    const encoded = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `https://${this.host}/${this.bucket}/${encoded}`;
  }

  /**
   * Compute an audio object's duration in seconds (float) by reading a small
   * header slice. Returns null when the duration cannot be determined.
   */
  async getAudioDuration(key: string): Promise<number | null> {
    try {
      const size = await this.getItemSize(key);
      if (size <= 0) return null;
      const end = Math.min(size - 1, 64 * 1024 - 1);
      const header = await this.getItemRange(key, 0, end);
      const seconds = audioDuration(key, header, size);
      return seconds === undefined ? null : seconds;
    } catch {
      return null;
    }
  }

  /** Resolve an object's size in bytes (0 when unknown/HEAD fails). */
  async getItemSize(key: string): Promise<number> {
    try {
      const objectUrl = this.getItemUrl(key);
      if (!objectUrl) return 0;
      const res = await fetch(objectUrl, {
        method: 'HEAD',
        headers: this.getSignedHeaders('HEAD', objectUrl),
      });
      if (!res.ok) return 0;
      return Number(res.headers.get('content-length') ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Fetch a contiguous byte range of an object. Returns a Buffer containing
   * the requested bytes (possibly fewer if the object is smaller).
   */
  async getItemRange(key: string, start: number, end: number): Promise<Buffer> {
    const objectUrl = this.getItemUrl(key);
    if (!objectUrl) throw new Error('Object storage is not configured');
    const range = `bytes=${start}-${end}`;
    const res = await fetch(objectUrl, {
      headers: this.getSignedHeaders('GET', objectUrl, { Range: range }),
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`Failed to fetch object range (HTTP ${res.status})`);
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  }

  /**
   * Fetch the raw object listing from the bucket. Returns an array of items
   * parsed from the S3-compatible XML response.
   */
  async listItems(prefix = ''): Promise<StorageItem[]> {
    if (!this.isConfigured()) {
      throw new Error('Object storage is not configured');
    }

    const url = new URL(`https://${this.host}/${this.bucket}`);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('delimiter', '/');
    if (prefix) url.searchParams.set('prefix', prefix);
    url.searchParams.set('max-keys', '1000');

    const res = await fetch(url, {
      headers: this.getSignedHeaders('GET', url.toString(), {
        Accept: 'application/xml',
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Failed to list storage objects (HTTP ${res.status}): ${body.slice(0, 500)}`,
      );
    }

    const text = await res.text();
    return parseListResponse(text, (name) => this.getItemUrl(name));
  }

  /**
   * Build AWS Signature Version 4 headers for a request to Object Storage.
   * Returns an empty object when credentials are not configured (public buckets).
   */
  getSignedHeaders(
    method: string,
    fullUrl: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    if (!this.accessKey || !this.secretKey) return { ...extra };

    const url = new URL(fullUrl);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const service = 's3';

    const payloadHash = extra['x-amz-content-sha256'] ?? sha256Hex('');

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-date': amzDate,
      ...extra,
    };
    if (!headers['x-amz-content-sha256']) {
      headers['x-amz-content-sha256'] = payloadHash;
    }

    // Normalize all header names to lowercase for signing and matching.
    const normalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      normalized[k.toLowerCase()] = v;
    }

    const signedHeaders = Object.keys(normalized).sort().join(';');

    const canonicalHeaders = Object.keys(normalized)
      .sort()
      .map((k) => `${k}:${normalized[k].trim()}\n`)
      .join('');

    const canonicalRequest = [
      method.toUpperCase(),
      url.pathname,
      canonicalQueryString(url),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmac(`AWS4${this.secretKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = hmacHex(kSigning, stringToSign);

    headers['Authorization'] =
      `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return headers;
  }
}

/**
 * Parse the S3-compatible ListObjectsV2 XML response into StorageItems.
 */
function parseListResponse(
  xml: string,
  buildUrl: (name: string) => string,
): StorageItem[] {
  const items: StorageItem[] = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = contentsRe.exec(xml)) !== null) {
    const block = match[1];
    const name = extractTag(block, 'Key');
    if (!name) continue;
    items.push({
      name,
      url: buildUrl(name),
      size: Number(extractTag(block, 'Size') ?? 0),
      lastModified: extractTag(block, 'LastModified') ?? '',
    });
  }
  return items;
}

function extractTag(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(block);
  return m ? m[1].trim() : undefined;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string | Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function hmacHex(key: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Build the canonical query string per SigV4 (URI-encoded, sorted by key). */
function canonicalQueryString(url: URL): string {
  if (!url.searchParams.size) return '';
  const pairs: [string, string][] = [];
  for (const [key, value] of url.searchParams.entries()) {
    pairs.push([encodeURIComponent(key), encodeURIComponent(value)]);
  }
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1,
  );
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}
