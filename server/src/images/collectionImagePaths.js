import path from 'path';

/**
 * 采集图片磁盘根目录：{dataDir}/images/{采集记录ID}/
 *（不再使用 images/collections 中间层，路径更短。）
 */
export function absCollectionImagesRoot(dataDir, collectionId) {
  return path.join(dataDir, 'images', String(collectionId));
}

/** 导出表格 / zip 内相对路径前缀，如 images/42 */
export function relCollectionImagesDir(collectionId) {
  return `images/${String(collectionId)}`;
}
