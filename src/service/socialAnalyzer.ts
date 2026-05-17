import { Notice, normalizePath, setIcon, TFolder } from "obsidian";
import { spawn } from "child_process";
import { access } from "fs/promises";
import { isAbsolute, join, resolve } from "path";
import WhereAmIPlugin from "../main";
import { uuid } from "../tool";
import {
  createRootTextNode,
  ensureEdge,
  findNodeById,
  findRootByTitle,
  readToolState,
  removeTrackedChildren,
  setNodeText,
  writeToolState,
} from "./toolNode";

interface SocialAnalyzerProfile {
  link?: string;
  url?: string;
  website?: string;
  site?: string;
  service?: string;
  name?: string;
  rate?: string | number;
  status?: string;
  title?: string;
  text?: string;
  image?: string;
  img?: string;
  [key: string]: unknown;
}

interface SocialAnalyzerResult {
  detected?: SocialAnalyzerProfile[];
  unknown?: SocialAnalyzerProfile[];
  failed?: SocialAnalyzerProfile[];
  [key: string]: unknown;
}

interface SocialAnalyzerHit {
  site: string;
  url: string;
  status: string;
  meta: Record<string, unknown>;
}

interface SocialAnalyzerReport {
  hit: SocialAnalyzerHit;
  path: string;
}

export class SocialAnalyzerService {
  private plugin: WhereAmIPlugin;
  private statusEl: HTMLElement;

  constructor(plugin: WhereAmIPlugin) {
    this.plugin = plugin;
    this.statusEl = plugin.addStatusBarItem();
    this.statusEl.hide();
    setIcon(this.statusEl, "network");
  }

