import {
  Plugin,
  App,
  TFile,
  TFolder,
  Notice,
  Setting,
  Modal,
  SuggestModal,
  PluginSettingTab,
  Platform,
  MarkdownView,
} from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { ImaClient } from "./ima";
import {
  pushFiles,
  pullNotes,
  pullKnowledgeBase,
  diffProfile,
  PushOpts,
  PushState,
  SyncDiff,
  staleRecords,
  supersededTitles,
  sameBytes,
} from "./sync";
import { KbEntry, KbFolder, KbInfo, PushTarget } from "./types";
import {
  SECRET_API_KEY,
  SECRET_CLIENT_ID,
  hasSecretStorage,
  migrateCreds,
  parseCredentialText,
  readLocalCreds,
  secretGet,
  secretSet,
} from "./secrets";

/**
 * 推送「分身」：一组源文件夹 → 一组目标。
 * 所有源取并集作为一次推送的内容，每个目标都会收到**全部源**的内容；
 * 每个文件相对它自己所属的源文件夹算路径（不会多套一层父目录）；
 * 每个目标各自独立查重，已存在的同名条目不重复推。
 */
export interface PushProfile {
  id: string;
  name: string;
  /** 源文件夹（vault 相对路径）；"" 或 "/" = vault 根 */
  folders: string[];
  /** 目标（知识库或个人笔记），可多个 */
  targets: PushTarget[];
  /**
   * 是否把「源文件夹本身」这一层也推过去（默认 true）。
   *  - true：选「读书」→ 目标端也有「读书」，里面才是子文件夹
   *  - false：只推里面的内容，子文件夹直接摊在落点下
   */
  keepRoot: boolean;
}

/** 拉取「分身」：一组知识库（可选含个人笔记）→ 一个本地目录 */
export interface PullProfile {
  id: string;
  name: string;
  kbIds: string[];
  /** 是否同时拉取 ima 个人笔记（按笔记本建子目录） */
  includeNotes: boolean;
  /** 落地目录（vault 相对路径） */
  dest: string;
  /** 是否下载知识库里的 docx/pdf 等文件原件 */
  downloadFiles: boolean;
  /** 是否在落地目录下再套一层知识库名 */
  nestKbName: boolean;
}

