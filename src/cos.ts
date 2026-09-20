import * as crypto from "crypto";
import * as https from "https";

// COS 临时凭证字段（来自 create_media 返回的 cos_credential）
//
// ⚠️ 字段名跟着 IMA 变过：旧响应是 `bucket`，现在的响应是 `bucket_name`
//    （形如 ima-share-kb-1258344701，已含 -appid 后缀），另外还给了
//    appid / custom_domain / start_time / expired_time。
//    2026-09-19 实测：只读旧 `bucket` 时值是 undefined，拼出来的域名是
//    「undefined.cos.ap-shanghai.myqcloud.com」，COS 直接回 400
//    InvalidRequest: Bucket format should be <bucketname>-<appid> —— 
//    笔记走 import_doc + add_knowledge 不经 COS，所以只有 pdf/epub 这类文件型全挂。
export interface CosCredential {
  bucket_name?: string;
  bucket?: string;
  region: string;
  secret_id: string;
  secret_key: string;
  token: string;
  cos_key: string;
  appid?: string;
  custom_domain?: string;
  start_time?: string;
  expired_time?: string;
  [k: string]: any;
}

/** 取上传用的 COS 域名：<bucket_name>.<region>.myqcloud.com（虚拟主机式） */
export function cosHostOf(cred: CosCredential): string {
  const bucket = String(cred.bucket_name || cred.bucket || "").trim();
  const region = String(cred.region || "").trim();
  if (!bucket) throw new Error("COS 凭证里没有 bucket_name，无法拼接上传域名");
  if (!region) throw new Error("COS 凭证里没有 region，无法拼接上传域名");
  return `${bucket}.cos.${region}.myqcloud.com`;
}

/** 签名有效期：优先用服务端下发的 start_time / expired_time，避免本机时钟偏差 */
export function cosSignWindow(cred: CosCredential): { startTime: number; expiredTime: number } {
  const now = Math.floor(Date.now() / 1000);
  const startTime = Number(cred.start_time) || now;
  const expiredTime = Number(cred.expired_time) || startTime + 3600;
  return { startTime, expiredTime };
}

function hmacSha1(key: string, data: string): string {
  return crypto.createHmac("sha1", key).update(data).digest("hex");
}
function sha1(data: string): string {
  return crypto.createHash("sha1").update(data).digest("hex");
}

// COS PUT Object 签名（参考腾讯云文档 https://cloud.tencent.com/document/product/436/7778）
function buildAuthorization(opts: {
  secretId: string;
  secretKey: string;
  method: string;
  pathname: string;
  headers: Record<string, string>;
  startTime: number;
  expiredTime: number;
}): string {
  const keyTime = `${opts.startTime};${opts.expiredTime}`;
  const signKey = hmacSha1(opts.secretKey, keyTime);
  const headerKeys = Object.keys(opts.headers).sort();
  const httpHeaders = headerKeys
    .map((k) => `${k.toLowerCase()}=${encodeURIComponent(opts.headers[k])}`)
    .join("&");
  const httpString = `${opts.method.toLowerCase()}\n${opts.pathname}\n\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`;
  const signature = hmacSha1(signKey, stringToSign);
  const headerList = headerKeys.map((k) => k.toLowerCase()).join(";");
  return [
    "q-sign-algorithm=sha1",
    `q-ak=${opts.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    "q-url-param-list=",
    `q-signature=${signature}`,
  ].join("&");
}

// 把文件内容（Buffer）PUT 上传到 COS
export function uploadToCos(
  buffer: Buffer,
  cred: CosCredential,
  contentType: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let hostname: string;
    try {
      hostname = cosHostOf(cred);
    } catch (e: any) {
      reject(e);
      return;
    }
    const pathname = `/${cred.cos_key}`;
    const { startTime, expiredTime } = cosSignWindow(cred);
    const signHeaders = {
      "content-length": String(buffer.length),
      host: hostname,
    };
    const authorization = buildAuthorization({
      secretId: cred.secret_id,
      secretKey: cred.secret_key,
      method: "PUT",
      pathname,
      headers: signHeaders,
      startTime,
      expiredTime,
    });
    const options: any = {
      hostname,
      port: 443,
      path: pathname,
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": buffer.length,
        Authorization: authorization,
        "x-cos-security-token": cred.token,
      },
      timeout: 300_000,
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (c: any) => (body += c));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
        else
          reject(
            new Error(
              `COS 上传失败 (HTTP ${res.statusCode}) @ ${hostname}：${String(body).replace(/\s+/g, " ").slice(0, 300)}`,
            ),
          );
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("COS 上传超时"));
    });
    req.on("error", (err) => reject(err));
    req.write(buffer);
    req.end();
  });
}
