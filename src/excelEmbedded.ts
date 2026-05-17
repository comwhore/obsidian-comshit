import { dirname, isAbsolute, join, resolve } from "path";
import { createRequire } from "module";
import { readFile } from "fs/promises";
import { App, Plugin, PluginManifest } from "obsidian";
import { EMBEDDED_EXCEL_MAIN } from "./generated/excelBundle";

export type ComshitExcelParent = Plugin & { setting: unknown; state: unknown };

/** Obsidian sets `manifest.dir` to the real plugin folder; `__dirname` is inside electron.asar. */
function embeddedExcelMainPath(parent: Plugin): string {
  const manifestDir = parent.manifest.dir;
  if (manifestDir && isAbsolute(manifestDir)) {
    return join(manifestDir, "excel-modded", "main.js");
  }

  const configPath = manifestDir ?? join(parent.app.vault.configDir, "plugins", parent.manifest.id);
  const fsAdapter = parent.app.vault.adapter as { getBasePath?: () => string };
  const vaultBasePath = typeof fsAdapter.getBasePath === "function" ? fsAdapter.getBasePath() : "";
  const pluginDir = vaultBasePath ? resolve(vaultBasePath, configPath) : configPath;
  return join(pluginDir, "excel-modded", "main.js");
}

async function loadEmbeddedExcelCtor(excelPath: string): Promise<new (app: App, manifest: PluginManifest) => Plugin> {
  const localRequire = createRequire(excelPath);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const obsidianRuntime = require("obsidian");
  const moduleLike: { exports: unknown } = { exports: {} };

  const wrappedRequire = (id: string): unknown => {
    if (id === "obsidian") return obsidianRuntime;
    return localRequire(id);
  };

  let source: string;
  try {
    source = await readFile(excelPath, "utf8");
  } catch {
    source = EMBEDDED_EXCEL_MAIN;
  }
  const factory = new Function("exports", "require", "module", "__filename", "__dirname", source) as (
    exports: unknown,
    requireFn: (id: string) => unknown,
    moduleObj: { exports: unknown },
    filename: string,
    dirname: string,
  ) => void;
  factory(moduleLike.exports, wrappedRequire, moduleLike, excelPath, dirname(excelPath));
  const result = moduleLike.exports as { default?: new (app: App, manifest: PluginManifest) => Plugin };
  if (!result.default) throw new Error("Embedded excel-modded did not export a default plugin class.");
  return result.default;
}

/**
 * Loads the pre-bundled excel-modded plugin and runs its onload with storage
 * merged under `data.json` key `excel` so one comshit plugin owns both features.
 */
export async function mountEmbeddedExcel(parent: ComshitExcelParent): Promise<Plugin> {
  const excelPath = embeddedExcelMainPath(parent);
  const ExcelPlugin = await loadEmbeddedExcelCtor(excelPath);

  const excel = new ExcelPlugin(parent.app, {
    ...parent.manifest,
    name: "comsheet",
  });

  excel.register = parent.register.bind(parent);
  excel.loadData = async () => {
    const raw = (await Plugin.prototype.loadData.call(parent)) as { excel?: unknown } | null;
    return raw?.excel ?? {};
  };
  excel.saveData = async (data: unknown) => {
    await Plugin.prototype.saveData.call(parent, {
      settings: parent.setting,
      state: parent.state,
      excel: data,
    });
  };

  await excel.onload();
  return excel;
}
