import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// PowerShell AST Node interface
interface AstProperty {
    Name: string;
    Value: string;
    TypeName: string;
}

interface FlatAstNode {
    id: string;
    hashCode: number;
    parentHashCode: number | null;
    type: string;
    text: string;
    extentString: string;
    StartLineNumber: number;
    StartColumnNumber: number;
    EndLineNumber: number;
    EndColumnNumber: number;
    textLength: number;
    properties: AstProperty[];
}

interface PowerShellAstNode {
    type: string;
    text: string;
    extentString: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    textLength: number;
    children?: PowerShellAstNode[];
    properties?: AstProperty[];
    id: string; // Unique identifier for each node
    hashCode: number; // PowerShell object hash code
    parentHashCode: number | null; // Parent's hash code for tree building
}

// Documentation types loaded from AstDoc.json
interface AstDocProperty {
    Name: string;
    TypeName: string;
    EnumValues?: string[] | string; // some entries may have "" or array
    Summary?: string;
}

interface AstDocEntry {
    Name: string; // e.g., ScriptBlockAst
    Summary?: string;
    Properties?: AstDocProperty[];
}

class DocStore {
    private static _instance: DocStore;
    private _byType: Map<string, AstDocEntry> = new Map();

    static instance(): DocStore {
        if (!DocStore._instance) {
            DocStore._instance = new DocStore();
        }
        return DocStore._instance;
    }

    loadFromFileSync(jsonPath: string): void {
        try {
            if (!fs.existsSync(jsonPath)) {
                console.warn(`AstDoc.json not found at ${jsonPath}`);
                return;
            }
            const text = fs.readFileSync(jsonPath, 'utf8');
            const data = JSON.parse(text) as AstDocEntry[];
            this._byType.clear();
            for (const entry of data) {
                if (entry && entry.Name) {
                    this._byType.set(entry.Name, entry);
                }
            }
            console.log(`Loaded AST docs: ${this._byType.size} types`);
        } catch (err) {
            console.error('Failed to load AstDoc.json:', err);
        }
    }

    getTypeSummary(typeName: string): string | undefined {
        return this._byType.get(typeName)?.Summary;
    }

    getDisplayTypeName(typeName: string): string | undefined {
        // In AstDoc, the type name key is the display name to show
        if (this._byType.has(typeName)) {
            return this._byType.get(typeName)!.Name;
        }
        return undefined;
    }

    getPropertySummary(typeName: string, propName: string): string | undefined {
        const props = this._byType.get(typeName)?.Properties || [];
        const found = props.find(p => p.Name === propName);
        return found?.Summary;
    }
    
    getPropertyTypeName(typeName: string, propName: string): string | undefined {
        const props = this._byType.get(typeName)?.Properties || [];
        const found = props.find(p => p.Name === propName);
        const t = found?.TypeName;
        if (typeof t === 'string' && t.length > 0) {
            return t;
        }
        return undefined;
    }
}

// Global state manager
class AstState {
    private static instance: AstState;
    private _currentNode: PowerShellAstNode | null = null;
    private _astData: PowerShellAstNode[] = [];
    private _currentFilePath: string | null = null;
    private _isAnalyzing: boolean = false;
    private _onDidChangeSelection = new vscode.EventEmitter<PowerShellAstNode | null>();
    private _onDidChangeAnalyzing = new vscode.EventEmitter<boolean>();
    private _nodeMap: Map<number, PowerShellAstNode> = new Map();

    static getInstance(): AstState {
        if (!AstState.instance) {
            AstState.instance = new AstState();
        }
        return AstState.instance;
    }

    get onDidChangeSelection() {
        return this._onDidChangeSelection.event;
    }

    get onDidChangeAnalyzing() {
        return this._onDidChangeAnalyzing.event;
    }

    get currentNode() {
        return this._currentNode;
    }

    get astData() {
        return this._astData;
    }

    get currentFilePath() {
        return this._currentFilePath;
    }

    get currentFileName() {
        return this._currentFilePath ? path.basename(this._currentFilePath) : null;
    }

    get isAnalyzing() {
        return this._isAnalyzing;
    }

    get nodeMap() {
        return this._nodeMap;
    }

