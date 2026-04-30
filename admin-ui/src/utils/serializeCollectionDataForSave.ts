/** 将编辑中的 rows 与原始 data 合并为可 PUT 的 payload（与后台 collections 结构一致） */
export function serializeDataForSave(
  rows: Record<string, unknown>[],
  original: Record<string, unknown>
): Record<string, unknown> {
  if (Array.isArray(original.rows)) {
    const { rows: _r, ...rest } = original;
    return { ...rest, rows };
  }
  if (rows.length === 1) {
    return { ...(rows[0] as Record<string, unknown>) };
  }
  return { rows };
}
