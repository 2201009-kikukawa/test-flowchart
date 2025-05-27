import * as vscode from "vscode";
import * as path from "path";
import {
  Project,
  Node,
  FunctionDeclaration,
  MethodDeclaration,
  ArrowFunction,
  SourceFile,
  SyntaxKind, // SyntaxKind をインポート
  CallExpression,
  Identifier,
  PropertyAccessExpression,
  VariableDeclaration,
  PropertyAssignment,
  PropertyDeclaration,
  FunctionExpression,
} from "ts-morph";
import { FlowNode, FlowEdge, CodeReference } from "../types/flowTypes";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "./logger";

export class AstService {
  private project: Project;
  private visitedFunctions: Set<string>; // 循環参照防止用

  constructor() {
    this.project = new Project({
      // tsconfig.json を自動的に読み込む
    });
    this.visitedFunctions = new Set<string>();
  }

  private createCodeReference(node: Node): CodeReference {
    const sourceFile = node.getSourceFile();
    const startPos = node.getStart();
    const endPos = node.getEnd();
    const start = sourceFile.getLineAndColumnAtPos(startPos);
    const end = sourceFile.getLineAndColumnAtPos(endPos);
    let identifierName: string | undefined = undefined;

    // 様々なノードタイプから名前を抽出する試み
    if (Node.isIdentifier(node)) {
      identifierName = node.getText();
    } else if (
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isFunctionExpression(node)
    ) {
      identifierName = node.getName();
    } else if (Node.isArrowFunction(node)) {
      const parent = node.getParent();
      if (Node.isVariableDeclaration(parent)) {
        identifierName = parent.getName();
      } else if (Node.isPropertyAssignment(parent) || Node.isPropertyDeclaration(parent)) {
        identifierName = parent.getName();
      }
    }

    return {
      filePath: sourceFile.getFilePath(),
      range: {
        start: { line: start.line - 1, character: start.column - 1 }, // 0-indexed
        end: { line: end.line - 1, character: end.column - 1 },
      },
      identifier: identifierName,
    };
  }

