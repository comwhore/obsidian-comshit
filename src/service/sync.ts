import { Notice, TFile, normalizePath } from "obsidian";
import WhereAmIPlugin from "../main";

interface GraphNode {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GraphEdge {
  id: string;
  fromNode: string;
  fromSide: string;
  toNode: string;
  toSide: string;
}

interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface PreservePayload {
  unsupportedNodes: any[];
  unsupportedEdges: any[];
}

interface CanvasPayload {
  nodes: any[];
  edges: any[];
  whereami?: {
    pairId?: string;
  };
}

const GRAPH_START = "<!-- whereami:graph:start -->";
const GRAPH_END = "<!-- whereami:graph:end -->";
const PRESERVE_START = "<!-- whereami:preserve:start -->";
const PRESERVE_END = "<!-- whereami:preserve:end -->";
const MAIN_NODE_ID = "whereami-main";
const MAIN_NODE_WIDTH = 340;
const MAIN_NODE_HEIGHT = 96;
const MANAGED_SPACER_LINES = 24;

export class SyncService {
  private plugin: WhereAmIPlugin;
  private debounceTimers = new Map<string, number>();
  private suppressedPaths = new Set<string>();
  private renameInFlight = false;

  constructor(plugin: WhereAmIPlugin) {
    this.plugin = plugin;
  }

