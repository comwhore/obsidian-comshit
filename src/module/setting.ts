import { Notice, PluginSettingTab, Setting as ObsidianSetting } from "obsidian";
import WhereAmIPlugin from "../main";
import { convertHotkey2Array } from "../tool";

export interface WhereAmISettings {
  autoFocus: boolean;
  hotkeys: {
    Focus: string;
    CreateChild: string;
    CreateBeforeSib: string;
    CreateAfterSib: string;
    RunSherlock: string;
    ArrowUp: string;
    ArrowDown: string;
    ArrowLeft: string;
    ArrowRight: string;
  };
  ROW_GAP: number;
  COLUMN_GAP: number;
  EPSILON: number;
  OFFSET_WEIGHT: number;
  MACRO_TASK_DELAY: number;
  sherlockCommand: string;
  sherlockExtraArgs: string;
  sherlockTimeout: number;
  sherlockIncludeNsfw: boolean;
  sherlockProxy: string;
  syncDebounceMs: number;
  maigretCommand: string;
  maigretExtraArgs: string;
  maigretThreads: number;
  maigretProxy: string;
  maigretRetries: number;
  maigretTimeout: number;
  maigretReportsFolder: string;
  socialAnalyzerUseEmbedded: boolean;
  socialAnalyzerPythonCommand: string;
  socialAnalyzerEmbeddedDir: string;
  socialAnalyzerCommand: string;
  socialAnalyzerWorkingDir: string;
  socialAnalyzerExtraArgs: string;
  socialAnalyzerMode: string;
  socialAnalyzerWebsites: string;
  socialAnalyzerMethod: string;
  socialAnalyzerFilter: string;
  socialAnalyzerFilterGood: boolean;
  socialAnalyzerFilterMaybe: boolean;
  socialAnalyzerFilterBad: boolean;
  socialAnalyzerFilterAll: boolean;
  socialAnalyzerProfiles: string;
  socialAnalyzerProfileDetected: boolean;
  socialAnalyzerProfileUnknown: boolean;
  socialAnalyzerProfileFailed: boolean;
  socialAnalyzerProfileAll: boolean;
  socialAnalyzerCountries: string;
  socialAnalyzerType: string;
  socialAnalyzerTop: number | null;
  socialAnalyzerExtractMetadata: boolean;
  socialAnalyzerExtractPatterns: boolean;
  socialAnalyzerGenerateCategoryStats: boolean;
  socialAnalyzerGenerateMetadataStats: boolean;
  socialAnalyzerSimplify: boolean;
  socialAnalyzerReportsFolder: string;
}

export const DEFAULT_SETTINGS: WhereAmISettings = {
  autoFocus: false,
  hotkeys: {
    CreateChild: "Tab",
    CreateBeforeSib: "Shift + Enter",
    CreateAfterSib: "Enter",
    RunSherlock: "Alt + Shift + Enter",
    Focus: "F",
    ArrowUp: "Alt + ArrowUp",
    ArrowDown: "Alt + ArrowDown",
    ArrowLeft: "Alt + ArrowLeft",
    ArrowRight: "Alt + ArrowRight",
  },
  ROW_GAP: 20,
  COLUMN_GAP: 200,
  EPSILON: 1,
  OFFSET_WEIGHT: 1.1,
  MACRO_TASK_DELAY: 50,
  sherlockCommand: "python -m sherlock",
  sherlockExtraArgs: "",
  sherlockTimeout: 60,
  sherlockIncludeNsfw: true,
  sherlockProxy: "",
  syncDebounceMs: 500,
  maigretCommand: "maigret",
  maigretExtraArgs: "",
  maigretThreads: 100,
  maigretProxy: "",
  maigretRetries: 1,
  maigretTimeout: 30,
  maigretReportsFolder: "Comshit/Maigret",
  socialAnalyzerUseEmbedded: true,
  socialAnalyzerPythonCommand: "python",
  socialAnalyzerEmbeddedDir: "social-analyzer-main",
  socialAnalyzerCommand: "python app.py",
  socialAnalyzerWorkingDir: "",
  socialAnalyzerExtraArgs: "",
  socialAnalyzerMode: "fast",
  socialAnalyzerWebsites: "",
  socialAnalyzerMethod: "all",
  socialAnalyzerFilter: "good",
  socialAnalyzerFilterGood: true,
  socialAnalyzerFilterMaybe: false,
  socialAnalyzerFilterBad: false,
  socialAnalyzerFilterAll: false,
  socialAnalyzerProfiles: "detected",
  socialAnalyzerProfileDetected: true,
  socialAnalyzerProfileUnknown: false,
  socialAnalyzerProfileFailed: false,
  socialAnalyzerProfileAll: false,
  socialAnalyzerCountries: "all",
  socialAnalyzerType: "all",
  socialAnalyzerTop: null,
  socialAnalyzerExtractMetadata: true,
  socialAnalyzerExtractPatterns: false,
  socialAnalyzerGenerateCategoryStats: false,
  socialAnalyzerGenerateMetadataStats: false,
  socialAnalyzerSimplify: false,
  socialAnalyzerReportsFolder: "Comshit/Social Analyzer",
};

