import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import { PowerShellRunner } from './PowerShellRunner';

export class PowerShellService {
    private runner: PowerShellRunner | null = null;
    private isDisposed: boolean = false;
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.outputChannel.show(true);
        this.initialise();
    }

    private initialise() {
        const config = vscode.workspace.getConfiguration('powershellAst');
        const flavor = config.get<string>('powershellFlavor', 'core');
        const exePath = this.resolvePowerShellExecutable(flavor);

        this.outputChannel.appendLine(`Starting PowerShell process using: ${exePath} (flavor: ${flavor})`);

        try {
            this.runner = new PowerShellRunner(exePath, flavor, this.outputChannel);
        } catch (error: any) {
            this.outputChannel.appendLine(`Failed to initialize PowerShell runner: ${error.message}`);
            vscode.window.showErrorMessage(`Failed to start PowerShell: ${error.message}`);
        }
    }

    public async analyze(content: string): Promise<string> {
        if (this.isDisposed) {
            throw new Error('PowerShell service is disposed');
        }

        if (!this.runner) {
             // Try to re-initialize
             this.initialise();
             if (!this.runner) {
                 throw new Error('PowerShell service failed to initialize');
             }
        }

        const scriptPath = path.join(__dirname, 'AstParse.ps1');
        
        // Use Base64 encoding to avoid escaping issues
        const base64Content = Buffer.from(content, 'utf8').toString('base64');
        const command = `& "${scriptPath}" -Base64Content '${base64Content}'`;
            
        this.outputChannel.appendLine(`Invoking AST analysis...`);
        // this.outputChannel.appendLine(`Invoking command using script: ${scriptPath}`);
        
        try {
            const result = await this.runner.invoke(command);
            this.outputChannel.appendLine('Analysis completed.');
            return result;
        } catch (err: any) {
            const errorMessage = err.message || String(err);
            this.outputChannel.appendLine(`PowerShell invocation failed: ${errorMessage}`);
            throw new Error(`PowerShell invocation failed: ${errorMessage}`);
        }
    }

    public async dispose(): Promise<void> {
        if (!this.isDisposed) {
            this.isDisposed = true;
            if (this.runner) {
                this.outputChannel.appendLine('Terminating PowerShell process...');
                try {
                    this.runner.dispose();
                    this.outputChannel.appendLine('PowerShell process terminated.');
                } catch (err: any) {
                    this.outputChannel.appendLine(`Error terminating PowerShell process: ${err}`);
                }
                this.runner = null;
            }
        }
    }

    private resolvePowerShellExecutable(flavor: string): string {
        const isWindows = os.platform() === 'win32';
        this.outputChannel.appendLine(`Resolving PowerShell executable for flavor: ${flavor} (isWindows: ${isWindows})`);
        
        if (isWindows) {
            if (flavor === 'desktop') {
                try {
                    const psPath = execSync('where powershell.exe', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
                    this.outputChannel.appendLine(`Found powershell.exe at: ${psPath}`);
                    if (this.isExecutable(psPath)) return psPath;
                } catch (e: any) {
                    this.outputChannel.appendLine(`Error finding powershell.exe: ${e.message}`);
                }
                this.outputChannel.appendLine('Falling back to default powershell.exe');
                return 'powershell.exe';
            } else {
                try {
                    const pwshPath = execSync('where pwsh.exe', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
                    this.outputChannel.appendLine(`Found pwsh.exe at: ${pwshPath}`);
                    if (this.isExecutable(pwshPath)) return pwshPath;
                } catch (e: any) {
                    this.outputChannel.appendLine(`Error finding pwsh.exe: ${e.message}`);
                }
                this.outputChannel.appendLine('Falling back to default pwsh.exe');
                return 'pwsh.exe';
            }
        } else {
            // macOS/Linux
            try {
                const pwshPath = execSync('which pwsh', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
                this.outputChannel.appendLine(`Found pwsh at: ${pwshPath}`);
                if (pwshPath && this.isExecutable(pwshPath)) return pwshPath;
            } catch (e: any) {
                this.outputChannel.appendLine(`Error finding pwsh: ${e.message}`);
            }
            this.outputChannel.appendLine('Falling back to default pwsh');
            return 'pwsh';
        }
    }

    private isExecutable(file: string): boolean {
        try {
            fs.accessSync(file, fs.constants.X_OK);
            return true;
        } catch (e: any) {
            this.outputChannel.appendLine(`File ${file} is not executable: ${e.message}`);
            return false;
        }
    }
}