  public async parseFunctionCalls(
    filePath: string,
    functionName?: string,
    startLine?: number,
    endLine?: number,
    isRecursiveCall: boolean = false,
    callerNodeId?: string // この関数を呼び出したノードのID（再帰呼び出し時）
  ): Promise<{
    nodes: FlowNode[];
    edges: FlowEdge[];
    entryNodeId: string | null;
    exitNodeId: string | null;
  }> {
    if (!isRecursiveCall) {
      this.visitedFunctions.clear(); // トップレベルの呼び出し時にリセット
    }

    const visitedKey = `${filePath}::${functionName || `range:${startLine}-${endLine}`}`;
    if (this.visitedFunctions.has(visitedKey)) {
      Logger.log(`AST Service: Skipping already visited function/range: ${visitedKey}`);
      // TODO: 既に訪問済みの関数のエントリーポイントIDを返す方法を検討
      return { nodes: [], edges: [], entryNodeId: null, exitNodeId: null };
    }
    this.visitedFunctions.add(visitedKey);

    Logger.log(
      `AST Service: Parsing ${filePath}, function: ${functionName}, range: ${startLine}-${endLine}${
        isRecursiveCall ? ", (Recursive)" : ""
      }`
    );
    const localNodes: FlowNode[] = [];
    const localEdges: FlowEdge[] = [];
    let sourceFile: SourceFile;

    try {
      const existingSourceFile = this.project.getSourceFile(filePath);
      if (existingSourceFile) {
        await existingSourceFile.refreshFromFileSystem();
        sourceFile = existingSourceFile;
      } else {
        sourceFile = this.project.addSourceFileAtPath(filePath);
        // 新規追加時は refreshFromFileSystem は不要、または addSourceFileAtPath の後で一度だけ
        await sourceFile.formatText(); //必要であれば
      }
    } catch (error) {
      Logger.error(`AST Service: Error adding or refreshing source file ${filePath}`, error);
      vscode.window.showErrorMessage(
        `Flow Master: Could not parse file ${filePath}. Ensure it's a valid TypeScript/JavaScript file.`
      );
      return { nodes: [], edges: [], entryNodeId: null, exitNodeId: null };
    }

    let currentScopeEntryNodeId: string | null = null;
    let currentScopeExitNodeId: string | null = null;
    let rootNodeToScan: Node | undefined = sourceFile;
    let entryPointType: FlowNode["type"] = isRecursiveCall ? "Function" : "EntryPoint";

    if (functionName) {
      const foundFunction = this.findFunctionByName(sourceFile, functionName, startLine);
      if (foundFunction) {
        rootNodeToScan = foundFunction;
        currentScopeEntryNodeId = uuidv4();
        currentScopeExitNodeId = uuidv4(); // 関数の出口ノード

        localNodes.push({
          id: currentScopeEntryNodeId,
          label: functionName,
          type: entryPointType,
          codeReference: this.createCodeReference(foundFunction),
          description: `${isRecursiveCall ? "Function" : "Entry"}: ${functionName}`,
        });
        localNodes.push({
          id: currentScopeExitNodeId,
          label: `Exit ${functionName}`,
          type: "ExitPoint",
          codeReference: this.createCodeReference(
            foundFunction.getLastChildByKind(SyntaxKind.CloseBraceToken) ||
              foundFunction.getLastToken() ||
              foundFunction
          ),
          description: `Exit of ${functionName}`,
        });
      } else {
        Logger.error(`AST Service: Function ${functionName} not found in ${filePath}.`);
        // 関数が見つからない場合、このスコープの解析は限定的になる
        if (callerNodeId) {
          // 再帰呼び出しで関数が見つからなかったが、呼び出し元がある場合
          // ダミーノードを作成して呼び出し元に接続するかもしれない
          currentScopeEntryNodeId = uuidv4();
          localNodes.push({
            id: currentScopeEntryNodeId,
            label: `Unresolved: ${functionName}`,
            type: "Note",
            description: `Function ${functionName} in ${filePath} not found during recursive call.`,
          });
          return {
            nodes: localNodes,
            edges: [],
            entryNodeId: currentScopeEntryNodeId,
            exitNodeId: currentScopeEntryNodeId,
          };
        }
        return { nodes: [], edges: [], entryNodeId: null, exitNodeId: null }; // トップレベルで関数が見つからない場合は空
      }
    } else if (startLine !== undefined && endLine !== undefined && !isRecursiveCall) {
      currentScopeEntryNodeId = uuidv4();
      currentScopeExitNodeId = uuidv4(); // 範囲の出口ノード
      localNodes.push({
        id: currentScopeEntryNodeId,
        label: `Code Block (Lines ${startLine}-${endLine})`,
        type: "EntryPoint",
        description: `Selected code block in ${path.basename(filePath)}`,
      });
      localNodes.push({
        id: currentScopeExitNodeId,
        label: `Exit Block (Lines ${startLine}-${endLine})`,
        type: "ExitPoint",
        description: `Exit of selected block in ${path.basename(filePath)}`,
      });
      // rootNodeToScan は sourceFile のまま、descendant の中で範囲チェックを行う
    } else if (!isRecursiveCall) {
      // ファイル全体をトップレベルで解析
      currentScopeEntryNodeId = uuidv4();
      currentScopeExitNodeId = uuidv4(); // ファイルの出口ノード
      localNodes.push({
        id: currentScopeEntryNodeId,
        label: path.basename(filePath),
        type: "EntryPoint",
        description: `Entry: File ${path.basename(filePath)}`,
        codeReference: this.createCodeReference(
          sourceFile.getFullText().length > 0
            ? sourceFile.getFirstChildByKind(SyntaxKind.SyntaxList) || sourceFile
            : sourceFile
        ),
      });
      localNodes.push({
        id: currentScopeExitNodeId,
        label: `Exit File ${path.basename(filePath)}`,
        type: "ExitPoint",
        description: `Exit of file ${path.basename(filePath)}`,
      });
    } else {
      // 再帰呼び出しで functionName がないのは通常予期しない
      Logger.error("AST Service: Recursive call without functionName.");
      return { nodes: [], edges: [], entryNodeId: null, exitNodeId: null };
    }

    if (!currentScopeEntryNodeId || !currentScopeExitNodeId) {
      Logger.error("AST Service: Could not determine entry/exit points for current parsing scope.");
      return {
        nodes: localNodes,
        edges: localEdges,
        entryNodeId: currentScopeEntryNodeId,
        exitNodeId: currentScopeExitNodeId,
      };
    }

    let lastProcessedNodeIdInCurrentScope = currentScopeEntryNodeId;
    const descendantParsePromises: Promise<void>[] = [];

    rootNodeToScan.forEachDescendant((node, traversal) => {
      if (startLine !== undefined && endLine !== undefined) {
        const nodeStartLine = node.getStartLineNumber();
        const nodeEndLine = node.getEndLineNumber();
        if (nodeStartLine < startLine || nodeEndLine > endLine) {
          if (nodeEndLine < startLine || nodeStartLine > endLine) {
            traversal.skip();
          }
          return;
        }
      }

      if (Node.isCallExpression(node)) {
        const callExpr = node as CallExpression;
        const callee = callExpr.getExpression();
        let callName = callee.getText();

        if (Node.isIdentifier(callee)) {
          callName = callee.getText();
        } else if (Node.isPropertyAccessExpression(callee)) {
          callName = `${callee.getExpression().getText()}.${callee.getName()}`;
        }

        const callSiteNodeId = uuidv4();
        const callSiteNode: FlowNode = {
          id: callSiteNodeId,
          label: `Call: ${callName}`,
          type: "Function", // このノードは呼び出し操作自体を表す
          codeReference: this.createCodeReference(callExpr),
          description: `Invocation of ${callName}`,
        };
        localNodes.push(callSiteNode);

        if (lastProcessedNodeIdInCurrentScope) {
          localEdges.push({
            id: uuidv4(),
            from: lastProcessedNodeIdInCurrentScope,
            to: callSiteNodeId,
            type: "DirectCall",
          });
        }

        const symbol = callee.getSymbol();
        if (symbol) {
          const declarations = symbol.getDeclarations();
          if (declarations.length > 0) {
            const declaration = declarations[0]; // 最初の定義を利用
            if (
              Node.isFunctionDeclaration(declaration) ||
              Node.isMethodDeclaration(declaration) ||
              Node.isArrowFunction(declaration) ||
              Node.isFunctionExpression(declaration)
            ) {
              const targetSourceFile = declaration.getSourceFile();
              const targetFilePath = targetSourceFile.getFilePath();

              if (!targetFilePath.includes("node_modules")) {
                let targetFunctionName: string | undefined;
                if (
                  Node.isFunctionDeclaration(declaration) ||
                  Node.isMethodDeclaration(declaration) ||
                  Node.isFunctionExpression(declaration)
                ) {
                  targetFunctionName = declaration.getName();
                } else if (Node.isArrowFunction(declaration)) {
                  const parentVar = declaration.getParentIfKind(SyntaxKind.VariableDeclaration);
                  if (parentVar) targetFunctionName = parentVar.getName();
                  else {
                    const parentProp =
                      declaration.getParentIfKind(SyntaxKind.PropertyAssignment) ||
                      declaration.getParentIfKind(SyntaxKind.PropertyDeclaration);
                    if (parentProp) targetFunctionName = parentProp.getName();
                  }
                }
                if (!targetFunctionName)
                  targetFunctionName = `anonymous_func_at_L${declaration.getStartLineNumber()}`;

                // 再帰解析のPromiseを作成
                const promise = this.parseFunctionCalls(
                  targetFilePath,
                  targetFunctionName,
                  declaration.getStartLineNumber(), // 対象関数の開始行
                  undefined, // endLine
                  true, // isRecursiveCall
                  callSiteNodeId // callerNodeId
                ).then((recursiveResult) => {
                  if (recursiveResult.nodes.length > 0 && recursiveResult.entryNodeId) {
                    localNodes.push(...recursiveResult.nodes);
                    localEdges.push(...recursiveResult.edges);
                    // 呼び出し元(callSiteNode)から呼び出し先関数のエントリーポイントへエッジを張る
                    localEdges.push({
                      id: uuidv4(),
                      from: callSiteNodeId,
                      to: recursiveResult.entryNodeId,
                      type: "DirectCall",
                    });
                    // 再帰解析の出口ノードがある場合、呼び出し元から出口ノードへエッジを張る
                    if (recursiveResult.exitNodeId) {
                      const hasOutgoingEdgeFromExit = localEdges.some(
                        (edge) => edge.from === recursiveResult.exitNodeId
                      );
                      if (!hasOutgoingEdgeFromExit) {
                        localEdges.push({
                          id: uuidv4(),
                          from: recursiveResult.exitNodeId,
                          to: lastProcessedNodeIdInCurrentScope,
                          type: "DirectCall",
                        });
                      }
                    }
                  }
                });
                descendantParsePromises.push(promise);
                lastProcessedNodeIdInCurrentScope = callSiteNodeId; // 次の兄弟ノードは、この呼び出しサイトから接続される
                traversal.skip(); // 呼び出し先の内部は再帰で解析するので、このノードの子孫はスキップ
                return;
              }
            }
          }
        }
        // 再帰解析が行われなかった場合 (外部ライブラリ等)
        lastProcessedNodeIdInCurrentScope = callSiteNodeId;
      }
      // 他の制御構文（IfStatementなど）のハンドリングを追加する場合はここに記述
    });

    await Promise.all(descendantParsePromises);

    // 現在のスコープの最後の処理ノードから、スコープの出口ノードへエッジを張る
    // (ただし、それがまだ接続されていない場合)
    const hasOutgoingEdgeFromLast = localEdges.some(
      (edge) => edge.from === lastProcessedNodeIdInCurrentScope
    );
    if (
      lastProcessedNodeIdInCurrentScope &&
      lastProcessedNodeIdInCurrentScope !== currentScopeExitNodeId &&
      !hasOutgoingEdgeFromLast
    ) {
      localEdges.push({
        id: uuidv4(),
        from: lastProcessedNodeIdInCurrentScope,
        to: currentScopeExitNodeId,
        type: "DirectCall",
      });
    } else if (
      lastProcessedNodeIdInCurrentScope === currentScopeEntryNodeId &&
      currentScopeEntryNodeId !== currentScopeExitNodeId &&
      localNodes.length <= 2
    ) {
      // エントリーポイントと出口しかない場合（例：空の関数）
      localEdges.push({
        id: uuidv4(),
        from: currentScopeEntryNodeId,
        to: currentScopeExitNodeId,
        type: "DirectCall",
      });
    }

    Logger.log(
      `AST Service: Parsing complete for ${visitedKey}. Nodes: ${localNodes.length}, Edges: ${localEdges.length}`
    );
    return {
      nodes: localNodes,
      edges: localEdges,
      entryNodeId: currentScopeEntryNodeId,
      exitNodeId: currentScopeExitNodeId,
    };
  }

