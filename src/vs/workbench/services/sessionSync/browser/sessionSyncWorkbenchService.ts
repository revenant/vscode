/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { Action2, MenuId, registerAction2 } from 'vs/platform/actions/common/actions';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IFileService } from 'vs/platform/files/common/files';
import { ILogService } from 'vs/platform/log/common/log';
import { IProductService } from 'vs/platform/product/common/productService';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from 'vs/platform/quickinput/common/quickInput';
import { IRequestService } from 'vs/platform/request/common/request';
import { IStorageService, IStorageValueChangeEvent, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { IAuthenticationProvider } from 'vs/platform/userDataSync/common/userDataSync';
import { UserDataSyncStoreClient } from 'vs/platform/userDataSync/common/userDataSyncStoreService';
import { AuthenticationSession, AuthenticationSessionsChangeEvent, IAuthenticationService } from 'vs/workbench/services/authentication/common/authentication';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { EditSession, EDIT_SESSION_SYNC_TITLE, ISessionSyncWorkbenchService } from 'vs/workbench/services/sessionSync/common/sessionSync';

type ExistingSession = IQuickPickItem & { session: AuthenticationSession & { providerId: string } };
type AuthenticationProviderOption = IQuickPickItem & { provider: IAuthenticationProvider };

export class SessionSyncWorkbenchService extends Disposable implements ISessionSyncWorkbenchService {

	_serviceBrand = undefined;

	private serverConfiguration = this.productService['sessionSync.store'];
	private storeClient: UserDataSyncStoreClient | undefined;

	#authenticationInfo: { sessionId: string; token: string; providerId: string } | undefined;
	private static CACHED_SESSION_STORAGE_KEY = 'editSessionSyncAccountPreference';

	private initialized = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService,
		@IRequestService private readonly requestService: IRequestService,
	) {
		super();

		// If the user signs out of the current session, reset our cached auth state in memory and on disk
		this._register(this.authenticationService.onDidChangeSessions((e) => this.onDidChangeSessions(e.event)));

		// If another window changes the preferred session storage, reset our cached auth state in memory
		this._register(this.storageService.onDidChangeValue(e => this.onDidChangeStorage(e)));

		this.registerResetAuthenticationAction();
	}

	/**
	 *
	 * @param editSession An object representing edit session state to be restored.
	 * @returns The ref of the stored edit session state.
	 */
	async write(editSession: EditSession): Promise<string> {
		this.initialized = await this.waitAndInitialize();
		if (!this.initialized) {
			throw new Error('Please sign in to store your edit session.');
		}

		return this.storeClient!.write('editSessions', JSON.stringify(editSession), null);
	}

	/**
	 * @param ref: A specific content ref to retrieve content for, if it exists.
	 * If undefined, this method will return the latest saved edit session, if any.
	 *
	 * @returns An object representing the requested or latest edit session state, if any.
	 */
	async read(ref: string | undefined): Promise<EditSession | undefined> {
		this.initialized = await this.waitAndInitialize();
		if (!this.initialized) {
			throw new Error('Please sign in to apply your latest edit session.');
		}

		let content: string | undefined | null;
		try {
			if (ref !== undefined) {
				content = await this.storeClient?.resolveContent('editSessions', ref);
			} else {
				content = (await this.storeClient?.read('editSessions', null))?.content;
			}
		} catch (ex) {
			this.logService.error(ex);
		}

		// TODO@joyceerhl Validate session data, check schema version
		return (content !== undefined && content !== null) ? JSON.parse(content) : undefined;
	}

	/**
	 *
	 * Ensures that the store client is initialized,
	 * meaning that authentication is configured and it
	 * can be used to communicate with the remote storage service
	 */
	private async waitAndInitialize(): Promise<boolean> {
		// Wait for authentication extensions to be registered
		await this.extensionService.whenInstalledExtensionsRegistered();

		if (!this.serverConfiguration?.url) {
			throw new Error('Unable to initialize sessions sync as session sync preference is not configured in product.json.');
		}

		if (!this.storeClient) {
			this.storeClient = new UserDataSyncStoreClient(URI.parse(this.serverConfiguration.url), this.productService, this.requestService, this.logService, this.environmentService, this.fileService, this.storageService);
		}

		// If we already have an existing auth session in memory, use that
		if (this.#authenticationInfo !== undefined) {
			return true;
		}

		// If the user signed in previously and the session is still available, reuse that without prompting the user again
		if (this.existingSessionId) {
			const existing = await this.getExistingSession();
			if (existing !== undefined) {
				this.#authenticationInfo = { sessionId: existing.session.id, token: existing.session.accessToken, providerId: existing.session.providerId };
				this.storeClient.setAuthToken(this.#authenticationInfo.token, this.#authenticationInfo.providerId);
				return true;
			}
		}

		// Ask the user to pick a preferred account
		const session = await this.getAccountPreference();
		if (session !== undefined) {
			this.#authenticationInfo = { sessionId: session.id, token: session.accessToken, providerId: session.providerId };
			this.storeClient.setAuthToken(this.#authenticationInfo.token, this.#authenticationInfo.providerId);
			this.existingSessionId = session.id;
			return true;
		}

		return false;
	}

	/**
	 *
	 * Prompts the user to pick an authentication option for storing and getting edit sessions.
	 */
	private async getAccountPreference(): Promise<AuthenticationSession & { providerId: string } | undefined> {
		const quickpick = this.quickInputService.createQuickPick<ExistingSession | AuthenticationProviderOption>();
		quickpick.title = localize('account preference', 'Edit Sessions');
		quickpick.ok = false;
		quickpick.placeholder = localize('choose account placeholder', "Select an account to sign in");
		quickpick.ignoreFocusOut = true;
		quickpick.items = await this.createQuickpickItems();

		return new Promise((resolve, reject) => {
			quickpick.onDidHide((e) => {
				resolve(undefined);
				quickpick.dispose();
			});

			quickpick.onDidAccept(async (e) => {
				const selection = quickpick.selectedItems[0];
				const session = 'provider' in selection ? { ...await this.authenticationService.createSession(selection.provider.id, selection.provider.scopes), providerId: selection.provider.id } : selection.session;
				resolve(session);
				quickpick.hide();
			});

			quickpick.show();
		});
	}

	private async createQuickpickItems(): Promise<(ExistingSession | AuthenticationProviderOption | IQuickPickSeparator)[]> {
		const options: (ExistingSession | AuthenticationProviderOption | IQuickPickSeparator)[] = [];

		options.push({ type: 'separator', label: localize('signed in', "Signed In") });

		const sessions = await this.getAllSessions();
		options.push(...sessions);

		options.push({ type: 'separator', label: localize('others', "Others") });

		for (const authenticationProvider of (await this.getAuthenticationProviders())) {
			const signedInForProvider = sessions.some(account => account.session.providerId === authenticationProvider.id);
			if (!signedInForProvider || this.authenticationService.supportsMultipleAccounts(authenticationProvider.id)) {
				const providerName = this.authenticationService.getLabel(authenticationProvider.id);
				options.push({ label: localize('sign in using account', "Sign in with {0}", providerName), provider: authenticationProvider });
			}
		}

		return options;
	}

	/**
	 *
	 * Returns all authentication sessions available from {@link getAuthenticationProviders}.
	 */
	private async getAllSessions() {
		const options: ExistingSession[] = [];
		const authenticationProviders = await this.getAuthenticationProviders();

		for (const provider of authenticationProviders) {
			const sessions = await this.authenticationService.getSessions(provider.id, provider.scopes);

			for (const session of sessions) {
				options.push({
					label: session.account.label,
					description: this.authenticationService.getLabel(provider.id),
					session: { ...session, providerId: provider.id }
				});
			}
		}

		return options;
	}

	/**
	 *
	 * Returns all authentication providers which can be used to authenticate
	 * to the remote storage service, based on product.json configuration
	 * and registered authentication providers.
	 */
	private async getAuthenticationProviders() {
		if (!this.serverConfiguration) {
			throw new Error('Unable to get configured authentication providers as session sync preference is not configured in product.json.');
		}

		// Get the list of authentication providers configured in product.json
		const authenticationProviders = this.serverConfiguration.authenticationProviders;
		const configuredAuthenticationProviders = Object.keys(authenticationProviders).reduce<IAuthenticationProvider[]>((result, id) => {
			result.push({ id, scopes: authenticationProviders[id].scopes });
			return result;
		}, []);

		// Filter out anything that isn't currently available through the authenticationService
		const availableAuthenticationProviders = this.authenticationService.declaredProviders;

		return configuredAuthenticationProviders.filter(({ id }) => availableAuthenticationProviders.some(provider => provider.id === id));
	}

	private get existingSessionId() {
		return this.storageService.get(SessionSyncWorkbenchService.CACHED_SESSION_STORAGE_KEY, StorageScope.GLOBAL);
	}

	private set existingSessionId(sessionId: string | undefined) {
		if (sessionId === undefined) {
			this.storageService.remove(SessionSyncWorkbenchService.CACHED_SESSION_STORAGE_KEY, StorageScope.GLOBAL);
		} else {
			this.storageService.store(SessionSyncWorkbenchService.CACHED_SESSION_STORAGE_KEY, sessionId, StorageScope.GLOBAL, StorageTarget.USER);
		}
	}

	private async getExistingSession() {
		const accounts = await this.getAllSessions();
		return accounts.find((account) => account.session.id === this.existingSessionId);
	}

	private async onDidChangeStorage(e: IStorageValueChangeEvent): Promise<void> {
		if (e.key === SessionSyncWorkbenchService.CACHED_SESSION_STORAGE_KEY
			&& e.scope === StorageScope.GLOBAL
			&& this.#authenticationInfo?.sessionId !== this.existingSessionId
		) {
			this.#authenticationInfo = undefined;
			this.initialized = false;
		}
	}

	private clearAuthenticationPreference(): void {
		this.#authenticationInfo = undefined;
		this.initialized = false;
		this.existingSessionId = undefined;
	}

	private onDidChangeSessions(e: AuthenticationSessionsChangeEvent): void {
		if (this.#authenticationInfo?.sessionId && e.removed.find(session => session.id === this.#authenticationInfo?.sessionId)) {
			this.clearAuthenticationPreference();
		}
	}

	private registerResetAuthenticationAction() {
		const that = this;
		this._register(registerAction2(class ResetEditSessionAuthenticationAction extends Action2 {
			constructor() {
				super({
					id: 'workbench.sessionSync.actions.resetAuth',
					title: localize('reset auth', '{0}: Reset Authentication State', EDIT_SESSION_SYNC_TITLE),
					menu: {
						id: MenuId.CommandPalette,
					}
				});
			}

			run() {
				that.clearAuthenticationPreference();
			}
		}));
	}
}
