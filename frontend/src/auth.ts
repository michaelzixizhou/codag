import * as vscode from 'vscode';
import { APIClient } from './api';
import { CONFIG } from './config';
import { AuthState, OAuthProvider } from './types';

// Re-export for backwards compatibility
export { AuthState, OAuthProvider };

export class AuthManager {
    private static readonly TOKEN_KEY = 'codag.token';
    private static readonly AUTH_STATE_KEY = 'codag.authState';

    private authState: AuthState = {
        isAuthenticated: false,
        isTrial: true,
        remainingAnalyses: CONFIG.TRIAL.TOTAL_ANALYSES,
    };

    // Callback to notify webview of auth state changes
    private onAuthStateChange?: (state: AuthState) => void;
    // Callback to show auth errors in webview
    private onAuthError?: (error: string) => void;

    constructor(
        private context: vscode.ExtensionContext,
        private api: APIClient
    ) {
        // Set device ID on API client
        this.api.setDeviceId(this.getDeviceId());

        // Load cached auth state (for user info display before async init)
        const cachedState = this.context.globalState.get<AuthState>(AuthManager.AUTH_STATE_KEY);
        if (cachedState) {
            this.authState = cachedState;
        }

        // Listen for token changes from other windows
        this.context.secrets.onDidChange(async (e) => {
            if (e.key === AuthManager.TOKEN_KEY) {
                await this.handleTokenChange();
            }
        });
    }

    /**
     * Initialize the auth manager asynchronously.
     * Must be called after construction to load token from secure storage.
     */
    async initialize(): Promise<void> {
        const token = await this.getToken();
        const cachedState = this.context.globalState.get<AuthState>(AuthManager.AUTH_STATE_KEY);
        console.log('[auth] initialize: token exists =', !!token, ', cachedState =', !!cachedState);

        if (token) {
            console.log('[auth] initialize: Setting token on API client');
            this.api.setToken(token);

            // Always validate token on startup by fetching user
            console.log('[auth] initialize: Validating token by fetching user');
            let user;
            try {
                user = await this.api.getUser();
            } catch (error: any) {
                // Clear token on auth errors (401/403) and user not found (404)
                const status = error.response?.status;
                if (status === 401 || status === 403 || status === 404) {
                    console.log(`[auth] initialize: Token invalid (${status}), clearing`);
                    await this.clearToken();
                    return;
                }
                // For other errors (network, 500), keep token and use cached state
                console.log('[auth] initialize: API error but keeping token:', error.message);
                if (cachedState) {
                    this.authState = cachedState;
                    return;
                }
                return;
            }

            this.authState = {
                isAuthenticated: true,
                isTrial: false,
                remainingAnalyses: -1,
                user,
            };
            await this.saveAuthState();
            console.log('[auth] initialize: Auth state set to authenticated');
        } else {
            console.log('[auth] initialize: No token found');
            // Clear stale auth state if cached says authenticated but no token exists
            if (cachedState?.isAuthenticated) {
                console.log('[auth] initialize: Clearing stale auth state (no token but cachedState.isAuthenticated=true)');
                this.authState = {
                    isAuthenticated: false,
                    isTrial: true,
                    remainingAnalyses: CONFIG.TRIAL.TOTAL_ANALYSES,
                    user: undefined,
                };
                await this.context.globalState.update(AuthManager.AUTH_STATE_KEY, this.authState);
            }
        }
    }
    /**
     * Handle token changes from other windows.
     */
    private async handleTokenChange(): Promise<void> {
        const token = await this.getToken();
        if (token) {
            // Token was set in another window - validate and update state
            this.api.setToken(token);
            try {
                const user = await this.api.getUser();
                this.authState = {
                    isAuthenticated: true,
                    isTrial: false,
                    remainingAnalyses: -1,
                    user: user,
                };
                await this.saveAuthState();
            } catch (error: any) {
                // Clear token on auth errors (401/403) and user not found (404)
                const status = error.response?.status;
                if (status === 401 || status === 403 || status === 404) {
                    await this.clearToken();
                }
                // For other errors, keep token
            }
        } else {
            // Token was cleared in another window - reset to trial
            this.api.clearToken();
            this.authState = {
                isAuthenticated: false,
                isTrial: true,
                remainingAnalyses: CONFIG.TRIAL.TOTAL_ANALYSES,
                user: undefined,
            };
            await this.saveAuthState();
            await this.checkTrialStatus();
        }
    }

    /**
     * Set callback for auth state changes.
     * Used to update webview when auth state changes.
     */
    setOnAuthStateChange(callback: (state: AuthState) => void): void {
        this.onAuthStateChange = callback;
    }

    /**
     * Set callback for auth errors.
     * Used to show errors in webview instead of VSCode notifications.
     */
    setOnAuthError(callback: (error: string) => void): void {
        this.onAuthError = callback;
    }

    /**
     * Get the device ID for trial tracking.
     * Uses VSCode's machineId which is unique per installation.
     */
    getDeviceId(): string {
        return vscode.env.machineId;
    }

    /**
     * Get the current auth token if available.
     * Uses SecretStorage for secure, cross-window persistent storage.
     */
    private async getToken(): Promise<string | undefined> {
        return this.context.secrets.get(AuthManager.TOKEN_KEY);
    }

    /**
     * Store the auth token.
     * Uses SecretStorage - triggers onDidChange in other windows.
     */
    private async setToken(token: string): Promise<void> {
        await this.context.secrets.store(AuthManager.TOKEN_KEY, token);
        this.api.setToken(token);
    }

