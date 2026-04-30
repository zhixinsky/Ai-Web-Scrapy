/**
 * 从 DB 行读取「平台数据」与「通用数据」JSON 字符串（兼容仅有 data_json 的旧数据）
 */
export function getPlatformJsonString(row) {
  if (row.platform_data_json != null && String(row.platform_data_json).trim() !== '') {
    return String(row.platform_data_json);
  }
  return row.data_json != null ? String(row.data_json) : '{}';
}

export function getGenericJsonString(row) {
  if (row.generic_data_json != null && String(row.generic_data_json).trim() !== '') {
    return String(row.generic_data_json);
  }
  return row.data_json != null ? String(row.data_json) : '{}';
}