    setSelection(node: PowerShellAstNode | null) {
        this._currentNode = node;
        this._onDidChangeSelection.fire(node);
    }

    setAnalyzing(analyzing: boolean) {
        this._isAnalyzing = analyzing;
        this._onDidChangeAnalyzing.fire(analyzing);
        // Update VS Code context for button enablement
        vscode.commands.executeCommand('setContext', 'powershellAst.isAnalyzing', analyzing);
    }

    setAstData(data: PowerShellAstNode[], filePath?: string) {
        this._astData = data;
        this._currentFilePath = filePath || null;

        // Build nodeMap for O(1) parent lookup
        this._nodeMap = new Map();
        const collectNodes = (nodes: PowerShellAstNode[]) => {
            for (const node of nodes) {
                this._nodeMap.set(node.hashCode, node);
                if (node.children && node.children.length > 0) {
                    collectNodes(node.children);
                }
            }
        };
        collectNodes(data);

        // Update context for UI button visibility
        const hasData = data.length > 0;
        vscode.commands.executeCommand('setContext', 'powershellAst.hasAstData', hasData);

        // Select root node by default
        if (data.length > 0) {
            this.setSelection(data[0]);
        } else {
            this.setSelection(null);
        }
    }

    clear() {
        this._astData = [];
        this._currentFilePath = null;
        this._nodeMap = new Map();
        this.setSelection(null);

        // Update context for UI button visibility
        vscode.commands.executeCommand('setContext', 'powershellAst.hasAstData', false);
    }
}

// Tree data provider for AST visualization
class AstTreeDataProvider implements vscode.TreeDataProvider<PowerShellAstNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<PowerShellAstNode | undefined | null | void> = new vscode.EventEmitter<PowerShellAstNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<PowerShellAstNode | undefined | null | void> = this._onDidChangeTreeData.event;

    private astState = AstState.getInstance();

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PowerShellAstNode): vscode.TreeItem {
        const collapsibleState = element.children && element.children.length > 0 ? 
            vscode.TreeItemCollapsibleState.Collapsed : 
            vscode.TreeItemCollapsibleState.None;
        
        const item = new vscode.TreeItem(element.type, collapsibleState);
        
        // Truncate text for display
        const displayText = `${element.startLine},${element.startColumn} - ${element.endLine},${element.endColumn}`;
        item.description = displayText;
        item.tooltip = `Type: ${element.type}\nText: ${element.text}\nLocation: ${element.extentString}`;
        
        // Add context value for menu items
        item.contextValue = 'astNode';
        
        // Store the node ID for selection tracking
        item.id = element.id;
        
        // Add custom icons based on AST node type
        switch (element.type) {
            case 'FunctionDefinitionAst':
                item.iconPath = new vscode.ThemeIcon('symbol-function');
                break;
            case 'VariableExpressionAst':
                item.iconPath = new vscode.ThemeIcon('symbol-variable');
                break;
            case 'CommandAst':
                item.iconPath = new vscode.ThemeIcon('terminal');
                break;
            case 'ParameterAst':
                item.iconPath = new vscode.ThemeIcon('symbol-parameter');
                break;
            case 'StringConstantExpressionAst':
                item.iconPath = new vscode.ThemeIcon('symbol-string');
                break;
            case 'ScriptBlockAst':
                item.iconPath = new vscode.ThemeIcon('code');
                break;
            case 'IfStatementAst':
                item.iconPath = new vscode.ThemeIcon('symbol-boolean');
                break;
            case 'ForStatementAst':
            case 'ForEachStatementAst':
            case 'WhileStatementAst':
                item.iconPath = new vscode.ThemeIcon('sync');
                break;
            case 'TryStatementAst':
            case 'CatchClauseAst':
                item.iconPath = new vscode.ThemeIcon('warning');
                break;
            case 'PipelineAst':
                item.iconPath = new vscode.ThemeIcon('arrow-right');
                break;
            default:
                item.iconPath = new vscode.ThemeIcon('symbol-misc');
                break;
        }
        
        // Add command to handle selection-only behavior (no expand/collapse)
        item.command = {
            command: 'showast.selectItem',
            title: 'Select Item',
            arguments: [element]
        };
        
        return item;
    }

    getChildren(element?: PowerShellAstNode): Thenable<PowerShellAstNode[]> {
        if (!element) {
            return Promise.resolve(this.astState.astData);
        }
        return Promise.resolve(element.children || []);
    }

    getParent(element: PowerShellAstNode): vscode.ProviderResult<PowerShellAstNode> {
        // If the element has no parent hash code, it's a root node
        if (element.parentHashCode === null) {
            return null;
        }
        // Use the nodeMap for O(1) parent lookup
        return this.astState.nodeMap.get(element.parentHashCode) || null;
    }
}

