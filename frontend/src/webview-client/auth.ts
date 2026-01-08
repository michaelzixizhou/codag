/**
 * Auth panel and trial status management for webview.
 */
import * as state from './state';

export interface AuthState {
    isAuthenticated: boolean;
    isTrial: boolean;
    remainingAnalyses: number;
    user?: {
        id: string;
        email: string;
        name?: string;
        avatar_url?: string;
        provider: 'github' | 'google';
        is_paid: boolean;
    };
}

let currentAuthState: AuthState = {
    isAuthenticated: false,
    isTrial: true,
    remainingAnalyses: 5
};

/**
 * Update the auth UI based on current state.
 */
export function updateAuthUI(): void {
    console.log('[webview-auth] updateAuthUI:', 'isAuthenticated=', currentAuthState.isAuthenticated, 'user=', !!currentAuthState.user);
    const trialTag = document.getElementById('trial-tag');
    const signupBtn = document.getElementById('btn-signup');
    const trialRemaining = document.getElementById('trial-remaining');
    const userProfileBtn = document.getElementById('btn-user-profile');
    const userAvatar = document.getElementById('user-avatar') as HTMLImageElement | null;
    const userGreeting = document.getElementById('user-greeting');

    if (currentAuthState.isAuthenticated && currentAuthState.user) {
        // Logged in - show user profile button, hide trial elements
        trialTag?.classList.add('hidden');
        signupBtn?.classList.add('hidden');
        userProfileBtn?.classList.remove('hidden');

        // Set user greeting
        const firstName = currentAuthState.user.name?.split(' ')[0] || 'User';
        if (userGreeting) {
            userGreeting.textContent = `Hi ${firstName}`;
        }

        // Set avatar
        if (userAvatar) {
            if (currentAuthState.user.avatar_url) {
                userAvatar.src = currentAuthState.user.avatar_url;
                userAvatar.style.display = '';
            } else {
                userAvatar.style.display = 'none';
            }
        }

        // Update dropdown content
        updateDropdown(currentAuthState.user);
    } else {
        // Trial user - show trial elements, hide user profile
        trialTag?.classList.remove('hidden');
        signupBtn?.classList.remove('hidden');
        userProfileBtn?.classList.add('hidden');

        if (trialRemaining) {
            const remaining = Math.max(0, currentAuthState.remainingAnalyses);
            trialRemaining.textContent = `${remaining}/5`;
        }
    }
}

/**
 * Update dropdown content with user info.
 */
function updateDropdown(user: NonNullable<AuthState['user']>): void {
    const dropdownAvatar = document.getElementById('dropdown-avatar') as HTMLImageElement | null;
    const dropdownName = document.getElementById('dropdown-name');
    const dropdownEmail = document.getElementById('dropdown-email');
    const dropdownProviderIcon = document.getElementById('dropdown-provider-icon');
    const dropdownProviderText = document.getElementById('dropdown-provider-text');

    if (dropdownAvatar) {
        if (user.avatar_url) {
            dropdownAvatar.src = user.avatar_url;
            dropdownAvatar.style.display = '';
        } else {
            dropdownAvatar.style.display = 'none';
        }
    }
    if (dropdownName) {
        dropdownName.textContent = user.name || 'User';
    }
    if (dropdownEmail) {
        dropdownEmail.textContent = user.email;
    }
    if (dropdownProviderIcon) {
        dropdownProviderIcon.innerHTML = user.provider === 'github' ? getGitHubIcon() : getGoogleIcon();
    }
    if (dropdownProviderText) {
        dropdownProviderText.textContent = `Signed in with ${user.provider === 'github' ? 'GitHub' : 'Google'}`;
    }
}

function getGitHubIcon(): string {
    return `<svg viewBox="0 0 24 24" width="14" height="14">
        <path fill="currentColor" d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
    </svg>`;
}

function getGoogleIcon(): string {
    return `<svg viewBox="0 0 24 24" width="14" height="14">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>`;
}

/**
 * Toggle user dropdown visibility.
 */
function toggleUserDropdown(): void {
    const dropdown = document.getElementById('userDropdown');
    dropdown?.classList.toggle('open');
}

/**
 * Close user dropdown.
 */
function closeUserDropdown(): void {
    const dropdown = document.getElementById('userDropdown');
    dropdown?.classList.remove('open');
}

/**
 * Update auth state from extension message.
 */
export function setAuthState(newState: AuthState): void {
    console.log('[webview-auth] setAuthState received:', JSON.stringify(newState));
    currentAuthState = newState;
    updateAuthUI();
}

/**
 * Get current auth state.
 */
export function getAuthState(): AuthState {
    return { ...currentAuthState };
}

/**
 * Open the auth panel.
 */
export function openAuthPanel(): void {
    const panel = document.getElementById('authPanel');
    panel?.classList.add('open');
}

/**
 * Close the auth panel with optional minimize animation.
 */
export function closeAuthPanel(minimize: boolean = true): void {
    const panel = document.getElementById('authPanel');
    if (!panel) return;

    if (minimize) {
        // Add minimizing class for scale animation
        panel.classList.add('minimizing');
        setTimeout(() => {
            panel.classList.remove('open', 'minimizing');
        }, 300);
    } else {
        panel.classList.remove('open');
    }
}

/**
 * Start OAuth flow for a provider.
 */
function startOAuth(provider: 'github' | 'google'): void {
    state.vscode.postMessage({
        command: 'startOAuth',
        provider
    });
}

/**
 * Setup auth-related event handlers.
 */
export function setupAuthHandlers(): void {
    // Sign up button opens auth panel
    const signupBtn = document.getElementById('btn-signup');
    signupBtn?.addEventListener('click', () => {
        openAuthPanel();
    });

    // Close button on auth panel
    const closeBtn = document.getElementById('btn-close-auth');
    closeBtn?.addEventListener('click', () => {
        closeAuthPanel();
    });

    // GitHub OAuth button
    const githubBtn = document.getElementById('btn-oauth-github');
    githubBtn?.addEventListener('click', () => {
        startOAuth('github');
        closeAuthPanel(false);
    });

    // Google OAuth button
    const googleBtn = document.getElementById('btn-oauth-google');
    googleBtn?.addEventListener('click', () => {
        startOAuth('google');
        closeAuthPanel(false);
    });

    // User profile button toggles dropdown
    const userProfileBtn = document.getElementById('btn-user-profile');
    userProfileBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleUserDropdown();
    });

    // Logout button
    const logoutBtn = document.getElementById('btn-logout');
    logoutBtn?.addEventListener('click', () => {
        closeUserDropdown();
        state.vscode.postMessage({ command: 'logout' });
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('userDropdown');
        const profileBtn = document.getElementById('btn-user-profile');
        if (dropdown?.classList.contains('open') &&
            !dropdown.contains(e.target as Node) &&
            !profileBtn?.contains(e.target as Node)) {
            closeUserDropdown();
        }
    });
}

/**
 * Check if user has analyses remaining.
 */
export function hasAnalysesRemaining(): boolean {
    if (currentAuthState.isAuthenticated && !currentAuthState.isTrial) {
        return true; // Unlimited for authenticated users
    }
    return currentAuthState.remainingAnalyses > 0;
}
