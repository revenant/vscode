/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { SkinnyTextDocument } from '../workspaceContents';
import { MdReferencesProvider } from './references';

export class MdDefinitionProvider implements vscode.DefinitionProvider {

	constructor(
		private readonly referencesProvider: MdReferencesProvider
	) { }

	async provideDefinition(document: SkinnyTextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | undefined> {
		const allRefs = await this.referencesProvider.getReferencesAtPosition(document, position, token);

		return allRefs.find(ref => ref.kind === 'link' && ref.isDefinition)?.location;
	}
}

export function registerDefinitionSupport(
	selector: vscode.DocumentSelector,
	referencesProvider: MdReferencesProvider,
): vscode.Disposable {
	return vscode.languages.registerDefinitionProvider(selector, new MdDefinitionProvider(referencesProvider));
}