  async runFromSelection() {
    const canvas = this.plugin.canvas;
    const selected = this.plugin.node.getSingleSelection();
    const canvasFile = this.plugin.getActiveCanvasFile();
    if (!canvas || !selected || !canvasFile) {
      new Notice("Comshit: select one Canvas text node first.");
      return;
    }
    const query = this.extractQuery(selected.text);
    if (!query) {
      new Notice("Comshit: selected node has no username text.");
      return;
    }

    let command = "";
    let args: string[] = [];
    let cwd: string | undefined;
    try {
      ({ command, args, cwd } = await this.buildCommand(query));
    } catch (error) {
      new Notice(`Comshit: ${(error as Error).message}`);
      return;
    }
    this.ensureRoot(canvas, canvasFile.path, selected, query);
    await this.plugin.saveState();
    canvas.requestSave?.();

    this.statusEl.show();
    this.statusEl.textContent = "Social Analyzer: running";
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      cwd,
      env: this.buildProcessEnv(),
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      this.statusEl.hide();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        new Notice("Comshit: Social Analyzer command not found. Configure it in settings.", 9000);
      } else {
        new Notice(`Comshit: Social Analyzer failed to start (${error.message}).`);
      }
    });

    child.on("close", async (code) => {
      this.statusEl.hide();
      if (code !== 0) {
        new Notice(`Comshit: Social Analyzer exited with code ${code}. ${this.formatProcessError(stderr || stdout)}`, 12000);
        if (stderr.trim()) console.error("[Comshit][SocialAnalyzer]", stderr);
        if (stdout.trim()) console.info("[Comshit][SocialAnalyzer stdout]", stdout);
        return;
      }
      const parsed = this.parseOutput(stdout);
      const hits = this.toHits(parsed);
      if (this.plugin.setting.socialAnalyzerSimplify) {
        await this.applySimpleResults(canvas, canvasFile.path, selected, query, hits);
        new Notice(`Comshit: Social Analyzer returned ${hits.length} profile(s).`);
        return;
      }
      const { reports, written } = await this.writeMarkdownReports(query, hits);
      await this.applyResults(canvas, canvasFile.path, selected, query, reports);
      new Notice(`Comshit: Social Analyzer returned ${hits.length} profile(s), wrote ${written} report file(s).`);
    });
  }

  private extractQuery(text: string): string {
    return (
      text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? ""
    );
  }

  private async buildCommand(query: string): Promise<{ command: string; args: string[]; cwd?: string }> {
    const embeddedDir = this.resolveEmbeddedDir();
    const embeddedApp = join(embeddedDir, "app.py");
    try {
      await access(embeddedApp);
    } catch {
      throw new Error(`Embedded Social Analyzer not found at ${embeddedApp}`);
    }
    const pythonConfigured = this.plugin.setting.socialAnalyzerPythonCommand.trim();
    const pythonChunks = this.tokenize(pythonConfigured || "python");
    if (!pythonChunks.length) {
      throw new Error("Social Analyzer Python command is empty.");
    }
    const command = pythonChunks[0];
    const args = [...pythonChunks.slice(1), embeddedApp, ...this.buildToolArgs(query)];
    if (this.plugin.setting.socialAnalyzerExtraArgs.trim()) {
      args.push(...this.tokenize(this.plugin.setting.socialAnalyzerExtraArgs.trim()));
    }
    return { command, args, cwd: embeddedDir };
  }

  private buildToolArgs(query: string): string[] {
    const args = ["--username", query, "--output", "json"];
    const mode = this.plugin.setting.socialAnalyzerMode.trim() || "fast";
    args.push("--mode", mode);

    this.pushArg(args, "--method", this.plugin.setting.socialAnalyzerMethod);
    this.pushArg(args, "--filter", this.plugin.setting.socialAnalyzerFilter);
    this.pushArg(args, "--profiles", this.plugin.setting.socialAnalyzerProfiles);
    this.pushArg(args, "--countries", this.plugin.setting.socialAnalyzerCountries);
    this.pushArg(args, "--type", this.plugin.setting.socialAnalyzerType);

    const websites = this.plugin.setting.socialAnalyzerWebsites.trim();
    if (websites) args.push("--websites", websites);

    if ((this.plugin.setting.socialAnalyzerTop ?? 0) > 0) {
      args.push("--top", String(this.plugin.setting.socialAnalyzerTop));
    }
    if (this.plugin.setting.socialAnalyzerExtractMetadata) args.push("--metadata");
    if (this.plugin.setting.socialAnalyzerExtractPatterns) args.push("--extract");
    if (this.plugin.setting.socialAnalyzerSimplify) args.push("--simplify");
    return args;
  }

  private pushArg(args: string[], flag: string, value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    args.push(flag, trimmed);
  }

  private tokenize(value: string): string[] {
    const tokens: string[] = [];
    const regex = /[^\s"]+|"([^"]*)"/g;
    let match = regex.exec(value);
    while (match) {
      tokens.push(match[1] ?? match[0]);
      match = regex.exec(value);
    }
    return tokens;
  }

  private resolveEmbeddedDir(): string {
    const configured =
      this.plugin.setting.socialAnalyzerEmbeddedDir.trim() || "social-analyzer-main";
    if (isAbsolute(configured)) return configured;

    const manifestDir = this.plugin.manifest.dir;
    if (manifestDir && isAbsolute(manifestDir)) {
      return join(manifestDir, configured);
    }

    const configPath =
      manifestDir ?? join(this.plugin.app.vault.configDir, "plugins", this.plugin.manifest.id);
    const fsAdapter = this.plugin.app.vault.adapter as { getBasePath?: () => string };
    const vaultBasePath = typeof fsAdapter.getBasePath === "function" ? fsAdapter.getBasePath() : "";
    const pluginDir = vaultBasePath ? resolve(vaultBasePath, configPath) : configPath;
    return join(pluginDir, configured);
  }

  private parseOutput(stdout: string): SocialAnalyzerResult {
    const first = stdout.indexOf("{");
    const last = stdout.lastIndexOf("}");
    if (first < 0 || last < 0 || last <= first) return {};
    try {
      return JSON.parse(stdout.slice(first, last + 1)) as SocialAnalyzerResult;
    } catch {
      return {};
    }
  }

  private toHits(result: SocialAnalyzerResult): SocialAnalyzerHit[] {
    return [
      ...this.mapProfiles(result.detected ?? [], "detected"),
      ...this.mapProfiles(result.unknown ?? [], "unknown"),
      ...this.mapProfiles(result.failed ?? [], "failed"),
    ].filter((hit) => hit.url);
  }

  private mapProfiles(items: SocialAnalyzerProfile[], status: string): SocialAnalyzerHit[] {
    return items.map((item) => {
      const url = String(item.link ?? item.url ?? "").trim();
      const site = this.getSiteName(item, url);
      const meta = this.cleanMetadata(item);
      return { site, url, status, meta };
    });
  }

  private getSiteName(item: SocialAnalyzerProfile, url: string): string {
    const explicit = item.website || item.site || item.service || item.name;
    if (explicit) return String(explicit).trim();
    return this.getDomain(url);
  }

  private cleanMetadata(value: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!value || typeof value !== "object") return out;

    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (this.shouldDropMetadataKey(key) || this.isEmptyMetadataValue(raw)) continue;
      out[key] = raw;
    }
    return out;
  }

  private shouldDropMetadataKey(key: string): boolean {
    return ["link", "url", "rate", "rank", "status"].includes(key.toLowerCase());
  }

  private isEmptyMetadataValue(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      return normalized.length === 0 || normalized === "filtered" || normalized === "unavailable";
    }
    if (Array.isArray(value)) return value.length === 0;
    return false;
  }

  private async applyResults(
    canvas: any,
    canvasPath: string,
    sourceNode: M.Node,
    query: string,
    reports: SocialAnalyzerReport[],
  ) {
    const root = this.ensureRoot(canvas, canvasPath, sourceNode, query);
    this.removeOldChildren(canvas, canvasPath, sourceNode.id);
    const childWidth = 400;
    const childHeight = 400;
    const gap = this.plugin.setting.COLUMN_GAP;
    const y = root.y + root.height + gap;
    const n = reports.length;
    const rowWidth = n * childWidth + Math.max(0, n - 1) * gap;
    const startX = root.x + (root.width - rowWidth) / 2;

    const data = canvas.getData();
    const created = reports.map((report, i) => ({
      id: uuid(),
      x: startX + i * (childWidth + gap),
      y,
      width: childWidth,
      height: childHeight,
      type: "file",
      file: report.path,
    }));

    canvas.importData({
      nodes: [...data.nodes, ...created],
      edges: [
        ...data.edges,
        ...created.map((node) => ({
          id: uuid(),
          fromNode: root.id,
          fromSide: "bottom",
          toNode: node.id,
          toSide: "top",
        })),
      ],
    });

    this.plugin.state.socialAnalyzerChildren[canvasPath] ??= {};
    this.plugin.state.socialAnalyzerChildren[canvasPath][sourceNode.id] = {
      rootId: root.id,
      childIds: created.map((node) => node.id),
    };
    await this.plugin.saveState();
    canvas.requestSave?.();
  }

  private async applySimpleResults(
    canvas: any,
    canvasPath: string,
    sourceNode: M.Node,
    query: string,
    hits: SocialAnalyzerHit[],
  ) {
    const root = this.ensureRoot(canvas, canvasPath, sourceNode, query);
    this.removeOldChildren(canvas, canvasPath, sourceNode.id);
    if (!hits.length) {
      await this.plugin.saveState();
      canvas.requestSave?.();
      return;
    }
    const childWidth = root.width;
    const childHeight = root.height;
    const gap = this.plugin.setting.COLUMN_GAP;
    const y = root.y + root.height + gap;
    const n = hits.length;
    const rowWidth = n * childWidth + Math.max(0, n - 1) * gap;
    const startX = root.x + (root.width - rowWidth) / 2;

    const createdNodes = hits.map((hit, i) =>
      canvas.createTextNode({
        pos: { x: startX + i * (childWidth + gap), y },
        size: { width: childWidth, height: childHeight },
        text: `${hit.site}\n${hit.url}`,
        focus: false,
        save: true,
      }),
    );
    const data = canvas.getData();
    canvas.importData({
      nodes: data.nodes,
      edges: [
        ...data.edges,
        ...createdNodes.map((node: M.Node) => ({
          id: uuid(),
          fromNode: root.id,
          fromSide: "bottom",
          toNode: node.id,
          toSide: "top",
        })),
      ],
    });
    this.plugin.state.socialAnalyzerChildren[canvasPath] ??= {};
    this.plugin.state.socialAnalyzerChildren[canvasPath][sourceNode.id] = {
      rootId: root.id,
      childIds: createdNodes.map((node: M.Node) => node.id),
    };
    await this.plugin.saveState();
    canvas.requestSave?.();
  }

  private ensureRoot(canvas: any, canvasPath: string, sourceNode: M.Node, query: string): M.Node {
    const bucket = this.plugin.state.socialAnalyzerChildren as unknown as Record<string, Record<string, unknown>>;
    const state = readToolState(bucket, canvasPath, sourceNode.id);
    const text = `Social Analyzer\n${query}`;
    const existing =
      (state.rootId ? findNodeById(canvas, state.rootId) : null) ?? findRootByTitle(canvas, sourceNode.id, "Social Analyzer");
    const root =
      existing ??
      createRootTextNode(
        canvas,
        sourceNode,
        { x: sourceNode.x, y: sourceNode.y + sourceNode.height + this.plugin.setting.COLUMN_GAP },
        text,
      );
    const updatedRoot = setNodeText(canvas, root, text);
    ensureEdge(canvas, {
      fromNode: sourceNode.id,
      fromSide: "bottom",
      toNode: updatedRoot.id,
      toSide: "top",
    });
    writeToolState(bucket, canvasPath, sourceNode.id, {
      rootId: updatedRoot.id,
      childIds: state.childIds,
    });
    return updatedRoot as M.Node;
  }

  private removeOldChildren(canvas: any, canvasPath: string, sourceNodeId: string) {
    const bucket = this.plugin.state.socialAnalyzerChildren as unknown as Record<string, Record<string, unknown>>;
    const state = readToolState(bucket, canvasPath, sourceNodeId);
    if (!state.childIds.length) return;
    removeTrackedChildren(canvas, state.childIds);
    writeToolState(bucket, canvasPath, sourceNodeId, {
      rootId: state.rootId,
      childIds: [],
    });
  }

  private buildProcessEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    };
  }

  private formatProcessError(output: string): string {
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const message = lines.at(-1) ?? lines[0] ?? "";
    return message ? message.slice(0, 220) : "Check developer console for details.";
  }

  private async writeMarkdownReports(query: string, hits: SocialAnalyzerHit[]): Promise<{ reports: SocialAnalyzerReport[]; written: number }> {
    if (!hits.length) return { reports: [], written: 0 };
    const folderPath = normalizePath(this.plugin.setting.socialAnalyzerReportsFolder.trim() || "Comshit/Social Analyzer");
    await this.ensureFolder(folderPath);
    const date = this.getLocalDateDotted();
    const reports: SocialAnalyzerReport[] = [];

    for (const hit of hits) {
      const domain = this.getDomain(hit.url);
      const baseName = `${query} ${domain} ${date}`;
      const filePath = await this.uniqueFilePath(folderPath, this.sanitizeFileName(baseName));
      await this.plugin.app.vault.create(filePath, this.buildSiteMarkdown(query, hit));
      reports.push({ hit, path: filePath });
    }

    return { reports, written: reports.length };
  }

  private buildSiteMarkdown(query: string, hit: SocialAnalyzerHit): string {
    const rows = [`username: ${query}`, `service: ${hit.site}`, `status: ${hit.status}`];
    for (const [key, value] of Object.entries(hit.meta)) {
      rows.push(...this.renderMetadataEntry(key, value));
    }
    return `# ${this.getPreferredHeader(query, hit)}\n\n<small>${hit.url}</small>\n\n${rows.join("\n")}\n`;
  }

  private getPreferredHeader(query: string, hit: SocialAnalyzerHit): string {
    const handle = this.metadataValueToString(hit.meta.username || hit.meta.handle || hit.meta.screen_name);
    if (handle && handle.toLowerCase() !== query.toLowerCase()) {
      return `${query} / ${handle}`;
    }
    return handle || query;
  }

  private getImageUrl(hit: SocialAnalyzerHit): string {
    return (
      this.metadataValueToString(hit.meta.image) ||
      this.metadataValueToString(hit.meta.img) ||
      this.metadataValueToString(hit.meta.avatar) ||
      this.metadataValueToString(hit.meta.avatar_url) ||
      this.metadataValueToString(hit.meta.profile_image_url) ||
      ""
    );
  }

  private renderMetadataEntry(key: string, value: unknown): string[] {
    if (this.isEmptyMetadataValue(value)) return [];
    if (Array.isArray(value)) {
      if (!value.length) return [];
      const lines = [`${key}:`];
      for (const item of value) {
        lines.push(...this.renderMetadataArrayItem(item));
      }
      return lines.length > 1 ? lines : [];
    }
    if (value && typeof value === "object") {
      const lines = [`${key}:`];
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (this.shouldDropMetadataKey(childKey) || this.isEmptyMetadataValue(childValue)) continue;
        lines.push(...this.renderIndentedMetadata(childKey, childValue, "\t"));
      }
      return lines.length > 1 ? lines : [];
    }
    return [`${key}: ${String(value)}`];
  }

  private renderMetadataArrayItem(item: unknown): string[] {
    if (this.isEmptyMetadataValue(item)) return [];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [`\t${this.metadataValueToString(item)}`];
    }

    const entries = Object.entries(item as Record<string, unknown>).filter(
      ([key, value]) => !this.shouldDropMetadataKey(key) && !this.isEmptyMetadataValue(value),
    );
    if (!entries.length) return [];

    const lines: string[] = [];
    const nameEntry = entries.find(([key]) => key === "name" || key === "property");
    if (nameEntry) {
      lines.push(`\tname: ${this.metadataValueToString(nameEntry[1])}`);
    }
    for (const [key, value] of entries) {
      if (nameEntry && (key === "name" || key === "property")) continue;
      lines.push(...this.renderIndentedMetadata(key, value, "\t\t"));
    }
    return lines;
  }

  private renderIndentedMetadata(key: string, value: unknown, indent: string): string[] {
    if (this.isEmptyMetadataValue(value)) return [];
    if (Array.isArray(value)) {
      const lines = [`${indent}${key}:`];
      for (const item of value) {
        lines.push(...this.renderMetadataArrayItem(item).map((line) => `${indent}${line}`));
      }
      return lines.length > 1 ? lines : [];
    }
    if (value && typeof value === "object") {
      const lines = [`${indent}${key}:`];
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (this.shouldDropMetadataKey(childKey) || this.isEmptyMetadataValue(childValue)) continue;
        lines.push(...this.renderIndentedMetadata(childKey, childValue, `${indent}\t`));
      }
      return lines.length > 1 ? lines : [];
    }

    const text = this.metadataValueToString(value);
    if (this.looksLikeImageUrl(text)) {
      return [`${indent}${key}:`, `${indent}\t![](${text})`];
    }
    return [`${indent}${key}: ${text}`];
  }

  private metadataValueToString(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
  }

  private looksLikeImageUrl(value: string): boolean {
    return /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#]\S*)?$/i.test(value);
  }

  private getLocalDateDotted(): string {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const yyyy = String(now.getFullYear());
    return `${dd}.${mm}.${yyyy}`;
  }

  private getDomain(url: string): string {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname.replace(/^www\./, "");
    } catch {
      return "unknown.site";
    }
  }

  private sanitizeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "social-analyzer-report";
  }

  private async uniqueFilePath(folderPath: string, baseName: string): Promise<string> {
    let candidate = normalizePath(`${folderPath}/${baseName}.md`);
    let i = 2;
    while (this.plugin.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${folderPath}/${baseName} (${i}).md`);
      i++;
    }
    return candidate;
  }

  private async ensureFolder(path: string): Promise<void> {
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const node = this.plugin.app.vault.getAbstractFileByPath(current);
      if (!node) {
        await this.plugin.app.vault.createFolder(current);
      }
    }
  }
}
