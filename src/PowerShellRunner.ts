import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as os from 'os';

/**
 * A lightweight wrapper around PowerShell using child_process.spawn.
 * Replaces the unmaintained node-powershell dependency.
 */
export class PowerShellRunner {
    private process: cp.ChildProcess | null = null;
    private outputChannel: vscode.OutputChannel;
    private exePath: string;
    private flavor: string;
    private isDisposed: boolean = false;
    private pendingCallbacks: Array<{ resolve: (value: string) => void, reject: (reason: any) => void }> = [];
    private currentData: string = '';
    private currentError: string = '';

    constructor(exePath: string, flavor: string, outputChannel: vscode.OutputChannel) {
        this.exePath = exePath;
        this.flavor = flavor;
        this.outputChannel = outputChannel;
        this.startProcess();
    }

    private startProcess() {
        const args = [
            '-NoLogo',
            '-NoExit',
            '-Command', '-'
        ];

        // Add execution policy for Windows
        if (os.platform() === 'win32') {
            args.unshift('-ExecutionPolicy', 'Bypass');
        }

        this.outputChannel.appendLine(`Spawning PowerShell process: ${this.exePath}`);

        try {
            this.process = cp.spawn(this.exePath, args, {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            if (!this.process.pid) {
                throw new Error('Failed to start PowerShell process.');
            }

            this.process.stdout?.on('data', (data) => {
                const chunk = data.toString();
                // Check for our custom delimiter
                if (chunk.includes('__END_OF_COMMAND__')) {
                    const parts = chunk.split('__END_OF_COMMAND__');
                    this.currentData += parts[0];
                    this.resolveCurrentCommand();
                    // If there's data after the delimiter, it's part of the next command (unlikely but possible)
                    if (parts.length > 1 && parts[1].trim().length > 0) {
                        this.currentData = parts[1];
                    }
                } else {
                    this.currentData += chunk;
                }
            });

            this.process.stderr?.on('data', (data) => {
                const chunk = data.toString();
                this.currentError += chunk;
                // We don't resolve on error immediately because stderr might be mixed with stdout
                // and we want to wait for the command to finish.
                // However, for fatal errors, we might want to log.
                this.outputChannel.append(`[STDERR] ${chunk}`);
            });

            this.process.on('error', (err) => {
                this.outputChannel.appendLine(`PowerShell process error: ${err.message}`);
                this.rejectCurrentCommand(err);
            });

            this.process.on('exit', (code) => {
                this.outputChannel.appendLine(`PowerShell process exited with code ${code}`);
                this.process = null;
                this.rejectCurrentCommand(new Error(`PowerShell process exited unexpectedly with code ${code}`));
            });

        } catch (error: any) {
            this.outputChannel.appendLine(`Failed to spawn PowerShell: ${error.message}`);
            throw error;
        }
    }

    public async invoke(command: string): Promise<string> {
        if (this.isDisposed || !this.process) {
            // Try to restart if process is gone but not disposed
            if (!this.isDisposed) {
                this.outputChannel.appendLine('PowerShell process is gone, restarting...');
                this.startProcess();
            } else {
                throw new Error('PowerShell runner is disposed');
            }
        }

        return new Promise((resolve, reject) => {
            this.pendingCallbacks.push({ resolve, reject });
            
            // Reset buffers
            this.currentData = '';
            this.currentError = '';

            // Write command to stdin
            // We append a sentinel string to know when the command is done
            const fullCommand = `${command}; Write-Output "__END_OF_COMMAND__"`;
            
            try {
                this.process!.stdin?.write(fullCommand + '\n');
            } catch (error) {
                const handler = this.pendingCallbacks.shift();
                handler?.reject(error);
            }
        });
    }

    private resolveCurrentCommand() {
        const handler = this.pendingCallbacks.shift();
        if (handler) {
            if (this.currentError && this.currentError.trim().length > 0) {
                // Determine if stderr should fail the command or just warn
                // For now, we'll treat stderr as potentially non-fatal if we got stdout too,
                // but let's log it.
                // If we have no stdout but have stderr, it's likely a failure.
                if (!this.currentData.trim()) {
                     handler.reject(new Error(this.currentError));
                } else {
                     handler.resolve(this.currentData.trim());
                }
            } else {
                handler.resolve(this.currentData.trim());
            }
        }
    }

    private rejectCurrentCommand(error: Error) {
        const handler = this.pendingCallbacks.shift();
        if (handler) {
            handler.reject(error);
        }
    }

    public dispose() {
        this.isDisposed = true;
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }
}
