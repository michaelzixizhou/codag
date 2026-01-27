/**
 * Onboarding tutorial for first-time users
 */

import * as state from './state';

interface TutorialStep {
    title: string;
    description: string;
    icon: string;
}

const TUTORIAL_STEPS: TutorialStep[] = [
    {
        title: 'Welcome to Codag',
        description: 'Visualize your AI/LLM workflows as interactive graphs. Let\'s take a quick tour.',
        icon: `<svg class="tutorial-codag-logo" viewBox="0 0 183.49023 48.22958" xmlns="http://www.w3.org/2000/svg">
            <g transform="translate(-4.663109,-100.21196)">
                <circle fill="currentColor" cx="12.989979" cy="136.37827" r="8.32687" />
                <path fill="currentColor" d="m 23.348962,100.21197 c -1.884958,0 -3.402376,1.51742 -3.402376,3.40238 v 22.4131 c 0,1.88496 1.517418,3.40238 3.402376,3.40238 h 22.413103 c 1.884958,0 3.402376,-1.51742 3.402376,-3.40238 v -22.4131 c 0,-1.88496 -1.517418,-3.40238 -3.402376,-3.40238 z m 11.30267,6.39083 a 8.32687,8.32687 0 0 1 8.32714,8.32714 8.32687,8.32687 0 0 1 -8.32714,8.32662 8.32687,8.32687 0 0 1 -8.326624,-8.32662 8.32687,8.32687 0 0 1 8.326624,-8.32714 z" />
                <path fill="currentColor" d="m 12.407616,130.60648 13.191254,-13.19125 6.269113,6.39971 -15.411566,15.41157 z" />
                <text fill="currentColor" style="font-size:44.0158px;font-weight:bold;font-family:Damascus,system-ui,-apple-system,sans-serif" x="55.822399" y="131.09103" transform="scale(0.94435948,1.0589188)">codag</text>
            </g>
        </svg>`
    },
    {
        title: 'Select Files to Analyze',
        description: 'Click the <strong>folder icon</strong> in the top-right to open the file picker. Select files containing LLM API calls.',
        icon: `<svg viewBox="0 0 24 24" width="64" height="64" fill="var(--vscode-button-background)">
            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
        </svg>`
    },
    {
        title: 'Explore the Graph',
        description: '<strong>Drag</strong> to pan around. <strong>Scroll</strong> to zoom in/out. Use the <strong>minimap</strong> in the bottom-left for navigation.',
        icon: `<svg viewBox="0 0 24 24" width="64" height="64" fill="var(--vscode-button-background)">
            <path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/>
        </svg>`
    },
    {
        title: 'Inspect Nodes',
        description: '<strong>Click any node</strong> to open the side panel with details. Click the <strong>source link</strong> to jump directly to the code.',
        icon: `<svg viewBox="0 0 24 24" width="64" height="64" fill="var(--vscode-button-background)">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
        </svg>`
    },
    {
        title: 'You\'re Ready!',
        description: 'That\'s it! Start by selecting files to analyze. The graph updates automatically as your code changes.',
        icon: `<svg viewBox="0 0 24 24" width="64" height="64" fill="#22c55e">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>`
    }
];

const STORAGE_KEY = 'codag-tutorial-completed';

class Tutorial {
    private overlay: HTMLElement | null = null;
    private content: HTMLElement | null = null;
    private dots: HTMLElement | null = null;
    private prevBtn: HTMLElement | null = null;
    private nextBtn: HTMLElement | null = null;
    private skipBtn: HTMLElement | null = null;
    private currentStep = 0;

    /**
     * Check if tutorial should be shown (first time user)
     */
    shouldShow(): boolean {
        try {
            return localStorage.getItem(STORAGE_KEY) !== 'true';
        } catch {
            return false;  // localStorage not available
        }
    }

    /**
     * Initialize and show tutorial if needed
     */
    init(): void {
        this.overlay = document.getElementById('tutorialOverlay');
        this.content = document.getElementById('tutorialContent');
        this.dots = document.getElementById('tutorialDots');
        this.prevBtn = document.getElementById('tutorialPrev');
        this.nextBtn = document.getElementById('tutorialNext');
        this.skipBtn = document.getElementById('tutorialSkip');

        if (!this.overlay || !this.content || !this.dots || !this.prevBtn || !this.nextBtn || !this.skipBtn) {
            return;
        }

        // Set up event listeners
        this.prevBtn.addEventListener('click', () => this.prev());
        this.nextBtn.addEventListener('click', () => this.next());
        this.skipBtn.addEventListener('click', () => this.complete());

        // Close on overlay click
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.complete();
            }
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.overlay?.style.display !== 'none') {
                this.complete();
            }
        });
    }

    /**
     * Show the tutorial
     */
    show(): void {
        if (!this.overlay) return;

        this.currentStep = 0;
        this.renderDots();
        this.renderStep();
        this.overlay.style.display = 'flex';
    }

    /**
     * Go to previous step
     */
    private prev(): void {
        if (this.currentStep > 0) {
            this.currentStep--;
            this.renderStep();
        }
    }

    /**
     * Go to next step or complete
     */
    private next(): void {
        if (this.currentStep < TUTORIAL_STEPS.length - 1) {
            this.currentStep++;
            this.renderStep();
        } else {
            this.complete();
        }
    }

    /**
     * Render the dots indicator
     */
    private renderDots(): void {
        if (!this.dots) return;

        this.dots.innerHTML = TUTORIAL_STEPS.map((_, i) =>
            `<span class="tutorial-dot ${i === this.currentStep ? 'active' : ''}" data-step="${i}"></span>`
        ).join('');

        // Allow clicking dots to navigate
        this.dots.querySelectorAll('.tutorial-dot').forEach((dot, i) => {
            dot.addEventListener('click', () => {
                this.currentStep = i;
                this.renderStep();
            });
        });
    }

    /**
     * Render the current step content
     */
    private renderStep(): void {
        if (!this.content || !this.prevBtn || !this.nextBtn || !this.dots) return;

        const step = TUTORIAL_STEPS[this.currentStep];
        const isFirst = this.currentStep === 0;
        const isLast = this.currentStep === TUTORIAL_STEPS.length - 1;

        this.content.innerHTML = `
            <div class="tutorial-icon">${step.icon}</div>
            <h2 class="tutorial-title">${step.title}</h2>
            <p class="tutorial-description">${step.description}</p>
        `;

        // Update button states
        this.prevBtn.style.visibility = isFirst ? 'hidden' : 'visible';
        this.nextBtn.textContent = isLast ? 'Get Started' : 'Next';

        // Update dots
        this.dots.querySelectorAll('.tutorial-dot').forEach((dot, i) => {
            dot.classList.toggle('active', i === this.currentStep);
        });
    }

    /**
     * Complete tutorial and save preference
     */
    private complete(): void {
        if (!this.overlay) return;

        this.overlay.style.display = 'none';

        try {
            localStorage.setItem(STORAGE_KEY, 'true');
        } catch {
            // localStorage not available
        }
    }

    /**
     * Reset tutorial (for testing)
     */
    reset(): void {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            // localStorage not available
        }
    }
}

// Singleton
let tutorialInstance: Tutorial | null = null;

export function getTutorial(): Tutorial {
    if (!tutorialInstance) {
        tutorialInstance = new Tutorial();
    }
    return tutorialInstance;
}

export function initTutorial(): void {
    const tutorial = getTutorial();
    tutorial.init();

    if (tutorial.shouldShow()) {
        // Slight delay to let the UI settle
        setTimeout(() => tutorial.show(), 500);
    }
}
