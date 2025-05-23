import * as vscode from "vscode";
import { FlowStorageService } from "../listeners/flowStorageService";
import { CapturedFlow } from "../types/flowTypes";
import { Logger } from "../utilities/logger";
import * as path from "path";

export class FlowListProvider implements vscode.TreeDataProvider<FlowTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<FlowTreeItem | undefined | null | void> =
    new vscode.EventEmitter<FlowTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<FlowTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private searchTerm: string = "";
  private filterCategory: string | undefined;
  private sortBy: "name" | "date" = "name";
  private sortOrder: "asc" | "desc" = "asc";

  constructor(
    private context: vscode.ExtensionContext,
    private flowStorageService: FlowStorageService
  ) {
    // Could register commands here for search, filter, sort if not done globally
  }

  refresh(): void {
    Logger.log("FlowListProvider: Refreshing tree data.");
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FlowTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FlowTreeItem): Promise<FlowTreeItem[]> {
    if (element) {
      // If we had nested items (e.g., nodes under a flow), handle here
      return [];
    }

    try {
      let flows = await this.flowStorageService.getAllFlows();
      Logger.log(`FlowListProvider: Fetched ${flows.length} flows.`);

      // Filter
      if (this.searchTerm) {
        const lowerSearchTerm = this.searchTerm.toLowerCase();
        flows = flows.filter(
          (flow) =>
            flow.name.toLowerCase().includes(lowerSearchTerm) ||
            flow.description.toLowerCase().includes(lowerSearchTerm) ||
            (flow.tags && flow.tags.some((tag) => tag.toLowerCase().includes(lowerSearchTerm)))
        );
      }
      if (this.filterCategory && this.filterCategory !== "All") {
        flows = flows.filter((flow) => flow.category === this.filterCategory);
      }

      // Sort
      flows.sort((a, b) => {
        let comparison = 0;
        if (this.sortBy === "name") {
          comparison = a.name.localeCompare(b.name);
        } else {
          // date (updatedAt)
          comparison = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(); // descending by default for date
        }
        return this.sortOrder === "asc" ? comparison : -comparison;
      });

      return flows.map((flow) => new FlowTreeItem(flow, vscode.TreeItemCollapsibleState.None));
    } catch (error) {
      Logger.error("FlowListProvider: Error fetching children:", error);
      vscode.window.showErrorMessage("Could not load flows for the sidebar.");
      return [];
    }
  }

  // --- Search, Filter, Sort methods (to be called by commands) ---
  public async setSearchTerm() {
    const term = await vscode.window.showInputBox({
      prompt: "Search flows (name, description, tags)",
      value: this.searchTerm,
    });
    if (term !== undefined) {
      this.searchTerm = term;
      this.refresh();
    }
  }

  public async setFilterCategory() {
    const categories = [
      "All",
      "General",
      "User Interaction",
      "Data Processing",
      "API Call",
      "Authentication",
      "Needs Review",
    ]; // Match flowTypes.ts
    const category = await vscode.window.showQuickPick(categories, {
      placeHolder: "Filter by category",
      canPickMany: false,
    });
    if (category !== undefined) {
      this.filterCategory = category === "All" ? undefined : category;
      this.refresh();
    }
  }

  public async setSortBy() {
    const sortByOptions = [
      { label: "Name", sortBy: "name" as const },
      { label: "Last Updated", sortBy: "date" as const },
    ];
    const picked = await vscode.window.showQuickPick(sortByOptions, { placeHolder: "Sort by" });
    if (picked) {
      const orderOptions = [
        { label: "Ascending", sortOrder: "asc" as const },
        { label: "Descending", sortOrder: "desc" as const },
      ];
      const pickedOrder = await vscode.window.showQuickPick(orderOptions, {
        placeHolder: `Sort ${picked.label}`,
      });
      if (pickedOrder) {
        this.sortBy = picked.sortBy;
        this.sortOrder = pickedOrder.sortOrder;
        this.refresh();
      }
    }
  }
}

export class FlowTreeItem extends vscode.TreeItem {
  constructor(
    public readonly flow: CapturedFlow,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(flow.name, collapsibleState);
    this.tooltip = `${flow.name}\nCategory: ${flow.category || "N/A"}\nLast Updated: ${new Date(
      flow.updatedAt
    ).toLocaleString()}\n${flow.description}`;
    this.description = `${flow.category || ""} - ${path.basename(
      flow.startPin?.filePath || "Multiple files"
    )}`; // Short description

    this.command = {
      command: "flowMaster.viewFlow",
      title: "View Flow",
      arguments: [flow.id],
    };
    // Use a more specific context value if you have different types of items
    this.contextValue = "flow"; // Used in package.json for menu contributions
    this.iconPath = new vscode.ThemeIcon(
      flow.category === "Needs Review" ? "warning" : "symbol-method"
    );
  }
}
