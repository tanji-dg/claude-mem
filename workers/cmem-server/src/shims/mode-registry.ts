// SPDX-License-Identifier: Apache-2.0
//
// Every mode shipped in plugin/modes/, bundled as static JSON imports (Workers
// have no filesystem to read them from at runtime). All 35 files add ~27 KB
// gzipped to the bundle. When a mode is added to plugin/modes/, add it here;
// test/mode-manager.test.ts fails until the registry matches the directory
// (vitest.config.ts passes the directory listing in as TEST_MODE_IDS).

import code__ar from '../../../../plugin/modes/code--ar.json';
import code__bn from '../../../../plugin/modes/code--bn.json';
import code__chill from '../../../../plugin/modes/code--chill.json';
import code__cs from '../../../../plugin/modes/code--cs.json';
import code__da from '../../../../plugin/modes/code--da.json';
import code__de from '../../../../plugin/modes/code--de.json';
import code__el from '../../../../plugin/modes/code--el.json';
import code__es from '../../../../plugin/modes/code--es.json';
import code__fi from '../../../../plugin/modes/code--fi.json';
import code__fr from '../../../../plugin/modes/code--fr.json';
import code__he from '../../../../plugin/modes/code--he.json';
import code__hi from '../../../../plugin/modes/code--hi.json';
import code__hu from '../../../../plugin/modes/code--hu.json';
import code__id from '../../../../plugin/modes/code--id.json';
import code__it from '../../../../plugin/modes/code--it.json';
import code__ja from '../../../../plugin/modes/code--ja.json';
import code__ko from '../../../../plugin/modes/code--ko.json';
import code__nl from '../../../../plugin/modes/code--nl.json';
import code__no from '../../../../plugin/modes/code--no.json';
import code__pl from '../../../../plugin/modes/code--pl.json';
import code__pt_br from '../../../../plugin/modes/code--pt-br.json';
import code__ro from '../../../../plugin/modes/code--ro.json';
import code__ru from '../../../../plugin/modes/code--ru.json';
import code__sv from '../../../../plugin/modes/code--sv.json';
import code__th from '../../../../plugin/modes/code--th.json';
import code__tr from '../../../../plugin/modes/code--tr.json';
import code__uk from '../../../../plugin/modes/code--uk.json';
import code__ur from '../../../../plugin/modes/code--ur.json';
import code__vi from '../../../../plugin/modes/code--vi.json';
import code__zh from '../../../../plugin/modes/code--zh.json';
import code from '../../../../plugin/modes/code.json';
import email_investigation from '../../../../plugin/modes/email-investigation.json';
import law_study__chill from '../../../../plugin/modes/law-study--chill.json';
import law_study from '../../../../plugin/modes/law-study.json';
import meme_tokens from '../../../../plugin/modes/meme-tokens.json';

/** Raw mode files keyed by mode id (file name without .json). */
export const MODE_FILES: Readonly<Record<string, unknown>> = {
	'code--ar': code__ar,
	'code--bn': code__bn,
	'code--chill': code__chill,
	'code--cs': code__cs,
	'code--da': code__da,
	'code--de': code__de,
	'code--el': code__el,
	'code--es': code__es,
	'code--fi': code__fi,
	'code--fr': code__fr,
	'code--he': code__he,
	'code--hi': code__hi,
	'code--hu': code__hu,
	'code--id': code__id,
	'code--it': code__it,
	'code--ja': code__ja,
	'code--ko': code__ko,
	'code--nl': code__nl,
	'code--no': code__no,
	'code--pl': code__pl,
	'code--pt-br': code__pt_br,
	'code--ro': code__ro,
	'code--ru': code__ru,
	'code--sv': code__sv,
	'code--th': code__th,
	'code--tr': code__tr,
	'code--uk': code__uk,
	'code--ur': code__ur,
	'code--vi': code__vi,
	'code--zh': code__zh,
	'code': code,
	'email-investigation': email_investigation,
	'law-study--chill': law_study__chill,
	'law-study': law_study,
	'meme-tokens': meme_tokens,
};
