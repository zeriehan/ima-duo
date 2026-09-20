import { TFile, Vault } from "obsidian";
import { ImaClient } from "./ima";
import { KbEntry, PushTarget } from "./types";

export interface PushOpts {
  useFileNameAsTitle: boolean;
  /**
   * 推送源文件夹的 vault 相对路径（"" 或 "/" = vault 根）。
   * 只推该文件夹「里面的内容」——文件与子文件夹按相对它的结构落到目标下，
   * 不把这一层文件夹本身推过去。
   */
  baseFolder?: string;
  /**
   * 多个源文件夹（分身里可以选多个源）。给了它就以它为准，baseFolder 被忽略。
   * 各源取并集推给同一目标；每个文件相对**它自己所属的那个源**算路径，
   * 跨源同名文件各自保留自己的子目录结构，互不顶掉。
   * 是否带上源文件夹这一层由 keepSourceRoot 决定。
   */
  baseFolders?: string[];
  /** 知识库内目标文件夹路径（相对知识库根，"" = 根）。内容落在它里面 */
  kbBasePath?: string;
  /**
   * 是否保留「源文件夹本身」这一层（默认 true）。
   *  - true：选「读书」推 → 目标端也有「读书」，里面才是子文件夹；多个源＝多棵树
   *  - false：只推里面的内容，不带这一层（子文件夹直接摊在落点下）
   * 两种情况下，目标端已存在的同名文件夹都会被复用，不会造重复的一层。
   */
  keepSourceRoot?: boolean;
  /**
   * 目标里**首次**遇到同名条目时的处理（仅在没有推送记录、即升级前推过/手动传过时才会碰到）：
   *  - "skip"（默认）：跳过，并在本地登记指纹（采纳为同一版本，日后改动仍能识别）
   *  - "rename"：改名为「名字 (2)」再新建一份
   * 注意：文件**内容改过**时不受这个开关影响 —— 见 prev 的说明。
   */
  onDuplicate?: "skip" | "rename";
  /** 关闭查重（不建议；仅用于需要强制全部新建的场合） */
  skipDedupe?: boolean;
  /**
   * 上次推送记录（键 = 文件的 vault 路径，由调用方持久化）。这是「只推改动」的基础：
   *  - 有记录且内容没变 → 什么都不做（连查重请求都不发）
   *  - 有记录但内容变了 → IMA 没有覆盖接口，只能带版本号另存一份（`名字@v2.pdf`）
   *  - 没有记录（首次，或升级前推过）→ 目标已有同名就当同一版本采纳下来，不重复造条目
   */
  prev?: PushState;
  /** 每处理完一个文件回传最新记录，由调用方合并进持久化状态 */
  onRecord?: (path: string, rec: PushRecord) => void;
}

/** 某个文件相对某个目标的上次推送记录 */
export interface PushRecord {
  /** 字节数，用于便宜的变更探测（省掉大文件的读盘） */
  size: number;
  /** 修改时间（ms），与 size 一起做快速排除 */
  mtime: number;
  /** 内容指纹（FNV-1a），确认内容是否真的变了 */
  hash: string;
  /** 当前这一版在 IMA 上用的标题 */
  title: string;
  /** 版本号：1 = 原名，2 以上 = 名字@vN */
  version: number;
  /** 原始标题（不带 @vN），用于反推历史版本的标题 */
  raw: string;
  /** 是不是文件型（标题含扩展名）；md 用「名字@v2」、文件用「名字@v2.pdf」 */
  isFile: boolean;
  /** 落地在知识库里的文件夹路径（"" = 根），用于在 IMA 客户端里定位待清理条目 */
  folder: string;
}
/** 推送状态表：文件 vault 路径 → 记录 */
export type PushState = Record<string, PushRecord>;

/**
 * 某条记录在当前版本之前的旧标题（v1…v(n-1)）。
 * 这些是"改动后就没人要了"的历史版本 —— IMA 没有删除接口，只能列出来给人手动清。
 */
export function supersededTitles(rec: PushRecord): string[] {
  const v = rec.version || 1;
  if (v < 2) return [];
  const raw = rec.raw || rec.title;
  const out: string[] = [];
  for (let i = 1; i < v; i++) out.push(i === 1 ? raw : versionedTitle(raw, i, !!rec.isFile));
  return out;
}

/**
 * 从推送记录里挑出「本地已经没有对应文件」的条目（被删掉或改名了）。
 * IMA 那边不会跟着删，只能列出来给人手动清。
 */
export function staleRecords(
  prev: PushState,
  currentPaths: Set<string>,
): { path: string; rec: PushRecord }[] {
  return Object.entries(prev)
    .filter(([p]) => !currentPaths.has(p))
    .map(([path, rec]) => ({ path, rec }));
}
export interface PushResult {
  pushed: number;
  skipped: number;
  /** 因目标已存在同名条目而跳过（属于 skipped 的子集，单独计数便于提示） */
  exists: number;
  /** 因同名而改名为新条目后成功推送 */
  renamed: number;
  /** 有记录且内容没变，直接不动（不算失败，也不是「已有同名」） */
  unchanged: number;
}

/** 标题归一，用于查重比较：去首尾空白 + Unicode 归一 */
function normTitle(s: string): string {
  return String(s || "").trim().normalize("NFC");
}

/**
 * 查重用的标题键。比 normTitle 多两步，都是为了追平 IMA 那边的"走样"：
 *  - 去掉前导的 `#`：正文首行是 `# 标题`、且后面紧跟 YAML frontmatter 时，
 *    标题里会**保留这个井号**（实测 `# book-data-combined`），而本地文件名没有
 *  - 不做大小写折叠：库里 `English` 和 `english` 可以并存，折叠会误判
 */
