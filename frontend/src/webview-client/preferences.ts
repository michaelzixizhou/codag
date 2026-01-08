// User preferences management for webview client
import * as state from './state';

/**
 * User preferences structure
 */
export interface UserPreferences {
    /** Enable high contrast mode for better visibility */
    highContrastUI: boolean;
}

/**
 * Default preferences
 */
const DEFAULT_PREFERENCES: UserPreferences = {
    highContrastUI: false
};

/**
 * Current preferences state
 */
let currentPreferences: UserPreferences = { ...DEFAULT_PREFERENCES };

/**
 * Callback for when preferences change
 */
type PreferenceChangeCallback = (prefs: UserPreferences) => void;
let onPreferenceChangeCallbacks: PreferenceChangeCallback[] = [];

/**
 * Get current preferences
 */
export function getPreferences(): UserPreferences {
    return { ...currentPreferences };
}

/**
 * Get a specific preference value
 */
export function getPreference<K extends keyof UserPreferences>(key: K): UserPreferences[K] {
    return currentPreferences[key];
}

/**
 * Update preferences (merges with current)
 */
export function setPreferences(prefs: Partial<UserPreferences>): void {
    const oldPrefs = { ...currentPreferences };
    currentPreferences = { ...currentPreferences, ...prefs };
    
    // Notify callbacks if anything changed
    if (JSON.stringify(oldPrefs) !== JSON.stringify(currentPreferences)) {
        notifyPreferenceChange();
    }
}

/**
 * Set a single preference
 */
export function setPreference<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]): void {
    if (currentPreferences[key] !== value) {
        currentPreferences[key] = value;
        notifyPreferenceChange();
        
        // Sync to extension
        syncPreferenceToExtension(key, value);
    }
}

/**
 * Toggle a boolean preference
 */
export function togglePreference<K extends keyof UserPreferences>(key: K): boolean | null {
    const currentValue = currentPreferences[key];
    if (typeof currentValue === 'boolean') {
        const newValue = !currentValue;
        setPreference(key, newValue as UserPreferences[K]);
        return newValue;
    }
    return null;
}

/**
 * Reset preferences to defaults
 */
export function resetPreferences(): void {
    currentPreferences = { ...DEFAULT_PREFERENCES };
    notifyPreferenceChange();
}

/**
 * Register callback for preference changes
 */
export function onPreferenceChange(callback: PreferenceChangeCallback): () => void {
    onPreferenceChangeCallbacks.push(callback);
    
    // Return unsubscribe function
    return () => {
        onPreferenceChangeCallbacks = onPreferenceChangeCallbacks.filter(cb => cb !== callback);
    };
}

/**
 * Notify all registered callbacks of preference change
 */
function notifyPreferenceChange(): void {
    const prefs = getPreferences();
    onPreferenceChangeCallbacks.forEach(cb => {
        try {
            cb(prefs);
        } catch (error) {
            console.error('[preferences] Callback error:', error);
        }
    });
}

/**
 * Sync a preference value to the VS Code extension
 */
function syncPreferenceToExtension<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]): void {
    state.vscode.postMessage({
        command: 'updatePreference',
        key,
        value
    });
}

/**
 * Initialize preferences from extension settings
 * Called when webview receives initial preferences from extension
 */
export function initPreferencesFromExtension(prefs: Partial<UserPreferences>): void {
    currentPreferences = { ...DEFAULT_PREFERENCES, ...prefs };
    notifyPreferenceChange();
}

/**
 * Update UI elements to reflect current preference state
 */
export function updatePreferenceUI(): void {
    // Update high contrast toggle
    const highContrastToggle = document.getElementById('toggle-high-contrast') as HTMLInputElement;
    if (highContrastToggle) {
        highContrastToggle.checked = currentPreferences.highContrastUI;
    }
    
    // Apply high contrast class to body
    document.body.classList.toggle('high-contrast', currentPreferences.highContrastUI);
}
