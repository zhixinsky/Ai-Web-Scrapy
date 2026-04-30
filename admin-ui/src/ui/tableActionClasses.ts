/**
 * 列表「操作」列按钮样式，与采集数据管理页一致（空心细边框 + 圆角）
 */
export const tableActionEditClass =
  'inline-flex items-center gap-0.5 rounded-full border border-blue-200 bg-white/80 px-2.5 py-1 text-xs font-medium text-blue-700 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-blue-300 hover:bg-blue-50 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 disabled:hover:bg-white';

/** 采集数据管理：行已展开详情时的「收起」 */
export const tableActionExpandedClass =
  'inline-flex items-center gap-0.5 rounded-full border border-orange-300 bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-800 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-orange-400 hover:bg-orange-100 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 disabled:hover:bg-orange-50';

export const tableActionCopyClass =
  'inline-flex items-center gap-0.5 rounded-full border border-emerald-200 bg-white/80 px-2.5 py-1 text-xs font-medium text-emerald-700 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-emerald-50 hover:shadow-md';

/** 单行导出 Excel */
export const tableActionExportClass =
  'inline-flex items-center gap-0.5 rounded-full border border-violet-200 bg-white/80 px-2.5 py-1 text-xs font-medium text-violet-800 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-violet-300 hover:bg-violet-50 hover:shadow-md';

export const tableActionDeleteClass =
  'inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-red-100 hover:shadow-md';

export const tableActionRowWrapClass =
  'inline-flex flex-wrap items-center justify-center gap-1.5';
