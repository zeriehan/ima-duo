export interface KbInfo {
  id: string;
  name: string;
  baseType?: string; // 个人知识库 / 我加入的订阅知识库 / 共享知识库
  contentCount?: number;
}

export interface NotebookInfo {
  id: string;
  name: string;
}

export interface NoteInfo {
  note_id: string;
  title: string;
  folderId?: string;
  folderName?: string;
}

export interface PushTarget {
  kind: "kb" | "note";
  kbId?: string;
  kbName?: string;
  /** 知识库内目标文件夹的 media_id；不传 = 知识库根 */
  kbFolderId?: string;
  /** 知识库内目标文件夹路径（相对知识库根，"" = 根），仅用于展示与建树 */
  kbFolderPath?: string;
  noteFolderId?: string; // "" 或 undefined = 未分类（个人笔记根）
  noteFolderName?: string;
}

/** 知识库内的文件夹（保留原始大小写的路径 + media_id） */
export interface KbFolder {
  path: string;
  id: string;
}

/** 知识库内的一条目（笔记或文件），带所在目录路径，用于重复检测 */
export interface KbEntry {
  title: string;
  mediaId: string;
  mediaType: number;
  /** 所在文件夹路径，"" = 知识库根 */
  folderPath: string;
}
