// Reusable dropdown component
import { DROPDOWN_OFFSET } from './constants';

/**
 * Dropdown component for managing popover menus
 */
export class Dropdown {
    private trigger: HTMLElement;
    private dropdown: HTMLElement;
    private isOpen: boolean = false;
    private outsideClickHandler: ((e: MouseEvent) => void) | null = null;

    constructor(triggerId: string, dropdownId: string) {
        const trigger = document.getElementById(triggerId);
        const dropdown = document.getElementById(dropdownId);

        if (!trigger || !dropdown) {
            throw new Error(`Dropdown: trigger or dropdown element not found (${triggerId}, ${dropdownId})`);
        }

        this.trigger = trigger;
        this.dropdown = dropdown;
        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        this.trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });
    }

    private toggle(): void {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    private open(): void {
        if (this.isOpen) return;

        // Position dropdown relative to trigger
        this.positionDropdown();

        // Show dropdown
        this.dropdown.classList.remove('hidden');
        this.isOpen = true;

        // Setup outside click handler
        this.outsideClickHandler = (e: MouseEvent) => {
            if (!this.dropdown.contains(e.target as Node) && !this.trigger.contains(e.target as Node)) {
                this.close();
            }
        };

        // Delay to avoid immediate trigger
        setTimeout(() => {
            document.addEventListener('click', this.outsideClickHandler!);
        }, 0);
    }

    private close(): void {
        if (!this.isOpen) return;

        this.dropdown.classList.add('hidden');
        this.isOpen = false;

        // Remove outside click handler
        if (this.outsideClickHandler) {
            document.removeEventListener('click', this.outsideClickHandler);
            this.outsideClickHandler = null;
        }
    }

    private positionDropdown(): void {
        const triggerRect = this.trigger.getBoundingClientRect();
        const dropdownRect = this.dropdown.getBoundingClientRect();

        // Position below trigger, aligned to right
        let top = triggerRect.bottom + DROPDOWN_OFFSET;
        let right = window.innerWidth - triggerRect.right;

        // Adjust if dropdown would go off bottom of screen
        if (top + dropdownRect.height > window.innerHeight) {
            top = triggerRect.top - dropdownRect.height - DROPDOWN_OFFSET;
        }

        this.dropdown.style.top = `${top}px`;
        this.dropdown.style.right = `${right}px`;
    }

    public isDropdownOpen(): boolean {
        return this.isOpen;
    }

    public closeDropdown(): void {
        this.close();
    }
}

/**
 * Create a dropdown instance
 */
export function createDropdown(triggerId: string, dropdownId: string): Dropdown {
    return new Dropdown(triggerId, dropdownId);
}
