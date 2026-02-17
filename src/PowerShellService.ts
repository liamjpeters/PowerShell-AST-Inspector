import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

// Interface for node-powershell instance to improve type safety
interface IPowerShell {
    invoke(command: string): Promise<any>;
    dispose(): Promise<void>;
}

// We need to require node-powershell because it doesn't have types
let PowerShell = require('node-powershell');
// Handle different export patterns (CommonJS vs ESM)
if (PowerShell.PowerShell) {
    PowerShell = PowerShell.PowerShell;
} else if (PowerShell.default) {
    PowerShell = PowerShell.default;
}

export class PowerShellService {
    private ps: IPowerShell;
    private isDisposed: boolean = false;
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.ps = this.initialise();
    }

    private initialise(): IPowerShell {
        const config = vscode.workspace.getConfiguration('powershellAst');
        const flavor = config.get<string>('powershellFlavor', 'core');
        const exePath = this.resolvePowerShellExecutable(flavor);

        this.outputChannel.appendLine(`Starting PowerShell process using: ${exePath} (flavor: ${flavor})`);

        return new PowerShell({
            executionPolicy: 'Bypass',
            noProfile: true,
            executableOptions: {
                '-NoLogo': true,
                '-NonInteractive': true,
            },
            executablePath: exePath
        }) as IPowerShell;
    }

    public async analyze(content: string): Promise<string> {
        if (this.isDisposed) {
            throw new Error('PowerShell service is disposed');
        }

        const scriptPath = path.join(__dirname, 'AstParse.ps1');
        
        // Use Base64 encoding to avoid escaping issues and some command line weirdness
        const base64Content = Buffer.from(content, 'utf8').toString('base64');
        const command = `& "${scriptPath}" -Base64Content '${base64Content}'`;
            
        this.outputChannel.appendLine(`Analyzing content (length: ${content.length})...`);
        try {
            const result = await this.ps.invoke(command);
            this.outputChannel.appendLine('Analysis completed');
            
            // Handle v5 result structure
            // node-powershell v5 usually returns an object { raw: string }
            if (result && typeof result === 'object') {
                return result.raw || result.stdout || (result.toString ? result.toString() : '');
            }
            return String(result);
        } catch (err: any) {
            // Check if the error is just the script returning an error JSON
            // node-powershell throws on non-zero exit code or stderr
            // But AstParse.ps1 captures errors and returns JSON (exit 0) or JSON with error property (exit 1)
            // If it throws, it might be a real error
            const errorMessage = err.message || String(err);
            const errorStack = err.stack || '';
            const fullError = `Message: ${errorMessage}\nStack: ${errorStack}`;
            
            this.outputChannel.appendLine(`PowerShell invocation failed: ${errorMessage}`);
            throw new Error(`PowerShell invocation failed: ${fullError}`);
        }
    }

    public async dispose(): Promise<void> {
        if (!this.isDisposed) {
            this.isDisposed = true;
            if (this.ps) {
                this.outputChannel.appendLine('Terminating PowerShell process...');
                try {
                    await this.ps.dispose();
                    this.outputChannel.appendLine('PowerShell process terminated.');
                } catch (err: any) {
                    this.outputChannel.appendLine(`Error terminating PowerShell process: ${err}`);
                }
            }
        }
    }

    private resolvePowerShellExecutable(flavor: string): string {
        const isWindows = os.platform() === 'win32';
        if (isWindows) {
            if (flavor === 'desktop') {
                try {
                    const psPath = execSync('where powershell.exe', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
                    if (this.isExecutable(psPath)) return psPath;
                } catch {}
                return 'powershell.exe';
            } else {
                try {
                    const pwshPath = execSync('where pwsh.exe', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
                    if (this.isExecutable(pwshPath)) return pwshPath;
                } catch {}
                return 'pwsh.exe';
            }
        } else {
            // macOS/Linux
            try {
                const pwshPath = execSync('which pwsh', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
                if (pwshPath && this.isExecutable(pwshPath)) return pwshPath;
            } catch {}
            return 'pwsh';
        }
    }

    private isExecutable(file: string): boolean {
        try {
            fs.accessSync(file, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }
}
