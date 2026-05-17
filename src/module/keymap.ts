import { KeymapContext, KeymapEventHandler, KeymapEventListener } from "obsidian";
import { Node } from "./node";
import WhereAmIPlugin from "../main";
import autobind from "autobind-decorator";
import { convertHotkey2Array, debounce } from "../tool";

@autobind
class Keymap {
  hotkeys: KeymapEventHandler[] = [];
  main: WhereAmIPlugin;
  node: Node;

  constructor(main: WhereAmIPlugin) {
    this.main = main;
    this.node = main.node;
  }

  @debounce()
  help() {
    if (this.main.view.isCreating()) return;
    console.debug("whereami keymap", this.main.canvas);
  }

  nodeNavigation(_: unknown, context: KeymapContext) {
    type Key = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";
    const { key } = context as Omit<KeymapContext, "key"> & { key: Key };
    const selection = this.node.getSingleSelection();
    if (!selection || selection.isEditing || !this.main.canvas) return;

    const { OFFSET_WEIGHT } = this.main.setting;
    const data = this.main.canvas.getViewportNodes();
    const offsetX = (a: M.Node, b: M.Node) => Math.abs(b.x - a.x);
    const offsetY = (a: M.Node, b: M.Node) => Math.abs(b.y - a.y);
    const endpointOffset = (a: M.Node, b: M.Node) =>
      Math.min(
        Math.abs(b.y - a.y + 2 / a.height),
        Math.abs(b.y + b.height - a.y - 2 / a.height),
        Math.abs(b.x - a.x + 2 / a.width),
        Math.abs(b.x + b.width - a.x + 2 / a.width),
      );
    const calcDistance = (a: M.Node, b: M.Node) =>
      key === "ArrowLeft" || key === "ArrowRight"
        ? offsetX(a, b) + endpointOffset(a, b) ** OFFSET_WEIGHT
        : offsetY(a, b) + endpointOffset(a, b) ** OFFSET_WEIGHT;

    const isSameDirection = (node: M.Node) => {
      const notSelf = node.id !== selection.id;
      const strategies = {
        ArrowRight: notSelf && node.x > selection.x + selection.width,
        ArrowLeft: notSelf && node.x + node.width < selection.x,
        ArrowUp: notSelf && node.y + node.height < selection.y,
        ArrowDown: notSelf && node.y > selection.y + selection.height,
      };
      return strategies[key];
    };

    const midpoints = data
      .filter(isSameDirection)
      .map((node: M.Node) => ({
        node,
        distance: calcDistance(selection, node),
      }))
      .sort((a, b) => a.distance - b.distance);

    if (midpoints.length > 0) {
      this.main.view.zoomToNode(midpoints[0].node);
    }
  }

  blurNode() {
    if (this.main.view.isCreating()) {
      this.main.view.creation2Navigation();
      return;
    }
    if (this.main.view.isNavigating()) {
      this.main.view.useTouch();
    }
  }

  focusNode() {
    if (this.main.view.isTouching()) {
      this.main.view.touch2Navigation();
      return;
    }
    const navigationNode = this.main.node.getNavigationNode();
    if (navigationNode) {
      this.main.view.useCreation(navigationNode);
    }
  }

  register(modifiers: any[], key: string | null, func: KeymapEventListener): KeymapEventHandler {
    return this.main.app.scope.register(modifiers, key, func);
  }

  registerAll(options?: { [key in M.NodeActionName]?: () => KeymapEventHandler }) {
    const { hotkeys } = this.main.setting;
    const registerHotkey = (action: M.NodeActionName, callback: KeymapEventListener) => {
      if (options?.[action]) {
        this.hotkeys.push(options[action]!());
        return;
      }
      const [modifier, key] = convertHotkey2Array(hotkeys[action]);
      this.hotkeys.push(this.register(modifier, key, callback));
    };

    registerHotkey("Focus", this.focusNode);
    registerHotkey("CreateChild", this.main.node.createChildren);
    registerHotkey("CreateBeforeSib", this.main.node.createBeforeSibNode);
    registerHotkey("CreateAfterSib", this.main.node.createAfterSibNode);
    registerHotkey("RunSherlock", this.main.runSherlockFromSelection);
    registerHotkey("ArrowLeft", this.nodeNavigation);
    registerHotkey("ArrowRight", this.nodeNavigation);
    registerHotkey("ArrowUp", this.nodeNavigation);
    registerHotkey("ArrowDown", this.nodeNavigation);
  }

  unregisterAll() {
    this.hotkeys.forEach((key) => this.main.app.scope.unregister(key));
    this.hotkeys = [];
  }
}

export { Keymap };
