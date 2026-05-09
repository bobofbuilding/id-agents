export interface TabularDetection {
  fieldName: string;
  rows: Array<Record<string, unknown>>;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function detectTabularResult(result: unknown): TabularDetection | null {
  let fieldName: string;
  let rows: unknown[];

  if (Array.isArray(result)) {
    // Top-level array of plain objects (e.g. the bulk lifecycle fan-out
    // returns rows directly). Synthesize a field name for the renderer.
    fieldName = 'rows';
    rows = result;
  } else if (isPlainObject(result)) {
    const arrayEntries = Object.entries(result).filter(([, value]) => Array.isArray(value));
    if (arrayEntries.length !== 1) return null;
    [fieldName, rows] = arrayEntries[0] as [string, unknown[]];
  } else {
    return null;
  }

  if (rows.length === 0) return null;
  if (!rows.every(isPlainObject)) return null;

  const commonKeys = rows.reduce<string[]>((common, row, index) => {
    const keys = Object.keys(row);
    if (index === 0) return keys;
    return common.filter((key) => keys.includes(key));
  }, []);

  if (commonKeys.length === 0) return null;
  return { fieldName, rows: rows as Array<Record<string, unknown>> };
}