function titleKey(s: string): string {
  return normTitle(s).replace(/^#{1,6}\s*/, "");
}

/** 标题是否被 IMA 截断过（超长标题会变成「前 30 字...」，实测 33 字符） */
function isTruncatedTitle(k: string): boolean {
  return /(\.\.\.|…)$/.test(k) && k.replace(/(\.\.\.|…)$/, "").length >= 20;
}

/** 内容指纹（FNV-1a 32 位）。只用来判断"变没变"，不做安全用途 */
function fnv1a(u8: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
const UTF8 = new TextEncoder();
export function fnv1aText(s: string): string {
  return fnv1a(UTF8.encode(s));
}

/**
 * 「改动过的文件」在 IMA 上的新名字。
 * IMA 没有覆盖接口，改动只能另存一份，用 `@vN` 标号；带扩展名的把标号插在扩展名之前
 * （`a.pdf` → `a@v2.pdf`），否则会变成 `a.pdf@v2` 这种连系统都认不出类型的名字。
 */
export function versionedTitle(raw: string, version: number, isFile: boolean): string {
  const tag = `@v${version}`;
  if (!isFile) return `${raw}${tag}`;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return `${raw}${tag}`;
  return `${raw.slice(0, dot)}${tag}${raw.slice(dot)}`;
}

/**
 * versionedTitle 的逆运算：`名字@v2.pdf` → { raw: "名字.pdf", version: 2 }。
 * 不是本插件产生的版本名时返回 null（`@v2` 是插件专属记号，用户不会这么命名文件）。
 * 顺序有讲究：先试「带扩展名」的形式，否则 `a@v2.pdf` 会被误parse成 raw=`a@v2.pdf`。
 */
export function parseVersionedTitle(title: string): { raw: string; version: number } | null {
  const s = normTitle(title);
  const mFile = s.match(/^(.*)@v(\d+)(\.[A-Za-z0-9]{1,8})$/);
  if (mFile) return { raw: mFile[1] + mFile[3], version: Number(mFile[2]) };
  const mNote = s.match(/^(.*)@v(\d+)$/);
  if (mNote) return { raw: mNote[1], version: Number(mNote[2]) };
  return null;
}

/** 变更探测结果；text/bytes 会顺手捎给 pushOne，同一轮不重复读盘 */
interface Probe {
  size: number;
  mtime: number;
  hash: string;
  text?: string;
  bytes?: ArrayBuffer;
}

/**
 * 探测一个文件相对上次推送有没有变。
 * 先用 size+mtime 快速排除（大文件不必读盘），只有对不上才读内容算指纹。
 * stat 缺失时退化为每次读内容 —— 结果依然正确，只是慢一点。
 */
async function probeFile(vault: Vault, file: TFile, rec?: PushRecord): Promise<Probe> {
  const st: any = (file as any).stat || {};
  const size = typeof st.size === "number" ? st.size : -1;
  const mtime = typeof st.mtime === "number" ? st.mtime : -1;
  if (rec && rec.hash && size >= 0 && mtime >= 0 && rec.size === size && rec.mtime === mtime) {
    return { size, mtime, hash: rec.hash };
  }
  if (file.extension.toLowerCase() === "md") {
    const text = await vault.read(file);
    return { size: size >= 0 ? size : text.length, mtime, hash: fnv1aText(text), text };
  }
  const ab = await vault.readBinary(file);
  return { size: size >= 0 ? size : ab.byteLength, mtime, hash: fnv1a(new Uint8Array(ab)), bytes: ab };
}

/**
 * 在已存在的标题集合里给 title 找一个不冲突的新名字：「名字 (2)」「名字 (3)」…
 * 对带扩展名的文件（如 a.pdf）把序号插在扩展名之前。
 */
function uniqueTitle(title: string, taken: Set<string>, isFile: boolean): string {
  let stem = title;
  let tail = "";
  if (isFile) {
    const dot = title.lastIndexOf(".");
    if (dot > 0) {
      stem = title.slice(0, dot);
      tail = title.slice(dot);
    }
  }
  for (let n = 2; n < 1000; n++) {
    const cand = `${stem} (${n})${tail}`;
    if (!taken.has(titleKey(cand))) return cand;
  }
  return `${stem} (${Date.now()})${tail}`;
}

/**
 * 目标容器里已有标题的索引。
 * 「截断前缀」这一层是必需的：IMA 会把超长标题截成「前 30 字 + ...」存下来，
 * 本地文件名却是完整的 —— 只比全等就会把同一条目当成新文件，重复上传一份。
 */
interface TitleIndex {
  exact: Set<string>;
  prefixes: string[];
  has(raw: string): boolean;
  add(raw: string): void;
}

/** 归一路径：去掉首尾斜杠，"/" 视作 vault 根（空串） */
function normRel(p?: string): string {
  return (p || "").replace(/^\/+|\/+$/g, "");
}

/** 求 parent 相对 base 的路径；base 为空表示以 vault 根为基准 */
function relTo(parent: string, base: string): string {
  if (!base) return parent;
  if (parent === base) return "";
  if (parent.startsWith(base + "/")) return parent.slice(base.length + 1);
  return parent;
}

/** 一个文件在目标里的落点 */
export interface Placement {
  file: TFile;
  /** 相对「目标容器」（知识库里的落点文件夹 / 知识库根）的目录路径，"" = 直接落在容器里 */
  relDir: string;
}

/**
 * 计算每个文件落在目标的哪个目录。**推送与同步差异检查必须共用这一个函数** ——
 * 两边各算一遍的话，"报告说该在 A/B、实际推到了 A/C" 这种偏差永远查不出来。
 *
 * 规则：
 *  - keepSourceRoot=true（默认）：相对源文件夹的**父目录**算，于是源文件夹这一层被带过去
 *  - keepSourceRoot=false：相对源文件夹**自己**算，只推里面的内容
 *  - 源文件夹名与落点名（知识库内文件夹名 / 知识库名）同名时丢掉这一层，避免 读书/读书
 */
export function computePlacement(
  files: TFile[],
  opts: {
    baseFolder?: string;
    baseFolders?: string[];
    keepSourceRoot?: boolean;
    kbBasePath?: string;
  },
  kbName = "",
): Placement[] {
  const kbBase = normRel(opts.kbBasePath);
  const rawBases =
    opts.baseFolders && opts.baseFolders.length ? opts.baseFolders : [opts.baseFolder ?? ""];
  const bases = rawBases.map(normRel);

  /**
   * 取该文件所属的源文件夹：命中多个时用**最长**的那个，
   * 这样嵌套的源（同时选了 A 和 A/B）也会归到更具体的 A/B，路径不会算歪。
   * 空基准（vault 根）优先级最低，但永远可用。
   */
  const baseFor = (parent: string): string => {
    let best = "";
    let bestLen = -1;
    for (const b of bases) {
      if (b && parent !== b && !parent.startsWith(b + "/")) continue;
      const len = b ? b.length : 0;
      if (bestLen < 0 || len > bestLen) {
        best = b;
        bestLen = len;
      }
    }
    return bestLen < 0 ? "" : best;
  };
  /** 源文件夹的父目录；源在 vault 顶层时返回 ""（= vault 根） */
  const parentDir = (p: string): string => {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  };

  /**
   * 「落点」的名字：指定了知识库内文件夹就用那个文件夹名，否则用知识库名本身。
   * 知识库名也算数，是为了压住「本地同名文件夹推到同名知识库」这种情况，
   * 库名已经表达了这一层，再套一次就成 读书/读书 了。
   */
  const landingName = kbBase
    ? kbBase.split("/").filter(Boolean).pop() || ""
    : String(kbName || "").trim();

  /** 源文件夹名与落点名相同时不再套一层（避免 读书/读书） */
  const dropDupRoot = (rel: string): string => {
    if (!rel || !opts.keepSourceRoot || !landingName) return rel;
    const segs = rel.split("/").filter(Boolean);
    if (segs.length && segs[0].toLowerCase() === landingName.toLowerCase()) {
      return segs.slice(1).join("/");
    }
    return rel;
  };

  return files.map((f) => {
    const parent = f.parent ? f.parent.path : "";
    const src = baseFor(parent);
    const rel = opts.keepSourceRoot && src ? relTo(parent, parentDir(src)) : relTo(parent, src);
    return { file: f, relDir: dropDupRoot(rel) };
  });
}

// 文件扩展名 -> IMA media_type + content_type（移植自 ima-skills preflight-check）
function preflightForExt(ext: string): { mediaType: number; contentType: string } | null {
  const m: any = {
    pdf: [1, "application/pdf"],
    doc: [3, "application/msword"],
    docx: [3, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ppt: [4, "application/vnd.ms-powerpoint"],
    pptx: [4, "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    xls: [5, "application/vnd.ms-excel"],
    xlsx: [5, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    csv: [5, "text/csv"],
    md: [7, "text/markdown"],
    png: [9, "image/png"],
    jpg: [9, "image/jpeg"],
    jpeg: [9, "image/jpeg"],
    webp: [9, "image/webp"],
    txt: [13, "text/plain"],
    xmind: [14, "application/x-xmind"],
    mp3: [15, "audio/mpeg"],
    html: [20, "text/html"],
    epub: [21, "application/epub+zip"],
  }[ext];
  return m ? { mediaType: m[0], contentType: m[1] } : null;
}

// 推送一批文件到目标（知识库或笔记）
export async function pushFiles(
  files: TFile[],
  target: PushTarget,
  client: ImaClient,
  vault: Vault,
  opts: PushOpts,
  onLog?: (msg: string) => void,
): Promise<PushResult> {
  const kbBase = target.kind === "kb" ? normRel(opts.kbBasePath) : "";
  // 落点计算与「同步差异检查」共用同一个函数：否则报告说"该落在 A/B"、
  // 实际却推进了 A/C，这种偏差根本无从发现。
  const items = computePlacement(files, opts, target.kind === "kb" ? target.kbName : "");
  let folderIndex: Record<string, string> = {};

  if (target.kind === "kb" && target.kbId) {
    folderIndex = await client.buildFolderIndex(target.kbId);
    const dirs = new Set(items.filter((i) => i.relDir).map((i) => i.relDir));
    for (const dir of dirs) {
      // 从目标容器（知识库根 / 所选知识库内文件夹）往下建，逐级复用已存在的同名文件夹
      let cur = kbBase;
      // 优先用实时索引里的 id，避免设置里缓存的 id 已失效
      let curId: string | undefined = kbBase
        ? folderIndex[kbBase.toLowerCase()] || target.kbFolderId
        : target.kbFolderId;
      if (kbBase && !curId) {
        onLog && onLog(`⚠️ 知识库内没找到文件夹「${kbBase}」，将落在根目录`);
      }
      for (const seg of dir.split("/").filter(Boolean)) {
        cur = cur ? cur + "/" + seg : seg;
        const key = cur.toLowerCase();
        if (!folderIndex[key]) {
          const mid = await client.createFolder(target.kbId, seg, curId);
          folderIndex[key] = mid;
          onLog && onLog(`创建文件夹 ${cur}`);
        }
        curId = folderIndex[key];
      }
    }
  }

  let pushed = 0;
  let skipped = 0;
  let exists = 0;
  let renamed = 0;
  let unchanged = 0;

  // 目标容器里「已有条目标题」的索引：同一容器只查一次网络
  const takenTitles = new Map<string, TitleIndex>();
  const loadTaken = async (dedupeFolder: string): Promise<TitleIndex> => {
    const key = `${target.kind}:${target.kbId || ""}:${dedupeFolder}`;
    const cached = takenTitles.get(key);
    if (cached) return cached;
    const exact = new Set<string>();
    const prefixes: string[] = [];
    if (!opts.skipDedupe) {
      try {
        const titles =
          target.kind === "kb" && target.kbId
            ? await client.listTitlesInKb(target.kbId, dedupeFolder || undefined)
            : await client.listNoteTitles(dedupeFolder);
        for (const t of titles) {
          exact.add(titleKey(t));
          const k = titleKey(t);
          if (isTruncatedTitle(k)) prefixes.push(k.replace(/(\.\.\.|…)$/, ""));
        }
        onLog &&
          onLog(
            `目标已有条目 ${exact.size} 个（已启用同名查重${prefixes.length ? `，其中 ${prefixes.length} 个标题被 IMA 截断过` : ""}）`,
          );
      } catch (e: any) {
        onLog && onLog(`⚠️ 查重失败，本次不做重复检查：${e.message}`);
      }
    }
    const idx: TitleIndex = {
      exact,
      prefixes,
      has: (raw: string) => {
        const k = titleKey(raw);
        if (exact.has(k)) return true;
        return prefixes.some((p) => k.startsWith(p));
      },
      add: (raw: string) => {
        exact.add(titleKey(raw));
      },
    };
    takenTitles.set(key, idx);
    return idx;
  };

  for (const it of items) {
    const file = it.file;
    let folderId: string | null = null;
    /** 落地在知识库里的文件夹路径（"" = 根），随记录一起存，方便日后定位待清理条目 */
    let folderPath = target.kind === "kb" ? "" : target.noteFolderName || "";
    if (target.kind === "kb") {
      // 目标容器：文件直接落在所选的文件夹里时用它
      const containerId = kbBase
        ? folderIndex[kbBase.toLowerCase()] || target.kbFolderId || null
        : target.kbFolderId || null;
      const full = it.relDir ? (kbBase ? kbBase + "/" + it.relDir : it.relDir) : "";
      folderPath = full || kbBase || "";
      folderId = full ? folderIndex[full.toLowerCase()] || containerId : containerId;
    }
    const isMd = file.extension.toLowerCase() === "md";
    // 标题口径与推送时保持一致：md 用不带扩展名的文件名，其它文件用完整文件名
    const rawTitle = isMd ? file.basename : file.name;
    const dedupeFolder = target.kind === "kb" ? folderId || "" : target.noteFolderId || "";
    const rec = opts.prev ? opts.prev[file.path] : undefined;

    // ① 变没变？没变就彻底不动 —— 连查重请求都不发
    let probe: Probe;
    try {
      probe = await probeFile(vault, file, rec);
    } catch (e: any) {
      skipped++;
      onLog && onLog(`失败（读不到文件内容）${file.path}: ${e.message}`);
      continue;
    }
    if (rec && rec.hash && probe.hash === rec.hash) {
      unchanged++;
      // 回写探测值：可能只是被 touch 过（mtime 变了、内容没变）
      opts.onRecord &&
        opts.onRecord(file.path, { ...rec, size: probe.size, mtime: probe.mtime });
      continue;
    }

    // ② 改过了：IMA 没有覆盖接口，只能带版本号另存一份（旧版会留在库里，API 删不掉）
    let title = rawTitle;
    let version = 1;
    if (rec) {
      version = (rec.version || 1) + 1;
      title = versionedTitle(rawTitle, version, !isMd);
      onLog &&
        onLog(`「${rawTitle}」有改动 → 新建「${title}」（IMA 不支持覆盖，旧版留在库里）`);
    }

    try {
      const taken = await loadTaken(dedupeFolder);
      if (taken.has(title)) {
        if (!rec && (opts.onDuplicate || "skip") === "rename") {
          // ③-a 首次 + 「改名新建」策略：按老规矩另存一份「名字 (2)」
          title = uniqueTitle(rawTitle, taken.exact, !isMd);
          renamed++;
          onLog &&
            onLog(`「${rawTitle}」目标里已存在，改名新建为「${title}」（IMA 不支持覆盖，只能另存一份）`);
        } else if (!rec) {
          // ③-b 首次 + 默认策略：升级前推过、或你在 IMA 里手动传过同名文件。
          //      采纳为同一版本（只登记指纹），免得首次跑就造一堆重复。
          opts.onRecord &&
            opts.onRecord(file.path, {
              size: probe.size,
              mtime: probe.mtime,
              hash: probe.hash,
              title: rawTitle,
              version: 1,
              raw: rawTitle,
              isFile: !isMd,
              folder: folderPath,
            });
          exists++;
          skipped++;
          onLog &&
            onLog(`已对齐「${rawTitle}」：目标里已有同名条目，按同一版本登记（不新建）。`);
          continue;
        } else {
          // ③-c 已改动的文件：版本号撞车（少见）时往后顺延，保证这次改动一定推得出去
          let v = version;
          while (taken.exact.has(titleKey(versionedTitle(rawTitle, v, !isMd)))) v++;
          version = v;
          title = versionedTitle(rawTitle, version, !isMd);
          onLog && onLog(`「${rawTitle}」目标里已有同名版本，顺延为 ${title}`);
        }
      }
      taken.add(title);
    } catch (e: any) {
      onLog && onLog(`⚠️ 查重环节异常，仍继续推送：${e.message}`);
    }
    try {
      const r = await pushOne(file, title, target, client, vault, opts, folderId, probe);
      if (r === "pushed") {
        pushed++;
        opts.onRecord &&
          opts.onRecord(file.path, {
            size: probe.size,
            mtime: probe.mtime,
            hash: probe.hash,
            title,
            version,
            raw: rawTitle,
            isFile: !isMd,
            folder: folderPath,
          });
      } else {
        skipped++;
        onLog && onLog(`跳过 ${file.path}（${r}）`);
      }
    } catch (e: any) {
      skipped++;
      onLog && onLog(`失败 ${it.file.path}: ${e.message}`);
    }
  }
  return { pushed, skipped, exists, renamed, unchanged };
}

async function pushOne(
  file: TFile,
  title: string,
  target: PushTarget,
  client: ImaClient,
  vault: Vault,
  opts: PushOpts,
  folderId: string | null,
  pre?: Probe,
): Promise<string> {
  const ext = file.extension.toLowerCase();
  if (ext === "md") {
    // 探测阶段读到的正文直接用，别再读一遍盘
    let content = pre && pre.text !== undefined ? pre.text : await vault.read(file);
    if (opts.useFileNameAsTitle) {
      content = `# ${title}\n\n` + content;
    }
    if (target.kind === "kb" && target.kbId) {
      const noteId = await client.importDoc(content, title);
      await client.addKnowledge(target.kbId, {
        mediaType: 11,
        noteId,
        title,
        folderId: folderId || undefined,
      });
    } else {
      await client.importDoc(content, title, target.noteFolderId || undefined);
    }
    return "pushed";
  } else {
    if (target.kind === "note") {
      return "skipped-noteonly"; // 个人笔记仅支持 md
    }
    if (!target.kbId) return "skipped";
    const pf = preflightForExt(ext);
    if (!pf) return "skipped-unsupported";
    const buf = Buffer.from(pre && pre.bytes ? pre.bytes : await vault.readBinary(file));
    const cm = await client.createMedia(file.name, buf.length, pf.contentType, ext, target.kbId);
    const cred: any = cm.cos_credential;
    await client.uploadCos(buf, cred, pf.contentType);
    await client.addKnowledge(target.kbId, {
      mediaType: pf.mediaType,
      mediaId: cm.media_id,
      title,
      folderId: folderId || undefined,
      fileInfo: {
        cos_key: cred.cos_key,
        file_size: buf.length,
        last_modify_time: Math.floor(Date.now() / 1000),
        file_name: file.name,
      },
    });
    return "pushed";
  }
}

function safeName(s: string): string {
  return (s || "untitled").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}
/** 拼接 vault 路径；dir 为空时直接返回 name（避免出现前导斜杠） */
function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
/**
 * 写入结果。
 * 早期版本用 uniquePath() 对同名文件加 -2/-3 序号，导致每次拉取都堆一份重复，
 * 现在改成"镜像"语义：内容一致就不动，不同才覆盖。
 */
export type WriteOutcome = "created" | "updated" | "unchanged" | "skipped";

/** 文本文件：不存在则新建；已存在且内容一致 → 不动；内容不同 → 覆盖 */
async function writeTextReconciled(vault: Vault, p: string, content: string): Promise<WriteOutcome> {
  const existing = vault.getAbstractFileByPath(p);
  if (!existing) {
    await vault.create(p, content);
    return "created";
  }
  if (!(existing instanceof TFile)) return "skipped";
  const old = await vault.read(existing);
  if (old === content) return "unchanged";
  await vault.modify(existing, content);
  return "updated";
}

/** 二进制文件：不存在则新建；已存在且字节一致 → 不动；不同 → 覆盖 */
async function writeBinaryReconciled(
  vault: Vault,
  p: string,
  buf: ArrayBuffer,
): Promise<WriteOutcome> {
  const existing = vault.getAbstractFileByPath(p);
  if (!existing) {
    await vault.adapter.writeBinary(p, buf);
    return "created";
  }
  if (!(existing instanceof TFile)) return "skipped";
  try {
    const old = await vault.readBinary(existing);
    if (sameBytes(old, buf)) return "unchanged";
  } catch {
    // 读不出来就当作不同，走覆盖
  }
  await vault.modifyBinary(existing, buf);
  return "updated";
}

export function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

export interface PullResult {
  /** 实际落盘的文件数（新建 + 覆盖） */
  count: number;
  /** 新建的文件数 */
  created: number;
  /** 覆盖更新的文件数 */
  updated: number;
  /** 内容与本地一致、已跳过的文件数 */
  unchanged: number;
  /** 写入 vault 的相对路径（新建 + 覆盖），用于"强制阅读模式"跟踪 */
  paths: string[];
  /** 因是推送产生的历史版本（`名字@vN`）而跳过的条目 —— 它们是改动后的残留，不是独立内容 */
  skippedVersions: { title: string; folderPath: string }[];
}

// 拉取个人笔记到 vault 文件夹（list_note + export_note 下载 txt 全文）
export async function pullNotes(
  client: ImaClient,
  vault: Vault,
  destFolder: string,
  notebook: { id: string; name: string } | null,
  onLog?: (msg: string) => void,
): Promise<PullResult> {
  let groups: { name: string; notes: any[] }[] = [];
  if (!notebook || notebook.id === "") {
    const unc = await client.listNote("");
    groups.push({ name: "未分类", notes: unc });
    const nbs = await client.listNotebook();
    for (const nb of nbs) {
      const ns = await client.listNote(nb.id);
      groups.push({ name: nb.name, notes: ns });
    }
  } else {
    const ns = await client.listNote(notebook.id);
    groups.push({ name: notebook.name, notes: ns });
  }

  const tally = { created: 0, updated: 0, unchanged: 0 };
  const paths: string[] = [];
  for (const g of groups) {
    const folder = g.name === "未分类" ? destFolder : `${destFolder}/${safeName(g.name)}`;
    await ensureFolder(vault, folder);
    for (const note of g.notes) {
      try {
        const title = safeName(note.title || "untitled");
        const p = `${folder}/${title}.md`;
        const url = await client.exportNoteUrl(note.note_id);
        const txt = await client.downloadText(url);
        const outcome = await writeTextReconciled(vault, p, txt);
        if (outcome === "unchanged") {
          tally.unchanged++;
          onLog && onLog(`未变化 ${title}（跳过）`);
          continue;
        }
        tally[outcome === "created" ? "created" : "updated"]++;
        paths.push(p);
        onLog && onLog(`${outcome === "created" ? "拉取" : "更新"} ${note.title} -> ${p}`);
      } catch (e: any) {
        onLog && onLog(`拉取失败 ${note.title}: ${e.message}`);
      }
    }
  }
  return {
    count: tally.created + tally.updated,
    created: tally.created,
    updated: tally.updated,
    unchanged: tally.unchanged,
    paths,
    // 个人笔记没有 @vN 这套版本机制（那是知识库推送的产物）
    skippedVersions: [],
  };
}

export interface KbPullOpts {
  /** 是否下载知识库中的 docx/pdf 等原件（笔记类始终拉取） */
  downloadFiles: boolean;
  /** 是否在目标目录下再套一层知识库名（默认 false：知识库内容直接进目标目录） */
  nestKbName?: boolean;
  /**
   * 跳过本插件推送产生的历史版本（`名字@v2`、`名字@v2.pdf`），默认 **true**。
   * 这些是"改动后只能另存"的残留，真正的当前版另有条目 —— 一起拉下来只会在本地
   * 多出一份同内容的重复文件。要在本地留全历史时才设为 false。
   */
  skipOldVersions?: boolean;
}

// 拉取知识库到 vault 文件夹（递归）：
//  - 笔记(media_type=11)：get_media_info 拿 notebook_id -> get_doc_content 取 markdown 正文，写 .md
//  - 文件(media_type=1)：get_media_info 拿 url_info.url(+headers) 下载原件
//  - 网页/链接类（url 为 chrome:// 等不可下载）仅写占位 .md
export async function pullKnowledgeBase(
  client: ImaClient,
  vault: Vault,
  kbId: string,
  kbName: string,
  destFolder: string,
  opts: KbPullOpts = { downloadFiles: false },
  onLog?: (msg: string) => void,
): Promise<PullResult> {
  // 默认不套知识库名这一层：知识库内容直接落到目标目录（与推送行为对称）
  const dest = normRel(destFolder);
  const root = opts.nestKbName ? (dest ? `${dest}/${safeName(kbName)}` : safeName(kbName)) : dest;
  if (root) await ensureFolder(vault, root);
  const tally = { created: 0, updated: 0, unchanged: 0 };
  const paths: string[] = [];
  const skipOld = opts.skipOldVersions !== false;
  const skippedVersions: { title: string; folderPath: string }[] = [];
  /** 统一记账：一致就跳过、不同才覆盖，不再对同名文件加序号 */
  const tallyPull = (outcome: WriteOutcome, p: string, what: string) => {
    if (outcome === "skipped") return;
    if (outcome === "unchanged") {
      tally.unchanged++;
      onLog && onLog(`未变化 ${what}（跳过）`);
      return;
    }
    tally[outcome === "created" ? "created" : "updated"]++;
    paths.push(p);
    onLog && onLog(`${outcome === "created" ? "拉取" : "更新"} ${what} -> ${p}`);
  };

  async function recurse(parent: string, relDir: string) {
    let cursor = "";
    let isEnd = false;
    let g = 0;
    while (!isEnd && g++ < 200) {
      const body =
        parent === kbId
          ? { cursor, limit: 50, knowledge_base_id: kbId }
          : { cursor, limit: 50, knowledge_base_id: kbId, folder_id: parent };
      const d = await client.call("openapi/wiki/v1/get_knowledge_list", body);
      const items: any[] = d.knowledge_list || [];

      for (const it of items) {
        if (it.media_type === 99) continue; // 文件夹稍后递归
        const rawTitle = String(it.title || it.name || "未命名");
        // 推送产生的历史版本（`名字@vN`）：真正的当前版另有条目，一起拉下来
        // 只会在本地堆出一份同内容的重复文件 —— 默认跳过，日志里说明。
        if (skipOld && parseVersionedTitle(rawTitle)) {
          skippedVersions.push({ title: rawTitle, folderPath: relDir });
          onLog && onLog(`跳过历史版本「${rawTitle}」（推送残留的旧版本，当前版另有条目）`);
          continue;
        }
        const title = safeName(rawTitle);
        try {
          if (it.media_type === 11) {
            const mi = await client.getMediaInfo(it.media_id);
            const docId = mi.notebook_ext_info && mi.notebook_ext_info.notebook_id;
            if (!docId) {
              onLog && onLog(`跳过(无doc_id) ${title}`);
              continue;
            }
            const content = await client.getDocContent(docId);
            const p = joinPath(relDir, `${title}.md`);
            tallyPull(await writeTextReconciled(vault, p, content || ""), p, `笔记 ${title}`);
          } else {
            // 文件型：**任何**非笔记、非文件夹的条目都能经 url_info 拿到原件，
            // 别只认 media_type=1。pdf(1)/doc(3)/ppt(4)/xls(5)/图片(9)/txt(13)/
            // xmind(14)/音频(15)/html(20)/epub(21) 全都走这条路 —— 早先只处理 1，
            // 导致拉取时 epub 等会被当作「未知类型」静默丢掉。
            const mi = await client.getMediaInfo(it.media_id);
            const ui = mi && mi.url_info;
            const url = ui && ui.url ? String(ui.url) : "";
            if (!url || url.startsWith("chrome://")) {
              // 网页/链接类：IMA 未提供可下载原文，写占位
              const p = joinPath(relDir, `${title}.md`);
              tallyPull(
                await writeTextReconciled(
                  vault,
                  p,
                  `# ${title}\n\n> 该条目为网页/链接类，IMA 未提供可下载原文（url: ${url || "无"}）\n`,
                ),
                p,
                `链接 ${title}`,
              );
              continue;
            }
            if (!opts.downloadFiles) {
              onLog && onLog(`跳过文件（未开启下载知识库文件）${title}`);
              continue;
            }
            const buf = await client.downloadBuffer(url, ui.headers || {});
            const ext = extForEntry(title, url, Number(it.media_type));
            const p = joinPath(relDir, withExt(title, ext));
            tallyPull(await writeBinaryReconciled(vault, p, buf), p, `文件 ${title}${ext}`);
          }
        } catch (e: any) {
          onLog && onLog(`拉取失败 ${title}: ${e.message}`);
        }
      }

      for (const it of items) {
        if (it.media_type === 99) {
          const seg = safeName(it.title || it.name || "folder");
          await ensureFolder(vault, joinPath(relDir, seg));
          await recurse(it.media_id, joinPath(relDir, seg));
        }
      }

      isEnd = d.is_end;
      cursor = d.next_cursor || "";
      if (!cursor) break;
    }
  }

  await recurse(kbId, root);
  if (skippedVersions.length) {
    onLog &&
      onLog(
        `共跳过 ${skippedVersions.length} 个历史版本条目（推送残留，未拉回本地；设置里可关闭此行为）`,
      );
  }
  return {
    count: tally.created + tally.updated,
    created: tally.created,
    updated: tally.updated,
    unchanged: tally.unchanged,
    paths,
    skippedVersions,
  };
}

// ─────────────────────────────────────────────────────────────
// 同步差异检查：把「两侧对不上的东西」一次性列清楚
// ─────────────────────────────────────────────────────────────

/** 本地一个文件在差异检查里的形态（落点与标题口径与推送完全一致） */
export interface DiffLocal {
  localPath: string;
  /** 相对目标容器的目录路径 */
  relDir: string;
  /** 推上去用的标题：md 不带扩展名，其它文件带 */
  title: string;
  isFile: boolean;
  /** 当前内容指纹 */
  hash: string;
}

export interface SyncDiff {
  /** 两边都有、内容一致 —— 只计数，不逐条列 */
  synced: number;
  /** ① 本地有、IMA 没有。recorded=true = 推过但 IMA 那边已经没了（被删了） */
  localOnly: { title: string; relDir: string; localPath: string; recorded: boolean }[];
  /** ③ 两边都有但本地改过：推送会新建一个 @vN，库里原条目随即变成旧版 */
  localChanged: { title: string; relDir: string; localPath: string; nextTitle: string }[];
  /** ② IMA 有、本地没有（IMA 多出来的 / 本地删了或改名了） */
  imaOnly: { title: string; folderPath: string; isOldVersion: boolean }[];
  /** ④ 旧版本残留：本地文件还在，但这条不是当前版 —— 删掉不影响同步 */
  staleVersions: { title: string; keep: string; folderPath: string; localPath: string }[];
  /** ⑤ 同一位置出现多条同名条目 */
  duplicates: { title: string; folderPath: string; count: number }[];
}

/** 归一化的「位置键」：文件夹（忽略大小写）+ 归一标题 */
function placeKey(folder: string, title: string): string {
  return String(folder || "").toLowerCase() + "\u0000" + titleKey(title);
}

/** 拼相对路径；任一侧为空都能正确处理 */
function joinRel(a: string, b: string): string {
  const x = normRel(a);
  const y = normRel(b);
  if (!x) return y;
  if (!y) return x;
  return `${x}/${y}`;
}

/**
 * 两侧对照：本地文件（含落点、标题） ↔ 知识库条目。
 * 纯函数 —— 不联网、不读盘，网络与读盘都在 `diffProfile` 里做完。
 *
 * 两个判据缺一不可：
 *  - **位置**（文件夹 + 标题）判断"这一条在不在对面"，并照顾 IMA 的两种标题走样（前导 `#`、超长截断）
 *  - **推送记录里的指纹**判断"本地改没改" —— 只看标题永远看不出内容已经换过了
 */
export function classifyDiff(
  locals: DiffLocal[],
  imaEntries: KbEntry[],
  kbBase: string,
  prev: PushState,
): SyncDiff {
  const base = normRel(kbBase);

  // IMA 侧索引：位置键 -> 条目下标（同一位置多条 = 重复）
  const byKey = new Map<string, number[]>();
  imaEntries.forEach((e, i) => {
    const k = placeKey(e.folderPath || "", e.title);
    const arr = byKey.get(k) || [];
    arr.push(i);
    byKey.set(k, arr);
  });
  // 被截断的超长标题单独按前缀索引，否则同一条目会被当成新文件
  const trunc = new Map<string, { prefix: string; idx: number }[]>();
  imaEntries.forEach((e, i) => {
    const tk = titleKey(e.title);
    if (!isTruncatedTitle(tk)) return;
    const fk = String(e.folderPath || "").toLowerCase();
    const arr = trunc.get(fk) || [];
    arr.push({ prefix: tk.replace(/(\.\.\.|…)$/, ""), idx: i });
    trunc.set(fk, arr);
  });

  /** 在 IMA 侧找「这个文件夹里、这个标题」的条目（含被 IMA 截断存储的情况） */
  const findIma = (folder: string, title: string): number[] => {
    const out = [...(byKey.get(placeKey(folder, title)) || [])];
    const tk = titleKey(title);
    for (const t of trunc.get(folder.toLowerCase()) || []) {
      if (tk.startsWith(t.prefix) && !out.includes(t.idx)) out.push(t.idx);
    }
    return out;
  };

  const claimed = new Set<number>();
  const localOnly: SyncDiff["localOnly"] = [];
  const localChanged: SyncDiff["localChanged"] = [];
  const staleVersions: SyncDiff["staleVersions"] = [];
  const duplicates: SyncDiff["duplicates"] = [];
  let synced = 0;

  for (const l of locals) {
    const folder = joinRel(base, l.relDir);
    const rec = prev[l.localPath];
    // 当前版在 IMA 上叫什么：推过的按记录走，没推过就是原始标题
    const curTitle = rec ? rec.title : l.title;
    const changed = !!rec && rec.hash !== l.hash;
    const hits = findIma(folder, curTitle);
    for (const i of hits) claimed.add(i);

    const plain = hits.filter((i) => !parseVersionedTitle(imaEntries[i].title));
    if (plain.length > 1) {
      duplicates.push({ title: curTitle, folderPath: folder, count: plain.length });
    }

    if (changed) {
      localChanged.push({
        title: l.title,
        relDir: l.relDir,
        localPath: l.localPath,
        nextTitle: versionedTitle(l.title, (rec!.version || 1) + 1, l.isFile),
      });
    } else if (hits.length) {
      synced++;
    } else {
      // 没推过（recorded=false），或推过但 IMA 那边已经被删（recorded=true）
      localOnly.push({ title: l.title, relDir: l.relDir, localPath: l.localPath, recorded: !!rec });
    }

    // 历史版本残留：这个文件改过 N 次，库里还躺着 v1…v(n-1)
    if (rec) {
      for (const h of supersededTitles(rec)) {
        for (const i of findIma(folder, h)) {
          if (claimed.has(i)) continue;
          claimed.add(i);
          staleVersions.push({
            title: imaEntries[i].title,
            keep: curTitle,
            folderPath: folder,
            localPath: l.localPath,
          });
        }
      }
    }
  }

  // 剩下没人认领的 IMA 条目 = 本地这一侧根本没有对应文件
  const imaOnly: SyncDiff["imaOnly"] = imaEntries
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => !claimed.has(i))
    .map(({ e }) => ({
      title: e.title,
      folderPath: e.folderPath || "",
      isOldVersion: !!parseVersionedTitle(e.title),
    }));

  return { synced, localOnly, localChanged, imaOnly, staleVersions, duplicates };
}

/**
 * 对一个推送分身的某个目标做双向差异检查：联网读知识库现有条目 + 本地按落点算出"应该在哪"。
 * **纯读** —— 不写知识库、不写本地文件、不改推送记录。
 */
export async function diffProfile(
  files: TFile[],
  target: PushTarget,
  client: ImaClient,
  vault: Vault,
  opts: PushOpts,
  prev: PushState,
  onLog?: (msg: string) => void,
): Promise<SyncDiff> {
  const empty: SyncDiff = {
    synced: 0,
    localOnly: [],
    localChanged: [],
    imaOnly: [],
    staleVersions: [],
    duplicates: [],
  };
  if (target.kind !== "kb" || !target.kbId) {
    onLog && onLog("（个人笔记目标暂不支持差异检查，只支持知识库）");
    return empty;
  }
  const kbBase = normRel(opts.kbBasePath);
  const imaEntries = await client.listAllKbEntries(target.kbId);
  onLog && onLog(`知识库「${target.kbName || target.kbId}」里读到 ${imaEntries.length} 个条目`);

  const placements = computePlacement(files, opts, target.kbName);
  const locals: DiffLocal[] = [];
  for (const p of placements) {
    const isMd = p.file.extension.toLowerCase() === "md";
    // 用与推送同一个探测：size+mtime 对得上就不读盘（92MB 的 pdf 也扛得住）
    const probe = await probeFile(vault, p.file, prev[p.file.path]);
    locals.push({
      localPath: p.file.path,
      relDir: p.relDir,
      title: isMd ? p.file.basename : p.file.name,
      isFile: !isMd,
      hash: probe.hash,
    });
  }
  return classifyDiff(locals, imaEntries, kbBase, prev);
}

function extFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("?")[0];
    const m = seg.match(/\.([a-zA-Z0-9]+)$/);
    if (m) return "." + m[1].toLowerCase();
  } catch {}
  return "";
}

/** media_type -> 兜底扩展名（url 与标题里都读不到扩展名时才用） */
const EXT_BY_MEDIA_TYPE: Record<number, string> = {
  1: ".pdf",
  3: ".docx",
  4: ".pptx",
  5: ".xlsx",
  9: ".png",
  13: ".txt",
  14: ".xmind",
  15: ".mp3",
  20: ".html",
  21: ".epub",
};

/**
 * 拉取文件型条目时落地用的扩展名：优先 URL 路径里带的，
 * 其次标题里本来就有的，最后按 media_type 兜底。
 */
export function extForEntry(title: string, url: string, mediaType: number): string {
  const fromUrl = extFromUrl(url);
  if (fromUrl) return fromUrl;
  const m = String(title || "").match(/\.([a-zA-Z0-9]{1,8})$/);
  if (m) return "." + m[1].toLowerCase();
  return EXT_BY_MEDIA_TYPE[mediaType] || "";
}

/**
 * 标题已带同名扩展名时不要再拼一遍 —— 知识库里文件型条目的标题本来就是文件名
 * （含扩展名），早先直接 `${title}${ext}` 会落地成 `xxx.pdf.pdf`。
 */
export function withExt(title: string, ext: string): string {
  if (!ext) return title;
  return title.toLowerCase().endsWith(ext.toLowerCase()) ? title : title + ext;
}

async function ensureFolder(vault: Vault, folderPath: string) {
  if (!folderPath) return;
  const parts = folderPath.split("/");
  let cur = "";
  for (const p of parts) {
    cur = cur ? cur + "/" + p : p;
    if (!vault.getAbstractFileByPath(cur)) {
      try {
        await vault.createFolder(cur);
      } catch {
        // 已存在或并发冲突，忽略
      }
    }
  }
}
