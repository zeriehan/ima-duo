import { requestUrl } from "obsidian";
import { KbEntry, KbFolder, KbInfo, NotebookInfo, NoteInfo } from "./types";
import { CosCredential, uploadToCos } from "./cos";

const IMA_BASE = "https://ima.qq.com";

/** 频率限制：IMA 会返回 code 200001（无 message），退避后重试即可 */
const RATE_LIMIT_CODE = 200001;
const MAX_RETRY = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 错误码解释（凭经验整理，仅用于给出更友好的提示）
 */
function describeCode(code: any, msg?: string): string {
  const map: Record<string, string> = {
    "-200": "当前使用的 SKILL / 开放平台接口版本过旧，请在 IMA 侧升级",
    "-1": "返回内容不是合法 JSON，可能是网关或网络中间层返回的错误页",
    "210001": "内容为空或过长，IMA 拒绝接收",
    "210005": "文档/笔记不存在，或该 ID 类型不匹配当前接口",
  };
  const hint = map[String(code)];
  const base = msg && msg !== "success" ? msg : "IMA 接口返回错误";
  return `${base}（code ${code}）${hint ? " —— " + hint : ""}`;
}

export class ImaClient {
  cid: string;
  key: string;
  private log?: (msg: string) => void;

  constructor(cid: string, key: string, log?: (msg: string) => void) {
    this.cid = cid;
    this.key = key;
    this.log = log;
  }

