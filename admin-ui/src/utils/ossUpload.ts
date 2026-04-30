import OSS from 'ali-oss';

export type OssStsResponse = {
  ok: true;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiration: string;
  region: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  publicOrigin: string;
};

export function ossPublicUrlFromKey(publicOrigin: string, key: string) {
  const b = String(publicOrigin || '').replace(/\/$/, '');
  const k = String(key || '').replace(/^\/+/, '');
  if (!b || !k) return '';
  return `${b}/${encodeURI(k).replace(/%2F/g, '/')}`;
}

export function ossKeyForCollectionImage(prefix: string, collectionId: number, role: string, filename: string) {
  const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
  const key = `images/${collectionId}/${role}/${filename}`;
  return p ? `${p}/${key}` : key;
}

export async function putObjectWithSts(
  sts: OssStsResponse,
  key: string,
  file: File,
  opts?: { contentType?: string; onProgress?: (p: number) => void }
) {
  const client = new OSS({
    region: sts.region,
    endpoint: sts.endpoint,
    bucket: sts.bucket,
    accessKeyId: sts.accessKeyId,
    accessKeySecret: sts.accessKeySecret,
    stsToken: sts.securityToken,
    authorizationV4: true,
  });

  const headers: Record<string, string> = {};
  const ct = opts?.contentType || file.type;
  if (ct) headers['Content-Type'] = ct;

  await client.put(key, file, {
    headers,
    progress: (p: number) => {
      opts?.onProgress?.(p);
    },
  });
}