export class WhereAmISettingTab extends PluginSettingTab {
  plugin: WhereAmIPlugin;

  constructor(plugin: WhereAmIPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    this.addToggle("Auto Focus", "Focus cursor on new nodes automatically.", "autoFocus");
    this.addHotkey("Create Child Node", "CreateChild", this.plugin.node.createChildren);
    this.addHotkey("Create Sibling Node Before", "CreateBeforeSib", this.plugin.node.createBeforeSibNode);
    this.addHotkey("Create Sibling Node After", "CreateAfterSib", this.plugin.node.createAfterSibNode);
    this.addHotkey("Run Sherlock on Selected Node", "RunSherlock", this.plugin.runSherlockFromSelection);

    containerEl.createEl("h3", { text: "Sherlock" });
    this.addText("Sherlock command", "Command used to start Sherlock. Example: python -m sherlock", "sherlockCommand");
    this.addText("Extra Sherlock args", "Additional arguments to run Sherlock with", "sherlockExtraArgs");
    this.addText("Proxy", "Make requests over a proxy. e.g. socks5://127.0.0.1:1080", "sherlockProxy");
    this.addNumber("Timeout", "Time (in seconds) to wait for response to requests", "sherlockTimeout");
    this.addToggle("Include NSFW sites", "Include checking of NSFW sites from default list.", "sherlockIncludeNsfw");

    containerEl.createEl("h3", { text: "Sync" });
    this.addNumber("Sync debounce (ms)", "Delay before pair synchronization starts.", "syncDebounceMs");

    containerEl.createEl("h3", { text: "Maigret" });
    this.addText("Maigret command", "Command used to run Maigret, e.g. maigret", "maigretCommand");
    this.addText("Extra Maigret args", "Additional arguments to run Maigret with", "maigretExtraArgs");
    this.addNumber("Connections", "Allowed number of concurrent connections (default 100).", "maigretThreads");
    this.addText(
      "Proxy",
      "Make requests over a proxy. e.g. socks5://127.0.0.1:1080",
      "maigretProxy",
    );
    this.addNumber("Retries", "Attempts to restart temporarily failed requests.", "maigretRetries");
    this.addNumber(
      "Timeout",
      "Time in seconds to wait for response to requests (default 30s). A longer timeout will be more  likely to get results from slow sites. On the other hand, this may cause a long delay to gather all results.",
      "maigretTimeout",
    );
    this.addText("FOLDER", "Create files in this folder by default", "maigretReportsFolder");

    containerEl.createEl("h3", { text: "Social Analyzer" });
    this.addText(
      "Python command",
      "Command used to start Python. Example: python",
      "socialAnalyzerPythonCommand",
    );
    this.addText(
      "FOLDER",
      "Create files in this folder by default",
      "socialAnalyzerEmbeddedDir",
    );
    this.addDropdown(
      "Mode",
      "Analysis mode E.g.fast -> FindUserProfilesFast, slow -> FindUserProfilesSlow or special -> FindUserProfilesSpecial",
      "socialAnalyzerMode",
      [
        ["fast", "fast"],
        ["slow", "slow"],
        ["special", "special"],
      ],
    );
    this.addText("Websites", "A website or websites separated by space E.g. youtube, tiktok or tumblr", "socialAnalyzerWebsites");
    this.addDropdown(
      "Method",
      "find -> show detected profiles, get -> show all profiles regardless detected or not, all -> combine  find & get",
      "socialAnalyzerMethod",
      [
        ["find", "find"],
        ["get", "get"],
        ["all", "all"],
      ],
    );
    this.addFilterToggles();
    this.addProfileToggles();
    this.addText("Countries", "Select websites by country or countries separated by space as: us br ru, or use all", "socialAnalyzerCountries");
    this.addText("Type", "Select websites by type (Adult, Music etc), or use all", "socialAnalyzerType");
    this.addNumber("Top websites", "Select top websites as 10, 50 etc...", "socialAnalyzerTop");
    this.addToggle("Metadata", "Extract metadata if possible", "socialAnalyzerExtractMetadata");
    this.addToggle("Extract", "Extract profiles, urls & patterns if possible", "socialAnalyzerExtractPatterns");
    this.addToggle("Simplify", "Print the detected profiles only (links)", "socialAnalyzerSimplify", true);
    this.addText("FOLDER", "Create files in this folder by default", "socialAnalyzerReportsFolder", this.plugin.setting.socialAnalyzerSimplify);
    this.addText("Extra Social Analyzer args", "Additional arguments to run Social Analyzer with", "socialAnalyzerExtraArgs");
  }

