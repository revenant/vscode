/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from 'vs/base/common/buffer';
import { Disposable } from 'vs/base/common/lifecycle';
import { basename, joinPath } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { ILocalExtension, Metadata } from 'vs/platform/extensionManagement/common/extensionManagement';
import { IExtensionsProfileScannerService } from 'vs/platform/extensionManagement/common/extensionsProfileScannerService';
import { ExtensionType } from 'vs/platform/extensions/common/extensions';
import { IFileService } from 'vs/platform/files/common/files';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { ILogService } from 'vs/platform/log/common/log';
import { IProgressService, ProgressLocation } from 'vs/platform/progress/common/progress';
import { IUserDataProfilesService } from 'vs/platform/userDataProfile/common/userDataProfile';
import { ISingleFolderWorkspaceIdentifier, IWorkspaceContextService, IWorkspaceIdentifier, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IExtensionManagementServerService, IWorkbenchExtensionManagementService } from 'vs/workbench/services/extensionManagement/common/extensionManagement';
import { IHostService } from 'vs/workbench/services/host/browser/host';
import { CreationOptions, IUserDataProfileManagementService, IUserDataProfileTemplate, PROFILES_CATEGORY } from 'vs/workbench/services/userDataProfile/common/userDataProfile';

const DefaultOptions: CreationOptions = {
	settings: true,
	keybindings: true,
	tasks: true,
	snippets: true,
	extensions: true,
	uiState: true
};

export class UserDataProfileManagementService extends Disposable implements IUserDataProfileManagementService {
	readonly _serviceBrand: undefined;

	constructor(
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@IFileService private readonly fileService: IFileService,
		@IExtensionManagementServerService private readonly extensionManagementServerService: IExtensionManagementServerService,
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IExtensionsProfileScannerService private readonly extensionsProfileScannerService: IExtensionsProfileScannerService,
		@IHostService private readonly hostService: IHostService,
		@IDialogService private readonly dialogService: IDialogService,
		@IProgressService private readonly progressService: IProgressService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService logService: ILogService
	) {
		super();
	}

	async createAndEnterProfile(name: string, options: CreationOptions = DefaultOptions, fromExisting?: boolean): Promise<void> {
		const workspaceIdentifier = this.getWorkspaceIdentifier();
		if (!workspaceIdentifier) {
			throw new Error(localize('cannotCreateProfileInEmptyWorkbench', "Cannot create a profile in an empty workspace"));
		}
		const promises: Promise<any>[] = [];
		const newProfile = this.userDataProfilesService.newProfile(name);
		await this.fileService.createFolder(newProfile.location);
		if (fromExisting) {
			if (options?.uiState) {
				promises.push(this.fileService.copy(this.userDataProfilesService.currentProfile.globalStorageHome, newProfile.globalStorageHome));
			}
			if (options?.settings) {
				promises.push(this.fileService.copy(this.userDataProfilesService.currentProfile.settingsResource, newProfile.settingsResource));
			}
			if (options?.extensions && newProfile.extensionsResource) {
				promises.push((async () => {
					const extensionsProfileResource = this.userDataProfilesService.currentProfile.extensionsResource ?? await this.createDefaultExtensionsProfile(joinPath(this.userDataProfilesService.defaultProfile.location, basename(newProfile.extensionsResource!)));
					this.fileService.copy(extensionsProfileResource, newProfile.extensionsResource!);
				})());
			}
			if (options?.keybindings) {
				promises.push(this.fileService.copy(this.userDataProfilesService.currentProfile.keybindingsResource, newProfile.keybindingsResource));
			}
			if (options?.tasks) {
				promises.push(this.fileService.copy(this.userDataProfilesService.currentProfile.tasksResource, newProfile.tasksResource));
			}
			if (options?.snippets) {
				promises.push(this.fileService.copy(this.userDataProfilesService.currentProfile.snippetsHome, newProfile.snippetsHome));
			}
		} else {
			promises.push(this.fileService.createFolder(newProfile.globalStorageHome));
		}
		await Promise.allSettled(promises);
		await this.userDataProfilesService.createProfile(newProfile, options, workspaceIdentifier);
		await this.enterProfile();
	}

