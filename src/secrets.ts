import { App } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// 本插件独占的钥匙串键
export const SECRET_CLIENT_ID = "ima-duo-client-id";
export const SECRET_API_KEY = "ima-duo-api-key";

// ima.copilot Sync 插件使用的键（用于首次自动迁移，省得重复粘贴）
const SHARED_CLIENT_ID = "ima-client-id";
const SHARED_API_KEY = "ima-api-key";

export interface Creds {
  clientId: string;
  apiKey: string;
}

export interface MigrateResult extends Creds {
  /** 明文凭证是否可安全清除（仅当钥匙串确实写入成功） */
  clearPlain: boolean;
  /** 凭证来源，用于设置页提示 */
  source: string;
}

function store(app: App): any {
  const s = (app as any).secretStorage;
  if (s && typeof s.getSecret === "function" && typeof s.setSecret === "function") return s;
  return null;
}

export function hasSecretStorage(app: App): boolean {
  return !!store(app);
}

export function secretGet(app: App, id: string): string {
  const s = store(app);
  if (!s) return "";
  try {
    return s.getSecret(id) || "";
  } catch {
    return "";
  }
}

export function secretSet(app: App, id: string, value: string): boolean {
  const s = store(app);
  if (!s) return false;
  try {
    s.setSecret(id, value);
    return true;
  } catch (e) {
    console.warn("[ima-duo] 写入 Obsidian 钥匙串失败", e);
    return false;
  }
}

// 兜底：读取与本地同步脚本共用的 ~/.config/ima 凭据
export function readLocalCreds(): Creds | null {
  try {
    const home = os.homedir();
    const clientId = fs.readFileSync(path.join(home, ".config/ima/client_id"), "utf8").trim();
    const apiKey = fs.readFileSync(path.join(home, ".config/ima/api_key"), "utf8").trim();
    if (clientId && apiKey) return { clientId, apiKey };
  } catch {}
  return null;
}

/**
 * 首次运行时把散落各处的凭证统一收进 Obsidian 钥匙串，优先级：
 *   本插件钥匙串 > ima.copilot Sync 钥匙串 > data.json 明文 > ~/.config/ima 文件
 */
export function migrateCreds(app: App, plain: Partial<Creds>): MigrateResult {
  const canStore = hasSecretStorage(app);

  let clientId = secretGet(app, SECRET_CLIENT_ID);
  let apiKey = secretGet(app, SECRET_API_KEY);
  let source = clientId && apiKey ? "Obsidian 钥匙串" : "";

  if (!(clientId && apiKey)) {
    const sharedCid = secretGet(app, SHARED_CLIENT_ID);
    const sharedKey = secretGet(app, SHARED_API_KEY);
    const plainCid = (plain.clientId || "").trim();
    const plainKey = (plain.apiKey || "").trim();

    if (sharedCid && sharedKey) {
      clientId = sharedCid;
      apiKey = sharedKey;
      source = "从 ima.copilot Sync 迁移";
    } else if (plainCid && plainKey) {
      clientId = plainCid;
      apiKey = plainKey;
      source = "从旧配置迁移";
    }

    if (clientId && apiKey && canStore) {
      secretSet(app, SECRET_CLIENT_ID, clientId);
      secretSet(app, SECRET_API_KEY, apiKey);
      source = source === "从 ima.copilot Sync 迁移" ? source : "已迁入钥匙串";
    }
  }

  return {
    clientId,
    apiKey,
    // 钥匙串不可用时必须保留明文，否则凭证就丢了
    clearPlain: canStore && !!(plain.clientId || plain.apiKey),
    source,
  };
}

/** 解析 IMA 开放平台页面上复制的凭证文本 */
export function parseCredentialText(text: string): Creds | null {
  const apiKey = text.match(/API\s*Key\s*[:：]\s*(\S+)/i);
  const clientId = text.match(/Client\s*ID\s*[:：]\s*(\S+)/i);
  if (!apiKey && !clientId) return null;
  return {
    clientId: clientId ? clientId[1].trim() : "",
    apiKey: apiKey ? apiKey[1].trim() : "",
  };
}
