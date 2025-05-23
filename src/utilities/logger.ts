import * as vscode from 'vscode';

export class Logger {
    private static outputChannel: vscode.OutputChannel | undefined;

    public static init(context: vscode.ExtensionContext): void {
        if (!Logger.outputChannel) {
            Logger.outputChannel = vscode.window.createOutputChannel("Flow Master");
            context.subscriptions.push(Logger.outputChannel);
        }
    }

    public static log(message: string, ...optionalParams: any[]): void {
        if (Logger.outputChannel) {
            const timestamp = new Date().toISOString();
            Logger.outputChannel.appendLine(`[${timestamp}] ${message} ${optionalParams.length > 0 ? JSON.stringify(optionalParams) : ''}`);
        } else {
            console.log(`[Flow Master LATE LOG] ${message}`, ...optionalParams);
        }
    }

    public static error(message: string, error?: any): void {
        if (Logger.outputChannel) {
            const timestamp = new Date().toISOString();
            Logger.outputChannel.appendLine(`[${timestamp}] ERROR: ${message}`);
            if (error) {
                if (error instanceof Error) {
                    Logger.outputChannel.appendLine(error.stack || error.message);
                } else {
                    Logger.outputChannel.appendLine(JSON.stringify(error));
                }
            }
        } else {
            console.error(`[Flow Master LATE ERROR] ${message}`, error);
        }
    }

    public static show(): void {
        Logger.outputChannel?.show(true);
    }
}