// SPDX-License-Identifier: Apache-2.0
//
// Worker replacement for src/services/domain/ModeManager.ts (swapped in by
// build/aliases.mjs). The original resolves mode directories from the package
// root / ~/.claude-mem and reads <mode>.json with fs; Workers have neither, so
// modes come from the static registry in ./mode-registry.ts instead.
//
// Same exported class and public API surface (getInstance, loadMode,
// getActiveMode, getActiveModeId, getObservationTypes, getTypeIcon,
// getWorkEmoji) and the same semantics, including `parent--override`
// inheritance with a deep merge and the fall-back-to-'code' rules, so the
// reused parser (src/sdk/parser.ts) and prompt builder behave exactly as on
// the Node runtime.
//
// The original is a lazily-configured singleton: callers must loadMode()
// before getActiveMode(). The Worker calls ensureModeLoaded(env.CLAUDE_MEM_MODE)
// before every generation (cheap: a no-op when the id is unchanged).

import type { ModeConfig, ObservationType } from '../../../../src/services/domain/types';
import { logger } from './logger';
import { MODE_FILES } from './mode-registry';

const MODE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export const DEFAULT_MODE_ID = 'code';

export class ModeManager {
	private static instance: ModeManager | null = null;
	private activeMode: ModeConfig | null = null;
	private activeModeId: string | null = null;

	private constructor() {}

	static getInstance(): ModeManager {
		if (!ModeManager.instance) {
			ModeManager.instance = new ModeManager();
		}
		return ModeManager.instance;
	}

	private parseInheritance(modeId: string): { hasParent: boolean; parentId: string; overrideId: string } {
		const parts = modeId.split('--');
		if (parts.length === 1) {
			return { hasParent: false, parentId: '', overrideId: '' };
		}
		if (parts.length > 2) {
			throw new Error(`Invalid mode inheritance: ${modeId}. Only one level of inheritance supported (parent--override)`);
		}
		return { hasParent: true, parentId: parts[0]!, overrideId: modeId };
	}

	private isPlainObject(value: unknown): boolean {
		return value !== null && typeof value === 'object' && !Array.isArray(value);
	}

	private deepMerge<T>(base: T, override: Partial<T>): T {
		const result = { ...base } as T;
		for (const key in override) {
			const overrideValue = override[key];
			const baseValue = base[key];
			if (this.isPlainObject(overrideValue) && this.isPlainObject(baseValue)) {
				result[key] = this.deepMerge(baseValue, overrideValue as Partial<typeof baseValue>);
			} else {
				result[key] = overrideValue as T[Extract<keyof T, string>];
			}
		}
		return result;
	}

	private loadModeFile(modeId: string): ModeConfig {
		if (!MODE_ID_PATTERN.test(modeId)) {
			throw new Error(`Invalid mode ID: ${modeId}`);
		}
		const raw = Object.hasOwn(MODE_FILES, modeId) ? MODE_FILES[modeId] : undefined;
		if (!raw) {
			throw new Error(`Mode file not found: ${modeId}.json (bundled modes: ${Object.keys(MODE_FILES).join(', ')})`);
		}
		// Hand out a copy: the registry objects are module-level singletons.
		return structuredClone(raw) as ModeConfig;
	}

	loadMode(modeId: string): ModeConfig {
		const inheritance = this.parseInheritance(modeId);

		if (!inheritance.hasParent) {
			try {
				const mode = this.loadModeFile(modeId);
				this.activeMode = mode;
				this.activeModeId = modeId;
				logger.debug('SYSTEM', `Loaded mode: ${mode.name} (${modeId})`, undefined, {
					types: mode.observation_types.map((t) => t.id),
				});
				return mode;
			} catch (error) {
				logger.warn('WORKER', `Mode file not found: ${modeId}, falling back to 'code'`, {
					message: error instanceof Error ? error.message : String(error),
				});
				if (modeId === DEFAULT_MODE_ID) {
					throw new Error('Critical: code.json mode file missing');
				}
				return this.loadMode(DEFAULT_MODE_ID);
			}
		}

		const { parentId, overrideId } = inheritance;

		let parentMode: ModeConfig;
		try {
			parentMode = this.loadMode(parentId);
		} catch (error) {
			logger.warn('WORKER', `Parent mode '${parentId}' not found for ${modeId}, falling back to 'code'`, {
				message: error instanceof Error ? error.message : String(error),
			});
			parentMode = this.loadMode(DEFAULT_MODE_ID);
		}

		let overrideConfig: Partial<ModeConfig>;
		try {
			overrideConfig = this.loadModeFile(overrideId);
		} catch (error) {
			logger.warn('WORKER', `Override file '${overrideId}' not found, using parent mode '${parentId}' only`, {
				message: error instanceof Error ? error.message : String(error),
			});
			this.activeMode = parentMode;
			return parentMode;
		}

		const mergedMode = this.deepMerge(parentMode, overrideConfig);
		this.activeMode = mergedMode;
		this.activeModeId = modeId;
		logger.debug('SYSTEM', `Loaded mode with inheritance: ${mergedMode.name} (${modeId} = ${parentId} + ${overrideId})`);
		return mergedMode;
	}

	getActiveMode(): ModeConfig {
		if (!this.activeMode) {
			throw new Error('No mode loaded. Call loadMode() first.');
		}
		return this.activeMode;
	}

	getActiveModeId(): string {
		if (!this.activeModeId) {
			throw new Error('No mode loaded. Call loadMode() first.');
		}
		return this.activeModeId;
	}

	getObservationTypes(): ObservationType[] {
		return this.getActiveMode().observation_types;
	}

	getTypeIcon(typeId: string): string {
		const type = this.getObservationTypes().find((t) => t.id === typeId);
		return type?.emoji || '📝';
	}

	getWorkEmoji(typeId: string): string {
		const type = this.getObservationTypes().find((t) => t.id === typeId);
		return type?.work_emoji || '📝';
	}
}

let loadedFor: string | null = null;

/**
 * Worker-only helper: make `modeId` (CLAUDE_MEM_MODE; empty ⇒ 'code') the
 * active mode unless it already is. Isolates are reused across requests, so
 * this runs the (cheap, in-memory) load at most once per mode id per isolate.
 */
export function ensureModeLoaded(modeId: string | undefined | null): ModeConfig {
	const id = modeId?.trim() || DEFAULT_MODE_ID;
	const manager = ModeManager.getInstance();
	if (loadedFor !== id) {
		manager.loadMode(id);
		loadedFor = id;
	}
	return manager.getActiveMode();
}