  private findFunctionByName(
    sourceFile: SourceFile,
    functionName: string,
    targetLine?: number
  ): FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression | undefined {
    // FunctionExpression も追加
    let foundFunc:
      | FunctionDeclaration
      | MethodDeclaration
      | ArrowFunction
      | FunctionExpression
      | undefined;

    // FunctionDeclarations
    foundFunc = sourceFile
      .getFunctions()
      .find(
        (f) =>
          f.getName() === functionName &&
          (targetLine === undefined || this.isNodeAroundLine(f, targetLine))
      );
    if (foundFunc) return foundFunc;

    // Class Methods and Arrow Function Properties
    sourceFile.getClasses().forEach((c) => {
      if (foundFunc) return;
      foundFunc = c
        .getMethods()
        .find(
          (m) =>
            m.getName() === functionName &&
            (targetLine === undefined || this.isNodeAroundLine(m, targetLine))
        );
      if (foundFunc) return;
      c.getProperties().forEach((p) => {
        if (foundFunc) return;
        const initializer = p.getInitializer();
        if (
          initializer &&
          Node.isArrowFunction(initializer) &&
          p.getName() === functionName &&
          (targetLine === undefined || this.isNodeAroundLine(p, targetLine))
        ) {
          foundFunc = initializer;
        }
      });
    });
    if (foundFunc) return foundFunc;

    // Top-level Variable Declarations (Arrow Functions and Function Expressions)
    sourceFile.getVariableDeclarations().forEach((vd) => {
      if (foundFunc) return;
      const initializer = vd.getInitializer();
      if (vd.getName() === functionName) {
        if (
          initializer &&
          (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) &&
          (targetLine === undefined || this.isNodeAroundLine(vd, targetLine))
        ) {
          foundFunc = initializer as ArrowFunction | FunctionExpression; // キャスト
        }
      }
    });
    return foundFunc;
  }