  start() {
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", async (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension === "canvas") {
          await this.ensureMdPairForCanvas(file);
        }
      }),
    );

    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile)) return;
        if (this.consumeSuppressed(file.path)) return;
        await this.scheduleSync(file);
      }),
    );

    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", async (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        if (this.renameInFlight) return;
        if (file.extension !== "md" && file.extension !== "canvas") return;
        await this.renameCounterpartForFileRename(file, oldPath);
      }),
    );
  }

  async createPairFromBase(basePathNoExt: string) {
    const mdPath = normalizePath(`${basePathNoExt}.md`);
    const canvasPath = normalizePath(`${basePathNoExt}.canvas`);
    const title = this.getTitleFromBasePath(basePathNoExt);
    const pairId = this.createPairId();
    const graph = this.createDefaultGraph(title);
    const preserve: PreservePayload = { unsupportedNodes: [], unsupportedEdges: [] };
    const markdown = this.composeMdContent(canvasPath, graph, preserve, `# ${title}\n`, pairId);
    const canvasData = this.composeCanvasContent(graph, preserve, pairId);

    let mdFile = this.plugin.app.vault.getAbstractFileByPath(mdPath);
    if (!(mdFile instanceof TFile)) {
      mdFile = await this.plugin.app.vault.create(mdPath, markdown);
    }
    let canvasFile = this.plugin.app.vault.getAbstractFileByPath(canvasPath);
    if (!(canvasFile instanceof TFile)) {
      canvasFile = await this.plugin.app.vault.create(canvasPath, JSON.stringify(canvasData, null, "\t"));
    }
    return { mdFile: mdFile as TFile, canvasFile: canvasFile as TFile };
  }

  async convertCurrentMdToCanvas(mdFile: TFile) {
    const basePath = mdFile.path.replace(/\.md$/i, "");
    const canvasPath = normalizePath(`${basePath}.canvas`);
    const mdContent = await this.plugin.app.vault.read(mdFile);
    const preserve = this.parsePreserveRegion(mdContent);
    const canvasPair = this.plugin.app.vault.getAbstractFileByPath(canvasPath);
    const existingCanvasData =
      canvasPair instanceof TFile ? this.parseCanvasData(await this.plugin.app.vault.read(canvasPair)) : { nodes: [], edges: [] };
    const existingGraph = this.graphFromCanvasData(existingCanvasData, mdFile.basename);
    const pairId = this.getPairId(mdContent, existingCanvasData);
    const graph = this.parseMarkdownToGraph(mdContent, mdFile.basename, existingGraph);
    const mergedPreserve = this.mergePreservePayloads(preserve, this.extractUnsupportedFromCanvasData(existingCanvasData));
    const canvasData = this.composeCanvasContent(graph, mergedPreserve, pairId);

    const existing = this.plugin.app.vault.getAbstractFileByPath(canvasPath);
    if (existing instanceof TFile) {
      await this.plugin.app.vault.modify(existing, JSON.stringify(canvasData, null, "\t"));
    } else {
      await this.plugin.app.vault.create(canvasPath, JSON.stringify(canvasData, null, "\t"));
    }

    const refreshed = this.composeMdContent(canvasPath, graph, mergedPreserve, this.stripManagedContent(mdContent), pairId);
    await this.plugin.app.vault.modify(mdFile, refreshed);
  }

  getPairFor(file: TFile): { mdPath: string; canvasPath: string } {
    if (file.extension === "md") {
      return { mdPath: file.path, canvasPath: file.path.replace(/\.md$/i, ".canvas") };
    }
    return { mdPath: file.path.replace(/\.canvas$/i, ".md"), canvasPath: file.path };
  }

  async openPair(file: TFile) {
    const pair = this.getPairFor(file);
    const targetPath = file.extension === "md" ? pair.canvasPath : pair.mdPath;
    const target = this.plugin.app.vault.getAbstractFileByPath(targetPath);
    if (!(target instanceof TFile)) {
      new Notice("Comshit: pair does not exist yet.");
      return;
    }
    await this.plugin.app.workspace.getLeaf(true).openFile(target);
  }

  private async ensureMdPairForCanvas(canvasFile: TFile) {
    const pair = this.getPairFor(canvasFile);
    const mdFile = this.plugin.app.vault.getAbstractFileByPath(pair.mdPath);
    if (mdFile instanceof TFile) return;
    const canvasRaw = await this.plugin.app.vault.read(canvasFile);
    const canvasData = this.parseCanvasData(canvasRaw);
    const graph = this.graphFromCanvasData(canvasData, canvasFile.basename);
    const preserve = this.extractUnsupportedFromCanvasData(canvasData);
    const pairId = this.getPairId("", canvasData);
    await this.restoreMainNodeInCanvasIfNeeded(canvasFile, canvasData, graph, pairId);
    const title = this.extractMainNodeTitle(graph, canvasFile.basename);
    const markdown = this.composeMdContent(
      pair.canvasPath,
      graph,
      preserve,
      `# ${title}\n`,
      pairId,
    );
    await this.plugin.app.vault.create(pair.mdPath, markdown);
  }

  private async scheduleSync(file: TFile) {
    if (file.extension !== "md" && file.extension !== "canvas") return;
    const existingTimer = this.debounceTimers.get(file.path);
    if (existingTimer) window.clearTimeout(existingTimer);
    const timer = window.setTimeout(async () => {
      this.debounceTimers.delete(file.path);
      await this.syncFile(file);
    }, this.plugin.setting.syncDebounceMs);
    this.debounceTimers.set(file.path, timer);
  }

  private async syncFile(file: TFile) {
    if (file.extension === "md") {
      await this.syncMdToCanvas(file);
      return;
    }

    if (file.extension === "canvas") {
      await this.syncCanvasToMd(file);
    }
  }

  private async syncMdToCanvas(mdFile: TFile) {
    const { canvasPath } = this.getPairFor(mdFile);
    const target = this.plugin.app.vault.getAbstractFileByPath(canvasPath);
    if (!(target instanceof TFile)) {
      // Do not auto-create a canvas pair from markdown changes.
      // Pair creation must be explicit via command/menu actions.
      return;
    }

    const mdContent = await this.plugin.app.vault.read(mdFile);
    const canvasRaw = await this.plugin.app.vault.read(target);
    const canvasData = this.parseCanvasData(canvasRaw);
    const existingGraph = this.graphFromCanvasData(canvasData, mdFile.basename);
    const graph = this.parseMarkdownToGraph(mdContent, mdFile.basename, existingGraph);
    const pairId = this.getPairId(mdContent, canvasData);
    const preserveFromMd = this.parsePreserveRegion(mdContent);
    const preserveFromCanvas = this.extractUnsupportedFromCanvasData(canvasData);
    const mergedPreserve = this.mergePreservePayloads(preserveFromMd, preserveFromCanvas);
    const nextCanvasContent = this.composeCanvasContent(graph, mergedPreserve, pairId);
    await this.writeIfChanged(target, JSON.stringify(nextCanvasContent, null, "\t"));
  }

  private async syncCanvasToMd(canvasFile: TFile) {
    const { mdPath } = this.getPairFor(canvasFile);
    const mdAbs = this.plugin.app.vault.getAbstractFileByPath(mdPath);
    if (!(mdAbs instanceof TFile)) {
      await this.ensureMdPairForCanvas(canvasFile);
      return;
    }

    const canvasRaw = await this.plugin.app.vault.read(canvasFile);
    const canvasData = this.parseCanvasData(canvasRaw);
    const graph = this.graphFromCanvasData(canvasData, canvasFile.basename);
    const unsupported = this.extractUnsupportedFromCanvasData(canvasData);

    const mdContent = await this.plugin.app.vault.read(mdAbs);
    // Preserve must reflect the current canvas only. Merging in old MD preserve
    // would keep nodes/edges the user already removed from the canvas.
    const preserve: PreservePayload = {
      unsupportedNodes: [...unsupported.unsupportedNodes],
      unsupportedEdges: [...unsupported.unsupportedEdges],
    };
    const pairId = this.getPairId(mdContent, canvasData);
    const title = this.extractMainNodeTitle(graph, canvasFile.basename);
    const renamedPair = await this.renamePairToTitleIfNeeded(canvasFile, mdAbs, title);
    const plainText = this.stripManagedContent(mdContent, title);
    const updated = this.composeMdContent(renamedPair.canvasFile.path, graph, preserve, plainText, pairId);
    await this.writeIfChanged(renamedPair.mdFile, updated);
    await this.restoreMainNodeInCanvasIfNeeded(renamedPair.canvasFile, canvasData, graph, pairId);
  }

  private mergeById(oldItems: any[], newItems: any[]) {
    const map = new Map<string, any>();
    [...oldItems, ...newItems].forEach((item) => {
      const id = String(item?.id ?? JSON.stringify(item));
      map.set(id, item);
    });
    return [...map.values()];
  }

  private parseGraphRegion(content: string): GraphPayload {
    const json = this.extractManagedJson(content, GRAPH_START, GRAPH_END);
    if (!json) return { nodes: [], edges: [] };
    try {
      const parsed = JSON.parse(json);
      return {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      };
    } catch {
      return { nodes: [], edges: [] };
    }
  }

  private parsePreserveRegion(content: string): PreservePayload {
    const json = this.extractManagedJson(content, PRESERVE_START, PRESERVE_END);
    if (!json) return { unsupportedNodes: [], unsupportedEdges: [] };
    try {
      const parsed = JSON.parse(json);
      return {
        unsupportedNodes: Array.isArray(parsed.unsupportedNodes) ? parsed.unsupportedNodes : [],
        unsupportedEdges: Array.isArray(parsed.unsupportedEdges) ? parsed.unsupportedEdges : [],
      };
    } catch {
      return { unsupportedNodes: [], unsupportedEdges: [] };
    }
  }

  private extractManagedJson(content: string, startMarker: string, endMarker: string): string | null {
    const escapedStart = startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedEnd = endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escapedStart}\\s*\\\`\\\`\\\`json\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`\\s*${escapedEnd}`, "m");
    const match = content.match(regex);
    if (!match) return null;
    return match[1].trim();
  }

  private stripManagedContent(content: string, mainTitle?: string): string {
    const escapedMain = mainTitle?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const explicitTitleRegex = escapedMain ? new RegExp(`^\\s*#\\s+${escapedMain}\\s*(?:\\r?\\n|$)`) : null;
    const withoutManaged = content
      .replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/m, "")
      .replace(new RegExp(`${GRAPH_START}[\\s\\S]*?${GRAPH_END}`, "g"), "")
      .replace(new RegExp(`${PRESERVE_START}[\\s\\S]*?${PRESERVE_END}`, "g"), "")
      .trimStart();

    const withoutManagedTitle = withoutManaged.replace(explicitTitleRegex ?? /$^/, "");
    const withoutTopHeading = withoutManagedTitle.replace(/^\s*#\s+.+\s*(?:\r?\n|$)/, "");
    return withoutTopHeading.trimEnd();
  }

  private composeMdContent(
    canvasPath: string,
    graph: GraphPayload,
    preserve: PreservePayload,
    userText: string,
    pairId: string,
  ) {
    const title = this.extractMainNodeTitle(graph, "Comshit");
    const frontmatter = [
      "---",
      "whereami:",
      "  version: 1",
      `  id: ${JSON.stringify(pairId)}`,
      `  pair: ${canvasPath}`,
      `  title: ${JSON.stringify(title)}`,
      "---",
      "",
    ].join("\n");

    const graphBlock = [
      GRAPH_START,
      "```json",
      JSON.stringify(graph, null, 2),
      "```",
      GRAPH_END,
      "",
    ].join("\n");

    const preserveBlock = [
      PRESERVE_START,
      "```json",
      JSON.stringify(preserve, null, 2),
      "```",
      PRESERVE_END,
      "",
    ].join("\n");

    const text = userText.trim().length > 0 ? `${userText.trim()}\n\n` : "";
    const spacer = "\n".repeat(MANAGED_SPACER_LINES);
    const includePreserve = preserve.unsupportedNodes.length > 0 || preserve.unsupportedEdges.length > 0;
    return `${frontmatter}# ${title}\n\n${text}${spacer}${graphBlock}${includePreserve ? preserveBlock : ""}`;
  }

  private composeCanvasContent(graph: GraphPayload, preserve: PreservePayload, pairId: string): CanvasPayload {
    const textNodes = graph.nodes.map((node) => ({
      id: node.id,
      type: "text",
      text: node.text ?? "",
      x: node.x ?? 0,
      y: node.y ?? 0,
      width: node.width ?? 250,
      height: node.height ?? 60,
      locked: node.id === MAIN_NODE_ID,
    }));
    const textNodeIds = new Set(textNodes.map((node) => node.id));
    const textEdges = graph.edges
      .filter((edge) => textNodeIds.has(edge.fromNode) && textNodeIds.has(edge.toNode))
      .map((edge) => ({
        id: edge.id,
        fromNode: edge.fromNode,
        fromSide: edge.fromSide,
        toNode: edge.toNode,
        toSide: edge.toSide,
      }));
    return {
      nodes: [...textNodes, ...preserve.unsupportedNodes],
      edges: [...textEdges, ...preserve.unsupportedEdges],
      whereami: {
        pairId,
      },
    };
  }

  private parseCanvasData(canvasRaw: string): CanvasPayload {
    try {
      const parsed = JSON.parse(canvasRaw);
      return {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
        whereami:
          parsed.whereami && typeof parsed.whereami === "object"
            ? {
                pairId: typeof parsed.whereami.pairId === "string" ? parsed.whereami.pairId : undefined,
              }
            : undefined,
      };
    } catch {
      return {
        nodes: [],
        edges: [],
      };
    }
  }

  private graphFromCanvasData(canvasData: any, fallbackTitle: string): GraphPayload {
    const supportedNodes = (canvasData.nodes ?? []).filter((node: any) => node.type === "text" || typeof node.type === "undefined");
    const supportedNodeIds = new Set(supportedNodes.map((node: any) => node.id));
    const supportedEdges = (canvasData.edges ?? []).filter(
      (edge: any) => supportedNodeIds.has(edge.fromNode) && supportedNodeIds.has(edge.toNode),
    );

    const graph: GraphPayload = {
      nodes: supportedNodes.map((node: any) => ({
        id: node.id,
        text: node.text ?? "",
        x: node.x ?? 0,
        y: node.y ?? 0,
        width: node.width ?? 250,
        height: node.height ?? 60,
      })),
      edges: supportedEdges.map((edge: any) => ({
        id: edge.id,
        fromNode: edge.fromNode,
        fromSide: edge.fromSide ?? "right",
        toNode: edge.toNode,
        toSide: edge.toSide ?? "left",
      })),
    };

    return this.ensureMainNode(graph, fallbackTitle);
  }

  private parseMarkdownToGraph(mdContent: string, fallbackTitle: string, fallbackGraph?: GraphPayload): GraphPayload {
    const managed = this.parseGraphRegion(mdContent);
    const headingTitle = this.extractHeadingTitle(mdContent) ?? this.extractFrontmatterTitle(mdContent) ?? fallbackTitle;
    if (managed.nodes.length > 0) {
      return this.ensureMainNode(managed, headingTitle);
    }
    if (fallbackGraph?.nodes.length) {
      return this.ensureMainNode(fallbackGraph, headingTitle);
    }

    const nonEmptyLines = mdContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("---") && !line.startsWith("whereami:"));

    const title = headingTitle || nonEmptyLines[0] || fallbackTitle;
    return this.createDefaultGraph(title);
  }

  private createDefaultGraph(title: string): GraphPayload {
    return {
      nodes: [
        {
          id: MAIN_NODE_ID,
          text: title,
          x: 0,
          y: 0,
          width: MAIN_NODE_WIDTH,
          height: MAIN_NODE_HEIGHT,
        },
      ],
      edges: [],
    };
  }

  private ensureMainNode(graph: GraphPayload, preferredTitle: string): GraphPayload {
    if (!graph.nodes.length) {
      return this.createDefaultGraph(preferredTitle);
    }

    // Always prefer an existing node with id "whereami-main" if present.
    // Without this, a Sherlock-added child (or any later node with no incoming edges)
    // can be incorrectly promoted to main, causing the real main to become
    // "whereami-main-legacy" and renaming the file pair after the wrong title.
    let rootCandidate = graph.nodes.find((node) => node.id === MAIN_NODE_ID);
    if (!rootCandidate) {
      const incoming = new Set(graph.edges.map((edge) => edge.toNode));
      rootCandidate =
        graph.nodes.find((node) => !incoming.has(node.id) && (node.text ?? "").trim().length > 0) ??
        graph.nodes.find((node) => !incoming.has(node.id)) ??
        graph.nodes[0];
    }
    if (!rootCandidate) {
      return this.createDefaultGraph(preferredTitle);
    }

    const orderedNodes = [rootCandidate, ...graph.nodes.filter((node) => node.id !== rootCandidate!.id)];
    if (rootCandidate.id !== MAIN_NODE_ID) {
      this.normalizeMainNodeId(orderedNodes, graph.edges);
    }
    orderedNodes[0].width = Math.max(orderedNodes[0].width ?? 0, MAIN_NODE_WIDTH);
    orderedNodes[0].height = Math.max(orderedNodes[0].height ?? 0, MAIN_NODE_HEIGHT);
    if (!orderedNodes[0].text?.trim()) {
      orderedNodes[0].text = preferredTitle;
    }

    return {
      ...graph,
      nodes: orderedNodes,
    };
  }

  private extractHeadingTitle(mdContent: string): string | null {
    const lines = mdContent.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^#\s+(.+)\s*$/);
      if (match) {
        return match[1].trim();
      }
    }
    return null;
  }

  private extractFrontmatterTitle(mdContent: string): string | null {
    const match = mdContent.match(/whereami:\s*[\s\S]*?title:\s*["']?(.+?)["']?\s*(?:\n|$)/m);
    return match?.[1]?.trim() ?? null;
  }

  private extractFrontmatterPairId(mdContent: string): string | null {
    const match = mdContent.match(/whereami:\s*[\s\S]*?id:\s*["']?(.+?)["']?\s*(?:\n|$)/m);
    return match?.[1]?.trim() ?? null;
  }

  private extractMainNodeTitle(graph: GraphPayload, fallback: string): string {
    const mainNode = graph.nodes[0];
    const mainLine = mainNode?.text
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return mainLine ?? fallback;
  }

  private getTitleFromBasePath(basePathNoExt: string): string {
    const normalized = basePathNoExt.replace(/\\/g, "/");
    const parts = normalized.split("/");
    return parts[parts.length - 1] || "Comshit";
  }

  private normalizeMainNodeId(nodes: GraphNode[], edges: GraphEdge[]) {
    if (nodes.length === 0) return;
    const mainNode = nodes[0];
    if (mainNode.id === MAIN_NODE_ID) return;
    const priorId = mainNode.id;
    const existingMain = nodes.find((node, idx) => idx > 0 && node.id === MAIN_NODE_ID);
    if (existingMain) {
      existingMain.id = `${MAIN_NODE_ID}-legacy`;
    }
    mainNode.id = MAIN_NODE_ID;
    edges.forEach((edge) => {
      if (edge.fromNode === priorId) edge.fromNode = MAIN_NODE_ID;
      if (edge.toNode === priorId) edge.toNode = MAIN_NODE_ID;
    });
  }

  private async restoreMainNodeInCanvasIfNeeded(
    canvasFile: TFile,
    canvasData: CanvasPayload,
    normalizedGraph: GraphPayload,
    pairId: string,
  ) {
    const hasMain = (canvasData.nodes ?? []).some((node: any) => node.id === MAIN_NODE_ID);
    if (hasMain) return;
    const preserve = this.extractUnsupportedFromCanvasData(canvasData);
    const repairedCanvas = this.composeCanvasContent(normalizedGraph, preserve, pairId);
    await this.writeIfChanged(canvasFile, JSON.stringify(repairedCanvas, null, "\t"));
  }

  private extractUnsupportedFromCanvasData(canvasData: CanvasPayload): PreservePayload {
    const supportedNodeIds = new Set(
      (canvasData.nodes ?? [])
        .filter((node: any) => node.type === "text" || typeof node.type === "undefined")
        .map((node: any) => node.id),
    );
    const unsupportedNodes = (canvasData.nodes ?? []).filter((node: any) => node.type !== "text" && typeof node.type !== "undefined");
    const unsupportedEdges = (canvasData.edges ?? []).filter(
      (edge: any) => !supportedNodeIds.has(edge.fromNode) || !supportedNodeIds.has(edge.toNode),
    );
    return { unsupportedNodes, unsupportedEdges };
  }

  private mergePreservePayloads(left: PreservePayload, right: PreservePayload): PreservePayload {
    return {
      unsupportedNodes: this.mergeById(left.unsupportedNodes, right.unsupportedNodes),
      unsupportedEdges: this.mergeById(left.unsupportedEdges, right.unsupportedEdges),
    };
  }

  private getPairId(mdContent: string, canvasData: CanvasPayload): string {
    return this.extractFrontmatterPairId(mdContent) ?? canvasData.whereami?.pairId ?? this.createPairId();
  }

  private createPairId(): string {
    const rand = Math.random().toString(16).slice(2, 10);
    return `whereami-${Date.now()}-${rand}`;
  }

  private async renameCounterpartForFileRename(file: TFile, oldPath: string) {
    const oldPairPath =
      file.extension === "md" ? oldPath.replace(/\.md$/i, ".canvas") : oldPath.replace(/\.canvas$/i, ".md");
    const newPairPath =
      file.extension === "md" ? file.path.replace(/\.md$/i, ".canvas") : file.path.replace(/\.canvas$/i, ".md");
    if (oldPairPath === newPairPath) return;

    const counterpart = this.plugin.app.vault.getAbstractFileByPath(oldPairPath);
    if (!(counterpart instanceof TFile)) return;
    if (this.plugin.app.vault.getAbstractFileByPath(newPairPath)) {
      new Notice(`Comshit: cannot rename paired file because ${newPairPath} already exists.`);
      return;
    }

    this.renameInFlight = true;
    try {
      await this.plugin.app.vault.rename(counterpart, newPairPath);
    } finally {
      this.renameInFlight = false;
    }
  }

  private async renamePairToTitleIfNeeded(canvasFile: TFile, mdFile: TFile, title: string) {
    const safeName = this.sanitizeFileName(title);
    if (!safeName || (canvasFile.basename === safeName && mdFile.basename === safeName)) {
      return { canvasFile, mdFile };
    }

    const folder = canvasFile.path.includes("/") ? canvasFile.path.slice(0, canvasFile.path.lastIndexOf("/")) : "";
    const basePath = folder ? `${folder}/${safeName}` : safeName;
    const targetCanvasPath = normalizePath(`${basePath}.canvas`);
    const targetMdPath = normalizePath(`${basePath}.md`);
    const canvasConflict = targetCanvasPath !== canvasFile.path && this.plugin.app.vault.getAbstractFileByPath(targetCanvasPath);
    const mdConflict = targetMdPath !== mdFile.path && this.plugin.app.vault.getAbstractFileByPath(targetMdPath);
    if (canvasConflict || mdConflict) {
      new Notice("Comshit: could not rename pair from title because a file with that name already exists.");
      return { canvasFile, mdFile };
    }

    this.renameInFlight = true;
    try {
      if (canvasFile.path !== targetCanvasPath) {
        await this.plugin.app.vault.rename(canvasFile, targetCanvasPath);
      }
      if (mdFile.path !== targetMdPath) {
        await this.plugin.app.vault.rename(mdFile, targetMdPath);
      }
    } finally {
      this.renameInFlight = false;
    }

    const nextCanvas = this.plugin.app.vault.getAbstractFileByPath(targetCanvasPath);
    const nextMd = this.plugin.app.vault.getAbstractFileByPath(targetMdPath);
    return {
      canvasFile: nextCanvas instanceof TFile ? nextCanvas : canvasFile,
      mdFile: nextMd instanceof TFile ? nextMd : mdFile,
    };
  }

  private sanitizeFileName(value: string): string {
    const cleaned = value.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
    const withoutEdgeDots = cleaned.replace(/^\.+/, "").replace(/\.+$/, "");
    return withoutEdgeDots || "Comshit";
  }

  private async writeIfChanged(file: TFile, nextContent: string) {
    const current = await this.plugin.app.vault.read(file);
    if (current === nextContent) return;
    this.suppressNextModify(file.path);
    await this.plugin.app.vault.modify(file, nextContent);
  }

  private suppressNextModify(path: string) {
    this.suppressedPaths.add(path);
  }

  private consumeSuppressed(path: string): boolean {
    if (!this.suppressedPaths.has(path)) return false;
    this.suppressedPaths.delete(path);
    return true;
  }
}
