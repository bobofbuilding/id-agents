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
  if (!isPlainObject(result)) return null;

  const arrayEntries = Object.entries(result).filter(([, value]) => Array.isArray(value));
  if (arrayEntries.length !== 1) return null;

  const [fieldName, value] = arrayEntries[0]!;
  const rows = value as unknown[];
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
