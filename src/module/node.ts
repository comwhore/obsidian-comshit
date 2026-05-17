import { debounce, uuid } from "../tool";
import WhereAmIPlugin from "../main";
import autobind from "autobind-decorator";

@autobind
class Node {
  main: WhereAmIPlugin;

  constructor(main: WhereAmIPlugin) {
    this.main = main;
  }

  getNavigationNode(): M.Node | null {
    const node = this.getSingleSelection();
    if (!node || !node.isFocused || node.isEditing) return null;
    return node;
  }

  getSelection(): Set<unknown> {
    return this.main.canvas?.selection ?? new Set();
  }

  getSingleSelection(): M.Node | null {
    if (!this.main.canvas?.selection) return null;
    const selections = this.main.canvas.selection;
    if (selections.size === 0 || selections.size > 1) return null;
    return selections.values().next().value as M.Node;
  }

  getFromNodes(node: M.Node) {
    return this.main.canvas
      .getEdgesForNode(node)
      .filter((edge: M.Edge) => edge.to.node.id === node.id)
      .map((edge: M.Edge) => edge.from.node);
  }

  getToNodes(node: M.Node) {
    return this.main.canvas
      .getEdgesForNode(node)
      .filter((edge: M.Edge) => edge.from.node.id === node.id)
      .map((edge: M.Edge) => edge.to.node);
  }

  @debounce()
  createChildren() {
    const selection = this.getNavigationNode();
    if (!selection || !this.main.canvas) return;

    const { x, y, width, height } = selection;
    const rightSideNodeFilter = (node: M.Edge) => node?.to?.side === "left" && selection.id !== node?.to?.node?.id;

    const sibNodes = this.main.canvas
      .getEdgesForNode(selection)
      .filter(rightSideNodeFilter)
      .map((node: M.Edge) => node.to.node);

    const nextNodeY = sibNodes.length > 0 ? Math.max(...sibNodes.map((node: M.Node) => node.y)) + this.main.setting.EPSILON : y;

    const childNode = this.main.canvas.createTextNode({
      pos: { x: x + width + 200, y: nextNodeY },
      size: { height, width },
      text: "",
      focus: false,
      save: true,
    });

    const data = this.main.canvas.getData();
    this.main.canvas.importData({
      edges: [
        ...data.edges,
        {
          id: uuid(),
          fromNode: selection.id,
          fromSide: "right",
          toNode: childNode.id,
          toSide: "left",
        },
      ],
      nodes: data.nodes,
    });

    this.main.layout.useSide(selection, sibNodes.concat(childNode));
    this.main.view.zoomToNode(childNode);
  }

  @debounce()
  createBeforeSibNode() {
    this.createSibNodeHelper(true);
  }

  @debounce()
  createAfterSibNode() {
    this.createSibNodeHelper(false);
  }

  private createSibNodeHelper(isBefore: boolean) {
    const selection = this.getNavigationNode();
    if (!selection || !this.main.canvas) return;

    const { x, y, width, height } = selection;
    const { EPSILON } = this.main.setting;
    const fromNode = this.getFromNodes(selection)[0];
    if (!fromNode) return;
    const toNodes = this.getToNodes(fromNode);

    const insertedNode = this.main.canvas.createTextNode({
      pos: { x, y: isBefore ? y - EPSILON : y + EPSILON },
      size: { height, width },
      text: "",
      focus: false,
      save: true,
    });

    const data = this.main.canvas.getData();
    this.main.canvas.importData({
      edges: [
        ...data.edges,
        {
          id: uuid(),
          fromNode: fromNode.id,
          fromSide: "right",
          toNode: insertedNode.id,
          toSide: "left",
        },
      ],
      nodes: data.nodes,
    });

    this.main.layout.useSide(fromNode, toNodes.concat(insertedNode));
    this.main.view.zoomToNode(insertedNode);
  }
}

export { Node };