  private addToggle(name: string, desc: string, key: keyof WhereAmISettings, refreshAfterChange = false) {
    new ObsidianSetting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.setting[key] as boolean).onChange(async (value) => {
          (this.plugin.setting[key] as boolean) = value;
          await this.plugin.saveSettings();
          if (refreshAfterChange) this.display();
        }),
      );
  }

  private addText(name: string, desc: string, key: keyof WhereAmISettings, disabled = false) {
    const setting = new ObsidianSetting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text.setDisabled(disabled).setValue(String(this.plugin.setting[key] ?? "")).onChange(async (value) => {
          (this.plugin.setting[key] as string) = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    this.applyDisabledVisual(setting, disabled);
  }

  private addNumber(name: string, desc: string, key: keyof WhereAmISettings) {
    new ObsidianSetting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text.setValue(this.plugin.setting[key] === null ? "" : String(this.plugin.setting[key])).onChange(async (value) => {
          if (!value.trim()) {
            (this.plugin.setting[key] as number | null) = null;
            await this.plugin.saveSettings();
            return;
          }
          const parsed = Number(value);
          if (!Number.isFinite(parsed)) return;
          (this.plugin.setting[key] as number) = parsed;
          await this.plugin.saveSettings();
        }),
      );
  }

  private addDropdown(
    name: string,
    desc: string,
    key: keyof WhereAmISettings,
    options: Array<[string, string]>,
  ) {
    new ObsidianSetting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addDropdown((dropdown) => {
        options.forEach(([value, label]) => dropdown.addOption(value, label));
        dropdown.setValue(String(this.plugin.setting[key] ?? options[0]?.[0] ?? "")).onChange(async (value) => {
          (this.plugin.setting[key] as string) = value;
          await this.plugin.saveSettings();
        });
      });
  }

  private addFilterToggles() {
    this.containerEl.createEl("h4", { text: "Filter" });
    this.containerEl.createEl("p", {
      text: "Filter detected profiles by good, maybe or bad, you can do combine them with comma (good,bad) or use all",
    });
    this.addSyncedToggle("All", "socialAnalyzerFilterAll", () => this.normalizeSocialAnalyzerFilters());
    this.addSyncedToggle("Good", "socialAnalyzerFilterGood", () => this.normalizeSocialAnalyzerFilters(), this.plugin.setting.socialAnalyzerFilterAll);
    this.addSyncedToggle("Maybe", "socialAnalyzerFilterMaybe", () => this.normalizeSocialAnalyzerFilters(), this.plugin.setting.socialAnalyzerFilterAll);
    this.addSyncedToggle("Bad", "socialAnalyzerFilterBad", () => this.normalizeSocialAnalyzerFilters(), this.plugin.setting.socialAnalyzerFilterAll);
    this.containerEl.createEl("hr");
  }

  private addProfileToggles() {
    this.containerEl.createEl("h4", { text: "Profiles" });
    this.containerEl.createEl("p", {
      text: "Filter profiles by detected, unknown or failed, you can do combine them with comma (detected,failed) or use all",
    });
    this.addSyncedToggle("All", "socialAnalyzerProfileAll", () => this.normalizeSocialAnalyzerProfiles());
    this.addSyncedToggle("Detected", "socialAnalyzerProfileDetected", () => this.normalizeSocialAnalyzerProfiles(), this.plugin.setting.socialAnalyzerProfileAll);
    this.addSyncedToggle("Unknown", "socialAnalyzerProfileUnknown", () => this.normalizeSocialAnalyzerProfiles(), this.plugin.setting.socialAnalyzerProfileAll);
    this.addSyncedToggle("Failed", "socialAnalyzerProfileFailed", () => this.normalizeSocialAnalyzerProfiles(), this.plugin.setting.socialAnalyzerProfileAll);
    this.containerEl.createEl("hr");
  }

  private addSyncedToggle(
    name: string,
    key: keyof WhereAmISettings,
    normalize: () => void,
    disabled = false,
  ) {
    const setting = new ObsidianSetting(this.containerEl).setName(name).addToggle((toggle) =>
      toggle
        .setDisabled(disabled)
        .setValue(Boolean(this.plugin.setting[key]))
        .onChange(async (value) => {
          (this.plugin.setting[key] as boolean) = value;
          if (key === "socialAnalyzerFilterAll") {
            this.plugin.setting.socialAnalyzerFilterGood = value || true;
            this.plugin.setting.socialAnalyzerFilterMaybe = value;
            this.plugin.setting.socialAnalyzerFilterBad = value;
          }
          if (key === "socialAnalyzerProfileAll") {
            this.plugin.setting.socialAnalyzerProfileDetected = value || true;
            this.plugin.setting.socialAnalyzerProfileUnknown = value;
            this.plugin.setting.socialAnalyzerProfileFailed = value;
          }
          normalize();
          await this.plugin.saveSettings();
          this.display();
        }),
    );
    this.applyDisabledVisual(setting, disabled);
  }

  private applyDisabledVisual(setting: ObsidianSetting, disabled: boolean) {
    setting.settingEl.classList.toggle("comshit-setting-disabled", disabled);
    setting.settingEl.setAttribute("aria-disabled", disabled ? "true" : "false");
  }

  private normalizeSocialAnalyzerFilters() {
    const settings = this.plugin.setting;
    if (settings.socialAnalyzerFilterAll) {
      settings.socialAnalyzerFilterGood = true;
      settings.socialAnalyzerFilterMaybe = true;
      settings.socialAnalyzerFilterBad = true;
    }
    if (!settings.socialAnalyzerFilterGood && !settings.socialAnalyzerFilterMaybe && !settings.socialAnalyzerFilterBad) {
      settings.socialAnalyzerFilterGood = true;
    }
    settings.socialAnalyzerFilterAll =
      settings.socialAnalyzerFilterGood && settings.socialAnalyzerFilterMaybe && settings.socialAnalyzerFilterBad;
    settings.socialAnalyzerFilter = settings.socialAnalyzerFilterAll
      ? "all"
      : [
          settings.socialAnalyzerFilterGood ? "good" : "",
          settings.socialAnalyzerFilterMaybe ? "maybe" : "",
          settings.socialAnalyzerFilterBad ? "bad" : "",
        ]
          .filter(Boolean)
          .join(",");
  }

  private normalizeSocialAnalyzerProfiles() {
    const settings = this.plugin.setting;
    if (settings.socialAnalyzerProfileAll) {
      settings.socialAnalyzerProfileDetected = true;
      settings.socialAnalyzerProfileUnknown = true;
      settings.socialAnalyzerProfileFailed = true;
    }
    if (!settings.socialAnalyzerProfileDetected && !settings.socialAnalyzerProfileUnknown && !settings.socialAnalyzerProfileFailed) {
      settings.socialAnalyzerProfileDetected = true;
    }
    settings.socialAnalyzerProfileAll =
      settings.socialAnalyzerProfileDetected && settings.socialAnalyzerProfileUnknown && settings.socialAnalyzerProfileFailed;
    settings.socialAnalyzerProfiles = settings.socialAnalyzerProfileAll
      ? "all"
      : [
          settings.socialAnalyzerProfileDetected ? "detected" : "",
          settings.socialAnalyzerProfileUnknown ? "unknown" : "",
          settings.socialAnalyzerProfileFailed ? "failed" : "",
        ]
          .filter(Boolean)
          .join(",");
  }

  private addHotkey(title: string, key: M.NodeActionName, callback: () => void) {
    let nextHotKey = this.plugin.setting.hotkeys[key];
    new ObsidianSetting(this.containerEl)
      .setName(title)
      .setDesc("Use formats like Enter, Tab, Ctrl + K, Alt + ArrowRight.")
      .addText((text) =>
        text.setValue(nextHotKey).onChange((value) => {
          nextHotKey = value;
        }),
      )
      .addButton((button) =>
        button.setButtonText("Save").setCta().onClick(async () => {
          try {
            const [modifier, hotkey] = convertHotkey2Array(nextHotKey);
            this.plugin.setting.hotkeys[key] = nextHotKey;
            await this.plugin.saveSettings();
            this.plugin.keymap.unregisterAll();
            this.plugin.keymap.registerAll({
              [key]: () => this.plugin.keymap.register(modifier, hotkey, callback),
            });
            new Notice("Saved hotkey.");
          } catch (error) {
            new Notice((error as Error).message);
          }
        }),
      );
  }
}