	async removeProfile(name: string): Promise<void> {
		if (name === this.userDataProfilesService.defaultProfile.name) {
			throw new Error(localize('cannotDeleteDefaultProfile', "Cannot delete the default profile"));
		}
		if (name === this.userDataProfilesService.currentProfile.name) {
			throw new Error(localize('cannotDeleteCurrentProfile', "Cannot delete the current profile"));
		}
		const profiles = await this.userDataProfilesService.getAllProfiles();
		const profile = profiles.find(p => p.name === name);
		if (!profile) {
			throw new Error(`Profile ${name} does not exist`);
		}
		await this.userDataProfilesService.removeProfile(profile);
		if (profiles.length === 2) {
			await this.fileService.del(this.userDataProfilesService.profilesHome, { recursive: true });
		} else {
			await this.fileService.del(profile.location, { recursive: true });
		}
	}

	async switchProfile(name: string): Promise<void> {
		const workspaceIdentifier = this.getWorkspaceIdentifier();
		if (!workspaceIdentifier) {
			throw new Error(localize('cannotSwitchProfileInEmptyWorkbench', "Cannot switch a profile in an empty workspace"));
		}
		const profiles = await this.userDataProfilesService.getAllProfiles();
		const profile = profiles.find(p => p.name === name);
		if (!profile) {
			throw new Error(`Profile ${name} does not exist`);
		}
		await this.userDataProfilesService.setProfileForWorkspace(profile, workspaceIdentifier);
		await this.enterProfile();
	}

	async createAndEnterProfileFromTemplate(name: string, template: IUserDataProfileTemplate, options: CreationOptions = DefaultOptions): Promise<void> {
		const workspaceIdentifier = this.getWorkspaceIdentifier();
		if (!workspaceIdentifier) {
			throw new Error(localize('cannotCreateProfileInEmptyWorkbench', "Cannot create a profile in an empty workspace"));
		}
		await this.progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('profiles.creating', "{0}: Creating...", PROFILES_CATEGORY),
		}, async progress => {
			const promises: Promise<any>[] = [];
			const newProfile = this.userDataProfilesService.newProfile(name);
			await this.fileService.createFolder(newProfile.location);
			if (template.globalState) {
				// todo: create global state
			}
			if (template.settings) {
				promises.push(this.fileService.writeFile(newProfile.settingsResource, VSBuffer.fromString(template.settings)));
			}
			if (template.extensions && newProfile.extensionsResource) {
				promises.push(this.fileService.writeFile(newProfile.extensionsResource, VSBuffer.fromString(template.extensions)));
			}
			await Promise.allSettled(promises);
			await this.userDataProfilesService.createProfile(newProfile, options, workspaceIdentifier);
		});
		await this.enterProfile();
	}

	private getWorkspaceIdentifier(): ISingleFolderWorkspaceIdentifier | IWorkspaceIdentifier | undefined {
		const workspace = this.workspaceContextService.getWorkspace();
		switch (this.workspaceContextService.getWorkbenchState()) {
			case WorkbenchState.FOLDER:
				return { uri: workspace.folders[0].uri, id: workspace.id };
			case WorkbenchState.WORKSPACE:
				return { configPath: workspace.configuration!, id: workspace.id };
		}
		return undefined;
	}

	private async enterProfile(): Promise<void> {
		const result = await this.dialogService.confirm({
			type: 'info',
			message: localize('reload message', "Switching a profile requires reloading VS Code."),
			primaryButton: localize('reload button', "&&Reload"),
		});
		if (result.confirmed) {
			await this.hostService.reload();
		}
	}

	private async createDefaultExtensionsProfile(extensionsProfileResource: URI): Promise<URI> {
		const extensionManagementService = this.extensionManagementServerService.localExtensionManagementServer?.extensionManagementService ?? this.extensionManagementService;
		const userExtensions = await extensionManagementService.getInstalled(ExtensionType.User);
		const extensions: [ILocalExtension, Metadata | undefined][] = await Promise.all(userExtensions.map(async e => ([e, await this.extensionManagementService.getMetadata(e)])));
		await this.extensionsProfileScannerService.addExtensionsToProfile(extensions, extensionsProfileResource);
		return extensionsProfileResource;
	}
}

registerSingleton(IUserDataProfileManagementService, UserDataProfileManagementService);
