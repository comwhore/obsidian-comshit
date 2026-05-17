import { Notice, setIcon } from "obsidian";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { promises as fs } from "fs";
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

interface SherlockCsvRow {
  username: string;
  name: string;
  url_main: string;
  url_user: string;
  exists: string;
  http_status: string;
  response_time_s: string;
}

interface SherlockJob {
  id: string;
  query: string;
  startedAt: number;
  sourceNodeId: string;
  sourceCanvasPath: string;
  status: "running" | "done" | "failed";
  stopProgressNotice?: () => void;
}

export class SherlockService {
  private plugin: WhereAmIPlugin;
  private statusEl: HTMLElement;
  private jobs = new Map<string, SherlockJob>();

  constructor(plugin: WhereAmIPlugin) {
    this.plugin = plugin;
    this.statusEl = plugin.addStatusBarItem();
    this.statusEl.hide();
    setIcon(this.statusEl, "search");
  }

  updateStatusBar() {
    const running = [...this.jobs.values()].filter((job) => job.status === "running");
    if (running.length === 0) {
      this.statusEl.hide();
      this.statusEl.textContent = "";
      this.statusEl.title = "";
      return;
    }
    this.statusEl.show();
    this.statusEl.textContent = `Sherlock: ${running.length} running`;
    this.statusEl.title = running.map((job) => `${job.query} (${Math.floor((Date.now() - job.startedAt) / 1000)}s)`).join("\n");
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

    const runDir = join(tmpdir(), `whereami-sherlock-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
    await fs.mkdir(runDir, { recursive: true });

    let commandArgs: { command: string; args: string[] };
    try {
      commandArgs = this.buildSherlockCommand(query, runDir);
    } catch (error) {
      new Notice(`Comshit: ${(error as Error).message}`);
      return;
    }
    this.ensureSherlockRootNode(canvas, canvasFile.path, selected, query);
    await this.plugin.saveState();
    canvas.requestSave?.();

    const { command, args } = commandArgs;
    const job: SherlockJob = {
      id: uuid(),
      query,
      startedAt: Date.now(),
      sourceNodeId: selected.id,
      sourceCanvasPath: canvasFile.path,
      status: "running",
    };
    this.jobs.set(job.id, job);
    this.updateStatusBar();
    new Notice(`Comshit: Sherlock started for "${query}".`);
    job.stopProgressNotice = this.createProgressNotice(query);

    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      job.status = "failed";
      job.stopProgressNotice?.();
      this.updateStatusBar();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        new Notice(
          "Comshit: Sherlock command not found. Set the full executable path in settings, e.g. C:\\Users\\toni\\AppData\\Local\\Programs\\Python\\Python313\\Scripts\\sherlock.exe",
          9000,
        );
      } else {
        new Notice(`Comshit: Sherlock failed to start (${error.message}).`);
      }
    });

    child.on("close", async (code) => {
      if (code !== 0) {
        job.status = "failed";
        job.stopProgressNotice?.();
        this.updateStatusBar();
        new Notice(`Comshit: Sherlock exited with code ${code}.`);
        if (stderr.trim()) {
          console.error("[Comshit][Sherlock]", stderr);
        }
        return;
      }

      try {
        const rows = await this.readCsvResults(runDir, query);
        await this.applyResults(canvas, selected, canvasFile.path, rows, query);
        job.status = "done";
        job.stopProgressNotice?.();
        this.updateStatusBar();
        new Notice(`Comshit: Sherlock found ${rows.length} profile(s).`);
      } catch (error) {
        job.status = "failed";
        job.stopProgressNotice?.();
        this.updateStatusBar();
        new Notice(`Comshit: could not parse Sherlock output.`);
        console.error("[Comshit][Sherlock]", error);
      }
    });
  }

  private extractQuery(text: string): string {
    const firstLine = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstLine ?? "";
  }

  private buildSherlockCommand(query: string, runDir: string): { command: string; args: string[] } {
    const configured = this.plugin.setting.sherlockCommand.trim();
    const chunks = this.tokenize(configured);
    if (chunks.length === 0) {
      throw new Error("Sherlock command is empty.");
    }
    const command = chunks[0];
    const args = chunks.slice(1);
    if (this.plugin.setting.sherlockIncludeNsfw) args.push("--nsfw");
    args.push("--csv", "--no-color", "--folderoutput", runDir, "--timeout", String(this.plugin.setting.sherlockTimeout));
    if (this.plugin.setting.sherlockProxy.trim()) {
      args.push("--proxy", this.plugin.setting.sherlockProxy.trim());
    }
    if (this.plugin.setting.sherlockExtraArgs.trim()) {
      args.push(...this.tokenize(this.plugin.setting.sherlockExtraArgs.trim()));
    }
    args.push(query);
    return { command, args };
  }

  private createProgressNotice(query: string): () => void {
    const container = document.createElement("div");
    container.className = "whereami-sherlock-progress";
    const spinner = document.createElement("span");
    spinner.className = "loader";
    spinner.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = `Sherlock running for "${query}"`;
    container.append(spinner, label);
    const notice = new Notice(container, 0);

    return () => {
      notice.hide();
    };
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

  private async readCsvResults(runDir: string, username: string): Promise<SherlockCsvRow[]> {
    const csvPath = join(runDir, `${username}.csv`);
    const raw = await fs.readFile(csvPath, "utf8");
    const rows = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (rows.length <= 1) return [];

    const parsed = rows.slice(1).map((line) => this.parseCsvLine(line));
    return parsed
      .map((cols) => ({
        username: cols[0] ?? "",
        name: cols[1] ?? "",
        url_main: cols[2] ?? "",
        url_user: cols[3] ?? "",
        exists: cols[4] ?? "",
        http_status: cols[5] ?? "",
        response_time_s: cols[6] ?? "",
      }))
      .filter((row) => row.exists.toLowerCase().includes("claimed"));
  }

  private parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === "\"") {
        if (inQuotes && line[i + 1] === "\"") {
          current += "\"";
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        fields.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    fields.push(current);
    return fields;
  }

  private async applyResults(canvas: any, sourceNode: M.Node, canvasPath: string, rows: SherlockCsvRow[], query: string) {
    const root = this.ensureSherlockRootNode(canvas, canvasPath, sourceNode, query);
    this.removePreviousSherlockChildren(canvas, canvasPath, sourceNode.id);
    if (rows.length === 0) {
      await this.plugin.saveState();
      canvas.requestSave?.();
      return;
    }

    const ROW_GAP = this.plugin.setting.ROW_GAP;
    const childHeight = root.height;
    const childWidth = root.width;
    const totalHeight = rows.length * childHeight + Math.max(0, rows.length - 1) * ROW_GAP;
    const top = root.y + root.height * 0.5 - totalHeight * 0.5;
    const x = root.x + root.width + this.plugin.setting.COLUMN_GAP;

    const createdNodes: M.Node[] = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const child = canvas.createTextNode({
        pos: {
          x,
          y: top + idx * (childHeight + ROW_GAP),
        },
        size: {
          width: childWidth,
          height: childHeight,
        },
        text: `${row.name}\n${row.url_user}`,
        focus: false,
        save: true,
      });
      createdNodes.push(child);
    }

    const data = canvas.getData();
    const newEdges = createdNodes.map((node: M.Node) => ({
      id: uuid(),
      fromNode: root.id,
      fromSide: "right",
      toNode: node.id,
      toSide: "left",
    }));
    canvas.importData({
      nodes: data.nodes,
      edges: [...data.edges, ...newEdges],
    });

    // Note: we intentionally do NOT call layout.useSide here. It operates on
    // stale node references after importData (which can recreate node objects),
    // so the moveTo() calls have no effect. Children are already placed
    // centered around the parent above, so the layout is correct from the
    // start and arrows route cleanly without crossing other nodes.

    this.plugin.state.sherlockChildren[canvasPath] ??= {};
    this.plugin.state.sherlockChildren[canvasPath][sourceNode.id] = {
      rootId: root.id,
      childIds: createdNodes.map((node) => node.id),
    };
    await this.plugin.saveState();
    canvas.requestSave?.();
  }

  private ensureSherlockRootNode(canvas: any, canvasPath: string, sourceNode: M.Node, query: string): M.Node {
    const bucket = this.plugin.state.sherlockChildren as unknown as Record<string, Record<string, unknown>>;
    const state = readToolState(bucket, canvasPath, sourceNode.id);
    const text = `Sherlock\n${query}`;
    const existing = (state.rootId ? findNodeById(canvas, state.rootId) : null) ?? findRootByTitle(canvas, sourceNode.id, "Sherlock");
    const root =
      existing ??
      createRootTextNode(
        canvas,
        sourceNode,
        {
          x: sourceNode.x + sourceNode.width + this.plugin.setting.COLUMN_GAP,
          y: sourceNode.y,
        },
        text,
      );
    const updatedRoot = setNodeText(canvas, root, text);
    ensureEdge(canvas, {
      fromNode: sourceNode.id,
      fromSide: "right",
      toNode: updatedRoot.id,
      toSide: "left",
    });
    writeToolState(bucket, canvasPath, sourceNode.id, {
      rootId: updatedRoot.id,
      childIds: state.childIds,
    });
    return updatedRoot as M.Node;
  }

  private removePreviousSherlockChildren(canvas: any, canvasPath: string, sourceNodeId: string) {
    const bucket = this.plugin.state.sherlockChildren as unknown as Record<string, Record<string, unknown>>;
    const state = readToolState(bucket, canvasPath, sourceNodeId);
    if (!state.childIds.length) return;

    removeTrackedChildren(canvas, state.childIds);
    writeToolState(bucket, canvasPath, sourceNodeId, {
      rootId: state.rootId,
      childIds: [],
    });
  }
}