  private isNodeAroundLine(node: Node, targetLine: number): boolean {
    const startLine = node.getStartLineNumber();
    const endLine = node.getEndLineNumber();
    // targetLine は 1-indexed なので、そのまま比較
    return targetLine >= startLine && targetLine <= endLine;
  }

  public async getFunctionNameAtCursor(
    filePath: string,
    position: vscode.Position
  ): Promise<string | undefined> {
    let sourceFile = this.project.getSourceFile(filePath);
    if (!sourceFile) {
      sourceFile = this.project.addSourceFileAtPath(filePath);
    }
    await sourceFile.refreshFromFileSystem();

    // ts-morphのPositionは0-indexedなので、VSCodeのline (0-indexed) はそのまま、character (0-indexed) もそのまま
    const posInFile = sourceFile.compilerNode.getPositionOfLineAndCharacter(
      position.line, // VSCode の line は 0-indexed
      position.character // VSCode の character は 0-indexed
    );

    let containingFunction: Node | undefined;
    // Note: getDescendantAtPos might be more efficient if we only need the immediate node at cursor
    // However, to find the "containing function", iterating and checking type is more robust.
    sourceFile.forEachDescendant((node) => {
      if (node.getStart() <= posInFile && posInFile < node.getEnd()) {
        if (
          Node.isFunctionDeclaration(node) ||
          Node.isMethodDeclaration(node) ||
          Node.isArrowFunction(node) ||
          Node.isFunctionExpression(node)
        ) {
          if (
            !containingFunction ||
            (node.getStart() >= containingFunction.getStart() &&
              node.getEnd() <= containingFunction.getEnd())
          ) {
            containingFunction = node;
          }
        }
      }
    });

    if (containingFunction) {
      if (
        Node.isFunctionDeclaration(containingFunction) ||
        Node.isMethodDeclaration(containingFunction)
      ) {
        return containingFunction.getName();
      } else if (
        Node.isArrowFunction(containingFunction) ||
        Node.isFunctionExpression(containingFunction)
      ) {
        const parent = containingFunction.getParent();
        if (Node.isVariableDeclaration(parent)) {
          return parent.getName();
        }
        if (Node.isPropertyAssignment(parent) || Node.isPropertyDeclaration(parent)) {
          return parent.getName();
        }
        // FunctionExpression の場合、自身の name プロパティも確認
        if (Node.isFunctionExpression(containingFunction) && containingFunction.getName()) {
          return containingFunction.getName();
        }
      }
    }
    return undefined;
  }
}
