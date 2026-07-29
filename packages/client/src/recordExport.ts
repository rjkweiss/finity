// Browser-only half of record export: triggers a .json download. Serialization,
// filenames, and import validation live in @finity/recorder (DOM-free)

import type { GameRecord } from '@finity/engine';
import { recordFileName, recordToJson } from '@finity/recorder';

/** Trigger a .json download of the record */
export function downloadGameRecord(record: GameRecord): void {
    const blob = new Blob([recordToJson(record)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = recordFileName(record);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
