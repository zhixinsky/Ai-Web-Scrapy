export const DEFAULT_SKU_DETECT_RULES = [
  {
    name: '1688 SKU 识别',
    platform: '1688',
    matchHost: ['1688.com', 'detail.1688.com'],
    enabled: true,
    priority: 10,
    windowPaths: [
      'window.context',
      'window.__INITIAL_STATE__',
      'window.__NUXT__',
      'window.__NEXT_DATA__',
      'window.runParams',
    ],
    scriptKeywords: ['skuId', 'offerSkuId', 'skuMap', 'skuList', 'skuProps', 'price', 'inventory', 'canBookCount', 'image', 'picUrl'],
    arrayDetectRules: {
      requiredAnyKeys: ['skuId', 'sku_id', 'offerSkuId', 'id'],
      optionalKeys: ['sku', 'sku2', 'specAttrs', 'attributes', 'price', 'stock', 'inventory', 'canBookCount', 'image', 'picUrl'],
      minItemCount: 1,
      maxDepth: 7,
    },
    fieldMapping: {
      skuId: ['skuId', 'sku_id', 'offerSkuId', 'id'],
      color: ['sku', 'color', '颜色', 'spec', 'specAttrs', 'attributes', 'propName', 'name'],
      size: ['sku2', 'size', '尺码', 'spec2', 'propertyValue', 'value'],
      stock: ['volume', 'stock', 'inventory', 'quantity', 'canBookCount'],
      price: ['price', 'salePrice', 'offerPrice', 'discountPrice'],
      mainImage: ['image', 'img', 'pic', 'picture', 'mainImage', 'imageUrl', 'picUrl'],
    },
  },
];