// Properties data provider for webview
class AstPropertiesProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private astState = AstState.getInstance();
    private docs = DocStore.instance();

    constructor(private readonly extensionUri: vscode.Uri) {
        // Listen for selection changes
        this.astState.onDidChangeSelection((node) => {
            this.updateProperties(node);
        });
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        this.updateProperties(this.astState.currentNode);
    }

    private updateProperties(node: PowerShellAstNode | null) {
        if (!this._view) return;

        if (!node) {
            this._view.webview.html = this.getEmptyHtml();
            return;
        }

        this._view.webview.html = this.getPropertiesHtml(node);
    }

    private getEmptyHtml(): string {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { 
                    font-family: var(--vscode-font-family); 
                    padding: 20px; 
                    color: var(--vscode-foreground);
                }
                .empty { 
                    text-align: center; 
                    color: var(--vscode-descriptionForeground);
                    margin-top: 50px;
                }
            </style>
        </head>
        <body>
            <div class="empty">
                <p>Select an AST node to view its properties</p>
            </div>
        </body>
        </html>`;
    }

    private getPropertiesHtml(node: PowerShellAstNode): string {
        // Main node information
        const displayType = this.docs.getDisplayTypeName(node.type) || node.type;
        const mainProperties = [
            { name: 'Type', value: displayType, typeName: 'System.String' },
            { name: 'Text', value: node.text || '(empty)', typeName: 'System.String' },
            { name: 'Extent', value: node.extentString || `Ln ${node.startLine}, Col ${node.startColumn} -> Ln ${node.endLine}, Col ${node.endColumn}`,typeName: 'InternalScriptExtent' }
        ];

        const nodeSummary = this.docs.getTypeSummary(node.type);

        // AST properties from the properties array
        let allRowsHtml = mainProperties.map(prop => `
            <div class="property">
                <div class="property-name">
                    ${this.escapeHtml(prop.name)}
                </div>
                ${prop.name === 'Type' && nodeSummary ? `<div class="property-help">${this.escapeHtml(nodeSummary)}</div>` : ''}
                <div class="property-value">
                    ${this.escapeHtml(prop.value || '(null)')}
                </div>
                <div class="property-type">
                    ${this.escapeHtml(prop.typeName)}
                </div>
            </div>
        `).join('');

        if (node.properties && node.properties.length > 0) {
            allRowsHtml += node.properties.map(prop => `

                <div class="property">
                    <div class="property-name">
                        ${this.escapeHtml(prop.Name)}
                    </div>
                    ${(() => { const h = this.docs.getPropertySummary(node.type, prop.Name); return h ? `<div class="property-help">${this.escapeHtml(h)}</div>` : ''; })()}
                    <div class="property-value">
                        ${this.escapeHtml(prop.Value || '(null)')}
                    </div>
                    <div class="property-type">
                        ${this.escapeHtml(this.docs.getPropertyTypeName(node.type, prop.Name) || prop.TypeName)}
                    </div>
                </div>
            `).join('');
        }

        return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { 
                    font-family: var(--vscode-font-family); 
                    padding: 0px 10px;
                    color: var(--vscode-foreground);
                    font-size: var(--vscode-font-size);
                }

                .property {
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding: 16px 16px;
                }

                .property-name { 
                    font-weight: bold; 
                    color: var(--vscode-symbolIcon-fieldForeground);
                }

                .property-value { 
                    font-family: var(--vscode-editor-font-family);
                    color: var(--vscode-editor-foreground);
                    word-break: break-word;
                    white-space: normal;
                    padding-top: 8px;
                    padding-bottom: 8px;
                }

                .property-help {
                    color: var(--vscode-descriptionForeground);
                    font-size: 0.9em;
                    margin-top: 6px;
                    margin-bottom: 6px;
                    word-break: break-word;
                    white-space: normal;
                }

                .property-type {
                    display: inline-block;
                    font-size: 0.7em;
                    font-style: normal;
                    font-family: var(--vscode-editor-font-family);
                    background: var(--vscode-editor-foreground);
                    color: var(--vscode-editor-background);
                    border-radius: 8px;
                    padding: 4px 8px;
                    word-break: break-word;
                    white-space: normal;
                }
            </style>
        </head>
        <body>
            <div class="container">
                ${allRowsHtml}
            </div>

            <script>
                // Force scroll to top on every update
                setTimeout(function() {
                    window.scrollTo(0, 0);
                    document.body.scrollTop = 0;
                    document.documentElement.scrollTop = 0;
                }, 0);
            </script>
        </body>
        </html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}

// PowerShell AST analyzer
class PowerShellAstAnalyzer {
    
    static async analyzeFile(filePath: string): Promise<PowerShellAstNode[]> {
        try {
            // Read the PowerShell file
            const content = fs.readFileSync(filePath, 'utf8');
            return await this.analyzeContent(content);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to analyze PowerShell AST: ${error}`);
            return [];
        }
    }

    static async analyzeContent(content: string): Promise<PowerShellAstNode[]> {
        const startTime = performance.now();

        try {
            // Use the external AstParse.ps1 script with -Content parameter
            const path = require('path');
            const astParseScript = path.join(__dirname, 'AstParse.ps1');
            
            // Escape the content for PowerShell - replace single quotes with double single quotes
            const escapedContent = content.replace(/'/g, "''");

            const powershellScript = `& "${astParseScript}" -Content '${escapedContent}'`;

            // Execute PowerShell script
            const result = await this.executePowerShell(powershellScript);
            if (result.trim()) {
                try {
                    const parseStart = performance.now();
                    const astData = JSON.parse(result);

                    // Check if we got an error response
                    if (astData.error) {
                        throw new Error(`PowerShell parsing error: ${astData.message}`);
                    }
                    
                    // Map the flat data structure from PowerShell to tree structure
                    const mapStart = performance.now();
                    const mappedData = this.buildTreeFromFlatData(astData);
                    
                    return mappedData;
                } catch (parseError) {
                    throw new Error(`JSON parsing failed: ${parseError}. Raw output: ${result.substring(0, 200)}...`);
                }
            } else {
                throw new Error('No output returned from PowerShell script');
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to analyze PowerShell AST: ${error}`);
            return [];
        }
    }

    private static buildTreeFromFlatData(flatData: FlatAstNode[]): PowerShellAstNode[] {
        if (!Array.isArray(flatData) || flatData.length === 0) {
            return [];
        }

        // Create a map to quickly find nodes by hash code
        const nodeMap = new Map<number, PowerShellAstNode>();
        
        // First pass: convert flat nodes to tree nodes and build hash map
        for (const flatNode of flatData) {
            const treeNode: PowerShellAstNode = {
                id: flatNode.id,
                hashCode: flatNode.hashCode,
                parentHashCode: flatNode.parentHashCode,
                type: flatNode.type,
                text: flatNode.text,
                extentString: flatNode.extentString,
                startLine: flatNode.StartLineNumber,
                startColumn: flatNode.StartColumnNumber,
                endLine: flatNode.EndLineNumber,
                endColumn: flatNode.EndColumnNumber,
                textLength: flatNode.textLength,
                children: [],
                properties: flatNode.properties || []
            };
            nodeMap.set(flatNode.hashCode, treeNode);
        }

        // Second pass: build parent-child relationships
        const rootNodes: PowerShellAstNode[] = [];
        
        for (const [hashCode, node] of nodeMap) {
            if (node.parentHashCode === null) {
                // Root node
                rootNodes.push(node);
            } else {
                // Find parent and add this node as a child
                const parent = nodeMap.get(node.parentHashCode);
                if (parent) {
                    if (!parent.children) {
                        parent.children = [];
                    }
                    parent.children.push(node);
                }
            }
        }

        return rootNodes;
    }

    private static async executePowerShell(script: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const { spawn } = require('child_process');
            

            const config = vscode.workspace.getConfiguration('powershellAst');
            let flavor = config.get<string>('powershellFlavor', 'core');
            const isWindows = os.platform() === 'win32';

            // Force 'core' on non-Windows
            if (!isWindows) {
                flavor = 'core';
            }

            if (!isWindows && flavor === 'desktop') {
                vscode.window.showWarningMessage("PowerShell Desktop is only available on Windows. Using PowerShell Core instead.");
            }

            const exe = (flavor === 'desktop') ? 'powershell.exe' : (isWindows ? 'pwsh.exe' : 'pwsh');

            const ps = spawn(exe, [
                '-NoProfile', 
                '-NoLogo', 
                '-NonInteractive', 
                '-OutputFormat', 'Text',
                '-Command', script
            ], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            ps.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            ps.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            ps.on('close', (code: number) => {
                if (code === 0) {
                    // Clean the output by removing any ANSI escape sequences and extra whitespace
                    const cleanOutput = stdout
                        .replace(/\x1b\[[0-9;]*m/g, '') // Remove ANSI color codes
                        .replace(/\r\n/g, '\n')         // Normalize line endings
                        .trim();                        // Remove leading/trailing whitespace
                    resolve(cleanOutput);
                } else {
                    reject(new Error(`PowerShell execution failed (exit code ${code}). STDERR: ${stderr}. STDOUT: ${stdout}`));
                }
            });

            ps.on('error', (error: Error) => {
                console.error('PowerShell process error:', error);
                reject(error);
            });
        });
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('PowerShell AST Analyzer extension is starting...');
    
    try {
        const astState = AstState.getInstance();
    // Load AST documentation (generated JSON) once on activation
    const docsPath = path.join(__dirname, 'AstDoc.json');
    DocStore.instance().loadFromFileSync(docsPath);

        // Initialize context states
        vscode.commands.executeCommand('setContext', 'powershellAst.isAnalyzing', false);
        vscode.commands.executeCommand('setContext', 'powershellAst.hasAstData', false);

        // Create properties provider FIRST
        const propertiesProvider = new AstPropertiesProvider(context.extensionUri);
        
        // Register properties view EARLY
        const propertiesViewProvider = vscode.window.registerWebviewViewProvider(
            'powershellAstPropertiesView', 
            propertiesProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        );

        // Create AST tree data provider
        const astProvider = new AstTreeDataProvider();
        
        // Register tree view
        const treeView = vscode.window.createTreeView('powershellAstTreeView', {
            treeDataProvider: astProvider,
            showCollapseAll: true  // Native VS Code feature, auto-hidden when no expandable items
        });

        // Handle tree view selection changes
        treeView.onDidChangeSelection((e) => {
            if (e.selection.length > 0) {
                astState.setSelection(e.selection[0]);
            }
        });

        // Function to check if a document is PowerShell
        const isPowerShellDocument = (document: vscode.TextDocument): boolean => {
            return document.languageId === 'powershell' || 
                   document.fileName.endsWith('.ps1') || 
                   document.fileName.endsWith('.psm1') || 
                   document.fileName.endsWith('.psd1');
        };

        // Function to analyze current editor (including unsaved files)
        const analyzeCurrentEditor = async () => {
            // Prevent multiple concurrent analyses
            if (astState.isAnalyzing) {
                vscode.window.showInformationMessage('Analysis already in progress...');
                return;
            }

            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                vscode.window.showErrorMessage('No active editor found');
                return;
            }

            const document = activeEditor.document;
            
            // Check if it's a PowerShell document
            if (!isPowerShellDocument(document)) {
                vscode.window.showErrorMessage('Active editor is not a PowerShell file');
                return;
            }

            // Get the display name for the file
            const displayName = document.isUntitled ? 
                `Untitled-${document.uri.path}` : 
                path.basename(document.fileName);
            
            const fileIdentifier = document.isUntitled ? 
                document.uri.toString() : 
                document.fileName;

            try {
                // Set analyzing state to disable buttons
                astState.setAnalyzing(true);
                
                // Use VS Code's progress indicator in the tree view
                await vscode.window.withProgress({
                    location: { viewId: 'powershellAstTreeView' },
                    title: `Analyzing ${displayName}`,
                    cancellable: false
                }, async (progress) => {
                    // Get current content from the editor (even if unsaved)
                    const content = document.getText();
                    const astData = await PowerShellAstAnalyzer.analyzeContent(content);
                    
                    astState.setAstData(astData, fileIdentifier);
                    astProvider.refresh();
                    
                    // Update tree view title
                    treeView.title = `AST: ${displayName}${document.isDirty ? ' (unsaved)' : ''}`;
                });
                
            } catch (error) {
                console.error('Failed to analyze AST:', error);
                vscode.window.showErrorMessage(`Analysis failed: ${error}`);
            } finally {
                // Always clear analyzing state to re-enable buttons
                astState.setAnalyzing(false);
            }
        };

        // Smart content analysis command that chooses the best method based on context
        const analyzeContentCommand = vscode.commands.registerCommand('powershellAst.analyzeContent', async (uri?: vscode.Uri) => {
            // // If called with a URI (from explorer context menu), analyze the file
            // if (uri) {
            //     const filePath = uri.fsPath;
            //     vscode.window.showInformationMessage(`Analyzing PowerShell file: ${filePath}`);
            //     // Check if it's a PowerShell file
            //     if (!filePath.endsWith('.ps1') && !filePath.endsWith('.psm1') && !filePath.endsWith('.psd1')) {
            //         vscode.window.showErrorMessage('Please select a PowerShell file (.ps1, .psm1, or .psd1)');
            //         return;
            //     }
                
            //     await analyzeCurrentFile(filePath);
            //     return;
            // }
            
            // Otherwise, analyze the current active editor (works with unsaved files)
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                vscode.window.showErrorMessage('No active PowerShell editor found');
                return;
            }
            
            // Check if it's a PowerShell document
            if (!isPowerShellDocument(activeEditor.document)) {
                vscode.window.showErrorMessage('Active editor is not a PowerShell file');
                return;
            }
            
            // Use editor analysis (works for both saved and unsaved files)
            await analyzeCurrentEditor();
        });

        // Command to analyze the currently active editor
        const refreshCommand = vscode.commands.registerCommand('powershellAst.refresh', async () => {
            await analyzeCurrentEditor();
        });

        // Command to clear the AST data and reset to welcome screen
        const clearCommand = vscode.commands.registerCommand('powershellAst.clear', async () => {
            // Clear the AST state
            astState.clear();
            
            // Refresh the tree view to show welcome screen
            astProvider.refresh();
            
            // Reset tree view title
            treeView.title = 'AST Structure';
        });

        // Command to expand all nodes in the tree
        const expandAllCommand = vscode.commands.registerCommand('powershellAst.expandAll', async () => {
            try {
                // Get all nodes in a flat array, organized by depth level
                const collectNodesByLevel = (nodes: PowerShellAstNode[], level: number = 0): Map<number, PowerShellAstNode[]> => {
                    const nodesByLevel = new Map<number, PowerShellAstNode[]>();
                    
                    for (const node of nodes) {
                        // Add current node to its level
                        if (!nodesByLevel.has(level)) {
                            nodesByLevel.set(level, []);
                        }
                        nodesByLevel.get(level)!.push(node);
                        
                        // Recursively collect children at deeper levels
                        if (node.children && node.children.length > 0) {
                            const childLevels = collectNodesByLevel(node.children, level + 1);
                            childLevels.forEach((childNodes, childLevel) => {
                                if (!nodesByLevel.has(childLevel)) {
                                    nodesByLevel.set(childLevel, []);
                                }
                                nodesByLevel.get(childLevel)!.push(...childNodes);
                            });
                        }
                    }
                    
                    return nodesByLevel;
                };

                const nodesByLevel = collectNodesByLevel(astState.astData);
                const maxLevel = Math.max(...Array.from(nodesByLevel.keys()));
                
                // Expand nodes level by level, starting from the root
                for (let level = 0; level <= maxLevel; level++) {
                    const nodesAtLevel = nodesByLevel.get(level) || [];
                    
                    for (const node of nodesAtLevel) {
                        if (node.children && node.children.length > 0) {
                            try {
                                await treeView.reveal(node, { expand: 1 }); // Expand only one level at a time
                                await new Promise(resolve => setTimeout(resolve, 10)); // Small delay between expansions
                            } catch (error) {
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('Expand all failed:', error);
                vscode.window.showErrorMessage('Failed to expand all nodes');
            }
        });

        // Command to handle selection-only behavior (without expand/collapsing)
        const selectItemCommand = vscode.commands.registerCommand('showast.selectItem', async (node: PowerShellAstNode) => {
            // Just set the selection without expanding/collapsing
            astState.setSelection(node);
        });

        // Command to highlight node in editor
        const highlightInEditorCommand = vscode.commands.registerCommand('powershellAst.highlightInEditor', async (node: PowerShellAstNode) => {
            const activeEditor = vscode.window.activeTextEditor;
            
            // Check if we have an active editor
            if (!activeEditor) {
                vscode.window.showWarningMessage('No active editor found');
                return;
            }
            
            // Check if the active editor matches the analyzed file
            const currentFilePath = astState.currentFilePath;
            const activeFilePath = activeEditor.document.isUntitled ? 
                activeEditor.document.uri.toString() : 
                activeEditor.document.fileName;
            
            if (currentFilePath !== activeFilePath) {
                vscode.window.showWarningMessage('Active editor does not match analyzed file');
                return;
            }
            
            // Create range and highlight
            const range = new vscode.Range(
                new vscode.Position(node.startLine - 1, node.startColumn - 1),
                new vscode.Position(node.endLine - 1, node.endColumn - 1)
            );
            
            // Set selection and reveal
            activeEditor.selection = new vscode.Selection(range.start, range.end);
            activeEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            
            // Add temporary highlighting decoration using theme-aware colors
            const decorationType = vscode.window.createTextEditorDecorationType({
                backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),//'editor.findMatchHighlightBackground'),
                // Alternative theme colors you could use:
                // backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
                // backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
            });
            
            activeEditor.setDecorations(decorationType, [range]);
            
            // Clear decoration after 2 seconds
            setTimeout(() => {
                decorationType.dispose();
            }, 2000);
        });
        
        // Command to reveal AST node for the current selection
        const revealNodeForSelectionCommand = vscode.commands.registerCommand('powershellAst.revealNodeForSelection', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                vscode.window.showWarningMessage('No active editor found');
                return;
            }
            const astState = AstState.getInstance();
            const currentFilePath = astState.currentFilePath;
            const activeFilePath = activeEditor.document.isUntitled ? 
                activeEditor.document.uri.toString() : 
                activeEditor.document.fileName;
            if (currentFilePath !== activeFilePath) {
                vscode.window.showWarningMessage('The active editor does not match the file the AST was generated for.');
                return;
            }
            const selection = activeEditor.selection;
            // Use the start of the selection (could be extended to support ranges)
            const pos = selection.active;
            const line = pos.line + 1; // 1-based
            const column = pos.character + 1; // 1-based

            // Use the nodeMap for efficient search
            let foundNode: PowerShellAstNode | null = null;
            for (const node of astState.nodeMap.values()) {
                if (
                    node.startLine < line || (node.startLine === line && node.startColumn <= column)
                ) {
                    if (
                        node.endLine > line || (node.endLine === line && node.endColumn >= column)
                    ) {
                        if (!foundNode || node.textLength <= foundNode.textLength) {
                            foundNode = node;
                        }
                    }
                }
            }

            if (!foundNode) {
                vscode.window.showInformationMessage('No AST node found for the current selection.');
                return;
            }

            // Use the existing treeView instance to reveal the node
            await treeView.reveal(foundNode, { expand: true, focus: true, select: true });
        });
        context.subscriptions.push(
            refreshCommand, 
            clearCommand,
            expandAllCommand,
            selectItemCommand,
            highlightInEditorCommand,
            treeView, 
            analyzeContentCommand, 
            propertiesViewProvider,
            revealNodeForSelectionCommand
        );
        
    } catch (error) {
        console.error('Error activating extension:', error);
        vscode.window.showErrorMessage(`Extension activation failed: ${error}`);
    }
}

export function deactivate() {}
