import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('hero-code.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from Hero Code!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
