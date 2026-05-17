import { App, Notice, Plugin, PluginManifest, TFile, setIcon } from "obsidian";
import { mountEmbeddedExcel } from "./excelEmbedded";
import { Keymap, Layout, Node, View, WhereAmISettingTab, DEFAULT_SETTINGS, WhereAmISettings } from "./module";
import { MaigretService, SherlockService, SocialAnalyzerService, SyncService } from "./service";

interface ToolChildrenState {
  rootId: string;
  childIds: string[];
}

interface WhereAmIState {
  sherlockChildren: Record<string, Record<string, ToolChildrenState>>;
  maigretChildren: Record<string, Record<string, ToolChildrenState>>;
  socialAnalyzerChildren: Record<string, Record<string, ToolChildrenState>>;
}

interface WhereAmIData {
  settings: WhereAmISettings;
  state: WhereAmIState;
  /** Excel (embedded) plugin flat settings, when present */
  excel?: unknown;
}

const DEFAULT_STATE: WhereAmIState = {
  sherlockChildren: {},
  maigretChildren: {},
  socialAnalyzerChildren: {},
};

const EXCEL_VIEW_TYPE = "excel-view";

export default class WhereAmIPlugin extends Plugin {
  canvas: any = null;
  intervalTimer = new Map<string, NodeJS.Timeout>();
  node: Node;
  keymap: Keymap;
  view: View;
  layout: Layout;
  setting: WhereAmISettings = { ...DEFAULT_SETTINGS };
  state: WhereAmIState = { ...DEFAULT_STATE };
  sherlock!: SherlockService;
  maigret!: MaigretService;
  socialAnalyzer!: SocialAnalyzerService;
  sync!: SyncService;
  private blurCommandRegistered = false;
  private canvasDeleteGuardInstalled = false;
  private guardedCanvasRef: unknown = null;
  private mainNodeStyleTimer: number | null = null;
  /** Pre-bundled excel-modded instance; registrations go through this plugin */
  private excelEmbedded: Plugin | null = null;

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
    this.node = new Node(this);
    this.keymap = new Keymap(this);
    this.view = new View(this);
    this.layout = new Layout(this);
  }

  async onload() {
    await this.loadPluginData();
    this.sherlock = new SherlockService(this);
    this.maigret = new MaigretService(this);
    this.socialAnalyzer = new SocialAnalyzerService(this);
    this.sync = new SyncService(this);

    try {
      this.excelEmbedded = await mountEmbeddedExcel(this);
    } catch (e) {
      console.error("[comshit] embedded Excel failed to load", e);
      new Notice("comshit: Excel (.sheet) failed to load — check console.");
    }

    this.addSettingTab(new WhereAmISettingTab(this));
    this.onActiveLeafChange();
    this.onKeymap();
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleMainNodeStyleApply()));
    this.registerCoreCommands();
    this.registerContextMenus();
    this.registerCanvasInteractionGuards();
    this.registerExcelSheetViewRouting();
    this.sync.start();
  }

  onunload() {
    this.keymap.unregisterAll();
    this.intervalTimer.forEach(clearInterval);
  }

  getActiveCanvasFile(): TFile | null {
    const leaf = this.app.workspace.getMostRecentLeaf();
    // @ts-ignore Obsidian canvas view type
    const file = leaf?.view?.file;
    if (!(file instanceof TFile) || file.extension !== "canvas") {
      return null;
    }
    return file;
  }

  runSherlockFromSelection = () => {
    this.sherlock.runFromSelection();
  };

  runMaigretFromSelection = () => {
    this.maigret.runFromSelection();
  };

  runSocialAnalyzerFromSelection = () => {
    this.socialAnalyzer.runFromSelection();
  };

  private registerCoreCommands() {
    this.addCommand({
      id: "open-help",
      name: "Comshit: Open help",
      callback: () => {
        const url = this.manifest.helpUrl;
        if (url) window.open(url);
        else new Notice("Open a Canvas file to use mindmap controls.");
      },
    });

    this.addCommand({
      id: "create-pair",
      name: "Comshit: Create graph pair (.md + .canvas)",
      callback: async () => {
        const active = this.app.workspace.getActiveFile();
        const base = active?.path.replace(/\.[^.]+$/, "") ?? `Comshit-${Date.now()}`;
        const pair = await this.sync.createPairFromBase(base);
        await this.app.workspace.getLeaf(true).openFile(pair.canvasFile);
        new Notice(`Comshit: created pair ${pair.mdFile.path} and ${pair.canvasFile.path}`);
      },
    });

    this.addCommand({
      id: "convert-current-md",
      name: "Comshit: Convert current Markdown into paired Canvas",
      checkCallback: (checking) => {
        const active = this.app.workspace.getActiveFile();
        if (!active || active.extension !== "md") return false;
        if (!checking) {
          this.sync.convertCurrentMdToCanvas(active).then(() => {
            new Notice("Comshit: converted current Markdown to Canvas pair.");
          });
        }
        return true;
      },
    });

    this.addCommand({
      id: "open-pair",
      name: "Comshit: Open paired file",
      checkCallback: (checking) => {
        const active = this.app.workspace.getActiveFile();
        if (!active || (active.extension !== "md" && active.extension !== "canvas")) return false;
        if (!checking) {
          this.sync.openPair(active);
        }
        return true;
      },
    });

    this.addCommand({
      id: "run-sherlock",
      name: "Comshit: Run Sherlock on selected Canvas node",
      checkCallback: (checking) => {
        if (!this.canvas || !this.node.getSingleSelection()) return false;
        if (!checking) {
          this.runSherlockFromSelection();
        }
        return true;
      },
    });

    this.addCommand({
      id: "run-maigret",
      name: "Comshit: Run Maigret on selected Canvas node",
      checkCallback: (checking) => {
        if (!this.canvas || !this.node.getSingleSelection()) return false;
        if (!checking) {
          this.runMaigretFromSelection();
        }
        return true;
      },
    });

    this.addCommand({
      id: "run-social-analyzer",
      name: "Comshit: Run Social Analyzer on selected Canvas node",
      checkCallback: (checking) => {
        if (!this.canvas || !this.node.getSingleSelection()) return false;
        if (!checking) {
          this.runSocialAnalyzerFromSelection();
        }
        return true;
      },
    });
  }

  private createCanvasInstance() {
    const timer = setInterval(() => {
      // @ts-ignore Canvas leaf internals
      this.canvas = this.app.workspace.getLeavesOfType("canvas").first()?.view?.canvas ?? null;
      if (this.canvas) {
        this.installCanvasDeleteGuard();
        clearInterval(this.intervalTimer.get("canvas"));
      }
    }, 100);

    if (!this.intervalTimer.get("canvas")) {
      this.intervalTimer.set("canvas", timer);
    }
  }

  private onActiveLeafChange() {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", async (leaf) => {
        // @ts-ignore leaf file internals
        const extension = leaf?.view?.file?.extension;
        if (extension === "canvas") {
          this.onKeymap();
          return;
        }
        this.keymap.unregisterAll();
      }),
    );
  }

  onKeymap() {
    this.createCanvasInstance();
    this.keymap.unregisterAll();
    this.keymap.registerAll();
    this.registerBlurCommand();
    this.scheduleMainNodeStyleApply();
  }

  private registerExcelSheetViewRouting() {
    const maybeRouteActiveLeaf = () => {
      const leaf = this.app.workspace.activeLeaf;
      if (!leaf) return;

      const viewAny = leaf.view as {
        file?: TFile;
        getViewType?: () => string;
        getState?: () => Record<string, unknown>;
      };
      const file = viewAny.file;
      if (!file || !this.isSheetMarkdown(file)) return;
      if (typeof viewAny.getViewType === "function" && viewAny.getViewType() === EXCEL_VIEW_TYPE) return;

      const state = typeof viewAny.getState === "function" ? viewAny.getState() : {};
      void leaf.setViewState({
        type: EXCEL_VIEW_TYPE,
        state,
        active: true,
      });
    };

    this.registerEvent(this.app.workspace.on("file-open", () => maybeRouteActiveLeaf()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => maybeRouteActiveLeaf()));
    this.app.workspace.onLayoutReady(() => maybeRouteActiveLeaf());
  }

  private isSheetMarkdown(file: TFile): boolean {
    return file.extension === "md" && /\.sheet$/i.test(file.basename);
  }

  private scheduleMainNodeStyleApply() {
    const apply = () => {
      this.applyMainNodeStyles();
      this.applySherlockQuickButtons();
    };
    apply();
    window.setTimeout(apply, 120);
    window.setTimeout(apply, 450);

    if (this.mainNodeStyleTimer !== null) return;
    // Run periodically but at low frequency, and only re-apply when the actual
    // node DOM has changed. This avoids constant style mutations that can make
    // Canvas re-layout / re-render edges unnecessarily.
    this.mainNodeStyleTimer = window.setInterval(apply, 1200);
    this.register(() => {
      if (this.mainNodeStyleTimer !== null) {
        window.clearInterval(this.mainNodeStyleTimer);
        this.mainNodeStyleTimer = null;
      }
    });
  }

  private collectMainNodes(): M.Node[] {
    const out: M.Node[] = [];
    const seen = new Set<M.Node>();

    const leaves = this.app.workspace.getLeavesOfType("canvas");
    for (const leaf of leaves) {
      const view = leaf.view as unknown as { canvas?: { nodes?: Map<string, M.Node> | Record<string, M.Node> } };
      const canvas = view?.canvas;
      if (!canvas?.nodes) continue;

      let mainNode: M.Node | undefined;
      if (canvas.nodes instanceof Map) {
        mainNode = canvas.nodes.get("whereami-main");
      } else {
        mainNode = (canvas.nodes as Record<string, M.Node>)["whereami-main"];
      }
      if (!mainNode || seen.has(mainNode)) continue;
      seen.add(mainNode);
      out.push(mainNode);
    }

    return out;
  }

  private applySherlockQuickButtons() {
    document.querySelectorAll(".canvas-menu").forEach((menuEl) => {
      if (!(menuEl instanceof HTMLElement)) return;
      if (menuEl.querySelector(".comshit-sherlock-quick-btn")) return;

      const templateBtn = menuEl.querySelector<HTMLButtonElement>("button.clickable-icon:last-of-type");
      const btn = document.createElement("button");
      btn.className = templateBtn?.className ?? "clickable-icon";
      btn.classList.add("comshit-sherlock-quick-btn");
      btn.type = "button";
      btn.title = "Run Sherlock on selected node";
      btn.setAttribute("aria-label", "Run Sherlock on selected node");
      btn.setAttribute("data-tooltip-position", "top");
      btn.replaceChildren();
      setIcon(btn, "search");
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const leafHost = btn.closest(".workspace-leaf") as HTMLElement | null;
        const viewFromLeaf = (leafHost as unknown as { view?: { canvas?: unknown } } | null)?.view;
        let canvas = viewFromLeaf?.canvas as { selection: Set<unknown> } | undefined;
        if (!canvas) {
          const active = this.app.workspace.activeLeaf;
          const v = active?.view as unknown as { canvas?: { selection: Set<unknown> } };
          canvas = v?.canvas;
        }
        if (!canvas) return;
        const selection = canvas.selection;
        if (!(selection instanceof Set) || selection.size !== 1) {
          new Notice("Comshit: select exactly one Canvas text node first.");
          return;
        }
        this.canvas = canvas;
        this.runSherlockFromSelection();
      });
      menuEl.appendChild(btn);
    });
  }

  private applyMainNodeStyles() {
    const nodes = this.collectMainNodes();
    if (!nodes.length) return;

    const setIf = (el: HTMLElement, prop: string, value: string, priority: "important" | "" = "important") => {
      if (el.style.getPropertyValue(prop) === value && el.style.getPropertyPriority(prop) === priority) return;
      el.style.setProperty(prop, value, priority);
    };

    nodes.forEach((node) => {
      const root = node.nodeEl;
      const content = node.contentEl ?? root.querySelector<HTMLElement>(".canvas-node-content") ?? root;
      if (!root.classList.contains("comshit-main-node")) {
        root.classList.add("comshit-main-node");
      }
      if (root.getAttribute("data-node-id") !== "whereami-main") {
        root.setAttribute("data-node-id", "whereami-main");
      }
      const base = Math.max(17, Math.min(30, Math.round(Math.min(node.width, node.height) * 0.17)));
      const boosted = Math.max(22, Math.min(45, Math.round(base * 1.5)));
      setIf(root, "--comshit-main-font-size", `${boosted}px`, "");

      // Flex only — never position/transform inner markdown layers: Canvas uses
      // layout measurements for edge anchors and port handles; transforms desync arrows.
      setIf(content, "display", "flex");
      setIf(content, "flex-direction", "column");
      setIf(content, "align-items", "center");
      setIf(content, "justify-content", "center");
      setIf(content, "padding", "0px");
      setIf(content, "margin", "0px");
      setIf(content, "overflow", "visible");

      const styleEl = (el: HTMLElement) => {
        setIf(el, "font-size", "var(--comshit-main-font-size, 1.15em)");
        setIf(el, "font-weight", "900");
        setIf(el, "line-height", "1.25");
        setIf(el, "text-align", "center");
        setIf(el, "margin", "0px");
      };

      styleEl(content);

      const targets = content.querySelectorAll<HTMLElement>(
        ".canvas-node-label, .markdown-rendered, .markdown-preview-view, .markdown-preview-sizer, .cm-editor, .cm-scroller, .cm-content, .cm-line, p, h1, h2, h3, h4, h5, h6, span",
      );
      targets.forEach((el) => {
        const cls = el.className?.toString() ?? "";
        if (
          cls.includes("canvas-node") ||
          cls.includes("cm-") ||
          cls.includes("markdown") ||
          el.tagName === "P" ||
          /^H[1-6]$/.test(el.tagName) ||
          el.tagName === "SPAN"
        ) {
          styleEl(el);
        }
      });
    });
  }

  private registerCanvasInteractionGuards() {
    this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => {
      const selected = this.node.getSingleSelection();
      if (!selected || !this.getActiveCanvasFile()) return;
      if (selected.id !== "whereami-main") return;
      if (selected.isEditing) return;
      if (!this.isMainDeleteGesture(event)) return;

      event.preventDefault();
      event.stopPropagation();
    });

    this.registerDomEvent(document, "paste", (event: ClipboardEvent) => {
      const selected = this.node.getSingleSelection();
      if (!selected || !this.canvas || !this.getActiveCanvasFile()) return;
      // If the node is already being edited, let Obsidian handle the paste natively.
      if (selected.isEditing) return;
      // If focus is inside any real editable element, don't intercept.
      if (this.isEditableTarget(event.target)) return;

      const pastedText = event.clipboardData?.getData("text/plain")?.replace(/\r\n/g, "\n");
      if (!pastedText || pastedText.length === 0) return;

      event.preventDefault();
      event.stopPropagation();

      // Put the node into edit mode, then after the editor mounts, overwrite its content.
      selected.startEditing?.();
      window.setTimeout(() => {
        const editor = (selected as any).child?.editor ?? (selected as any).editor;
        if (editor && typeof editor.setValue === "function") {
          editor.setValue(pastedText);
          const lastLine = editor.lastLine?.() ?? 0;
          editor.setCursor?.(lastLine, pastedText.split("\n").at(-1)?.length ?? 0);
        } else if (editor && typeof editor.dispatch === "function") {
          // CodeMirror 6 dispatch path
          const { state } = editor;
          editor.dispatch(state.update({ changes: { from: 0, to: state.doc.length, insert: pastedText } }));
        }
        this.canvas.requestSave?.();
      }, 40);
    });
  }

  private installCanvasDeleteGuard() {
    if (!this.canvas) return;
    if (this.guardedCanvasRef !== this.canvas) {
      this.canvasDeleteGuardInstalled = false;
    }
    if (this.canvasDeleteGuardInstalled) return;
    const canvasAny = this.canvas as any;
    this.guardedCanvasRef = this.canvas;
    this.canvasDeleteGuardInstalled = true;

    const wrapDeleteMethod = (methodName: string) => {
      const original = canvasAny[methodName];
      if (typeof original !== "function") return;
      canvasAny[methodName] = (...args: any[]) => {
        this.stripMainFromSelection(canvasAny);
        if (methodName === "removeNode" || methodName === "deleteNode") {
          const nodeArg = args[0];
          if (nodeArg?.id === "whereami-main") {
            return;
          }
        }
        return original.apply(canvasAny, args);
      };
    };

    wrapDeleteMethod("removeSelection");
    wrapDeleteMethod("deleteSelection");
    wrapDeleteMethod("removeNode");
    wrapDeleteMethod("deleteNode");
  }

  private stripMainFromSelection(canvasAny: any): boolean {
    const selection = canvasAny?.selection;
    if (!(selection instanceof Set) || selection.size === 0) return false;
    let removed = false;
    for (const node of [...selection]) {
      if (node?.id === "whereami-main") {
        selection.delete(node);
        removed = true;
      }
    }
    return removed;
  }

  private isMainDeleteGesture(event: KeyboardEvent): boolean {
    if (event.key === "Delete" || event.key === "Backspace") return true;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x") return true;
    return false;
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName.toLowerCase();
    if (tag === "textarea" || tag === "input") return true;
    return !!target.closest("textarea, input, [contenteditable='true']");
  }

  private registerBlurCommand() {
    if (this.blurCommandRegistered) return;
    this.blurCommandRegistered = true;
    this.addCommand({
      id: "blur-node",
      name: "Comshit: Blur node",
      hotkeys: [{ modifiers: ["Mod"], key: "Escape" }],
      checkCallback: () => this.keymap.blurNode(),
    });
  }

  private registerContextMenus() {
    const workspaceAny = this.app.workspace as any;
    if (typeof workspaceAny.on !== "function") return;

    this.registerEvent(
      workspaceAny.on("canvas:node-menu", (menu: any, node: any) => {
        if (node?.id === "whereami-main") {
          this.hideDeleteMenuItems(menu);
        }
        if (!this.node.getSingleSelection()) return;
        menu.addItem((item: any) =>
          item
            .setTitle("Run Sherlock on selected node")
            .setIcon("search")
            .onClick(() => this.runSherlockFromSelection()),
        );
        menu.addItem((item: any) =>
          item
            .setTitle("Run Maigret on selected node")
            .setIcon("scan-search")
            .onClick(() => this.runMaigretFromSelection()),
        );
        menu.addItem((item: any) =>
          item
            .setTitle("Run Social Analyzer on selected node")
            .setIcon("network")
            .onClick(() => this.runSocialAnalyzerFromSelection()),
        );
      }),
    );

    this.registerEvent(
      workspaceAny.on("file-menu", (menu: any, file: unknown) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item: any) =>
          item
            .setTitle("Comshit: Create paired Canvas")
            .setIcon("layout-dashboard")
            .onClick(() => {
              this.sync.convertCurrentMdToCanvas(file).then(() => {
                new Notice("Comshit: created/updated paired Canvas for this Markdown file.");
              });
            }),
        );
      }),
    );
  }

  private hideDeleteMenuItems(menu: any) {
    const menuAny = menu as any;
    if (Array.isArray(menuAny?.items)) {
      menuAny.items = menuAny.items.filter((item: any) => !String(item?.title ?? "").toLowerCase().includes("delete"));
    }
    const menuEl = menuAny?.dom as HTMLElement | undefined;
    if (!menuEl) return;
    const candidates = Array.from(menuEl.querySelectorAll(".menu-item"));
    candidates.forEach((entry) => {
      const label = entry.textContent?.toLowerCase() ?? "";
      if (label.includes("delete")) {
        entry.remove();
      }
    });
  }

  async loadPluginData() {
    const data = (await this.loadData()) as WhereAmIData | null;
    this.setting = {
      ...DEFAULT_SETTINGS,
      ...(data?.settings ?? {}),
      hotkeys: {
        ...DEFAULT_SETTINGS.hotkeys,
        ...(data?.settings?.hotkeys ?? {}),
      },
    };
    this.normalizeLoadedSettings(data?.settings as Partial<WhereAmISettings> | undefined);
    this.state = {
      ...DEFAULT_STATE,
      ...(data?.state ?? {}),
      sherlockChildren: {
        ...DEFAULT_STATE.sherlockChildren,
        ...(data?.state?.sherlockChildren ?? {}),
      },
      maigretChildren: {
        ...DEFAULT_STATE.maigretChildren,
        ...(data?.state?.maigretChildren ?? {}),
      },
      socialAnalyzerChildren: {
        ...DEFAULT_STATE.socialAnalyzerChildren,
        ...(data?.state?.socialAnalyzerChildren ?? {}),
      },
    };
  }

  async saveSettings() {
    const disk = ((await Plugin.prototype.loadData.call(this)) as WhereAmIData | null) ?? {};
    await this.saveData({
      settings: this.setting,
      state: this.state,
      excel: disk.excel ?? {},
    } satisfies WhereAmIData);
  }

  async saveState() {
    const disk = ((await Plugin.prototype.loadData.call(this)) as WhereAmIData | null) ?? {};
    await this.saveData({
      settings: this.setting,
      state: this.state,
      excel: disk.excel ?? {},
    } satisfies WhereAmIData);
  }

  private normalizeLoadedSettings(raw?: Partial<WhereAmISettings>) {
    const filter = String(raw?.socialAnalyzerFilter ?? this.setting.socialAnalyzerFilter ?? "good");
    const filterParts = new Set(filter.split(",").map((part) => part.trim()).filter(Boolean));
    this.setting.socialAnalyzerFilterAll = raw?.socialAnalyzerFilterAll ?? filterParts.has("all");
    this.setting.socialAnalyzerFilterGood = raw?.socialAnalyzerFilterGood ?? (this.setting.socialAnalyzerFilterAll || filterParts.has("good"));
    this.setting.socialAnalyzerFilterMaybe = raw?.socialAnalyzerFilterMaybe ?? (this.setting.socialAnalyzerFilterAll || filterParts.has("maybe"));
    this.setting.socialAnalyzerFilterBad = raw?.socialAnalyzerFilterBad ?? (this.setting.socialAnalyzerFilterAll || filterParts.has("bad"));
    if (!this.setting.socialAnalyzerFilterGood && !this.setting.socialAnalyzerFilterMaybe && !this.setting.socialAnalyzerFilterBad) {
      this.setting.socialAnalyzerFilterGood = true;
    }
    this.setting.socialAnalyzerFilterAll =
      this.setting.socialAnalyzerFilterGood && this.setting.socialAnalyzerFilterMaybe && this.setting.socialAnalyzerFilterBad;
    this.setting.socialAnalyzerFilter = this.setting.socialAnalyzerFilterAll
      ? "all"
      : [
          this.setting.socialAnalyzerFilterGood ? "good" : "",
          this.setting.socialAnalyzerFilterMaybe ? "maybe" : "",
          this.setting.socialAnalyzerFilterBad ? "bad" : "",
        ]
          .filter(Boolean)
          .join(",");

    const profiles = String(raw?.socialAnalyzerProfiles ?? this.setting.socialAnalyzerProfiles ?? "detected");
    const profileParts = new Set(profiles.split(",").map((part) => part.trim()).filter(Boolean));
    this.setting.socialAnalyzerProfileAll = raw?.socialAnalyzerProfileAll ?? profileParts.has("all");
    this.setting.socialAnalyzerProfileDetected =
      raw?.socialAnalyzerProfileDetected ?? (this.setting.socialAnalyzerProfileAll || profileParts.has("detected"));
    this.setting.socialAnalyzerProfileUnknown =
      raw?.socialAnalyzerProfileUnknown ?? (this.setting.socialAnalyzerProfileAll || profileParts.has("unknown"));
    this.setting.socialAnalyzerProfileFailed =
      raw?.socialAnalyzerProfileFailed ?? (this.setting.socialAnalyzerProfileAll || profileParts.has("failed"));
    if (
      !this.setting.socialAnalyzerProfileDetected &&
      !this.setting.socialAnalyzerProfileUnknown &&
      !this.setting.socialAnalyzerProfileFailed
    ) {
      this.setting.socialAnalyzerProfileDetected = true;
    }
    this.setting.socialAnalyzerProfileAll =
      this.setting.socialAnalyzerProfileDetected &&
      this.setting.socialAnalyzerProfileUnknown &&
      this.setting.socialAnalyzerProfileFailed;
    this.setting.socialAnalyzerProfiles = this.setting.socialAnalyzerProfileAll
      ? "all"
      : [
          this.setting.socialAnalyzerProfileDetected ? "detected" : "",
          this.setting.socialAnalyzerProfileUnknown ? "unknown" : "",
          this.setting.socialAnalyzerProfileFailed ? "failed" : "",
        ]
          .filter(Boolean)
          .join(",");

    if (this.setting.socialAnalyzerTop === 0) this.setting.socialAnalyzerTop = null;

    const pythonCommand = this.setting.socialAnalyzerPythonCommand.trim() || DEFAULT_SETTINGS.socialAnalyzerPythonCommand;
    this.setting.socialAnalyzerCommand = `${pythonCommand} app.py`;
    this.setting.socialAnalyzerWorkingDir = this.setting.socialAnalyzerEmbeddedDir.trim() || DEFAULT_SETTINGS.socialAnalyzerEmbeddedDir;
  }
}