  /**
   * 统一请求入口。
   * 必须使用 Obsidian 的 requestUrl —— 渲染进程里的 fetch 受 CORS 限制，
   * 从 app://obsidian.md 直连 ima.qq.com 会被浏览器安全策略挡掉（表现为"连不上"）。
   *
   * 自带**有界退避重试**：IMA 的列表类接口偶发返回 code 200001（无 message，纯频率限制）。
   * 拉取知识库是「每层文件夹一次请求」，一次限流就会让整批中断、只镜像一半，
   * 所以这里统一兜住，退避 0.4s/0.8s/1.6s（带抖动）后重试，最多 3 次。
   */
  async call(path: string, body: any): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce(path, body);
      } catch (e: any) {
        if (Number(e?.code) !== RATE_LIMIT_CODE || attempt >= MAX_RETRY) throw e;
        const wait = 400 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
        if (this.log) this.log(`⟳ ${path} 被限流，${wait}ms 后重试（第 ${attempt + 1}/${MAX_RETRY} 次）`);
        await sleep(wait);
      }
    }
  }

  /** 单次请求（重试逻辑见 call） */
  private async callOnce(path: string, body: any): Promise<any> {
    const url = IMA_BASE + "/" + path;
    if (this.log) this.log(`→ POST ${path} ${JSON.stringify(body).slice(0, 240)}`);

    let r: Awaited<ReturnType<typeof requestUrl>>;
    try {
      r = await requestUrl({
        url,
        method: "POST",
        headers: {
          "ima-openapi-clientid": this.cid,
          "ima-openapi-apikey": this.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        throw: false,
      });
    } catch (e: any) {
      if (this.log) this.log(`✗ ${path} 网络异常 ${e?.message || e}`);
      const err: any = new Error(`网络请求失败：${e?.message || e}`);
      err.code = "NETWORK";
      throw err;
    }

    let j: any;
    try {
      j = r.json;
    } catch {
      j = { code: -1, msg: r.text };
    }
    if (this.log) this.log(`← ${path} HTTP ${r.status} ${JSON.stringify(j).slice(0, 240)}`);

    if (r.status === 401 || r.status === 403) {
      const err: any = new Error(
        `鉴权失败（HTTP ${r.status}）：Client ID / API Key 不正确或已失效，请到 ima.qq.com/agent-interface 重新获取`,
      );
      err.code = r.status;
      throw err;
    }
    if (r.status >= 500) {
      const err: any = new Error(`IMA 服务异常（HTTP ${r.status}），请稍后重试`);
      err.code = r.status;
      throw err;
    }
    if (!j || j.code !== 0) {
      const err: any = new Error(describeCode(j?.code, j?.msg));
      err.code = j?.code;
      throw err;
    }
    return j.data;
  }

  /** 连通性 + 凭证校验：能列出知识库即视为成功 */
  async testConnection(): Promise<{ count: number; names: string[] }> {
    const kbs = await this.listKnowledgeBases();
    return { count: kbs.length, names: kbs.slice(0, 5).map((k) => k.name) };
  }

  // 列出知识库（空 query 返回全部，含个人/订阅/共享），按 base_type 区分
  async listKnowledgeBases(): Promise<KbInfo[]> {
    const list: KbInfo[] = [];
    let cursor = "";
    let isEnd = false;
    let g = 0;
    while (!isEnd && g++ < 20) {
      const d = await this.call("openapi/wiki/v1/search_knowledge_base", {
        query: "",
        cursor,
        limit: 20,
      });
      for (const x of d.info_list || []) {
        list.push({
          id: x.kb_id,
          name: x.kb_name,
          baseType: x.base_type,
          contentCount: Number(x.content_count || 0),
        });
      }
      isEnd = d.is_end;
      cursor = d.next_cursor || "";
      if (!cursor) break;
    }
    return list;
  }

  // 列出知识库内全部文件夹（保留原始大小写的路径 + media_id），供 UI 选择目标文件夹
  async listFolderTree(kbId: string): Promise<KbFolder[]> {
    const out: KbFolder[] = [];
    const rec = async (parent: string, prefix: string) => {
      let cursor = "";
      let isEnd = false;
      let g = 0;
      while (!isEnd && g++ < 200) {
        const body =
          parent === kbId
            ? { cursor, limit: 50, knowledge_base_id: kbId }
            : { cursor, limit: 50, knowledge_base_id: kbId, folder_id: parent };
        const d = await this.call("openapi/wiki/v1/get_knowledge_list", body);
        for (const it of d.knowledge_list || []) {
          if (it.media_type === 99 && it.media_id) {
            const seg = (it.title || it.name || "").trim();
            const full = prefix ? prefix + "/" + seg : seg;
            out.push({ path: full, id: it.media_id });
            await rec(it.media_id, full);
          }
        }
        isEnd = d.is_end;
        cursor = d.next_cursor || "";
        if (!cursor) break;
      }
    };
    await rec(kbId, "");
    return out;
  }

  // 递归建立知识库完整文件夹树（小写 path -> media_id）
  async buildFolderIndex(kbId: string): Promise<Record<string, string>> {
    const index: Record<string, string> = {};
    for (const f of await this.listFolderTree(kbId)) index[f.path.toLowerCase()] = f.id;
    return index;
  }

  matchFolder(relDir: string, index: Record<string, string>): string | null {
    if (!relDir) return null;
    return index[relDir.toLowerCase()] || null;
  }

  /**
   * 列出知识库某个容器（根 / 指定文件夹）下的**直接**子条目标题。
   * 用于推送前的查重：同名条目已存在就不要再新建（IMA 没有覆盖接口）。
   */
  async listTitlesInKb(kbId: string, folderId?: string): Promise<string[]> {
    const out: string[] = [];
    let cursor = "";
    let isEnd = false;
    let g = 0;
    while (!isEnd && g++ < 200) {
      const body: any = { cursor, limit: 50, knowledge_base_id: kbId };
      if (folderId) body.folder_id = folderId;
      const d = await this.call("openapi/wiki/v1/get_knowledge_list", body);
      const items: any[] = d.knowledge_list || [];
      for (const it of items) {
        if (it.media_type === 99) continue; // 文件夹不算条目标题
        out.push(String(it.title || it.name || ""));
      }
      isEnd = d.is_end;
      cursor = d.next_cursor || "";
      if (!cursor || items.length === 0) break;
    }
    return out;
  }

  /** 列出某笔记本（folderId="" 为未分类）下已有笔记的标题 */
  async listNoteTitles(folderId = ""): Promise<string[]> {
    const ns = await this.listNote(folderId);
    return ns.map((n) => String(n.title || ""));
  }

  /**
   * 递归列出知识库全部条目（不含文件夹），带所在目录路径。
   * 用于扫描重复条目并生成待清理清单。
   */
  async listAllKbEntries(kbId: string): Promise<KbEntry[]> {
    const out: KbEntry[] = [];
    const rec = async (parent: string, prefix: string) => {
      let cursor = "";
      let isEnd = false;
      let g = 0;
      while (!isEnd && g++ < 200) {
        const body =
          parent === kbId
            ? { cursor, limit: 50, knowledge_base_id: kbId }
            : { cursor, limit: 50, knowledge_base_id: kbId, folder_id: parent };
        const d = await this.call("openapi/wiki/v1/get_knowledge_list", body);
        const items: any[] = d.knowledge_list || [];
        for (const it of items) {
          if (it.media_type === 99) continue;
          out.push({
            title: String(it.title || it.name || ""),
            mediaId: it.media_id,
            mediaType: Number(it.media_type),
            folderPath: prefix,
          });
        }
        for (const it of items) {
          if (it.media_type === 99 && it.media_id) {
            const seg = String(it.title || it.name || "").trim();
            await rec(it.media_id, prefix ? prefix + "/" + seg : seg);
          }
        }
        isEnd = d.is_end;
        cursor = d.next_cursor || "";
        if (!cursor || items.length === 0) break;
      }
    };
    await rec(kbId, "");
    return out;
  }

  async createFolder(kbId: string, name: string, parentId?: string): Promise<string> {
    const body: any = { knowledge_base_id: kbId, name };
    if (parentId) body.folder_id = parentId;
    const r = await this.call("openapi/wiki/v1/create_folder", body);
    return r.media_id;
  }

  // 新建笔记（可指定 folder_id 归入某笔记本；不传则默认位置）
  async importDoc(content: string, title: string, folderId?: string): Promise<string> {
    const body: any = { content_format: 1, content, title };
    if (folderId) body.folder_id = folderId;
    const r = await this.call("openapi/note/v1/import_doc", body);
    return r.note_id;
  }

  // 申请文件上传凭证
  async createMedia(
    fileName: string,
    fileSize: number,
    contentType: string,
    fileExt: string,
    kbId: string,
  ): Promise<any> {
    return await this.call("openapi/wiki/v1/create_media", {
      file_name: fileName,
      file_size: fileSize,
      content_type: contentType,
      knowledge_base_id: kbId,
      file_ext: fileExt,
    });
  }

  // 把笔记/文件加入知识库
  async addKnowledge(kbId: string, opts: any): Promise<void> {
    const body: any = { knowledge_base_id: kbId, media_type: opts.mediaType };
    if (opts.noteId) {
      body.note_info = { content_id: opts.noteId };
      body.title = opts.title;
    }
    if (opts.mediaId) {
      body.media_id = opts.mediaId;
      body.title = opts.title;
      body.file_info = opts.fileInfo;
    }
    if (opts.folderId) body.folder_id = opts.folderId;
    await this.call("openapi/wiki/v1/add_knowledge", body);
  }

  // 列出笔记本
  async listNotebook(): Promise<NotebookInfo[]> {
    const list: NotebookInfo[] = [];
    let cursor = "0";
    let isEnd = false;
    let g = 0;
    while (!isEnd && g++ < 20) {
      const d = await this.call("openapi/note/v1/list_notebook", { cursor, limit: 20 });
      for (const x of d.note_folder_infos || []) {
        list.push({ id: x.folder_id, name: x.folder_name || x.name || "未命名" });
      }
      isEnd = d.is_end;
      cursor = d.next_cursor || "";
      if (!cursor) break;
    }
    return list;
  }

  // 列出某笔记本（或 folderId 为空 = 未分类）下的笔记
  async listNote(folderId = ""): Promise<NoteInfo[]> {
    const list: NoteInfo[] = [];
    let cursor = "";
    let isEnd = false;
    let g = 0;
    while (!isEnd && g++ < 50) {
      const d = await this.call("openapi/note/v1/list_note", {
        folder_id: folderId,
        sort_type: 0,
        cursor,
        limit: 20,
      });
      for (const x of d.note_book_list || []) {
        list.push({
          note_id: x.note_id,
          title: x.title,
          folderId: x.note_ext_info?.folder_id,
          folderName: x.note_ext_info?.folder_name,
        });
      }
      isEnd = d.is_end;
      cursor = d.next_cursor || "";
      if (!cursor) break;
    }
    return list;
  }

  // 取笔记导出链接（txt 全文）
  async exportNoteUrl(noteId: string): Promise<string> {
    const d = await this.call("openapi/note/v1/export_note", { note_id: noteId });
    return d.content_url;
  }

  async downloadText(url: string): Promise<string> {
    const r = await requestUrl({ url, throw: false });
    if (r.status >= 400) throw new Error(`下载失败 HTTP ${r.status}`);
    return r.text;
  }

  // 取知识库条目元信息：笔记 -> notebook_ext_info.notebook_id；文件 -> url_info.url(+headers)
  async getMediaInfo(mediaId: string): Promise<any> {
    return await this.call("openapi/wiki/v1/get_media_info", { media_id: mediaId });
  }

  // 取笔记正文（markdown）：先用 get_media_info 拿到 notebook_id，再取正文
  async getDocContent(docId: string): Promise<string> {
    const d = await this.call("openapi/note/v1/get_doc_content", {
      doc_id: docId,
      target_content_format: 1,
    });
    return d.content || "";
  }

  // 下载二进制内容（文件条目 url_info.url，可带自定义 headers）
  async downloadBuffer(url: string, headers?: Record<string, string>): Promise<ArrayBuffer> {
    const r = await requestUrl({ url, headers: headers || {}, throw: false });
    if (r.status >= 400) throw new Error(`下载失败 HTTP ${r.status}`);
    return r.arrayBuffer;
  }

  uploadCos(buffer: Buffer, cred: CosCredential, contentType: string): Promise<void> {
    return uploadToCos(buffer, cred, contentType);
  }
}
