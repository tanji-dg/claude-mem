// SPDX-License-Identifier: Apache-2.0
//
// Turns CLAUDE_MEM_CLOUD_SYNC_E2E + <data dir>/sync-e2e.key into the process-wide
// codec used by CanonicalContent. Returns false when E2E is required but the
// key is missing or unreadable: the caller must then not start sync at all.

import { logger } from '../../utils/logger.js';
import { configureSyncE2E } from './CanonicalContent.js';
import { E2ECodec, e2eKeyPath, readE2EKey } from './E2ECodec.js';

export function configureSyncE2EFromSettings(
  settings: { CLAUDE_MEM_CLOUD_SYNC_E2E?: string },
  keyPath = e2eKeyPath(),
): boolean {
  configureSyncE2E(null);
  if ((settings.CLAUDE_MEM_CLOUD_SYNC_E2E ?? '').trim().toLowerCase() !== 'true') return true;
  try {
    const key = readE2EKey(keyPath);
    if (!key) {
      logger.error('CLOUD_SYNC', 'End-to-end encryption is on but the key file is missing; sync stays off', { keyPath });
      return false;
    }
    const codec = new E2ECodec(key);
    configureSyncE2E(codec);
    logger.info('CLOUD_SYNC', 'End-to-end encryption enabled', { keyId: codec.keyId });
    return true;
  } catch (error) {
    logger.error('CLOUD_SYNC', 'End-to-end encryption key is unreadable; sync stays off', { keyPath }, error as Error);
    return false;
  }
}