let idSeq = 0;
function newProfileId(prefix: string): string {
  idSeq++;
  return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 5)}`;
}

interface ImaDuoSettings {
  /** 仅作旧版明文迁移来源，迁移进钥匙串后会清空 */
  clientId: string;
  apiKey: string;
  useLocalCreds: boolean;

  useFileNameAsTitle: boolean;

  /** 推送分身列表（当前的主配置） */
  pushProfiles: PushProfile[];
  /** 拉取分身列表（当前的主配置） */
  pullProfiles: PullProfile[];
  /** 是否已把旧版单项设置迁移成分身（只做一次） */
  profilesMigrated: boolean;

  /** @deprecated 旧版单份推送配置，已迁移进 pushProfiles，仅作迁移来源 */
  pushFolder: string;
  /** @deprecated 见 pushFolder */
  pushTarget: PushTarget | null;
  /**
   * 目标里已有同名条目时怎么办（只在**没有推送记录**时才会碰到，即升级前推过/手动传过）：
   *  - "skip"（默认）跳过，并按同一版本登记下来（避免首次跑就造一堆重复）
   *  - "rename" 改名为「名字 (2)」再新建一份
   * 注意：文件**内容改过**时不受这个开关影响 —— IMA 没有覆盖接口，改过的只能带 @vN 另存。
   */
  onDuplicate: "skip" | "rename";

  /**
   * 推送记录：`分身id|目标key|文件vault路径` → {size,mtime,hash,title,version}。
   * 「只推改动」靠它：没变的不推，变了的带版本号另存。**不要手动编辑**。
   */
  pushState: PushState;

  /**
   * 拉取时跳过本插件推送产生的历史版本（`名字@v2`、`名字@v2.pdf`），默认 true。
   * 这些是"改动后只能另存"留下的残留，真正的当前版另有条目 —— 一起拉下来
   * 只会在本地多出一份同内容的重复文件。要在本地留全历史才关掉。
   */
  skipOldVersions: boolean;

  /** @deprecated 已迁移进 pullProfiles */
  pullNotesEnabled: boolean;
  /** @deprecated 已迁移进 pullProfiles */
  pullKbEnabled: boolean;
  /** @deprecated 已迁移进 pullProfiles */
  pullNotesFolder: string;
  /** @deprecated 已迁移进 pullProfiles */
  pullKbFolder: string;
  /** @deprecated 已迁移进 pullProfiles */
  pullKbIds: string[];
  /** id -> 知识库名。缓存下来，设置页在没联网时也能显示名字而不是只有 id */
  pullKbNames: Record<string, string>;
  /** @deprecated 已迁移进 pullProfiles */
  downloadFiles: boolean;
  /** @deprecated 已迁移进 pullProfiles */
  kbNameAsSubfolder: boolean;

  forceReadingMode: boolean;
  pulledPaths: string[];
  enableDebugLog: boolean;

  /** 自动同步总开关：关闭时不起定时器，一切照旧手动跑 */
  autoSyncEnabled: boolean;
  /** 每天自动同步的时刻表（24 小时制 "HH:MM"，已排序去重）。空数组 = 不自动跑 */
  autoSyncTimes: string[];
  /** 自动同步跑哪边：both=推送+拉取（默认），push=仅推送，pull=仅拉取 */
  autoSyncMode: "both" | "push" | "pull";
  /** 上次自动同步完成时间（epoch ms，0 = 从未跑过），用于设置页/面板显示 */
  autoSyncLastAt: number;
}

const DEFAULT_SETTINGS: ImaDuoSettings = {
  clientId: "",
  apiKey: "",
  useLocalCreds: false,
  useFileNameAsTitle: true,
  pushProfiles: [],
  pullProfiles: [],
  profilesMigrated: false,
  pushFolder: "",
  pushTarget: null,
  onDuplicate: "skip",
  pushState: {},
  skipOldVersions: true,
  pullNotesEnabled: false,
  pullKbEnabled: true,
  pullNotesFolder: "ima/笔记",
  pullKbFolder: "ima/知识库",
  pullKbIds: [],
  pullKbNames: {},
  downloadFiles: false,
  kbNameAsSubfolder: false,
  forceReadingMode: false,
  pulledPaths: [],
  enableDebugLog: false,
  autoSyncEnabled: false,
  autoSyncTimes: ["09:00"],
  autoSyncMode: "both",
  autoSyncLastAt: 0,
};

/** 目标的可读标签，用于设置页展示 */
export function targetLabel(t: PushTarget | null): string {
  if (!t) return "";
  return t.kind === "kb" ? `知识库「${t.kbName}」` : `个人笔记「${t.noteFolderName}」`;
}

/**
 * 目标的稳定标识，用于给推送记录分组（同一个文件推到不同目标互不干扰）。
 * 只取会影响落点的字段：换知识库、换落点文件夹都会得到新的分组。
 */
export function targetKeyOf(t: PushTarget): string {
  return t.kind === "kb"
    ? `kb:${t.kbId || ""}:${t.kbFolderPath || ""}`
    : `note:${t.noteFolderId || ""}`;
}

/** 目标 + 落点，用于分身里逐条展示 */
export function targetDetail(t: PushTarget): string {
  if (t.kind !== "kb") return `个人笔记「${t.noteFolderName}」`;
  return t.kbFolderPath
    ? `知识库「${t.kbName}」/ ${t.kbFolderPath}`
    : `知识库「${t.kbName}」（知识库根目录）`;
}

/** 目标的窄版说法（同步面板的行里用，省地方） */
export function targetBrief(t: PushTarget): string {
  if (t.kind !== "kb") return `个人笔记「${t.noteFolderName}」`;
  return t.kbFolderPath ? `知识库「${t.kbName}」/ ${t.kbFolderPath}` : `知识库「${t.kbName}」`;
}

/**
 * 列表太长时的折叠说法：超过 max 项就只说前几项 + 「等 N 个」。
 * 面板一行放不下十几条路径，与其被省略号从中间切断，不如给个能读的摘要。
 */
export function summarizeList(items: string[], max = 2): string {
  if (items.length <= max) return items.join("、");
  return `${items.slice(0, max).join("、")} 等 ${items.length} 个`;
}

/** 自动同步「跑哪边」的可读标签（设置页与面板共用） */
export function autoSyncModeLabel(m: string): string {
  if (m === "push") return "仅推送";
  if (m === "pull") return "仅拉取";
  return "推送 + 拉取";
}

/**
 * 把 "9:5" / "09:05" / "0905" 这类写法规范成 24 小时制的 "HH:MM"。
 * 解析不了或超出范围时返回 null（调用方负责丢弃）。
 */
export function normalizeTimeValue(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(s) || /^(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** 规范时刻表：逐个校验、去重、按时间先后排序 */
export function normalizeTimeList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    const t = normalizeTimeValue(raw);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.sort();
}

/** 某个时刻在「day 这一天」对应的本地时间戳 */
function timeOnDayAt(time: string, day: Date): number {
  const [h, m] = time.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).getTime();
}

/** 下一个到点时刻（严格晚于 now）；没配置则 null */
export function nextTimeAt(times: string[], now: number): number | null {
  let best: number | null = null;
  for (const t of times) {
    const d = new Date(now);
    let at = timeOnDayAt(t, d);
    if (at <= now) {
      d.setDate(d.getDate() + 1);
      at = timeOnDayAt(t, d);
    }
    if (best === null || at < best) best = at;
  }
  return best;
}

/** 已经过去的最近一个时刻（用来判断「错过了要不要补跑」）；没配置则 null */
export function lastTimeAt(times: string[], now: number): number | null {
  let best: number | null = null;
  for (const t of times) {
    const d = new Date(now);
    let at = timeOnDayAt(t, d);
    if (at > now) {
      d.setDate(d.getDate() - 1);
      at = timeOnDayAt(t, d);
    }
    if (best === null || at > best) best = at;
  }
  return best;
}

/** 「＋ 添加时刻」的初值：空表给 09:00，否则比最后一个晚一小时（加闹钟的手感） */
export function nextSuggestedTime(times: string[]): string {
  if (!times.length) return "09:00";
  const [h] = times[times.length - 1].split(":").map(Number);
  return `${String((h + 1) % 24).padStart(2, "0")}:00`;
}

/** 拉取重复清理的候选项：疑似旧版 uniquePath 产生的 `a-2.md` */
export interface DupCandidate {
  file: TFile;
  /** 对应的主文件路径（a-2.md → a.md） */
  basePath: string;
  /** 内容是否与主文件完全一致（一致才可安全删除） */
  identical: boolean;
}

export default class ImaDuoPlugin extends Plugin {
  settings: ImaDuoSettings;
  /** 知识库目录缓存，避免设置页每次都打网络 */
  kbCache: KbInfo[] = [];
  /** 凭证来源说明，展示在设置页 */
  credSource = "";
  usingSecretStorage = false;
  /** 设置页注册的回调：配置项变更后立即重绘设置页 */
  onSettingsChanged: (() => void) | null = null;
  /** 推送进行中标记：防止连点导致重复推送 */
  pushBusy = false;
  /** 拉取进行中标记：防止「全部拉取」与单个分身同时跑 */
  pullBusy = false;

  refreshSettingsUi() {
    if (this.onSettingsChanged) this.onSettingsChanged();
  }

  private pulledPaths = new Set<string>();
  private statusEl: HTMLElement | null = null;

  /** 下一次到点的定时器句柄（关闭 / 改时刻表时重建） */
  private autoSyncTimer: number | null = null;
  /** 启动后补跑（追平错过的时刻）的定时器句柄 */
  private startupTimer: number | null = null;
  /** 一轮自动同步进行中标记：避免与自身或手动任务叠跑 */
  private autoSyncRunning = false;
  /** 静默开关：自动同步期间不弹通知（状态栏照常更新） */
  private quietRun = false;

  async onload() {
    await this.loadSettings();

    this.usingSecretStorage = hasSecretStorage(this.app);
    const m = migrateCreds(this.app, {
      clientId: this.settings.clientId,
      apiKey: this.settings.apiKey,
    });
    this.credSource = m.source;
    if (m.clearPlain) {
      // 凭证已收进钥匙串，配置文件里不再保留明文
      this.settings.clientId = "";
      this.settings.apiKey = "";
      await this.saveSettings();
    }

    this.pulledPaths = new Set(this.settings.pulledPaths || []);
    await this.migrateLegacyProfiles();

    if (Platform.isDesktop) {
      this.statusEl = this.addStatusBarItem();
      this.setStatus("IMA Duo 就绪");
    }

    this.addSettingTab(new ImaDuoSettingTab(this.app, this));

    // 自动同步：按设置起定时器（关闭时不占任何资源）
    this.restartAutoSync();

    this.addRibbonIcon("refresh-cw", "IMA Duo：打开同步面板", () => this.openPanel());

    this.addCommand({
      id: "open-panel",
      name: "打开同步面板（推送 / 拉取列表）",
      callback: () => this.openPanel(),
    });
    this.addCommand({ id: "push-active-file", name: "推当前文件到 IMA（选目标）", callback: () => this.pushActiveFile() });
    this.addCommand({ id: "push-folder", name: "推送文件夹到 IMA（选文件夹和目标）", callback: () => this.pushFolderCmd() });
    this.addCommand({
      id: "push-profiles",
      name: "运行全部推送分身",
      callback: () => this.confirmRunAllPush(),
    });
    this.addCommand({
      id: "push-profile",
      name: "运行指定推送分身",
      callback: () =>
        new ProfileSuggestModal(this.app, "选择要运行的推送分身…", this.settings.pushProfiles, (p) =>
          void this.runPushProfile(p as PushProfile),
        ).open(),
    });
    this.addCommand({ id: "pull-notes", name: "拉取个人笔记到 vault", callback: () => this.pullNotesCmd() });
    this.addCommand({ id: "pull-kb", name: "拉取知识库到 vault", callback: () => this.pullKbCmd() });
    this.addCommand({ id: "pull-all", name: "运行全部拉取分身", callback: () => this.runPullAll() });
    this.addCommand({
      id: "pull-profile",
      name: "运行指定拉取分身",
      callback: () =>
        new ProfileSuggestModal(this.app, "选择要运行的拉取分身…", this.settings.pullProfiles, (p) =>
          void this.runPullProfile(p as PullProfile),
        ).open(),
    });
    this.addCommand({
      id: "auto-sync-now",
      name: "立即自动同步一次（推送 / 拉取）",
      callback: () => void this.runAutoSync({ manual: true }),
    });
    this.addCommand({
      id: "scan-duplicates",
      name: "检查知识库重复条目（生成清单）",
      callback: () => void this.pickAndScanDuplicates(),
    });
    this.addCommand({
      id: "sync-diff",
      name: "检查同步差异（本地 ↔ 知识库，生成清单）",
      callback: () => void this.writeSyncDiffReport(),
    });
    this.addCommand({
      id: "stale-report",
      name: "列出待清理条目（旧版本 / 本地已删除）",
      callback: () => void this.writeStaleReport(),
    });
    this.addCommand({
      id: "clean-pull-duplicates",
      name: "清理拉取产生的重复文件",
      callback: () => void this.cleanPullDuplicates(),
    });

    // 强制阅读模式：拉取下来的文件默认以阅读视图打开，避免误编辑被下次同步覆盖
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!this.settings.forceReadingMode || !file) return;
        if (!this.pulledPaths.has(file.path)) return;
        window.setTimeout(() => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view || view.file?.path !== file.path) return;
          try {
            if (view.getMode() !== "preview") view.setState({ mode: "preview" }, { history: false });
          } catch {}
        }, 0);
      }),
    );
  }

  onunload() {
    this.stopAutoSync();
  }

  // ---------- 基础设施 ----------

  setStatus(text: string) {
    if (this.statusEl) this.statusEl.setText(text);
  }

  log(msg: string) {
    console.debug("[ima-duo]", msg);
    if (!this.settings.enableDebugLog) return;
    try {
      const dir = this.manifest.dir;
      if (!dir) return;
      const base = (this.app.vault.adapter as any).getBasePath?.();
      if (!base) return;
      fs.appendFileSync(
        path.join(base, dir, "ima-debug.log"),
        `[${new Date().toISOString()}] ${msg}\n`,
        "utf8",
      );
    } catch {}
  }

  logFilePath(): string {
    const dir = this.manifest.dir || `${this.app.vault.configDir}/plugins/ima-duo`;
    return `${dir}/ima-debug.log`;
  }

  getCreds(): { clientId: string; apiKey: string } {
    let clientId = secretGet(this.app, SECRET_CLIENT_ID);
    let apiKey = secretGet(this.app, SECRET_API_KEY);
    if (!clientId) clientId = this.settings.clientId || "";
    if (!apiKey) apiKey = this.settings.apiKey || "";
    if (this.settings.useLocalCreds) {
      const local = readLocalCreds();
      if (local) {
        clientId = local.clientId;
        apiKey = local.apiKey;
      }
    }
    return { clientId, apiKey };
  }

  saveCreds(clientId: string, apiKey: string) {
    if (this.usingSecretStorage) {
      if (clientId) secretSet(this.app, SECRET_CLIENT_ID, clientId);
      if (apiKey) secretSet(this.app, SECRET_API_KEY, apiKey);
    } else {
      this.settings.clientId = clientId;
      this.settings.apiKey = apiKey;
      void this.saveSettings();
    }
  }

  getClient(): ImaClient {
    const { clientId, apiKey } = this.getCreds();
    if (!clientId || !apiKey) {
      throw new Error("未配置 IMA 凭证：请在设置中填写 Client ID 与 API Key，或开启「从本地文件读取凭证」。");
    }
    return new ImaClient(clientId, apiKey, (m) => this.log(m));
  }

  async refreshKbCache(): Promise<KbInfo[]> {
    const kbs = await this.getClient().listKnowledgeBases();
    this.kbCache = kbs;
    // 顺带刷新分身里选过的知识库名字缓存，重启后设置页也能显示名字
    const ids = new Set<string>();
    for (const prof of this.settings.pullProfiles || []) for (const id of prof.kbIds) ids.add(id);
    let dirty = false;
    for (const k of kbs) {
      if (ids.has(k.id) && this.settings.pullKbNames[k.id] !== k.name) {
        this.settings.pullKbNames[k.id] = k.name;
        dirty = true;
      }
    }
    if (dirty) await this.saveSettings();
    return kbs;
  }

  /** 知识库显示名：实时缓存 → 持久化名字表 → id 前缀 */
  kbNameOf(id: string): string {
    const hit = this.kbCache.find((k) => k.id === id);
    if (hit) return hit.name;
    return this.settings.pullKbNames[id] || id.slice(0, 8);
  }

  /** 取某文件夹（vault 相对路径）下的所有文件；"" 或 "/" = 全库 */
  filesUnderPath(folderPath: string): TFile[] {
    const all = this.app.vault.getFiles();
    if (!folderPath || folderPath === "/") return all;
    return all.filter((f) => f.path.startsWith(folderPath + "/"));
  }

  describeFolder(p: string): string {
    if (!p) return "未选择";
    if (p === "/") return "vault 根目录";
    return p;
  }

  /**
   * 打开同步面板（侧边栏图标 / 命令面板入口）。
   * 面板里列出全部推送与拉取分身，逐个可跑；比"点一下就盲推当前文件"可控得多。
   */
  openPanel() {
    new ImaDuoPanelModal(this.app, this).open();
  }

  // ---------- 自动同步 ----------

  /**
   * 统一通知出口：自动同步期间（quietRun=true）只写日志、不弹通知，
   * 否则每 N 分钟弹一串「推送完成 / 拉取完成」会刷屏。手动操作时照常弹。
   */
  private notify(msg: string, timeout?: number) {
    if (this.quietRun) {
      this.log(`[静默通知] ${msg}`);
      return;
    }
    new Notice(msg, timeout);
  }

  /** 设置页 / 面板显示用的自动同步状态文案 */
  autoSyncStatusText(): string {
    const s = this.settings;
    if (!s.autoSyncEnabled) return "已关闭";
    const times = normalizeTimeList(s.autoSyncTimes);
    const last = s.autoSyncLastAt
      ? new Date(s.autoSyncLastAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "尚未运行";
    const when = times.length ? `每天 ${times.join("、")}` : "未设时刻";
    return `${when} · ${autoSyncModeLabel(s.autoSyncMode)} · 上次 ${last}`;
  }

  /**
   * 按当前设置（重）建自动同步定时器。开关、时刻表、内容任一项变动都走这里，
   * 保证任何时候只挂一个到点定时器。关闭或时刻表为空时清掉全部定时器。
   */
  restartAutoSync() {
    this.stopAutoSync();
    const s = this.settings;
    if (!s.autoSyncEnabled) return;

    s.autoSyncTimes = normalizeTimeList(s.autoSyncTimes);
    if (!s.autoSyncTimes.length) {
      this.log("自动同步已开启，但没设时刻：不会自动跑");
      return;
    }

    // 错过补跑：最近一个应跑时刻晚于上次运行（含从未跑过）→ 启动后补一轮。
    // 只补一次，不是把错过的每个时刻都跑一遍。
    const last = lastTimeAt(s.autoSyncTimes, Date.now());
    if (last !== null && s.autoSyncLastAt < last) {
      this.startupTimer = window.setTimeout(() => {
        this.startupTimer = null;
        void this.runAutoSync();
      }, 20_000);
    }
    this.armNextAutoSync();
    this.log(
      `自动同步已开启：每天 ${s.autoSyncTimes.join("、")}（${autoSyncModeLabel(s.autoSyncMode)}）`,
    );
  }

  /** 排下一次到点执行；触发后自己续上下一轮（一天一个，不堆积） */
  private armNextAutoSync() {
    if (this.autoSyncTimer !== null) {
      window.clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    const next = nextTimeAt(normalizeTimeList(this.settings.autoSyncTimes), Date.now());
    if (next === null) return;
    // setTimeout 上限 2^31-1 ms（约 24.8 天），这里最多一天，取个小于上限的值保险
    const delay = Math.max(1_000, Math.min(next - Date.now(), 2_147_000_000));
    this.autoSyncTimer = window.setTimeout(() => {
      this.autoSyncTimer = null;
      void this.runAutoSync().then(
        () => this.armNextAutoSync(),
        () => this.armNextAutoSync(),
      );
    }, delay);
  }

  /** 停止自动同步并清定时器（onunload / 关闭开关 / 改设置时用） */
  stopAutoSync() {
    if (this.autoSyncTimer !== null) {
      window.clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    if (this.startupTimer !== null) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  /**
   * 跑一轮自动同步。到点、启动补跑、面板/设置页「立即同步」共用这一个入口。
   * 三条守卫：已有同步在跑 → 跳过；手动推/拉正在进行 → 跳过；没有任何可跑分身 → 跳过。
   */
  async runAutoSync(opts: { manual?: boolean } = {}) {
    const s = this.settings;
    if (!opts.manual && !s.autoSyncEnabled) return;
    if (this.autoSyncRunning) return;
    if (this.pushBusy || this.pullBusy) {
      this.log("自动同步跳过：已有手动推送/拉取在进行");
      return;
    }
    const { clientId, apiKey } = this.getCreds();
    if (!clientId || !apiKey) {
      new Notice("自动同步：未配置 IMA 凭证，已跳过");
      return;
    }

    const mode = s.autoSyncMode || "both";
    const doPush = mode !== "pull";
    const doPull = mode !== "push";
    const hasPush =
      doPush && (s.pushProfiles || []).some((p) => p.folders.length && p.targets.length);
    const hasPull =
      doPull && (s.pullProfiles || []).some((p) => p.kbIds.length || p.includeNotes);
    if (!hasPush && !hasPull) {
      if (opts.manual) new Notice("没有可运行的同步分身：检查推送 / 拉取的配置");
      return;
    }

    this.autoSyncRunning = true;
    const prevQuiet = this.quietRun;
    this.quietRun = true;
    this.setStatus("自动同步中…");
    this.log(`—— 自动同步开始（${autoSyncModeLabel(mode)}）——`);
    try {
      if (hasPush) await this.runAllPushProfiles();
      if (hasPull) await this.runPullAll(true);
      s.autoSyncLastAt = Date.now();
      await this.saveSettings();
      this.setStatus(
        `自动同步完成 ${new Date(s.autoSyncLastAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`,
      );
    } catch (e: any) {
      this.setStatus("自动同步失败");
      this.log("自动同步失败：" + e.message);
      new Notice("自动同步失败：" + e.message, 8000);
    } finally {
      this.quietRun = prevQuiet;
      this.autoSyncRunning = false;
    }
  }

  /**
   * 渲染「同步时刻」编辑器：一行一个时刻（24 小时制），＋ 添加、✕ 删除。
   * 设置页与侧边栏面板共用同一套 UI；onChange 在增删改之后调用，
   * 用来重建定时器并重绘当前界面。
   */
  renderAutoSyncTimes(containerEl: HTMLElement, onChange: () => void) {
    const s = this.settings;
    const enabled = s.autoSyncEnabled;
    const times = normalizeTimeList(s.autoSyncTimes);
    const list = containerEl.createDiv({ cls: "ima-time-list" });

    times.forEach((t, i) => {
      const row = list.createDiv({ cls: "ima-time-row" });
      const input = row.createEl("input", { cls: "ima-input-time" });
      input.type = "time";
      input.value = t;
      input.disabled = !enabled;
      input.setAttribute("aria-label", `第 ${i + 1} 个同步时刻`);
      input.onchange = () => {
        const next = times.slice();
        next[i] = input.value;
        void this.commitAutoSyncTimes(next, onChange);
      };

      const del = row.createEl("button", { cls: "ima-time-del", text: "✕" });
      del.setAttribute("aria-label", `删除第 ${i + 1} 个同步时刻`);
      del.disabled = !enabled;
      del.onclick = () => {
        void this.commitAutoSyncTimes(
          times.filter((_, k) => k !== i),
          onChange,
        );
      };
    });

    const add = list.createEl("button", { cls: "ima-time-add", text: "＋ 添加时刻" });
    add.disabled = !enabled;
    add.onclick = () => void this.commitAutoSyncTimes([...times, nextSuggestedTime(times)], onChange);
  }

  /** 保存时刻表并重排定时器（增 / 删 / 改共用） */
  private async commitAutoSyncTimes(next: string[], onChange: () => void) {
    this.settings.autoSyncTimes = normalizeTimeList(next);
    await this.saveSettings();
    this.restartAutoSync();
    onChange();
  }

  // ---------- 推送 ----------

  /** 弹出目标选择（知识库 / 个人笔记）。只负责选，选完回调，不直接推送 */
  private pickTarget(cb: (t: PushTarget) => void) {
    let client: ImaClient;
    try {
      client = this.getClient();
    } catch (e: any) {
      new Notice(e.message);
      return;
    }
    new TargetPickModal(this.app, async (kind) => {
      try {
        if (kind === "kb") {
          const kbs = await client.listKnowledgeBases();
          this.kbCache = kbs;
          const pushable = kbs.filter(
            (k) => k.baseType === "个人知识库" || k.baseType === "共享知识库",
          );
          if (pushable.length === 0) {
            new Notice("没有可推送的知识库（个人 / 共享）");
            return;
          }
          new KbSuggestModal(
            this.app,
            pushable,
            (kb) => {
              // 再选一次「知识库里的哪个位置」——直接回车 = 知识库根目录
              const pickFolder = (folders: KbFolder[]) =>
                new KbFolderSuggestModal(this.app, folders, kb.name, (box) => {
                  cb({
                    kind: "kb",
                    kbId: kb.id,
                    kbName: kb.name,
                    kbFolderId: box.id || undefined,
                    kbFolderPath: box.path,
                  });
                }).open();

              this.setStatus(`读取「${kb.name}」的文件夹…`);
              client
                .listFolderTree(kb.id)
                .then((folders) => pickFolder(folders))
                .catch((e) => {
                  this.log(`读取文件夹树失败（按根目录处理）：${e.message}`);
                  pickFolder([]);
                })
                .finally(() => this.setStatus(""));
            },
          ).open();
        } else {
          const nbs = await client.listNotebook();
          const items = [{ id: "", name: "全部笔记（未分类）" }, ...nbs];
          new NotebookSuggestModal(this.app, items, (nb) => {
            cb({ kind: "note", noteFolderId: nb.id, noteFolderName: nb.name });
          }).open();
        }
      } catch (e: any) {
        new Notice("读取目标失败：" + e.message);
      }
    }).open();
  }

  /** 推当前文件：每次都问目标（一次性操作，不改动分身配置） */
  pushActiveFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("没有打开的文件可推送");
      return;
    }
    const base = file.parent ? file.parent.path : "";
    this.pickTarget((t) => void this.pushAdHoc([file], t, base));
  }

  /** 命令面板版：选文件夹 → 选目标 → 推送（一次性操作，不改动分身配置） */
  pushFolderCmd() {
    new FolderSuggestModal(this.app, this.app.vault.getAllFolders(), (f) => {
      const files = this.filesUnderPath(f.path);
      if (!files.length) {
        new Notice(`「${this.describeFolder(f.path)}」下没有文件`);
        return;
      }
      // 以所选文件夹为基准：只推它里面的内容，不再套一层同名文件夹
      this.pickTarget((t) => void this.pushAdHoc(files, t, f.path));
    }).open();
  }

  /** 一次性推送（临时选的目标），复用分身的推送管线与查重 */
  private async pushAdHoc(files: TFile[], target: PushTarget, baseFolder: string) {
    if (this.pushBusy) {
      new Notice("已有推送任务在进行中，请等它结束");
      return;
    }
    let client: ImaClient;
    try {
      client = this.getClient();
    } catch (e: any) {
      new Notice(e.message);
      return;
    }
    // 一次性推送也走同一套记录：同一个文件反复用这个入口推，同样只推改动
    const prefix = `adhoc|${targetKeyOf(target)}|`;
    const stateAll = this.settings.pushState;
    const prev: PushState = {};
    for (const [k, v] of Object.entries(stateAll)) {
      if (k.startsWith(prefix)) prev[k.slice(prefix.length)] = v;
    }
    const fresh: PushState = {};
    const opts: PushOpts = {
      useFileNameAsTitle: this.settings.useFileNameAsTitle,
      baseFolder,
      kbBasePath: target.kind === "kb" ? target.kbFolderPath || "" : "",
      onDuplicate: this.settings.onDuplicate === "rename" ? "rename" : "skip",
      prev,
      onRecord: (p, rec) => {
        fresh[p] = rec;
      },
    };
    this.pushBusy = true;
    new Notice(`开始推送 ${files.length} 个文件到 ${targetLabel(target)}…`);
    this.setStatus(`推送中（${files.length}）…`);
    try {
      const res = await pushFiles(files, target, client, this.app.vault, opts, (m) => this.log(m));
      for (const [p, rec] of Object.entries(fresh)) stateAll[prefix + p] = rec;
      await this.saveSettings();
      const parts = [`成功 ${res.pushed}`];
      if (res.unchanged > 0) parts.push(`未改动 ${res.unchanged}`);
      if (res.exists > 0) parts.push(`已存在跳过 ${res.exists}`);
      if (res.renamed > 0) parts.push(`改名新建 ${res.renamed}`);
      const other = res.skipped - res.exists;
      if (other > 0) parts.push(`其它跳过 ${other}`);
      new Notice(`推送完成：${parts.join("，")}`);
      this.setStatus(`推送完成 ${res.pushed}`);
    } catch (e: any) {
      new Notice("推送失败：" + e.message);
      this.setStatus("推送失败");
    } finally {
      this.pushBusy = false;
    }
  }

  // ---------- 推送分身 ----------

  /** 取多个文件夹下的文件并集（按路径去重） */
  filesUnderFolders(folders: string[]): TFile[] {
    const seen = new Set<string>();
    const out: TFile[] = [];
    for (const folder of folders) {
      for (const f of this.filesUnderPath(folder)) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        out.push(f);
      }
    }
    return out;
  }

  async addPushProfile() {
    const prof: PushProfile = {
      id: newProfileId("push"),
      name: `推送分身 ${this.settings.pushProfiles.length + 1}`,
      folders: [],
      targets: [],
      keepRoot: true,
    };
    this.settings.pushProfiles.push(prof);
    await this.saveSettings();
    this.refreshSettingsUi();
    new Notice(`已新建「${prof.name}」，请给它选源文件夹和目标`);
  }

  async removePushProfile(prof: PushProfile) {
    this.settings.pushProfiles = this.settings.pushProfiles.filter((p) => p.id !== prof.id);
    await this.saveSettings();
    this.refreshSettingsUi();
    new Notice(`已删除推送分身「${prof.name}」`);
  }

  /** 给分身（多）选源文件夹 —— 只写配置，不推送 */
  pickProfileFolders(prof: PushProfile) {
    new FolderChecklistModal(
      this.app,
      this.app.vault.getAllFolders(),
      prof.folders,
      async (folders) => {
        prof.folders = folders;
        await this.saveSettings();
        this.refreshSettingsUi();
      },
    ).open();
  }

  /** 给分身（多）选推送目标 —— 只写配置，不推送 */
  pickProfileTargets(prof: PushProfile) {
    let client: ImaClient;
    try {
      client = this.getClient();
    } catch (e: any) {
      new Notice(e.message);
      return;
    }
    new TargetPickModal(this.app, async (kind) => {
      try {
        if (kind === "kb") {
          const kbs = await client.listKnowledgeBases();
          this.kbCache = kbs;
          const pushable = kbs.filter(
            (k) => k.baseType === "个人知识库" || k.baseType === "共享知识库",
          );
          if (pushable.length === 0) {
            new Notice("没有可推送的知识库（个人 / 共享）");
            return;
          }
          new KbChecklistModal(
            this.app,
            pushable,
            prof.targets.filter((t) => t.kind === "kb").map((t) => t.kbId || ""),
            async (ids) => {
              const picked = pushable.filter((k) => ids.includes(k.id));
              // 保住已配好的知识库内落点，只增删目标本身
              prof.targets = prof.targets.filter((t) => t.kind !== "kb");
              for (const kb of picked) {
                prof.targets.push({ kind: "kb", kbId: kb.id, kbName: kb.name, kbFolderPath: "" });
              }
              await this.saveSettings();
              this.refreshSettingsUi();
              new Notice(`已更新「${prof.name}」的知识库目标`);
            },
            "选择推送目标知识库（可多选）",
            "勾选多个知识库，内容会分别推送到每一个。落点默认在知识库最外层，之后可逐个改。",
          ).open();
        } else {
          const nbs = await client.listNotebook();
          const items = [{ id: "", name: "全部笔记（未分类）" }, ...nbs];
          new NotebookSuggestModal(this.app, items, async (nb) => {
            const t: PushTarget = {
              kind: "note",
              noteFolderId: nb.id,
              noteFolderName: nb.name,
            };
            if (prof.targets.some((x) => x.kind === "note" && x.noteFolderId === nb.id)) {
              new Notice("这个个人笔记目标已经在分身里了");
              return;
            }
            prof.targets.push(t);
            await this.saveSettings();
            this.refreshSettingsUi();
            new Notice(`已给「${prof.name}」加上目标 ${targetLabel(t)}`);
          }).open();
        }
      } catch (e: any) {
        new Notice("读取目标失败：" + e.message);
      }
    }).open();
  }

  /** 改某个知识库目标在知识库内部的落点 */
  async pickTargetFolder(prof: PushProfile, target: PushTarget) {
    if (target.kind !== "kb" || !target.kbId) return;
    let client: ImaClient;
    try {
      client = this.getClient();
    } catch (e: any) {
      new Notice(e.message);
      return;
    }
    this.setStatus(`读取「${target.kbName}」的文件夹…`);
    let folders: KbFolder[] = [];
    try {
      folders = await client.listFolderTree(target.kbId);
    } catch (e: any) {
      this.log(`读取文件夹树失败（按根目录处理）：${e.message}`);
    } finally {
      this.setStatus("");
    }
    new KbFolderSuggestModal(this.app, folders, target.kbName || "", async (box) => {
      target.kbFolderId = box.id || undefined;
      target.kbFolderPath = box.path;
      await this.saveSettings();
      this.refreshSettingsUi();
      new Notice(`「${target.kbName}」的落点已设为 ${box.path || "知识库根目录"}`);
    }).open();
  }

  async removeProfileTarget(prof: PushProfile, target: PushTarget) {
    prof.targets = prof.targets.filter((t) => t !== target);
    await this.saveSettings();
    this.refreshSettingsUi();
  }

  /**
   * 跑一个推送分身：所有源文件夹的并集 → 依次推到每个目标。
   * 每个目标单独调一次 pushFiles，因此**每个目标各自查重**，互不影响。
   */
  async runPushProfile(prof: PushProfile) {
    if (this.pushBusy) {
      this.notify("已有推送任务在进行中，请等它结束");
      return;
    }
    if (prof.folders.length === 0) {
      this.notify(`「${prof.name}」还没有选源文件夹`);
      return;
    }
    if (prof.targets.length === 0) {
      this.notify(`「${prof.name}」还没有选目标`);
      return;
    }
    const files = this.filesUnderFolders(prof.folders);
    if (files.length === 0) {
      this.notify(`「${prof.name}」的源文件夹下没有可推送的文件`);
      return;
    }
    let client: ImaClient;
    try {
      client = this.getClient();
    } catch (e: any) {
      this.notify(e.message);
      return;
    }

    const base: PushOpts = {
      useFileNameAsTitle: this.settings.useFileNameAsTitle,
      baseFolders: prof.folders,
      keepSourceRoot: prof.keepRoot !== false,
      onDuplicate: this.settings.onDuplicate === "rename" ? "rename" : "skip",
    };

    this.pushBusy = true;
    const sum = { pushed: 0, exists: 0, renamed: 0, skipped: 0, unchanged: 0 };
    this.log(
      `—— 开始推送「${prof.name}」：${files.length} 个文件 → ${prof.targets.length} 个目标` +
        `（${base.keepSourceRoot ? "保留源文件夹这一层" : "只推里面的内容"}）——`,
    );
    try {
      const stateAll = this.settings.pushState;
      for (const target of prof.targets) {
        this.setStatus(`推送「${prof.name}」→ ${targetLabel(target)}…`);
        // 每个目标一份独立记录：同一个文件推到不同知识库互不影响
        const prefix = `${prof.id}|${targetKeyOf(target)}|`;
        const prev: PushState = {};
        for (const [k, v] of Object.entries(stateAll)) {
          if (k.startsWith(prefix)) prev[k.slice(prefix.length)] = v;
        }
        const fresh: PushState = {};
        const opts: PushOpts = {
          ...base,
          kbBasePath: target.kind === "kb" ? target.kbFolderPath || "" : "",
          prev,
          onRecord: (p, rec) => {
            fresh[p] = rec;
          },
        };
        const res = await pushFiles(
          files,
          target,
          client,
          this.app.vault,
          opts,
          (m) => this.log(m),
        );
        // 本轮结果写回状态表并落盘（中途崩了也不要紧：下次会按"已存在的同名"重新对齐）
        for (const [p, rec] of Object.entries(fresh)) stateAll[prefix + p] = rec;
        await this.saveSettings();
        sum.pushed += res.pushed;
        sum.exists += res.exists;
        sum.renamed += res.renamed;
        sum.unchanged += res.unchanged;
        sum.skipped += res.skipped;
      }

      // 顺手提醒库里还剩多少"用不到的"条目（旧版本 / 本地已删除）。
      // 不弹窗打扰，只记日志；完整清单在设置页「待清理条目」里生成。
      let staleHint = 0;
      {
        const current = new Set(files.map((f) => f.path));
        for (const target of prof.targets) {
          const prefix = `${prof.id}|${targetKeyOf(target)}|`;
          const prev: PushState = {};
          for (const [k, v] of Object.entries(stateAll)) {
            if (k.startsWith(prefix)) prev[k.slice(prefix.length)] = v;
          }
          staleHint += staleRecords(prev, current).length;
          for (const [p, rec] of Object.entries(prev)) {
            if (current.has(p)) staleHint += supersededTitles(rec).length;
          }
        }
      }
      if (staleHint > 0) {
        this.log(
          `另有 ${staleHint} 条库里已经用不到的条目（旧版本 / 本地已删除）—— 设置页「待清理条目」可生成清单，去 IMA 客户端手动删`,
        );
      }
      const parts = [`成功 ${sum.pushed}`];
      if (sum.unchanged > 0) parts.push(`未改动跳过 ${sum.unchanged}`);
      if (sum.exists > 0) parts.push(`已存在跳过 ${sum.exists}`);
      if (sum.renamed > 0) parts.push(`改名新建 ${sum.renamed}`);
      const other = sum.skipped - sum.exists;
      if (other > 0) parts.push(`其它跳过 ${other}`);
      if (sum.unchanged > 0 && sum.pushed === 0) {
        parts.push("（源里没有改动，未新建任何条目）");
      }
      this.notify(`「${prof.name}」推送完成：${parts.join("，")}`);
      this.setStatus(`推送完成 ${sum.pushed}`);
    } catch (e: any) {
      this.notify(`「${prof.name}」推送失败：` + e.message);
      this.setStatus("推送失败");
    } finally {
      this.pushBusy = false;
    }
  }

  /** 依次跑完所有推送分身 */
  async runAllPushProfiles() {
    const list = this.settings.pushProfiles;
    if (list.length === 0) {
      this.notify("还没有推送分身");
      return;
    }
    for (const prof of list) {
      // 单个分身失败不打断后面的（runPushProfile 内部已 try/catch）
      await this.runPushProfile(prof);
    }
    this.notify(`全部推送分身已跑完（共 ${list.length} 个）`);
  }

  /** 全部推送前先确认，避免误触 */
  confirmRunAllPush() {
    const list = this.settings.pushProfiles;
    const ready = list.filter((p) => p.folders.length && p.targets.length);
    if (ready.length === 0) {
      new Notice("没有配置完整的推送分身（需要同时有源文件夹和目标）");
      return;
    }
    const lines = ready.map((p) => {
      const n = this.filesUnderFolders(p.folders).length;
      return `${p.name}：${n} 个文件 → ${p.targets.map((t) => targetLabel(t)).join("、")}`;
    });
    new ConfirmModal(this.app, "全部推送", lines, `推送 ${ready.length} 个分身`, () =>
      void this.runAllPushProfiles(),
    ).open();
  }

  /** 扫描知识库里的同名重复条目，生成清单文件（IMA 无删除接口，只能手动清） */
  /** 先让用户挑一个知识库，再扫描其中的重复条目 */
  async pickAndScanDuplicates() {
    let client: ImaClient;
    try {
      client = this.getClient();
    } catch (e: any) {
      new Notice(e.message);
      return;
    }
    try {
      const kbs = await this.refreshKbCache();
      if (kbs.length === 0) {
        new Notice("没有读取到知识库，请先测试连接是否正常");
        return;
      }
      new KbSuggestModal(this.app, kbs, (kb) => void this.scanDuplicates(kb), "选择要扫描的知识库…").open();
    } catch (e: any) {
      new Notice("读取知识库失败：" + e.message);
    }
  }

  /**
   * 收集「库里还留着、本地已经不要了」的条目，生成待清理清单：
   *  - **旧版本**：文件被改动过，IMA 上留下的历史版本（`名字@v2`、`名字@v3`…）
   *  - **本地已删除/改名**：本地这个文件没了（或改名了），IMA 那边还在原处
   * 两者都只能去 IMA 客户端手删 —— 开放接口没有删除能力。
   * 这份清单靠推送记录（pushState）算出来，不需要联网。
   */
  async writeStaleReport() {
    const stateAll = this.settings.pushState || {};
    type Row = { kind: string; target: string; folder: string; title: string; keep: string; path: string };
    const rows: Row[] = [];
    for (const prof of this.settings.pushProfiles) {
      const current = new Set(this.filesUnderFolders(prof.folders).map((f) => f.path));
      for (const target of prof.targets) {
        const prefix = `${prof.id}|${targetKeyOf(target)}|`;
        const prev: PushState = {};
        for (const [k, v] of Object.entries(stateAll)) {
          if (k.startsWith(prefix)) prev[k.slice(prefix.length)] = v;
        }
        if (Object.keys(prev).length === 0) continue;
        const label = `${prof.name} → ${targetLabel(target)}`;
        for (const { path, rec } of staleRecords(prev, current)) {
          rows.push({
            kind: "本地已删除/改名",
            target: label,
            folder: rec.folder || "（根目录）",
            title: rec.title,
            keep: "",
            path,
          });
        }
        for (const [p, rec] of Object.entries(prev)) {
          if (!current.has(p)) continue;
          for (const t of supersededTitles(rec)) {
            rows.push({
              kind: "旧版本",
              target: label,
              folder: rec.folder || "（根目录）",
              title: t,
              keep: rec.title,
              path: p,
            });
          }
        }
      }
    }

    const olds = rows.filter((r) => r.kind === "旧版本");
    const gone = rows.filter((r) => r.kind === "本地已删除/改名");
    const lines: string[] = [];
    lines.push("# ima-duo 待清理条目");
    lines.push("");
    lines.push(`- 生成时间：${new Date().toLocaleString()}`);
    lines.push(`- 旧版本（改过之后残留的历史版本）：${olds.length} 条`);
    lines.push(`- 本地已删除/改名（本地没了、IMA 还在）：${gone.length} 条`);
    lines.push("");
    lines.push("> IMA 开放接口**没有删除能力**，下面这些只能去 IMA 客户端手动删。");
    lines.push("> 清单靠本地推送记录算出来，不联网；记录被清空过的话，可能列不全。");
    lines.push("");
    const section = (title: string, note: string, list: Row[]) => {
      lines.push(`## ${title}`, "");
      lines.push(note, "");
      if (list.length === 0) {
        lines.push("（无）", "");
        return;
      }
      for (const r of list) {
        lines.push(`- 「${r.title}」`);
        lines.push(`  - 位置：知识库 ${r.target} ｜ \`${r.folder}\``);
        if (r.keep) lines.push(`  - **保留**「${r.keep}」，删掉这一条`);
        lines.push(`  - 本地文件：\`${r.path}\``);
      }
      lines.push("");
    };
    section("旧版本", "删掉不影响同步 —— 插件只认最新的那一版（下面「保留」的那个）。", olds);
    section(
      "本地已删除 / 改名",
      "本地这个文件已经不在源文件夹里了。如果你其实还想要它，就别删。",
      gone,
    );

    const path = "ima-duo-待清理条目.md";
    const body = lines.join("\n");
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) await this.app.vault.adapter.write(path, body);
    else await this.app.vault.create(path, body);

    if (rows.length === 0) {
      new Notice("没有需要清理的条目");
    } else {
      new Notice(`待清理 ${rows.length} 条（旧版本 ${olds.length}、已删除 ${gone.length}），清单已写入「${path}」`);
    }
    this.log(`待清理清单已写入 ${path}：旧版本 ${olds.length} 条、本地已删除 ${gone.length} 条`);
    return rows.length;
  }

  /**
   * 同步差异检查：**联网**读知识库现有条目，与本地源两侧对照，生成 `ima-duo-同步差异.md`。
   * 回答的是"两边对不上的东西到底有哪些"：
   *  ① 本地有、IMA 没有 → 该 push
   *  ② IMA 有、本地没有 → 还想要就 pull，确实不要就去 IMA 删
   *  ③ 两边都有、本地改过 → push 后会新增一份 @vN
   *  ④ IMA 里的旧版本残留 → 去 IMA 删（删掉不影响同步）
   *  ⑤ IMA 里同一位置的多份同名条目 → 去 IMA 删
   * **纯读**：不推不拉、不写知识库、不改推送记录。
   */
  async writeSyncDiffReport() {
    let client: ImaClient;
    try {
      client = this.getClient();
    } catch (e: any) {
      new Notice(e.message);
      return;
    }
    const configs = this.settings.pushProfiles.filter((p) => p.folders.length && p.targets.length);
    if (configs.length === 0) {
      new Notice("没有配置完整的推送分身（需要同时有源文件夹和目标）");
      return;
    }
    this.setStatus("检查同步差异…");
    new Notice("正在对照两侧差异（要读知识库目录，条目多时需要一会儿）…");

    const blocks: { label: string; diff: SyncDiff }[] = [];
    const stateAll = this.settings.pushState || {};
    for (const prof of configs) {
      const files = this.filesUnderFolders(prof.folders);
      for (const target of prof.targets) {
        if (target.kind !== "kb") continue; // 差异检查只支持知识库目标
        const prefix = `${prof.id}|${targetKeyOf(target)}|`;
        const prev: PushState = {};
        for (const [k, v] of Object.entries(stateAll)) {
          if (k.startsWith(prefix)) prev[k.slice(prefix.length)] = v;
        }
        try {
          const diff = await diffProfile(
            files,
            target,
            client,
            this.app.vault,
            {
              useFileNameAsTitle: this.settings.useFileNameAsTitle,
              baseFolders: prof.folders,
              keepSourceRoot: prof.keepRoot !== false,
              kbBasePath: target.kbFolderPath || "",
            },
            prev,
            (m) => this.log(m),
          );
          blocks.push({ label: `${prof.name} → ${targetLabel(target)}`, diff });
        } catch (e: any) {
          this.log(`差异检查失败（${prof.name} → ${targetLabel(target)}）：${e.message}`);
        }
      }
    }

    const sum = { synced: 0, localOnly: 0, localChanged: 0, imaOnly: 0, stale: 0, dup: 0 };
    for (const b of blocks) {
      sum.synced += b.diff.synced;
      sum.localOnly += b.diff.localOnly.length;
      sum.localChanged += b.diff.localChanged.length;
      sum.imaOnly += b.diff.imaOnly.length;
      sum.stale += b.diff.staleVersions.length;
      sum.dup += b.diff.duplicates.length;
    }

    const L: string[] = [];
    L.push("# ima-duo 同步差异");
    L.push("");
    L.push(`- 生成时间：${new Date().toLocaleString()}`);
    L.push(`- 对照范围：${blocks.map((b) => b.label).join("；") || "（无）"}`);
    L.push("");
    L.push("> 这是**两侧对不上的东西**的完整清单（只读扫描，没有改动任何东西）。");
    L.push("> IMA 既没有覆盖更新、也没有删除接口 —— 「改过的文件」在库里只能带 `@vN` 另存一份，");
    L.push("> 旧的那份必须手动删。所以「多出来的」条目**只会越攒越多**，定期照这份清单清一次。");
    L.push("");
    L.push("## 概览");
    L.push("");
    L.push("| 情况 | 数量 | 该做什么 |");
    L.push("|---|---|---|");
    L.push(`| ① 本地有、IMA 没有 | ${sum.localOnly} | push |`);
    L.push(`| ③ 两边都有、本地改过 | ${sum.localChanged} | push（库里会多一份 @vN） |`);
    L.push(`| ② IMA 有、本地没有 | ${sum.imaOnly} | 还想要 → pull；确实不要 → 去 IMA 删 |`);
    L.push(`| ④ IMA 里的旧版本残留 | ${sum.stale} | 去 IMA 删（删掉不影响同步） |`);
    L.push(`| ⑤ IMA 里同一位置的重复条目 | ${sum.dup} | 去 IMA 删 |`);
    L.push(`| 已同步 | ${sum.synced} | — |`);
    L.push("");

    for (const b of blocks) {
      const d = b.diff;
      L.push(`## ${b.label}`);
      L.push("");
      L.push(
        `已同步 ${d.synced} ｜ 本地未推 ${d.localOnly.length} ｜ 本地改过 ${d.localChanged.length} ｜ ` +
          `库里多出 ${d.imaOnly.length} ｜ 旧版本 ${d.staleVersions.length} ｜ 重复 ${d.duplicates.length}`,
      );
      L.push("");

      L.push(`### ③ 本地改过了（${d.localChanged.length}）— push 后会新增带 @vN 的条目`);
      L.push("");
      if (d.localChanged.length === 0) L.push("（无）");
      for (const x of d.localChanged) {
        L.push(`- 「${x.title}」`);
        L.push(`  - 本地：\`${x.localPath}\``);
        L.push(`  - push 后库里会多一份「${x.nextTitle}」；原来那份随即变成旧版本（见下节）`);
      }
      L.push("");

      L.push(`### ① 本地有、IMA 没有（${d.localOnly.length}）— push 就会补上`);
      L.push("");
      if (d.localOnly.length === 0) L.push("（无）");
      for (const x of d.localOnly) {
        L.push(`- 「${x.title}」`);
        L.push(`  - 本地：\`${x.localPath}\``);
        L.push(`  - 应落在：\`${x.relDir || "（知识库根）"}\``);
        if (x.recorded) {
          L.push(`  - ⚠️ 推送记录里推过，但 IMA 那边已经查不到 —— 应该是被手动删了，push 会重新补一份`);
        }
      }
      L.push("");

      L.push(`### ② IMA 有、本地没有（${d.imaOnly.length}）— 「多出来的」`);
      L.push("");
      if (d.imaOnly.length === 0) L.push("（无）");
      for (const x of d.imaOnly) {
        L.push(`- 「${x.title}」`);
        L.push(`  - 位置：知识库 \`${x.folderPath || "（根目录）"}\``);
        L.push(
          x.isOldVersion
            ? `  - 这是历史版本残留，而本地对应文件也已经不在了 → 一般可直接删`
            : `  - 本地源文件夹里没有这个文件。是你在 IMA 里传的？还是本地删/改了名？还要就 pull，不要就删`,
        );
      }
      L.push("");

      L.push(`### ④ 旧版本残留（${d.staleVersions.length}）— 去 IMA 删，删掉不影响同步`);
      L.push("");
      if (d.staleVersions.length === 0) L.push("（无）");
      for (const x of d.staleVersions) {
        L.push(`- 「${x.title}」 在 \`${x.folderPath || "（根目录）"}\` —— **保留**「${x.keep}」`);
        L.push(`  - 本地对应文件：\`${x.localPath}\``);
      }
      L.push("");

      L.push(`### ⑤ 同一位置的重复条目（${d.duplicates.length}）`);
      L.push("");
      if (d.duplicates.length === 0) L.push("（无）");
      for (const x of d.duplicates) {
        L.push(`- 「${x.title}」 在 \`${x.folderPath || "（根目录）"}\` 有 ${x.count} 份同名条目 → 留一份、删其余`);
      }
      L.push("");
    }

    const path = "ima-duo-同步差异.md";
    const body = L.join("\n");
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) await this.app.vault.adapter.write(path, body);
    else await this.app.vault.create(path, body);

    const total = sum.localOnly + sum.localChanged + sum.imaOnly + sum.stale + sum.dup;
    const pendingPush = sum.localOnly + sum.localChanged;
    const extra = sum.imaOnly + sum.stale + sum.dup;
    new Notice(
      total === 0
        ? `两侧一致（已同步 ${sum.synced} 个），清单已写入「${path}」`
        : `发现 ${total} 处差异：待推 ${pendingPush}、库里多出/重复 ${extra} —— 详见「${path}」`,
    );
    this.log(
      `同步差异清单已写入 ${path}：已同步 ${sum.synced}、待推 ${pendingPush}、` +
        `库里多出 ${sum.imaOnly}、旧版本 ${sum.stale}、重复 ${sum.dup}`,
    );
    this.setStatus("差异检查完成");
    return total;
  }

  async scanDuplicates(kb?: { id: string; name: string }) {
    let client: ImaClient;
    try {
      client = this.getClient();
    } catch (e: any) {
      new Notice(e.message);
      return;
    }
    const kbId = kb?.id;
    if (!kbId) {
      new Notice("请先选择一个要扫描的知识库");
      return;
    }
    const kbName = kb?.name || "知识库";
    new Notice(`正在扫描「${kbName}」…`);
    this.setStatus("扫描重复条目…");
    try {
      const entries = await client.listAllKbEntries(kbId);
      const byTitle = new Map<string, KbEntry[]>();
      for (const e of entries) {
        const k = e.title.trim().normalize("NFC");
        const arr = byTitle.get(k) || [];
        arr.push(e);
        byTitle.set(k, arr);
      }
      const dupes = [...byTitle.entries()]
        .filter(([, v]) => v.length > 1)
        .sort((a, b) => b[1].length - a[1].length);

      const lines: string[] = [];
      lines.push(`# ima-duo 重复条目清单`);
      lines.push("");
      lines.push(`- 知识库：${kbName}`);
      lines.push(`- 扫描时间：${new Date().toLocaleString()}`);
      lines.push(`- 条目总数：${entries.length}`);
      lines.push(`- 同名标题：${dupes.length} 个`);
      lines.push("");
      lines.push("> 判定口径：标题相同 **且完整正文指纹一致** 才算真重复。");
      lines.push("> 标题相同但正文不同的不是重复 —— 比如 excalidraw / mindmap 文件，正文开头都是同一段插件提示语。");
      lines.push("> IMA 开放接口没有删除能力，真重复的要去 IMA 客户端手动删。");
      lines.push("");

      let realExtra = 0;
      let onlyTitle = 0;
      const totalItems = dupes.reduce((n, [, v]) => n + v.length, 0);
      let done = 0;
      for (const [title, list] of dupes) {
        const byHash = new Map<string, { e: KbEntry; brief: string }[]>();
        for (const e of list) {
          done++;
          this.setStatus(`读取正文 ${done}/${totalItems}…`);
          let brief = `（文件型条目，类型 ${e.mediaType}）`;
          let hash = `raw_${e.mediaId}`;
          if (e.mediaType === 11) {
            const r = await this.docFingerprint(client, e.mediaId);
            brief = r.brief;
            hash = r.hash;
          }
          const arr = byHash.get(hash) || [];
          arr.push({ e, brief });
          byHash.set(hash, arr);
        }
        const extra = [...byHash.values()].reduce((n, g) => n + Math.max(0, g.length - 1), 0);
        realExtra += extra;
        if (extra === 0) onlyTitle += list.length;
        lines.push(
          `### ${title}（${list.length} 条）${
            extra > 0 ? ` — 真重复，多余 ${extra} 条` : " — 仅标题相同，不是重复"
          }`,
        );
        lines.push("");
        for (const group of byHash.values()) {
          lines.push(
            group.length > 1
              ? `- **同一份内容重复 ${group.length} 次**，保留 1 条、删掉其余 ${group.length - 1} 条：`
              : `- 内容与其它条不同（保留）：`,
          );
          for (const { e, brief } of group) {
            lines.push(`  - 「${e.folderPath || "（根目录）"}」 ｜ \`${e.mediaId}\``);
            lines.push(`    > ${brief}`);
          }
        }
        lines.push("");
      }

      lines.push("---", "");
      lines.push(`真重复（多余、建议删除）：${realExtra} 条`);
      if (onlyTitle > 0) {
        lines.push(`仅标题相同的条目：${onlyTitle} 条（不要删，属于标题派生问题）`);
      }
      lines.push("");

      const path = "ima-duo-重复条目清单.md";
      const body = lines.join("\n");
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing) await this.app.vault.adapter.write(path, body);
      else await this.app.vault.create(path, body);

      new Notice(
        realExtra > 0
          ? `发现 ${realExtra} 条真重复，清单已写入「${path}」`
          : "没有发现真重复条目",
      );
      this.log(
        `重复扫描完成：条目 ${entries.length}，同名标题 ${dupes.length}，真重复多余 ${realExtra}，仅标题相同 ${onlyTitle}`,
      );
      this.setStatus("");
    } catch (e: any) {
      new Notice("扫描失败：" + e.message);
      this.setStatus("扫描失败");
    }
  }

  /** 取笔记型条目的正文摘要 + 内容指纹，用于判定是否真重复 */
  private async docFingerprint(
    client: ImaClient,
    mediaId: string,
  ): Promise<{ brief: string; hash: string }> {
    try {
      const mi = await client.getMediaInfo(mediaId);
      const docId = mi?.notebook_ext_info?.notebook_id;
      if (!docId) return { brief: "（无正文）", hash: `nodoc_${mediaId}` };
      const raw = String((await client.getDocContent(docId)) || "");
      const brief = raw
        .replace(/^#+\s*/gm, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 70);
      return { brief, hash: fnv1a(raw) };
    } catch (e: any) {
      return { brief: `（正文读取失败：${e.message}）`, hash: `err_${mediaId}` };
    }
  }

  // ---------- 拉取 ----------

  /** 临时拉取（命令面板）用的落地目录：优先取第一个相关分身的目录 */
  private defaultPullDest(notes: boolean): string {
    const profiles = this.settings.pullProfiles || [];
    const hit = profiles.find((p) => (notes ? p.includeNotes : p.kbIds.length > 0));
    return hit?.dest || profiles[0]?.dest || (notes ? "ima/笔记" : "ima/知识库");
  }

  private async pullNotesCmd() {
    try {
      const client = this.getClient();
      const nbs = await client.listNotebook();
      const items = [{ id: "", name: "全部笔记（未分类 + 各笔记本）" }, ...nbs];
      new NotebookSuggestModal(this.app, items, async (nb) => {
        const dest = this.defaultPullDest(true);
        new Notice(`开始拉取个人笔记到 ${dest}…`);
        this.setStatus("拉取笔记中…");
        const r = await pullNotes(
          client,
          this.app.vault,
          dest,
          nb.id === "" ? null : nb,
          (m) => this.log(m),
        );
        await this.rememberPulled(r.paths);
        new Notice(
          `拉取完成：新建 ${r.created}，更新 ${r.updated}，未变化跳过 ${r.unchanged}`,
        );
        this.setStatus(`笔记拉取 ${r.count}`);
      }).open();
    } catch (e: any) {
      new Notice("错误：" + e.message);
    }
  }

  private async pullKbCmd() {
    try {
      const client = this.getClient();
      const kbs = await client.listKnowledgeBases();
      this.kbCache = kbs;
      if (kbs.length === 0) {
        new Notice("没有可拉取的知识库");
        return;
      }
      new KbSuggestModal(
        this.app,
        kbs,
        async (kb) => {
          await this.pullOneKb(client, kb);
        },
        "选择要拉取的知识库…",
      ).open();
    } catch (e: any) {
      new Notice("错误：" + e.message);
    }
  }

  async pullOneKb(client: ImaClient, kb: KbInfo) {
    // 临时拉取沿用第一个含知识库的分身的选项（下载文件 / 是否套层）
    const ref = (this.settings.pullProfiles || []).find((p) => p.kbIds.length > 0);
    const dest = ref?.dest || this.defaultPullDest(false);
    new Notice(`开始拉取知识库「${kb.name}」到 ${dest}…`);
    this.setStatus(`拉取 ${kb.name}…`);
    try {
      const r = await pullKnowledgeBase(
        client,
        this.app.vault,
        kb.id,
        kb.name,
        dest,
        {
          downloadFiles: ref ? ref.downloadFiles : false,
          nestKbName: ref ? ref.nestKbName : false,
          skipOldVersions: this.settings.skipOldVersions !== false,
        },
        (m) => this.log(m),
      );
      await this.rememberPulled(r.paths);
      const skipped = r.skippedVersions ? r.skippedVersions.length : 0;
      if (skipped > 0) {
        new Notice(
          `知识库拉取完成：新建 ${r.created}，更新 ${r.updated}，未变化跳过 ${r.unchanged}。` +
            `另有 ${skipped} 个历史版本（@vN）未拉取 —— 它们是推送残留，不是独立内容`,
        );
      } else {
        new Notice(
          `知识库拉取完成：新建 ${r.created}，更新 ${r.updated}，未变化跳过 ${r.unchanged}`,
        );
      }
      this.setStatus(`知识库拉取 ${r.count}`);
    } catch (e: any) {
      new Notice("拉取失败：" + e.message);
      this.setStatus("拉取失败");
    }
  }

  // ---------- 拉取分身 ----------

  async addPullProfile() {
    const prof: PullProfile = {
      id: newProfileId("pull"),
      name: `拉取分身 ${this.settings.pullProfiles.length + 1}`,
      kbIds: [],
      includeNotes: false,
      dest: "ima/知识库",
      downloadFiles: true,
      nestKbName: false,
    };
    this.settings.pullProfiles.push(prof);
    await this.saveSettings();
    this.refreshSettingsUi();
    new Notice(`已新建「${prof.name}」，请勾选知识库并设置落地目录`);
  }

  async removePullProfile(prof: PullProfile) {
    this.settings.pullProfiles = this.settings.pullProfiles.filter((p) => p.id !== prof.id);
    await this.saveSettings();
    this.refreshSettingsUi();
    new Notice(`已删除拉取分身「${prof.name}」`);
  }

  /** 给拉取分身勾选知识库（多选） */
  async pickPullProfileKbs(prof: PullProfile) {
    try {
      const kbs = await this.refreshKbCache();
      if (kbs.length === 0) {
        new Notice("没有读取到知识库，请先测试连接是否正常");
        return;
      }
      new KbChecklistModal(
        this.app,
        kbs,
        prof.kbIds,
        async (ids) => {
          prof.kbIds = ids;
          const names = { ...this.settings.pullKbNames };
          for (const k of kbs) if (ids.includes(k.id)) names[k.id] = k.name;
          this.settings.pullKbNames = names;
          await this.saveSettings();
          this.refreshSettingsUi();
        },
        "选择要拉取的知识库（可多选）",
        "勾选的多个知识库都会拉到本分身设置的同一个目录。想让它们分开放，就建多个拉取分身，各设各的目录。",
      ).open();
    } catch (e: any) {
      new Notice("读取知识库失败：" + e.message);
    }
  }

  /** 跑一个拉取分身：先（可选）拉个人笔记，再把每个勾选的知识库拉到同一目录 */
  async runPullProfile(prof: PullProfile) {
    if (this.pullBusy) {
      this.notify("已有拉取任务在进行中，请等它结束");
      return;
    }
    if (!prof.includeNotes && prof.kbIds.length === 0) {
      this.notify(`「${prof.name}」还没有勾选知识库`);
      return;
    }
    let client: ImaClient;
    try {
      client = this.getClient();
    } catch (e: any) {
      this.notify(e.message);
      return;
    }
    const dest = prof.dest || "ima/知识库";
    const stat = { created: 0, updated: 0, unchanged: 0, count: 0, oldVersions: 0 };
    const allPaths: string[] = [];
    this.pullBusy = true;
    this.log(`—— 开始拉取「${prof.name}」→ ${dest} ——`);
    this.setStatus(`拉取「${prof.name}」中…`);
    try {
      if (prof.includeNotes) {
        const r = await pullNotes(client, this.app.vault, dest, null, (m) => this.log(m));
        stat.created += r.created;
        stat.updated += r.updated;
        stat.unchanged += r.unchanged;
        stat.count += r.count;
        allPaths.push(...r.paths);
      }
      if (prof.kbIds.length) {
        const kbs = await client.listKnowledgeBases();
        this.kbCache = kbs;
        const byId = new Map(kbs.map((k) => [k.id, k]));
        for (const id of prof.kbIds) {
          const kb = byId.get(id);
          const kbName = kb?.name || this.settings.pullKbNames[id] || id.slice(0, 10);
          this.setStatus(`拉取「${prof.name}」：${kbName}…`);
          try {
            const r = await pullKnowledgeBase(
              client,
              this.app.vault,
              id,
              kbName,
              dest,
              {
                downloadFiles: prof.downloadFiles,
                nestKbName: prof.nestKbName,
                skipOldVersions: this.settings.skipOldVersions !== false,
              },
              (m) => this.log(m),
            );
            stat.created += r.created;
            stat.updated += r.updated;
            stat.unchanged += r.unchanged;
            stat.count += r.count;
            stat.oldVersions += r.skippedVersions ? r.skippedVersions.length : 0;
            allPaths.push(...r.paths);
          } catch (e: any) {
            this.log(`知识库「${kbName}」拉取失败：${e.message}`);
          }
        }
      }
      await this.rememberPulled(allPaths);
      this.notify(
        `「${prof.name}」拉取完成：新建 ${stat.created}，更新 ${stat.updated}，未变化跳过 ${stat.unchanged}` +
          (stat.oldVersions > 0
            ? `，跳过历史版本 ${stat.oldVersions}（@vN 是推送残留，未拉回本地）`
            : ""),
      );
      this.setStatus(`拉取完成 ${stat.count}`);
    } catch (e: any) {
      this.notify(`「${prof.name}」拉取失败：` + e.message);
      this.setStatus("拉取失败");
    } finally {
      this.pullBusy = false;
    }
  }

  /** 依次跑完所有拉取分身 */
  async runAllPullProfiles() {
    const list = this.settings.pullProfiles;
    if (list.length === 0) {
      this.notify("还没有拉取分身");
      return;
    }
    for (const prof of list) await this.runPullProfile(prof);
    this.notify(`全部拉取分身已跑完（共 ${list.length} 个）`);
  }

  /** 跑完所有拉取分身（设置页「全部拉取」按钮 / 命令面板） */
  async runPullAll(silent = false): Promise<void> {
    const list = this.settings.pullProfiles || [];
    if (list.length === 0) {
      if (!silent) this.notify("还没有拉取分身，请先在设置里新建一个");
      return;
    }
    await this.runAllPullProfiles();
  }

  // ---------- 清理旧版拉取产生的重复文件 ----------

  /** 拉取目录（来自各拉取分身的落地目录），用于把清理范围限制在这些目录里 */
  private pullRoots(): string[] {
    const norm = (p: string) => (p || "").trim().replace(/^\/+|\/+$/g, "");
    const roots = new Set<string>();
    for (const p of this.settings.pullProfiles || []) {
      const d = norm(p.dest);
      if (d) roots.add(d);
    }
    return Array.from(roots);
  }

  /**
   * 扫描拉取目录里形如 `a-2.md` 的文件（旧版 uniquePath 的产物）。
   * 只有当同目录下存在主文件 `a.md` 时才算候选；
   * 内容与主文件完全一致的才标记为可删除，内容不同的交给人判断。
   */
  async scanPullDuplicates(): Promise<DupCandidate[]> {
    const roots = this.pullRoots();
    const out: DupCandidate[] = [];
    for (const f of this.app.vault.getFiles()) {
      const dir = f.parent && f.parent.path !== "/" ? f.parent.path : "";
      if (!roots.some((r) => dir === r || dir.startsWith(r + "/"))) continue;
      const m = f.basename.match(/^(.*)-(\d+)$/);
      if (!m || !m[1]) continue;
      // 日期文件名会误命中上面的正则：2026-08-10.md 会被当成 2026-08.md 的副本。
      // 主文件名形如「2026-08」的一律跳过（真正由本插件产生的副本不会长这样）。
      if (/^\d{4}-\d{1,2}$/.test(m[1])) continue;
      const basePath = dir ? `${dir}/${m[1]}.${f.extension}` : `${m[1]}.${f.extension}`;
      const baseFile = this.app.vault.getAbstractFileByPath(basePath);
      if (!(baseFile instanceof TFile)) continue; // 没有主文件 → 不是重复产物
      out.push({ file: f, basePath, identical: await this.isSameContent(f, baseFile) });
    }
    out.sort((a, b) => a.file.path.localeCompare(b.file.path));
    return out;
  }

  private async isSameContent(a: TFile, b: TFile): Promise<boolean> {
    try {
      const [x, y] = await Promise.all([this.app.vault.read(a), this.app.vault.read(b)]);
      return x === y;
    } catch {
      // 读文本失败说明是二进制文件，改比字节
      try {
        const [x, y] = await Promise.all([
          this.app.vault.readBinary(a),
          this.app.vault.readBinary(b),
        ]);
        return sameBytes(x, y);
      } catch {
        return false;
      }
    }
  }

  async cleanPullDuplicates() {
    this.setStatus("扫描重复文件…");
    let dups: DupCandidate[] = [];
    try {
      dups = await this.scanPullDuplicates();
    } catch (e: any) {
      new Notice("扫描失败：" + e.message);
      this.setStatus("扫描失败");
      return;
    }
    this.setStatus("");
    if (!dups.length) {
      new Notice("没有发现重复文件");
      return;
    }
    new DuplicateCleanModal(this.app, dups, async (files) => {
      let ok = 0;
      let fail = 0;
      for (const f of files) {
        try {
          await this.app.vault.trash(f, true); // true = 移入系统回收站，可恢复
          this.pulledPaths.delete(f.path);
          ok++;
        } catch (e: any) {
          fail++;
          this.log(`删除失败 ${f.path}: ${e.message}`);
        }
      }
      await this.saveSettings();
      new Notice(
        `已删除 ${ok} 个重复文件（移入回收站）${fail ? `，${fail} 个失败（见日志）` : ""}`,
      );
      this.log(`清理拉取重复：删除 ${ok}，失败 ${fail}`);
    }).open();
  }

  private async rememberPulled(paths: string[]) {
    if (!paths.length) return;
    for (const p of paths) this.pulledPaths.add(p);
    this.settings.pulledPaths = Array.from(this.pulledPaths).slice(-3000);
    await this.saveSettings();
  }

  // ---------- 设置持久化 ----------

  /**
   * 把旧版「单份推送/拉取配置」迁移成分身（只做一次）。
   * 迁移后清空旧字段，设置页只保留分身列表，不会出现两套重复入口。
   */
  private async migrateLegacyProfiles() {
    const s = this.settings;
    if (s.profilesMigrated) return;
    if (!Array.isArray(s.pushProfiles)) s.pushProfiles = [];
    if (!Array.isArray(s.pullProfiles)) s.pullProfiles = [];

    if (s.pushFolder || s.pushTarget) {
      s.pushProfiles.push({
        id: newProfileId("push"),
        name: "默认推送",
        folders: s.pushFolder ? [s.pushFolder] : [],
        targets: s.pushTarget ? [s.pushTarget] : [],
        keepRoot: true,
      });
      this.log(`已把旧推送配置迁移为分身「默认推送」（源 ${s.pushFolder || "无"}）`);
    }

    if (s.pullKbIds && s.pullKbIds.length) {
      s.pullProfiles.push({
        id: newProfileId("pull"),
        name: "默认拉取",
        kbIds: Array.from(s.pullKbIds),
        includeNotes: false,
        dest: s.pullKbFolder || "ima/知识库",
        downloadFiles: !!s.downloadFiles,
        nestKbName: !!s.kbNameAsSubfolder,
      });
      this.log("已把旧的知识库拉取配置迁移为分身「默认拉取」");
    }

    if (s.pullNotesEnabled) {
      s.pullProfiles.push({
        id: newProfileId("pull"),
        name: "默认拉取（个人笔记）",
        kbIds: [],
        includeNotes: true,
        dest: s.pullNotesFolder || "ima/笔记",
        downloadFiles: false,
        nestKbName: false,
      });
      this.log("已把旧的个人笔记拉取配置迁移为分身「默认拉取（个人笔记）」");
    }

    // 旧字段清空：此后一切以分身为准
    s.pushFolder = "";
    s.pushTarget = null;
    s.pullNotesEnabled = false;
    s.pullKbEnabled = true;
    s.pullKbIds = [];
    s.pullKbFolder = "";
    s.pullNotesFolder = "";
    s.profilesMigrated = true;

    await this.saveSettings();
  }

  async loadSettings() {
    // 注意：必须深拷贝默认值。Object.assign 是浅拷贝，数组/对象默认值会与
    // DEFAULT_SETTINGS 共享同一个引用 —— 往 pushProfiles 里 push 会污染
    // 默认值本身，禁用再启用插件（或同进程内新建实例）时会带着脏数据。
    const base: ImaDuoSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    this.settings = Object.assign(base, (await this.loadData()) || {});
    // 老版本存下来的分身没有 keepRoot 字段，补默认值（保留源文件夹这一层）
    if (Array.isArray(this.settings.pushProfiles)) {
      for (const p of this.settings.pushProfiles) {
        if (typeof p.keepRoot !== "boolean") p.keepRoot = true;
      }
    }
    // 推送记录表：老版本没有这个字段
    if (!this.settings.pushState || typeof this.settings.pushState !== "object") {
      this.settings.pushState = {};
    }
    // 老配置没有这两个开关，补上默认值
    if (typeof this.settings.skipOldVersions !== "boolean") this.settings.skipOldVersions = true;

    // 自动同步已从「每 N 分钟」改成「每天固定时刻」：清掉废弃字段，时刻表规范化
    const bag = this.settings as unknown as Record<string, unknown>;
    if ("autoSyncIntervalMin" in bag) delete bag.autoSyncIntervalMin;
    this.settings.autoSyncTimes = Array.isArray(this.settings.autoSyncTimes)
      ? normalizeTimeList(this.settings.autoSyncTimes)
      : [...DEFAULT_SETTINGS.autoSyncTimes];
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ---------- 弹窗 ----------

class TargetPickModal extends Modal {
  constructor(app: App, private onPick: (kind: "kb" | "note") => void) {
    super(app);
    this.setTitle("推送到哪里？");
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("p", { text: "选择 IMA 推送目标：" });
    const row = contentEl.createDiv({ cls: "ima-btn-row" });
    row.createEl("button", { text: "📚 知识库", cls: "mod-cta" }).onclick = () => {
      this.close();
      this.onPick("kb");
    };
    row.createEl("button", { text: "📝 个人笔记" }).onclick = () => {
      this.close();
      this.onPick("note");
    };
  }
  onClose() {
    this.contentEl.empty();
  }
}

/** 通用确认弹窗：列出将要发生的事，确认后才执行 */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    title: string,
    private lines: string[],
    private confirmText: string,
    private onConfirm: () => void,
  ) {
    super(app);
    this.setTitle(title);
  }
  onOpen() {
    const { contentEl } = this;
    const list = contentEl.createDiv({ cls: "ima-dup-list" });
    for (const l of this.lines) list.createEl("div", { text: l });
    const bar = contentEl.createDiv({ cls: "ima-btn-row" });
    bar.createEl("button", { text: this.confirmText, cls: "mod-cta" }).onclick = () => {
      this.close();
      this.onConfirm();
    };
    bar.createEl("button", { text: "取消" }).onclick = () => this.close();
  }
  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 同步面板：侧边栏图标点开的那个界面。
 *
 * 一屏看全「推送」和「拉取」两栏分身，每个都能单独跑，也能一键全跑；
 * 顶部是常用入口（推当前文件 / 全部推送 / 全部拉取），底部是差异检查等辅助动作。
 * 跑任务时面板不关，对应按钮变「推送中…」，跑完自动重绘。
 */
class ImaDuoPanelModal extends Modal {
  /** 正在跑的任务："" = 空闲，否则是分身 id 或 all-push / all-pull / diff 等 */
  private busy = "";

  constructor(app: App, private plugin: ImaDuoPlugin) {
    super(app);
    this.setTitle("IMA Duo 同步面板");
  }

  onOpen() {
    this.contentEl.addClass("ima-panel");
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  /** 整页重绘：状态一变就重建，省得维护局部 DOM */
  private render() {
    const p = this.plugin;
    const { contentEl } = this;
    contentEl.empty();

    const pushes = p.settings.pushProfiles || [];
    const pulls = p.settings.pullProfiles || [];
    const readyPush = pushes.filter((x) => x.folders.length && x.targets.length);
    const readyPull = pulls.filter((x) => x.kbIds.length || x.includeNotes);

    // ── 顶部：常用入口 ──
    // 两个批量动作是主操作，都标 mod-cta（紫底）；「推送当前文件」是单文件次要动作，不标。
    // 参数用具名选项而非相邻 boolean，免得 cta / disabled 传反。
    const quick = contentEl.createDiv({ cls: "ima-panel-quick" });
    const quickBtn = (
      text: string,
      opts: { cta?: boolean; disabled?: boolean },
      onClick: () => void,
    ) => {
      const b = quick.createEl("button", { text });
      b.addClass("ima-panel-quick-btn");
      if (opts.cta) b.addClass("mod-cta");
      b.disabled = !!opts.disabled || !!this.busy;
      b.onclick = onClick;
      return b;
    };
    quickBtn("推送当前文件", { disabled: !this.app.workspace.getActiveFile() }, () =>
      this.pushActive(),
    );
    quickBtn("全部推送", { cta: true, disabled: readyPush.length === 0 }, () =>
      void this.runTask("all-push", () => p.runAllPushProfiles()),
    );
    quickBtn("全部拉取", { cta: true, disabled: readyPull.length === 0 }, () =>
      void this.runTask("all-pull", () => p.runPullAll()),
    );

    // ── 推送栏 ──
    const pushSec = contentEl.createDiv({ cls: "ima-panel-sec" });
    const pushHead = pushSec.createDiv({ cls: "ima-panel-sec-head" });
    pushHead.createSpan({ cls: "ima-panel-sec-title", text: `推送（${pushes.length}）` });
    pushHead.createSpan({
      cls: "ima-panel-sec-sub",
      text: this.readyText(pushes.length, readyPush.length),
    });
    const pushList = pushSec.createDiv({ cls: "ima-panel-list" });
    if (pushes.length === 0) {
      pushList.createDiv({ cls: "ima-panel-empty", text: "还没有推送分身，去「设置」新建一个。" });
    } else {
      for (const prof of pushes) this.renderPushRow(pushList, prof);
    }

    // ── 拉取栏 ──
    const pullSec = contentEl.createDiv({ cls: "ima-panel-sec" });
    const pullHead = pullSec.createDiv({ cls: "ima-panel-sec-head" });
    pullHead.createSpan({ cls: "ima-panel-sec-title", text: `拉取（${pulls.length}）` });
    pullHead.createSpan({
      cls: "ima-panel-sec-sub",
      text: this.readyText(pulls.length, readyPull.length),
    });
    const pullList = pullSec.createDiv({ cls: "ima-panel-list" });
    if (pulls.length === 0) {
      pullList.createDiv({ cls: "ima-panel-empty", text: "还没有拉取分身，去「设置」新建一个。" });
    } else {
      for (const prof of pulls) this.renderPullRow(pullList, prof);
    }

    // ── 底部：辅助动作 ──
    const foot = contentEl.createDiv({ cls: "ima-panel-foot" });
    const footBtn = (text: string, onClick: () => void) => {
      const b = foot.createEl("button", { text });
      b.addClass("ima-panel-foot-btn");
      b.disabled = !!this.busy;
      b.onclick = onClick;
      return b;
    };
    footBtn("检查同步差异", () =>
      void this.runTask("diff", () => p.writeSyncDiffReport()),
    );
    footBtn("待清理条目", () => void this.runTask("stale", () => p.writeStaleReport()));
    footBtn("清理拉取重复", () =>
      void this.runTask("dup", () => p.cleanPullDuplicates()),
    );
    footBtn("设置", () => this.openSettings());

    // ── 自动同步（小设置，改完立即生效）──
    this.renderAutoSync(contentEl);

    if (this.busy) {
      contentEl.createDiv({
        cls: "ima-panel-status",
        text: "任务进行中……进度见左下角状态栏与通知",
      });
    }
  }

  /** 面板里的「自动同步」小设置：开关 + 间隔 + 内容，改完立即生效 */
  private renderAutoSync(containerEl: HTMLElement) {
    const p = this.plugin;
    const sec = containerEl.createDiv({ cls: "ima-panel-sec ima-panel-autosync" });
    const head = sec.createDiv({ cls: "ima-panel-sec-head" });
    head.createSpan({ cls: "ima-panel-sec-title", text: "自动同步" });
    head.createSpan({ cls: "ima-panel-sec-sub", text: p.autoSyncStatusText() });

    new Setting(sec)
      .setName("启用")
      .setDesc("到点自动跑，关闭则只手动同步")
      .addToggle((t) =>
        t.setValue(p.settings.autoSyncEnabled).onChange(async (v) => {
          p.settings.autoSyncEnabled = v;
          await p.saveSettings();
          p.restartAutoSync();
          this.render();
        }),
      );

    new Setting(sec).setName("时刻").setDesc("24 小时制，可加多个");

    p.renderAutoSyncTimes(sec, () => this.render());

    new Setting(sec)
      .setName("内容")
      .setDesc("自动同步跑哪边")
      .addDropdown((d) => {
        d.addOption("both", "推送 + 拉取")
          .addOption("push", "仅推送")
          .addOption("pull", "仅拉取")
          .setValue(p.settings.autoSyncMode)
          .onChange(async (v) => {
            p.settings.autoSyncMode = v as ImaDuoSettings["autoSyncMode"];
            await p.saveSettings();
            p.restartAutoSync();
            this.render();
          });
        d.setDisabled(!p.settings.autoSyncEnabled);
      });
  }

  /** 栏目右上角的统计文案 */
  private readyText(total: number, ready: number): string {
    if (total === 0) return "未配置";
    if (ready === total) return `${ready} 个可跑`;
    return `${ready} 个可跑，${total - ready} 个待补配置`;
  }

  /** 一条推送分身 */
  private renderPushRow(list: HTMLElement, prof: PushProfile) {
    const p = this.plugin;
    const row = list.createDiv({ cls: "ima-panel-row" });
    const main = row.createDiv({ cls: "ima-panel-row-main" });
    main.createDiv({ cls: "ima-panel-row-name", text: prof.name || "（未命名）" });

    const src = prof.folders.length
      ? summarizeList(prof.folders.map((f) => p.describeFolder(f)))
      : "未选源文件夹";
    const dst = prof.targets.length
      ? summarizeList(prof.targets.map((t) => targetBrief(t)))
      : "未选目标";
    main.createDiv({ cls: "ima-panel-row-meta", text: `${src} → ${dst}` });

    const ok = prof.folders.length > 0 && prof.targets.length > 0;
    const sub = main.createDiv({ cls: "ima-panel-row-sub" });
    if (ok) {
      sub.setText(`${p.filesUnderFolders(prof.folders).length} 个文件`);
    } else {
      sub.setText("配置不完整：需要同时有源文件夹和目标");
      sub.addClass("ima-panel-warn");
    }

    const btn = row.createEl("button", { text: this.busy === prof.id ? "推送中…" : "推送" });
    btn.addClass("ima-panel-run");
    btn.addClass("mod-cta");
    btn.disabled = !ok || !!this.busy;
    btn.onclick = () => void this.runTask(prof.id, () => p.runPushProfile(prof));
  }

  /** 一条拉取分身 */
  private renderPullRow(list: HTMLElement, prof: PullProfile) {
    const p = this.plugin;
    const row = list.createDiv({ cls: "ima-panel-row" });
    const main = row.createDiv({ cls: "ima-panel-row-main" });
    main.createDiv({ cls: "ima-panel-row-name", text: prof.name || "（未命名）" });

    const src =
      [
        prof.kbIds.length ? summarizeList(prof.kbIds.map((id) => p.kbNameOf(id))) : "",
        prof.includeNotes ? "个人笔记" : "",
      ]
        .filter(Boolean)
        .join("、") || "未选来源";
    main.createDiv({
      cls: "ima-panel-row-meta",
      text: `${src} → ${p.describeFolder(prof.dest) || "未设目录"}`,
    });

    const ok = prof.kbIds.length > 0 || prof.includeNotes;
    const sub = main.createDiv({ cls: "ima-panel-row-sub" });
    if (ok) {
      sub.setText(
        `${prof.downloadFiles ? "含文件原件" : "仅笔记类"}${prof.nestKbName ? " · 套知识库名" : ""}`,
      );
    } else {
      sub.setText("配置不完整：没勾知识库，也没开个人笔记");
      sub.addClass("ima-panel-warn");
    }

    const btn = row.createEl("button", { text: this.busy === prof.id ? "拉取中…" : "拉取" });
    btn.addClass("ima-panel-run");
    btn.addClass("mod-cta");
    btn.disabled = !ok || !!this.busy;
    btn.onclick = () => void this.runTask(prof.id, () => p.runPullProfile(prof));
  }

  /** 推当前文件：面板不关，目标选择弹窗叠在上面 */
  private pushActive() {
    if (!this.app.workspace.getActiveFile()) {
      new Notice("没有打开的文件可推送");
      return;
    }
    this.plugin.pushActiveFile();
  }

  /** 统一的"跑一件事"包装：置忙 → 重绘 → 执行 → 复位重绘 */
  private async runTask(id: string, fn: () => Promise<unknown>) {
    if (this.busy) {
      new Notice("已有任务在进行中，请等它结束");
      return;
    }
    this.busy = id;
    this.render();
    try {
      await fn();
    } catch (e: any) {
      new Notice("执行失败：" + e.message);
    } finally {
      this.busy = "";
      this.render();
    }
  }

  /** 跳到本插件设置页（面板里能直接改配置） */
  private openSettings() {
    const s: any = (this.app as any).setting;
    if (!s || typeof s.openTabById !== "function") {
      new Notice("请从「设置 → 第三方插件 → IMA Duo Sync」进入");
      return;
    }
    s.open();
    s.openTabById((this.plugin.manifest && this.plugin.manifest.id) || "ima-duo");
  }
}

/** 通用单选列表（分身选择等）：传对象数组和一个回调 */
class ProfileSuggestModal extends SuggestModal<any> {
  constructor(
    app: App,
    placeholder: string,
    private items: any[],
    private onPick: (item: any) => void,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getSuggestions(q: string): any[] {
    if (!q) return this.items;
    const k = q.toLowerCase();
    return this.items.filter((i) => String(i.name || "").toLowerCase().includes(k));
  }
  renderSuggestion(i: any, el: HTMLElement) {
    el.createEl("div", { text: i.name || "（未命名）" });
    const meta =
      i.targets !== undefined
        ? `${(i.folders || []).length} 个源 → ${(i.targets || []).length} 个目标`
        : `${(i.kbIds || []).length} 个知识库 → ${i.dest || "未设目录"}`;
    el.createEl("small", { text: meta, cls: "ima-muted" });
  }
  onChooseSuggestion(i: any) {
    this.onPick(i);
  }
}

/** 文件夹多选：带搜索的勾选列表，用于给推送分身挑多个源文件夹 */
class FolderChecklistModal extends Modal {
  private checked: Set<string>;
  private filter = "";
  constructor(
    app: App,
    private folders: TFolder[],
    selected: string[],
    private onSave: (paths: string[]) => void,
  ) {
    super(app);
    this.checked = new Set(selected);
    this.setTitle("选择源文件夹（可多选）");
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("p", {
      text: "选中的文件夹会取并集一起推送。只推送每个文件夹里面的内容，不会把文件夹本身带过去。",
      cls: "ima-muted",
    });

    const searchRow = contentEl.createDiv({ cls: "ima-search-row" });
    const input = searchRow.createEl("input", { type: "text", cls: "ima-search-input" });
    input.placeholder = "搜索文件夹…";
    input.value = this.filter;
    const listEl = contentEl.createDiv({ cls: "ima-folder-list" });
    const render = () => {
      listEl.empty();
      this.renderList(listEl);
    };
    input.oninput = () => {
      this.filter = input.value;
      render();
    };
    render();

    const bar = contentEl.createDiv({ cls: "ima-btn-row" });
    bar.createEl("button", { text: "全不选" }).onclick = () => {
      for (const p of this.visible().map((f) => f.path)) this.checked.delete(p);
      render();
    };
    bar.createEl("button", { text: "确定", cls: "mod-cta" }).onclick = () => {
      this.onSave(Array.from(this.checked));
      this.close();
    };
    bar.createEl("button", { text: "取消" }).onclick = () => this.close();
  }

  private visible(): TFolder[] {
    const k = this.filter.trim().toLowerCase();
    const all = this.folders.filter((f) => f.path);
    return k ? all.filter((f) => f.path.toLowerCase().includes(k)) : all;
  }

  private renderList(el: HTMLElement) {
    const list = this.visible();
    if (list.length === 0) {
      el.createEl("div", { text: "没有匹配的文件夹", cls: "ima-muted" });
      return;
    }
    for (const f of list.slice(0, 400)) {
      const row = el.createDiv({ cls: "ima-folder-row" });
      const cb = row.createEl("input", { type: "checkbox", cls: "ima-kb-checkbox" });
      cb.checked = this.checked.has(f.path);
      const label = row.createEl("label", { text: `/${f.path}` });
      label.onclick = () => {
        cb.checked = !cb.checked;
        if (cb.checked) this.checked.add(f.path);
        else this.checked.delete(f.path);
      };
      cb.onchange = () => {
        if (cb.checked) this.checked.add(f.path);
        else this.checked.delete(f.path);
      };
    }
    if (list.length > 400) {
      el.createEl("div", { text: `…另有 ${list.length - 400} 个文件夹，请用搜索缩小范围`, cls: "ima-muted" });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class DuplicateCleanModal extends Modal {
  constructor(
    app: App,
    private dups: DupCandidate[],
    private onConfirm: (files: TFile[]) => void,
  ) {
    super(app);
    this.setTitle("清理拉取重复文件");
  }

  onOpen() {
    const { contentEl } = this;
    const same = this.dups.filter((d) => d.identical).map((d) => d.file);
    const diff = this.dups.filter((d) => !d.identical);

    contentEl.createEl("p", {
      text: `在落地目录里找到 ${this.dups.length} 个重复文件。`,
    });
    contentEl.createEl("p", {
      text: `其中 ${same.length} 个与主文件内容完全一致，可以安全删除；${diff.length} 个内容与主文件不同，不会动它们。`,
    });

    if (same.length) {
      contentEl.createEl("h4", { text: `将删除（${same.length} 个，移入系统回收站）` });
      const list = contentEl.createDiv({ cls: "ima-dup-list" });
      for (const f of same.slice(0, 100)) list.createEl("div", { text: f.path });
      if (same.length > 100) {
        list.createEl("div", { text: `…另有 ${same.length - 100} 个`, cls: "ima-muted" });
      }
    }

    if (diff.length) {
      contentEl.createEl("h4", { text: `内容不同，保留（${diff.length} 个）` });
      const list = contentEl.createDiv({ cls: "ima-dup-list" });
      for (const d of diff.slice(0, 50)) {
        list.createEl("div", { text: `${d.file.path} ← 主文件：${d.basePath}` });
      }
      if (diff.length > 50) {
        list.createEl("div", { text: `…另有 ${diff.length - 50} 个`, cls: "ima-muted" });
      }
    }

    const bar = contentEl.createDiv({ cls: "ima-btn-row" });
    const delBtn = bar.createEl("button", {
      text: same.length ? `删除 ${same.length} 个` : "没有可删除的文件",
      cls: "mod-cta",
    }) as HTMLButtonElement;
    delBtn.disabled = same.length === 0;
    delBtn.onclick = () => {
      this.close();
      this.onConfirm(same);
    };
    bar.createEl("button", { text: "取消" }).onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class KbSuggestModal extends SuggestModal<KbInfo> {
  constructor(
    app: App,
    private items: KbInfo[],
    private onPick: (c: KbInfo) => void,
    placeholder = "搜索知识库…",
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getSuggestions(q: string): KbInfo[] {
    return this.items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
  }
  renderSuggestion(c: KbInfo, el: HTMLElement) {
    el.createEl("div", { text: c.name });
    const extra = [c.baseType || "", c.contentCount != null ? `${c.contentCount} 条` : ""]
      .filter(Boolean)
      .join(" · ");
    el.createEl("small", { text: extra, cls: "ima-muted" });
  }
  onChooseSuggestion(c: KbInfo) {
    this.onPick(c);
  }
}

/** 选知识库内的目标文件夹（第一项是根目录，直接回车即选） */
class KbFolderSuggestModal extends SuggestModal<{ path: string; id: string | null }> {
  constructor(
    app: App,
    private folders: KbFolder[],
    private kbName: string,
    private onPick: (c: { path: string; id: string | null }) => void,
  ) {
    super(app);
    this.setPlaceholder(`搜索「${kbName}」里的文件夹…（回车 = 知识库根目录）`);
  }
  getSuggestions(q: string) {
    const all: { path: string; id: string | null }[] = [
      { path: "", id: null },
      ...this.folders.map((f) => ({ path: f.path, id: f.id as string | null })),
    ];
    if (!q) return all;
    const k = q.toLowerCase();
    return all.filter((i) => (i.path || "根目录").toLowerCase().includes(k));
  }
  renderSuggestion(c: { path: string; id: string | null }, el: HTMLElement) {
    el.createEl("div", { text: c.path || "（知识库根目录）" });
    el.createEl("small", {
      text: c.path ? `内容将落在 ${this.kbName} / ${c.path} 里` : `内容直接落在 ${this.kbName} 最外层`,
      cls: "ima-muted",
    });
  }
  onChooseSuggestion(c: { path: string; id: string | null }) {
    this.onPick(c);
  }
}

class NotebookSuggestModal extends SuggestModal<{ id: string; name: string }> {
  constructor(
    app: App,
    private items: { id: string; name: string }[],
    private onPick: (c: { id: string; name: string }) => void,
  ) {
    super(app);
    this.setPlaceholder("搜索笔记本…");
  }
  getSuggestions(q: string) {
    return this.items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
  }
  renderSuggestion(c: { id: string; name: string }, el: HTMLElement) {
    el.createEl("div", { text: c.name });
  }
  onChooseSuggestion(c: { id: string; name: string }) {
    this.onPick(c);
  }
}

class FolderSuggestModal extends SuggestModal<TFolder> {
  constructor(app: App, private items: TFolder[], private onPick: (c: TFolder) => void) {
    super(app);
    this.setPlaceholder("搜索文件夹…");
  }
  getSuggestions(q: string) {
    return this.items.filter((i) => i.path.toLowerCase().includes(q.toLowerCase()));
  }
  renderSuggestion(c: TFolder, el: HTMLElement) {
    el.createEl("div", { text: c.path === "/" ? "/（vault 根目录）" : c.path });
  }
  onChooseSuggestion(c: TFolder) {
    this.onPick(c);
  }
}

/** 知识库多选（按 base_type 分组，复刻 ima.copilot Sync 的勾选列表） */
class KbChecklistModal extends Modal {
  private checked: Set<string>;
  constructor(
    app: App,
    private kbs: KbInfo[],
    selected: string[],
    private onSave: (ids: string[]) => void,
    title = "选择要拉取的知识库",
    private hint = "勾选后点「确定」保存。列表包含个人、共享与订阅知识库。",
  ) {
    super(app);
    this.checked = new Set(selected);
    this.setTitle(title);
  }
  onOpen() {
    const { contentEl } = this;
    if (this.kbs.length === 0) {
      contentEl.createEl("p", { text: "没有读取到知识库，请先在设置中确认凭证是否有效。" });
      return;
    }
    contentEl.createEl("p", { text: this.hint, cls: "ima-muted" });
    const groups = new Map<string, KbInfo[]>();
    for (const k of this.kbs) {
      const g = k.baseType || "其他";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(k);
    }
    for (const [g, list] of groups) {
      contentEl.createDiv({ cls: "ima-kb-group-header", text: `${g}（${list.length}）` });
      for (const kb of list) {
        const row = contentEl.createDiv({ cls: "ima-kb-row" });
        const cb = row.createEl("input", { type: "checkbox", cls: "ima-kb-checkbox" });
        cb.checked = this.checked.has(kb.id);
        cb.onchange = () => {
          if (cb.checked) this.checked.add(kb.id);
          else this.checked.delete(kb.id);
        };
        const label = row.createEl("label", { text: kb.name });
        label.onclick = () => {
          cb.checked = !cb.checked;
          if (cb.checked) this.checked.add(kb.id);
          else this.checked.delete(kb.id);
        };
        if (kb.contentCount != null) {
          row.createEl("span", { cls: "ima-kb-id", text: `${kb.contentCount} 条` });
        }
      }
    }
    const bar = contentEl.createDiv({ cls: "ima-btn-row" });
    bar.createEl("button", { text: "全选" }).onclick = () => {
      for (const k of this.kbs) this.checked.add(k.id);
      this.onOpenRefresh();
    };
    bar.createEl("button", { text: "全不选" }).onclick = () => {
      this.checked.clear();
      this.onOpenRefresh();
    };
    bar.createEl("button", { text: "确定", cls: "mod-cta" }).onclick = () => {
      this.onSave(Array.from(this.checked));
      this.close();
    };
  }
  private onOpenRefresh() {
    const { contentEl } = this;
    contentEl.empty();
    this.onOpen();
  }
  onClose() {
    this.contentEl.empty();
  }
}

// ---------- 设置页 ----------

const muted = { style: "color: var(--text-muted); font-size: 0.85em;" };

/** 32 位 FNV-1a，用于给正文取指纹（不是加密用途，够用即可） */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const pathStyle = { style: "color: var(--text-muted); font-size: 0.85em; word-break: break-all;" };

/**
 * 构造富文本描述（带链接、换行、灰字）。
 * Obsidian 在全局暴露了 createFragment()，这里额外留一条纯 DOM 兜底，
 * 以免个别版本或宿主环境下拿不到该全局而整页设置渲染失败。
 */
function richDesc(build: (el: DocumentFragment) => void): DocumentFragment {
  const frag =
    typeof createFragment === "function" ? createFragment() : document.createDocumentFragment();
  build(frag);
  return frag;
}

class ImaDuoSettingTab extends PluginSettingTab {
  plugin: ImaDuoPlugin;
  constructor(app: App, plugin: ImaDuoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    // 让插件在配置项变更后能立即重绘本页
    p.onSettingsChanged = () => this.display();
    containerEl.empty();

    if (!Platform.isDesktop) {
      const box = containerEl.createDiv({ cls: "ima-mobile-notice" });
      box.createEl("p", {
        text: "📢 本插件依赖 Node 能力上传文件与写入日志，建议在桌面端使用。个人笔记的推送与拉取不受影响。",
      });
    }

    // ══════════ 同步设置 ══════════
    new Setting(containerEl).setName("同步设置").setHeading();

    const credBox = containerEl.createDiv({ cls: "ima-cred-box" });

    new Setting(credBox)
      .setName("如何获取凭证")
      .setDesc(
        richDesc((w) => {
          w.appendText("访问 ");
          const a = w.createEl("a", {
            text: "https://ima.qq.com/agent-interface",
            href: "https://ima.qq.com/agent-interface",
          });
          a.target = "_blank";
          w.appendText(" 获取 Client ID 和 API Key。");
          w.createEl("br");
          w.appendText("复制页面上的凭证文本后，点击右侧按钮可自动解析填入。");
          w.createEl("br");
          w.createSpan({ text: "凭证格式：API Key: xxx\\nClient ID: xxx", attr: muted });
          w.createEl("br");
          w.createSpan({
            text: this.plugin.usingSecretStorage
              ? "凭证将安全存储于 Obsidian 钥匙串中，不会以明文保存在配置文件里。"
              : "⚠️ 当前 Obsidian 版本不支持钥匙串，凭证将以明文保存在插件配置中。",
            attr: muted,
          });
          if (p.credSource) {
            w.createEl("br");
            w.createSpan({ text: `当前凭证来源：${p.credSource}`, attr: muted });
          }
        }),
      )
      .addButton((b) =>
        b.setButtonText("粘贴并解析凭证").onClick(async () => {
          let text = "";
          try {
            text = await navigator.clipboard.readText();
          } catch {
            new Notice("无法读取剪贴板，请检查系统权限");
            return;
          }
          const parsed = parseCredentialText(text);
          if (!parsed || (!parsed.clientId && !parsed.apiKey)) {
            new Notice('未识别到有效凭证，请确认格式为 "API Key: xxx" 和 "Client ID: xxx"');
            return;
          }
          if (parsed.clientId) p.saveCreds(parsed.clientId, "");
          if (parsed.apiKey) p.saveCreds("", parsed.apiKey);
          p.credSource = "手动粘贴";
          this.display();
          new Notice("凭证已配置");
        }),
      );

    new Setting(credBox)
      .setName("Client ID")
      .setDesc(
        this.plugin.usingSecretStorage
          ? "ima OpenAPI 的 Client ID（安全存储于 Obsidian 钥匙串）"
          : "ima OpenAPI 的 Client ID",
      )
      .addText((t) => {
        t.setPlaceholder("输入 Client ID")
          .setValue(this.plugin.getCreds().clientId)
          .onChange((v) => p.saveCreds(v.trim(), ""));
        t.inputEl.addClass("ima-input-wide");
      });

    new Setting(credBox)
      .setName("API Key")
      .setDesc(
        this.plugin.usingSecretStorage
          ? "ima OpenAPI 的 API Key（安全存储于 Obsidian 钥匙串）"
          : "ima OpenAPI 的 API Key",
      )
      .addText((t) => {
        t.setPlaceholder("输入 API Key")
          .setValue(this.plugin.getCreds().apiKey)
          .onChange((v) => p.saveCreds("", v.trim()));
        t.inputEl.type = "password";
        t.inputEl.addClass("ima-input-wide");
      });

    new Setting(credBox)
      .setName("测试连接")
      .setDesc("验证 Client ID 与 API Key 是否有效，最长等 15 秒")
      .addButton((b) =>
        b.setButtonText("测试").onClick(async () => {
          const { clientId, apiKey } = p.getCreds();
          if (!clientId || !apiKey) {
            new Notice("请先填写 Client ID 和 API Key");
            return;
          }
          b.setDisabled(true);
          b.setButtonText("测试中…");
          try {
            const client = new ImaClient(clientId, apiKey, (m) => p.log(m));
            const timeout = new Promise<never>((_, rej) =>
              window.setTimeout(
                () => rej(new Error("测试连接超时（15s），请检查网络后重试")),
                15000,
              ),
            );
            const res = await Promise.race([client.testConnection(), timeout]);
            await p.refreshKbCache();
            new Notice(
              `连接成功：共 ${res.count} 个知识库\n` +
                (res.names.length ? res.names.join("、") : ""),
              8000,
            );
            p.credSource = "已验证通过";
            this.display();
          } catch (e: any) {
            new Notice("连接失败：" + e.message, 12000);
          } finally {
            b.setDisabled(false);
            b.setButtonText("测试");
          }
        }),
      );

    const syncBox = containerEl.createDiv({ cls: "ima-cred-box" });

    new Setting(syncBox)
      .setName("从本地文件读取凭证")
      .setDesc("改为读取本机 ~/.config/ima/ 下的 client_id 和 api_key，忽略上方手填的凭证")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useLocalCreds).onChange(async (v) => {
          this.plugin.settings.useLocalCreds = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(syncBox)
      .setName("文件名作为笔记标题")
      .setDesc("推送 Markdown 时，用文件名作为笔记标题。IMA 以正文首行决定标题，关闭后标题可能对不上")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useFileNameAsTitle).onChange(async (v) => {
          this.plugin.settings.useFileNameAsTitle = v;
          await this.plugin.saveSettings();
        }),
      );

    // ══════════ 自动同步 ══════════
    new Setting(containerEl).setName("自动同步").setHeading();
    const autoBox = containerEl.createDiv({ cls: "ima-cred-box" });

    new Setting(autoBox)
      .setName("启用自动同步")
      .setDesc(
        richDesc((w) => {
          w.appendText("到设定时刻自动执行全部推送与全部拉取，省去手动操作。");
          w.createEl("br");
          w.createSpan({ text: `当前：${p.autoSyncStatusText()}`, attr: muted });
        }),
      )
      .addToggle((t) =>
        t.setValue(p.settings.autoSyncEnabled).onChange(async (v) => {
          p.settings.autoSyncEnabled = v;
          await p.saveSettings();
          p.restartAutoSync();
          this.display();
        }),
      );

    new Setting(autoBox)
      .setName("同步时刻（24 小时制）")
      .setDesc(
        richDesc((w) => {
          w.appendText("每天到点自动跑一轮，可以加多个时刻，像闹钟一样。");
          w.createEl("br");
          w.appendText("到点时如果 Obsidian 没开着，下次启动后补跑一次；留空则不会自动跑。");
        }),
      );

    p.renderAutoSyncTimes(autoBox, () => this.display());

    new Setting(autoBox)
      .setName("同步内容")
      .setDesc("选择自动同步执行哪一侧。双向最省心，只需要一侧时选单边")
      .addDropdown((d) => {
        d.addOption("both", "推送 + 拉取")
          .addOption("push", "仅推送")
          .addOption("pull", "仅拉取")
          .setValue(p.settings.autoSyncMode)
          .onChange(async (v) => {
            p.settings.autoSyncMode = v as ImaDuoSettings["autoSyncMode"];
            await p.saveSettings();
            p.restartAutoSync();
            this.display();
          });
        d.setDisabled(!p.settings.autoSyncEnabled);
      });

    new Setting(autoBox)
      .setName("立即同步一次")
      .setDesc("不必等下一个时刻，立刻按上面的设置执行一轮")
      .addButton((b) =>
        b.setButtonText("立即同步").onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("同步中…");
          try {
            await p.runAutoSync({ manual: true });
          } finally {
            b.setDisabled(false);
            b.setButtonText("立即同步");
            this.display();
          }
        }),
      );

    // ══════════ 推送 ══════════
    new Setting(containerEl).setName("推送").setHeading();
    const pushBox = containerEl.createDiv({ cls: "ima-kb-box" });

    const pushProfiles = this.plugin.settings.pushProfiles;

    new Setting(pushBox)
      .setName("推送分身")
      .setDesc(
        richDesc((w) => {
          w.appendText("一个分身代表一组对应关系，即哪些文件夹推给哪些目标。多个文件夹的内容会合并，");
          w.createEl("strong", { text: "每个目标都会收到全部内容" });
          w.appendText("；文件按它相对源文件夹的路径放置，不会多套一层父目录。");
          w.createEl("br");
          w.appendText("每个目标分别查重，已存在的同名条目不会重复推送。");
          w.createEl("br");
          w.createSpan({
            text: "想让同一批内容推到多个目标、或者分别单独重推，就建多个分身。",
            attr: muted,
          });
        }),
      )
      .addButton((b) =>
        b.setButtonText("新建分身").setCta().onClick(() => void this.plugin.addPushProfile()),
      );

    if (pushProfiles.length === 0) {
      pushBox.createDiv({
        cls: "ima-empty-hint",
        text: "还没有推送分身，点上面的「新建分身」开始配置。",
      });
    }
    pushProfiles.forEach((prof, i) => this.renderPushProfileCard(pushBox, prof, i));

    new Setting(pushBox)
      .setName("全部推送")
      .setDesc(
        pushProfiles.length
          ? `依次运行全部 ${pushProfiles.length} 个分身，其中一个出错不影响其余分身`
          : "还没有推送分身",
      )
      .addButton((b) =>
        b
          .setButtonText("全部推送")
          .setDisabled(pushProfiles.length === 0)
          .onClick(() => this.plugin.confirmRunAllPush()),
      );

    new Setting(pushBox)
      .setName("同名条目")
      .setDesc(
        richDesc((w) => {
          w.appendText("仅当");
          w.createEl("strong", { text: "插件第一次遇到某个文件" });
          w.appendText(
            "、而目标里已经有同名条目时生效，比如之前手动传过。默认跳过，并把它登记为同一版本，不会重复创建。",
          );
        }),
      )
      .addDropdown((d) =>
        d
          .addOption("skip", "跳过已存在（推荐）")
          .addOption("rename", "改名新建一份")
          .setValue(this.plugin.settings.onDuplicate === "rename" ? "rename" : "skip")
          .onChange(async (v) => {
            this.plugin.settings.onDuplicate = v === "rename" ? "rename" : "skip";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(pushBox)
      .setName("改动怎么处理")
      .setDesc(
        richDesc((w) => {
          w.createEl("strong", { text: "未改动的文件不会重复推送。" });
          w.appendText("内容改过之后，插件会另存一份带版本号的新条目（");
          w.createEl("code", { text: "笔记.md → 笔记@v2.md" });
          w.appendText("）。");
          w.createEl("strong", { text: "IMA 不支持覆盖或删除" });
          w.appendText("，旧版本会留在库里，需要时到 IMA 客户端手动清理。");
        }),
      )
      .addButton((b) =>
        b.setButtonText("清空推送记录").onClick(async () => {
          const n = Object.keys(this.plugin.settings.pushState || {}).length;
          if (n === 0) {
            new Notice("还没有推送记录");
            return;
          }
          new ConfirmModal(
            this.app,
            "清空推送记录？",
            [
              `将清掉 ${n} 条记录（只影响本地，IMA 上的条目一个都不会动）。`,
              "下次推送会重新对齐，已存在的同名条目按同一版本采纳，不会新建。不过之前改过、还没推过的内容会被当成没改，需要再动一次才会推送。",
            ],
            "清空",
            async () => {
              this.plugin.settings.pushState = {};
              await this.plugin.saveSettings();
              new Notice("推送记录已清空");
            },
          ).open();
        }),
      );

    new Setting(pushBox)
      .setName("检查重复条目")
      .setDesc("选择一个知识库，扫描重复的同名条目并生成清单。IMA 不能自动删除，清理需到客户端手动完成")
      .addButton((b) =>
        b.setButtonText("选择知识库并扫描").onClick(() => void p.pickAndScanDuplicates()),
      );

    new Setting(pushBox)
      .setName("待清理条目")
      .setDesc(
        richDesc((w) => {
          w.appendText("列出不再需要的推送条目。");
          w.createEl("strong", { text: "改动后残留的旧版本" });
          w.appendText("（形如 ");
          w.createEl("code", { text: "名字@v2" });
          w.appendText("）和");
          w.createEl("strong", { text: "本地已删除或改名的文件" });
          w.appendText("。清单可拿到 IMA 客户端手动清理。只读本地推送记录，不联网。");
        }),
      )
      .addButton((b) => b.setButtonText("生成清单").onClick(() => void p.writeStaleReport()));

    new Setting(pushBox)
      .setName("同步差异检查")
      .setDesc(
        richDesc((w) => {
          w.appendText("联网对比知识库条目和本地文件，生成 ");
          w.createEl("code", { text: "ima-duo-同步差异.md" });
          w.appendText("。报告分几类：");
          w.createEl("strong", { text: "只在本地有" });
          w.appendText("、");
          w.createEl("strong", { text: "只在 IMA 有" });
          w.appendText("、本地改过还没推、旧版本残留、重复条目。");
          w.createEl("strong", { text: "只读取" });
          w.appendText("，不改动任何内容。");
        }),
      )
      .addButton((b) => b.setButtonText("开始检查").onClick(() => void p.writeSyncDiffReport()));

    new Setting(pushBox)
      .setName("推送当前文件")
      .setDesc("推送当前打开的笔记，每次都会先选择目标。这是一次性操作，不会改动分身配置")
      .addButton((b) => b.setButtonText("推送").onClick(() => p.pushActiveFile()));

    // ══════════ 拉取 ══════════
    new Setting(containerEl).setName("拉取").setHeading();
    const pullBox = containerEl.createDiv({ cls: "ima-kb-box" });

    new Setting(pullBox)
      .setName("拉取时跳过历史版本（@vN）")
      .setDesc(
        richDesc((w) => {
          w.appendText("改动过的文件在 IMA 里会保留旧版本（形如 ");
          w.createEl("code", { text: "名字@v2" });
          w.appendText(
            " 的条目）。把这些一起拉到本地只会多出重复文件，所以默认跳过。关掉后，历史版本也会一并拉到本地。",
          );
        }),
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.skipOldVersions !== false).onChange(async (v) => {
          this.plugin.settings.skipOldVersions = v;
          await this.plugin.saveSettings();
        }),
      );

    const pullProfiles = this.plugin.settings.pullProfiles;

    new Setting(pullBox)
      .setName("拉取分身")
      .setDesc(
        richDesc((w) => {
          w.appendText("一个分身代表一组来源（知识库，可加个人笔记）和");
          w.createEl("strong", { text: "一个落地目录" });
          w.appendText("。想让不同知识库落到不同目录，就建多个分身。");
          w.createEl("br");
          w.createSpan({
            text: "拉取是镜像，内容没变就不动本地文件，IMA 那边改了才更新，也不会重复堆积同内容的文件。",
            attr: muted,
          });
        }),
      )
      .addButton((b) =>
        b.setButtonText("新建分身").setCta().onClick(() => void this.plugin.addPullProfile()),
      );

    if (pullProfiles.length === 0) {
      pullBox.createDiv({
        cls: "ima-empty-hint",
        text: "还没有拉取分身，点上面的「新建分身」开始配置。",
      });
    }
    pullProfiles.forEach((prof, i) => this.renderPullProfileCard(pullBox, prof, i));

    new Setting(pullBox)
      .setName("全部拉取")
      .setDesc(
        pullProfiles.length
          ? `依次运行全部 ${pullProfiles.length} 个分身，其中一个出错不影响其余分身`
          : "还没有拉取分身",
      )
      .addButton((b) =>
        b
          .setButtonText("全部拉取")
          .setCta()
          .setDisabled(pullProfiles.length === 0)
          .onClick(async () => {
            b.setDisabled(true);
            b.setButtonText("拉取中…");
            try {
              await this.plugin.runPullAll();
            } finally {
              b.setDisabled(false);
              b.setButtonText("全部拉取");
            }
          }),
      );

    new Setting(pullBox)
      .setName("强制阅读模式")
      .setDesc("拉取下来的文件默认以阅读视图打开，避免误编辑")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.forceReadingMode).onChange(async (v) => {
          this.plugin.settings.forceReadingMode = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(pullBox)
      .setName("清理拉取重复")
      .setDesc(
        "扫描落地目录里的重复文件。只有内容与主文件完全一致的才会列出并可删除，删除后进入系统回收站，可以还原",
      )
      .addButton((b) =>
        b.setButtonText("扫描").onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("扫描中…");
          try {
            await p.cleanPullDuplicates();
          } finally {
            b.setDisabled(false);
            b.setButtonText("扫描");
          }
        }),
      );

    // ══════════ 通用 ══════════
    new Setting(containerEl).setName("通用").setHeading();
    const miscBox = containerEl.createDiv({ cls: "ima-kb-box" });

    new Setting(miscBox)
      .setName("输出调试日志")
      .setDesc("把接口请求和响应记录到插件目录的 ima-debug.log。默认关闭，排查问题时再打开")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableDebugLog).onChange(async (v) => {
          this.plugin.settings.enableDebugLog = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(miscBox)
      .setName("调试日志路径")
      .setDesc(
        richDesc((w) => {
          w.createSpan({ text: this.plugin.logFilePath(), attr: pathStyle });
        }),
      )
      .addButton((b) =>
        b.setButtonText("复制路径").onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.logFilePath());
          new Notice("路径已复制");
        }),
      );

    new Setting(miscBox)
      .setName("清除阅读模式记录")
      .setDesc(`已记录 ${this.plugin.settings.pulledPaths.length} 个拉取下来的文件，用于强制阅读模式`)
      .addButton((b) =>
        b.setButtonText("清除").onClick(async () => {
          this.plugin.settings.pulledPaths = [];
          await this.plugin.saveSettings();
          this.display();
          new Notice("已清除");
        }),
      );
  }

  /** 一个推送分身的卡片：名称 / 源文件夹 / 目标 / 单跑与删除 */
  private renderPushProfileCard(container: HTMLElement, prof: PushProfile, index: number) {
    const p = this.plugin;
    const card = container.createEl("details", { cls: "ima-profile" });
    card.open = true;
    const head = card.createEl("summary", { cls: "ima-profile-head" });
    head.createSpan({ cls: "ima-profile-badge", text: `推送 ${index + 1}` });
    const nameEl = head.createSpan({ cls: "ima-profile-name", text: prof.name || "（未命名）" });
    head.createSpan({
      cls: "ima-profile-meta",
      text: `${prof.folders.length} 个源 → ${prof.targets.length} 个目标`,
    });

    new Setting(card)
      .setName("名称")
      .setDesc("给这个分身起个名字，方便区分，例如「学习」「工作」。回车或点击别处生效")
      .addText((t) => {
        t.setPlaceholder("例如：学习")
          .setValue(prof.name)
          .onChange(async (v) => {
            prof.name = v.trim();
            await p.saveSettings();
          });
        t.inputEl.onblur = () => {
          nameEl.setText(prof.name || "（未命名）");
          this.display();
        };
      });

    new Setting(card)
      .setName("源文件夹")
      .setDesc(
        prof.folders.length
          ? richDesc((w) => {
              w.appendText("已选：");
              w.createEl("strong", {
                text: prof.folders.map((f) => p.describeFolder(f)).join("、"),
              });
              const n = p.filesUnderFolders(prof.folders).length;
              w.createSpan({ text: `（合计 ${n} 个文件）`, attr: muted });
            })
          : "尚未选择。可以选多个文件夹，内容合并后一起推送",
      )
      .addButton((b) =>
        b
          .setButtonText(prof.folders.length ? "更改源文件夹" : "选择源文件夹")
          .onClick(() => p.pickProfileFolders(prof)),
      );

    new Setting(card)
      .setName("保留源文件夹本身这一层")
      .setDesc(
        prof.keepRoot !== false
          ? richDesc((w) => {
              w.appendText(
                "打开时，源文件夹这一层也会一起推送。比如选中「读书」文件夹，目标端先有一个「读书」，点进去才是里面的子文件夹。选多个源就是多棵目录树并排。",
              );
              w.createEl("br");
              w.createSpan({
                text: "目标端已有同名文件夹时会直接并进去，不会套出两层同名目录。",
                attr: muted,
              });
            })
          : richDesc((w) => {
              w.appendText("关闭时只推文件夹里的内容，子文件夹直接放在落点下，不建源文件夹这一层。");
            }),
      )
      .addToggle((t) =>
        t.setValue(prof.keepRoot !== false).onChange(async (v) => {
          prof.keepRoot = v;
          await p.saveSettings();
          this.display();
        }),
      );

    new Setting(card)
      .setName("目标")
      .setDesc(
        prof.targets.length
          ? `已选 ${prof.targets.length} 个目标，每个目标都会收到全部源的内容`
          : "尚未选择。可以选多个知识库，也可以选个人笔记",
      )
      .addButton((b) => b.setButtonText("添加目标").onClick(() => p.pickProfileTargets(prof)));

    if (prof.targets.length) {
      const chipList = card.createDiv({ cls: "ima-chip-list" });
      for (const t of prof.targets) {
        const chip = chipList.createDiv({ cls: "ima-chip" });
        chip.createSpan({ cls: "ima-chip-text", text: targetDetail(t) });
        if (t.kind === "kb") {
          const edit = chip.createEl("button", { text: "改落点", cls: "ima-chip-btn" });
          edit.onclick = () => void p.pickTargetFolder(prof, t);
        }
        const del = chip.createEl("button", { text: "移除", cls: "ima-chip-btn" });
        del.onclick = () => void p.removeProfileTarget(prof, t);
      }
    }

    const bar = card.createDiv({ cls: "ima-btn-row" });
    const runBtn = bar.createEl("button", { text: "推送这个分身", cls: "mod-cta" });
    runBtn.disabled = !prof.folders.length || !prof.targets.length;
    runBtn.onclick = () => void p.runPushProfile(prof);
    const delBtn = bar.createEl("button", { text: "删除这个分身" });
    delBtn.onclick = () => void p.removePushProfile(prof);
  }

  /** 一个拉取分身的卡片：名称 / 知识库多选 / 可选个人笔记 / 目录与选项 / 单跑与删除 */
  private renderPullProfileCard(container: HTMLElement, prof: PullProfile, index: number) {
    const p = this.plugin;
    const card = container.createEl("details", { cls: "ima-profile" });
    card.open = true;
    const head = card.createEl("summary", { cls: "ima-profile-head" });
    head.createSpan({ cls: "ima-profile-badge", text: `拉取 ${index + 1}` });
    const nameEl = head.createSpan({ cls: "ima-profile-name", text: prof.name || "（未命名）" });
    const sources =
      [prof.kbIds.length ? `${prof.kbIds.length} 个知识库` : "", prof.includeNotes ? "个人笔记" : ""]
        .filter(Boolean)
        .join(" + ") || "未选来源";
    head.createSpan({
      cls: "ima-profile-meta",
      text: `${sources} → ${prof.dest || "未设目录"}`,
    });

    new Setting(card)
      .setName("名称")
      .setDesc("给这个分身起个名字，方便区分，例如「订阅内容」「工作资料」")
      .addText((t) => {
        t.setPlaceholder("例如：订阅内容")
          .setValue(prof.name)
          .onChange(async (v) => {
            prof.name = v.trim();
            await p.saveSettings();
          });
        t.inputEl.onblur = () => {
          nameEl.setText(prof.name || "（未命名）");
          this.display();
        };
      });

    new Setting(card)
      .setName("知识库")
      .setDesc(
        prof.kbIds.length
          ? `已选 ${prof.kbIds.length} 个：${prof.kbIds.map((id) => p.kbNameOf(id)).join("、")}`
          : "尚未选择。点右侧按钮可以多选知识库",
      )
      .addButton((b) =>
        b.setButtonText("选择知识库").onClick(() => void p.pickPullProfileKbs(prof)),
      );

    new Setting(card)
      .setName("包含个人笔记")
      .setDesc("同时拉取 ima 个人笔记，按笔记本自动建立子目录")
      .addToggle((t) =>
        t.setValue(prof.includeNotes).onChange(async (v) => {
          prof.includeNotes = v;
          await p.saveSettings();
          this.display();
        }),
      );

    new Setting(card)
      .setName("落地目录")
      .setDesc(
        prof.nestKbName
          ? "内容写入 vault 的这个文件夹，并在里面再建一层知识库名"
          : "内容写入 vault 的这个文件夹",
      )
      .addText((t) =>
        t
          .setPlaceholder("ima/知识库")
          .setValue(prof.dest)
          .onChange(async (v) => {
            prof.dest = v.trim();
            await p.saveSettings();
          }),
      );

    new Setting(card)
      .setName("下载知识库文件")
      .setDesc(
        "是否把知识库里的 docx、PDF 等文件下载到本地。关闭后只拉取笔记类内容。文件链接带时效签名，过期后需要重新获取",
      )
      .addToggle((t) =>
        t.setValue(prof.downloadFiles).onChange(async (v) => {
          prof.downloadFiles = v;
          await p.saveSettings();
        }),
      );

    new Setting(card)
      .setName("知识库名称作为子文件夹")
      .setDesc(
        richDesc((w) => {
          w.appendText("关闭（默认）时，知识库内容直接放在落地目录下，不再多套一层知识库名。");
          w.createEl("br");
          w.appendText(
            "打开时，在落地目录下再建一层以知识库命名的文件夹。一个分身把多个知识库拉到同一目录时，用它避免内容混在一起。",
          );
        }),
      )
      .addToggle((t) =>
        t.setValue(prof.nestKbName).onChange(async (v) => {
          prof.nestKbName = v;
          await p.saveSettings();
          this.display();
        }),
      );

    const bar = card.createDiv({ cls: "ima-btn-row" });
    const runBtn = bar.createEl("button", { text: "拉取这个分身", cls: "mod-cta" });
    runBtn.disabled = !prof.kbIds.length && !prof.includeNotes;
    runBtn.onclick = () => void p.runPullProfile(prof);
    const delBtn = bar.createEl("button", { text: "删除这个分身" });
    delBtn.onclick = () => void p.removePullProfile(prof);
  }
}