    /**
     * Clear the auth token.
     * Uses SecretStorage - triggers onDidChange in other windows.
     */
    private async clearToken(): Promise<void> {
        await this.context.secrets.delete(AuthManager.TOKEN_KEY);
        this.api.clearToken();
    }

    /**
     * Save auth state to storage and notify listeners.
     */
    private async saveAuthState(): Promise<void> {
        await this.context.globalState.update(AuthManager.AUTH_STATE_KEY, this.authState);
        this.onAuthStateChange?.(this.authState);
    }

    /**
     * Get the current auth state.
     */
    getAuthState(): AuthState {
        return { ...this.authState };
    }

    /**
     * Check trial status with backend.
     * Also validates stored token if present.
     * Returns remaining analyses.
     */
    async checkTrialStatus(): Promise<number> {
        try {
            // If we have a stored token, validate it first
            const token = await this.getToken();
            console.log('[auth] checkTrialStatus: token exists =', !!token);
            if (token) {
                try {
                    console.log('[auth] Validating stored token...');
                    const user = await this.api.getUser();
                    console.log('[auth] Token valid, user:', user?.email);
                    // Token valid - update user info
                    this.authState = {
                        isAuthenticated: true,
                        isTrial: false,
                        remainingAnalyses: -1, // Unlimited
                        user: user,
                    };
                    await this.saveAuthState();
                    return -1;
                } catch (error: any) {
                    // Token invalid - clear it and fall through to trial check
                    console.log('[auth] Stored token invalid:', error.message, error.response?.status, error.response?.data);
                    await this.clearToken();
                    this.authState = {
                        isAuthenticated: false,
                        isTrial: true,
                        remainingAnalyses: CONFIG.TRIAL.TOTAL_ANALYSES,
                        user: undefined,
                    };
                }
            }

            // Check trial status
            const response = await this.api.checkDevice(this.getDeviceId());
            this.authState.remainingAnalyses = response.remaining_analyses;
            this.authState.isTrial = response.is_trial && !response.is_authenticated;
            // Only mark as authenticated if we have user info
            // (device may be linked but token could be invalid)
            this.authState.isAuthenticated = response.is_authenticated && !!this.authState.user;
            await this.saveAuthState();
            return response.remaining_analyses;
        } catch (error) {
            console.error('Failed to check trial status:', error);
            return this.authState.remainingAnalyses;
        }
    }

    /**
     * Update remaining analyses count.
     * Called after each analysis.
     */
    async updateRemainingAnalyses(remaining: number): Promise<void> {
        this.authState.remainingAnalyses = remaining;
        await this.saveAuthState();
    }

    /**
     * Start OAuth flow for the given provider.
     * Opens browser to backend OAuth endpoint.
     */
    async startOAuth(provider: OAuthProvider): Promise<void> {
        const state = this.generateRandomState();
        await this.context.globalState.update('codag.oauth_state', state);

        const baseUrl = this.api.getBaseUrl();
        const url = `${baseUrl}/auth/${provider}?state=${state}`;

        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    /**
     * Handle OAuth callback from URI handler.
     * Called when vscode://codag/auth/callback is triggered.
     */
    async handleOAuthCallback(token: string): Promise<void> {
        try {
            await this.setToken(token);

            // Link device to user
            await this.api.linkDevice(this.getDeviceId());

            // Get user info
            const user = await this.api.getUser();

            // Update auth state
            this.authState = {
                isAuthenticated: true,
                isTrial: false,
                remainingAnalyses: -1, // Unlimited
                user: user,
            };

            await this.saveAuthState();
        } catch (error: any) {
            console.error('OAuth callback failed:', error);
            if (this.onAuthError) {
                this.onAuthError(`Sign in failed: ${error.message}`);
            }
        }
    }

    /**
     * Handle OAuth error from URI handler.
     */
    handleOAuthError(error: string): void {
        console.error('OAuth error:', error);

        let message = 'Sign in failed';
        if (error === 'no_email') {
            message = 'Could not get email from OAuth provider. Please ensure your email is public or verified.';
        } else {
            message = `Sign in failed: ${error}`;
        }

        if (this.onAuthError) {
            this.onAuthError(message);
        }
    }

    /**
     * Sign out and clear auth state.
     */
    async logout(): Promise<void> {
        await this.clearToken();

        // Reset to trial state
        this.authState = {
            isAuthenticated: false,
            isTrial: true,
            remainingAnalyses: CONFIG.TRIAL.TOTAL_ANALYSES,
            user: undefined,
        };

        await this.saveAuthState();

        // Check actual trial status
        await this.checkTrialStatus();

        vscode.window.showInformationMessage('Signed out');
    }

    /**
     * Check if user is authenticated (not trial).
     */
    isAuthenticated(): boolean {
        return this.authState.isAuthenticated && !this.authState.isTrial;
    }

    /**
     * Check if user has analyses remaining.
     */
    hasAnalysesRemaining(): boolean {
        if (this.isAuthenticated()) {
            return true; // Unlimited for authenticated users
        }
        return this.authState.remainingAnalyses > 0;
    }

    /**
     * Generate random state for OAuth CSRF protection.
     */
    private generateRandomState(): string {
        const array = new Uint8Array(32);
        require('crypto').randomFillSync(array);
        return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    // Legacy methods for backwards compatibility
    async login(): Promise<void> {
        // Redirect to OAuth
        await this.startOAuth('github');
    }

    async register(): Promise<void> {
        // Redirect to OAuth
        await this.startOAuth('github');
    }
}
